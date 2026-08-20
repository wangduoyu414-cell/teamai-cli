import crypto from 'node:crypto';
import path from 'node:path';
import fse from 'fs-extra';
import { getTeamaiHome, type Scope } from './types.js';

/** One ownership ledger covers every resource channel; handlers only supply targets. */
export type ManagedOwnership = 'created' | 'adopted' | 'replaced-with-backup';
export type ManagedPathKind = 'file' | 'directory';

export interface ManagedSection {
  start: string;
  end: string;
}

export interface ManagedResourceTarget {
  path: string;
  kind: ManagedPathKind;
  tool?: string;
  content?: string;
  sourcePath?: string;
  /** Optional destination-local normalization, run against the staged payload. */
  prepareStaged?: (payloadPath: string) => Promise<void>;
  /** A project instruction owns this block only, never the surrounding file. */
  section?: ManagedSection;
}

export interface DesiredManagedResource {
  id: string;
  type: 'skills' | 'agents' | 'instructions';
  targets: ManagedResourceTarget[];
  /** Existing targets to retain during a targeted uninstall. */
  retainTargetPaths?: string[];
}

interface ManagedTargetRecord {
  path: string;
  kind: ManagedPathKind;
  tool?: string;
  section?: ManagedSection;
  hash: string;
  ownership: ManagedOwnership;
  backupPath?: string;
}

interface ManagedResourceRecord {
  id: string;
  type: DesiredManagedResource['type'];
  targets: ManagedTargetRecord[];
}

export interface ManagedResourceManifest {
  version: 1;
  resources: Record<string, ManagedResourceRecord>;
}

type JournalStatus = 'staging' | 'applying' | 'committed' | 'completed' | 'rolled-back';
type JournalPhase = 'prepared' | 'previous-moved' | 'applied';
interface JournalOperation {
  target: string;
  previous: string;
  rollbackRoot: string;
  stagedRoot?: string;
  hadPrevious: boolean;
  phase: JournalPhase;
}
interface ManagedResourceJournal {
  version: 1;
  transactionId: string;
  status: JournalStatus;
  resourceIds: string[];
  operations: JournalOperation[];
  stagedRoots: string[];
  createdBackups: string[];
  backupCleanup: string[];
  /** Digest of the atomic manifest write that is the transaction commit point. */
  nextManifestHash?: string;
  updatedAt: string;
}

export interface ManagedReconcileOptions {
  pruneTypes?: DesiredManagedResource['type'][];
  /** Restrict pruning without creating a second state/transaction implementation. */
  pruneResourceIds?: string[];
  plan?: boolean;
  /** Focused test hook that proves earlier operations compensate after a later failure. */
  failAfterApply?: number;
}

export interface ManagedReconcileResult {
  applied: string[];
  removed: string[];
  conflicts: string[];
  planned: string[];
}

export interface ManagedUninstallOptions {
  types?: DesiredManagedResource['type'][];
  tool?: string;
  plan?: boolean;
}

const MANIFEST_FILE = 'managed-resources.json';
const JOURNAL_FILE = 'managed-resources.journal.json';
const BACKUPS_DIR = 'managed-resource-backups';

export function managedResourceManifestPath(scope: Scope, projectRoot?: string): string {
  return path.join(getTeamaiHome(scope, projectRoot), MANIFEST_FILE);
}

export function managedResourceJournalPath(scope: Scope, projectRoot?: string): string {
  return path.join(getTeamaiHome(scope, projectRoot), JOURNAL_FILE);
}

export async function loadManagedResourceManifest(home: string): Promise<ManagedResourceManifest> {
  const manifestPath = path.join(home, MANIFEST_FILE);
  let content: string;
  try {
    content = await fse.readFile(manifestPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, resources: {} };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Managed resource manifest is invalid: ${manifestPath}`);
  }
  const manifest = parsed as Partial<ManagedResourceManifest>;
  if (manifest.version !== 1 || !manifest.resources || typeof manifest.resources !== 'object') {
    throw new Error(`Managed resource manifest has an unsupported shape: ${manifestPath}`);
  }
  return { version: 1, resources: manifest.resources };
}

export async function managedManifestTargetPaths(home: string): Promise<Set<string>> {
  const manifest = await loadManagedResourceManifest(home);
  return new Set(Object.values(manifest.resources).flatMap((resource) => resource.targets.map((target) => target.path)));
}

function digest(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function serialised(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fse.ensureDir(path.dirname(filePath));
  const temp = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fse.writeFile(temp, serialised(value), 'utf8');
    await fse.rename(temp, filePath);
  } catch (error) {
    await fse.remove(temp).catch(() => undefined);
    throw error;
  }
}

async function writeJournal(home: string, journal: ManagedResourceJournal): Promise<void> {
  journal.updatedAt = new Date().toISOString();
  await writeJsonAtomic(path.join(home, JOURNAL_FILE), journal);
}

async function readJournal(home: string): Promise<ManagedResourceJournal | null> {
  const journalPath = path.join(home, JOURNAL_FILE);
  let content: string;
  try {
    content = await fse.readFile(journalPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const journal = JSON.parse(content) as ManagedResourceJournal;
    if (journal.version !== 1 || !Array.isArray(journal.operations)) throw new Error('shape');
    return journal;
  } catch {
    throw new Error(`Managed resource journal is invalid: ${journalPath}`);
  }
}

function token(value: string): string {
  return digest(value).slice(0, 20);
}

function extractSection(content: string, section: ManagedSection): string | null {
  const start = content.indexOf(section.start);
  const end = content.indexOf(section.end);
  if (start === -1 || end === -1 || end < start) return null;
  return content.slice(start, end + section.end.length);
}

function mergeSection(content: string, section: ManagedSection, block: string): string {
  const start = content.indexOf(section.start);
  const end = content.indexOf(section.end);
  if (start !== -1 && end !== -1 && end >= start) {
    return content.slice(0, start) + block + content.slice(end + section.end.length);
  }
  return `${content.trimEnd()}${content.trimEnd() ? '\n\n' : ''}${block}\n`;
}

function removeSection(content: string, section: ManagedSection): string {
  const start = content.indexOf(section.start);
  const end = content.indexOf(section.end);
  if (start === -1 || end === -1 || end < start) return content;
  const before = content.slice(0, start).replace(/\n+$/, '\n');
  const after = content.slice(end + section.end.length).replace(/^\n+/, '\n');
  return `${before}${after}`.trimEnd() + (before || after ? '\n' : '');
}

async function hashPath(target: string, kind: ManagedPathKind, section?: ManagedSection): Promise<string | null> {
  try {
    const stat = await fse.lstat(target);
    if ((stat.isDirectory() ? 'directory' : 'file') !== kind) return `kind:${stat.isDirectory() ? 'directory' : 'file'}`;
    if (section) {
      const sectionContent = extractSection(await fse.readFile(target, 'utf8'), section);
      return sectionContent === null ? null : digest(sectionContent);
    }
    if (kind === 'file') return digest(await fse.readFile(target));
    const hash = crypto.createHash('sha256');
    hash.update('directory\0');
    await hashDirectory(target, '', hash);
    return hash.digest('hex');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function hashDirectory(root: string, relative: string, hash: crypto.Hash): Promise<void> {
  const entries = await fse.readdir(path.join(root, relative), { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const rel = relative ? path.join(relative, entry.name) : entry.name;
    const fullPath = path.join(root, rel);
    if (entry.isDirectory()) {
      hash.update(`d:${rel}\0`);
      await hashDirectory(root, rel, hash);
    } else if (entry.isFile()) {
      hash.update(`f:${rel}\0`);
      hash.update(await fse.readFile(fullPath));
    } else {
      hash.update(`other:${rel}\0`);
    }
  }
}

interface StagedTarget {
  target: ManagedResourceTarget;
  root: string;
  payload: string;
  hash: string;
}

async function stageTarget(target: ManagedResourceTarget, transactionId: string, index: number): Promise<StagedTarget> {
  if ((target.content === undefined) === (target.sourcePath === undefined)) {
    throw new Error(`Managed target ${target.path} needs exactly one of content or sourcePath`);
  }
  if (target.section && (target.kind !== 'file' || target.content === undefined)) {
    throw new Error(`Managed section ${target.path} must be rendered file content`);
  }
  await fse.ensureDir(path.dirname(target.path));
  const root = await fse.mkdtemp(path.join(path.dirname(target.path), `.teamai-stage-${transactionId}-${index}-`));
  const payload = path.join(root, 'payload');
  try {
    if (target.content !== undefined) {
      const existing = target.section ? await fse.readFile(target.path, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      }) : undefined;
      await fse.writeFile(payload, target.section ? mergeSection(existing!, target.section, target.content) : target.content, 'utf8');
    } else {
      const source = await fse.stat(target.sourcePath!);
      if ((source.isDirectory() ? 'directory' : 'file') !== target.kind) throw new Error(`Managed source kind does not match ${target.path}`);
      await fse.copy(target.sourcePath!, payload, { overwrite: true });
    }
    if (target.prepareStaged) await target.prepareStaged(payload);
    const hash = target.section ? digest(target.content!) : await hashPath(payload, target.kind);
    if (!hash) throw new Error(`Could not stage ${target.path}`);
    return { target, root, payload, hash };
  } catch (error) {
    await fse.remove(root).catch(() => undefined);
    throw error;
  }
}

async function stageSectionRemoval(
  target: ManagedTargetRecord,
  transactionId: string,
  index: number,
  restoreBlock?: string,
): Promise<{ root: string; payload: string }> {
  const existing = await fse.readFile(target.path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const root = await fse.mkdtemp(path.join(path.dirname(target.path), `.teamai-stage-${transactionId}-remove-${index}-`));
  const payload = path.join(root, 'payload');
  const content = restoreBlock && target.section
    ? mergeSection(existing, target.section, restoreBlock)
    : removeSection(existing, target.section!);
  await fse.writeFile(payload, content, 'utf8');
  return { root, payload };
}

function cloneManifest(manifest: ManagedResourceManifest): ManagedResourceManifest {
  return JSON.parse(JSON.stringify(manifest)) as ManagedResourceManifest;
}

function findRecordByPath(manifest: ManagedResourceManifest, targetPath: string): ManagedTargetRecord | null {
  for (const resource of Object.values(manifest.resources)) {
    const target = resource.targets.find((entry) => entry.path === targetPath);
    if (target) return target;
  }
  return null;
}

async function rollbackJournal(journal: ManagedResourceJournal): Promise<void> {
  const recoveredRoots: string[] = [];
  const failures: string[] = [];
  for (const operation of [...journal.operations].reverse()) {
    try {
      const previousExists = await fse.pathExists(operation.previous);
      if (previousExists) {
        if (await fse.pathExists(operation.target)) await fse.remove(operation.target);
        await fse.rename(operation.previous, operation.target);
      } else if (!operation.hadPrevious && await fse.pathExists(operation.target)) {
        // A crash after moving staged content but before recording phase must still
        // restore the original absence.
        await fse.remove(operation.target);
      } else if (operation.hadPrevious && operation.phase !== 'prepared') {
        throw new Error(`missing rollback payload for ${operation.target}`);
      } else if (operation.hadPrevious && !await fse.pathExists(operation.target)) {
        // `prepared` can mean no move happened yet, but a missing original cannot
        // be guessed or discarded.
        throw new Error(`missing original target for ${operation.target}`);
      }
      recoveredRoots.push(operation.rollbackRoot);
    } catch {
      failures.push(operation.target);
    }
  }
  if (failures.length > 0) {
    // Do not remove any remaining rollback/staging evidence or mark the journal
    // rolled back. A later invocation may regain access and complete recovery.
    await Promise.all(recoveredRoots.map((entry) => fse.remove(entry).catch(() => undefined)));
    throw new Error(`Managed resource rollback incomplete: ${failures.join(', ')}`);
  }
  await Promise.all([
    ...journal.stagedRoots,
    ...recoveredRoots,
    ...journal.createdBackups,
  ].map((entry) => fse.remove(entry).catch(() => undefined)));
}

async function finishCommittedJournal(home: string, journal: ManagedResourceJournal): Promise<void> {
  await Promise.all([
    ...journal.stagedRoots,
    ...journal.operations.map((operation) => operation.rollbackRoot),
    ...journal.backupCleanup,
  ].map((entry) => fse.remove(entry).catch(() => undefined)));
  journal.status = 'completed';
  await writeJournal(home, journal);
}

/** Resolve a previously interrupted transaction before a new non-plan mutation. */
export async function recoverManagedResourceTransaction(home: string): Promise<void> {
  const journal = await readJournal(home);
  if (!journal || journal.status === 'completed' || journal.status === 'rolled-back') return;
  let committed = false;
  if (journal.nextManifestHash) {
    try {
      committed = digest(await fse.readFile(path.join(home, MANIFEST_FILE))) === journal.nextManifestHash;
    } catch {
      committed = false;
    }
  }
  if (committed) {
    await finishCommittedJournal(home, journal);
    return;
  }
  await rollbackJournal(journal);
  journal.status = 'rolled-back';
  await writeJournal(home, journal);
}

async function recordOperation(
  home: string,
  journal: ManagedResourceJournal,
  target: string,
  payload: string | null,
  stagedRoot?: string,
): Promise<void> {
  const rollbackRoot = await fse.mkdtemp(path.join(path.dirname(target), `.teamai-rollback-${journal.transactionId}-`));
  const previous = path.join(rollbackRoot, 'previous');
  const operation: JournalOperation = {
    target, previous, rollbackRoot, stagedRoot, hadPrevious: await fse.pathExists(target), phase: 'prepared',
  };
  journal.operations.push(operation);
  await writeJournal(home, journal);
  if (operation.hadPrevious) await fse.rename(target, previous);
  operation.phase = 'previous-moved';
  await writeJournal(home, journal);
  if (payload) await fse.rename(payload, target);
  operation.phase = 'applied';
  await writeJournal(home, journal);
}

/**
 * Stage sources before changing destinations, replace each target by rename, and
 * atomically commit the resulting ledger. The journal's expected manifest digest
 * makes a post-commit crash distinguishable from a pre-commit crash.
 */
export async function reconcileManagedResources(
  home: string,
  desiredResources: DesiredManagedResource[],
  options: ManagedReconcileOptions = {},
): Promise<ManagedReconcileResult> {
  if (!options.plan) await recoverManagedResourceTransaction(home);
  const manifest = await loadManagedResourceManifest(home);
  const result: ManagedReconcileResult = { applied: [], removed: [], conflicts: [], planned: [] };

  const desiredIds = new Set<string>();
  const desiredOwners = new Map<string, string>();
  for (const resource of desiredResources) {
    if (desiredIds.has(resource.id)) throw new Error(`Managed resource id is duplicated: ${resource.id}`);
    desiredIds.add(resource.id);
    for (const target of resource.targets) {
      const owner = desiredOwners.get(target.path);
      if (owner) throw new Error(`Managed target is claimed by both ${owner} and ${resource.id}: ${target.path}`);
      desiredOwners.set(target.path, resource.id);
    }
  }

  const desiredById = new Map(desiredResources.map((resource) => [resource.id, resource]));
  const desiredPaths = new Set(desiredResources.flatMap((resource) => [
    ...resource.targets.map((target) => target.path), ...(resource.retainTargetPaths ?? []),
  ]));
  const pruneTypes = new Set<DesiredManagedResource['type']>(options.pruneTypes ?? []);
  const pruneIds = options.pruneResourceIds ? new Set(options.pruneResourceIds) : null;
  const conflictIds = new Set<string>();

  for (const resource of desiredResources) {
    for (const target of resource.targets) {
      const prior = findRecordByPath(manifest, target.path);
      if (!prior) continue;
      const currentHash = await hashPath(target.path, prior.kind, prior.section);
      if (currentHash !== null && currentHash !== prior.hash) {
        conflictIds.add(resource.id);
        result.conflicts.push(`${resource.id}: ${target.path} was modified locally`);
      }
    }
  }
  const activeResources = desiredResources.filter((resource) => !conflictIds.has(resource.id));
  const shouldPrune = (id: string, resource: ManagedResourceRecord) =>
    pruneTypes.has(resource.type) && !conflictIds.has(id) && (!pruneIds || pruneIds.has(id));

  if (options.plan) {
    for (const resource of activeResources) result.planned.push(...resource.targets.map((target) => target.path));
    for (const [id, resource] of Object.entries(manifest.resources)) {
      if (!shouldPrune(id, resource)) continue;
      const wanted = new Set([...(desiredById.get(id)?.targets.map((target) => target.path) ?? []), ...(desiredById.get(id)?.retainTargetPaths ?? [])]);
      result.planned.push(...resource.targets.filter((target) => !wanted.has(target.path)).map((target) => target.path));
    }
    return result;
  }

  await fse.ensureDir(home);
  const transactionId = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
  const journal: ManagedResourceJournal = {
    version: 1, transactionId, status: 'staging', resourceIds: activeResources.map((resource) => resource.id),
    operations: [], stagedRoots: [], createdBackups: [], backupCleanup: [], updatedAt: new Date().toISOString(),
  };
  await writeJournal(home, journal);
  const staged = new Map<string, StagedTarget>();
  let committed = false;
  try {
    let index = 0;
    for (const resource of activeResources) {
      for (const target of resource.targets) {
        const entry = await stageTarget(target, transactionId, index++);
        staged.set(`${resource.id}\0${target.path}`, entry);
        journal.stagedRoots.push(entry.root);
        await writeJournal(home, journal);
      }
    }
    journal.status = 'applying';
    await writeJournal(home, journal);

    const next = cloneManifest(manifest);
    let appliedCount = 0;
    for (const resource of activeResources) {
      const oldTargets = next.resources[resource.id]?.targets ?? [];
      const plannedPaths = new Set(resource.targets.map((target) => target.path));
      // Keep stale records until their own local-modification guard has run.
      // This is essential for A → B renames where A was edited locally.
      const records = oldTargets.filter((target) => !plannedPaths.has(target.path));
      for (const target of resource.targets) {
        const entry = staged.get(`${resource.id}\0${target.path}`)!;
        const prior = findRecordByPath(manifest, target.path);
        const currentHash = await hashPath(target.path, target.kind, target.section);
        let ownership: ManagedOwnership;
        let backupPath: string | undefined;
        if (prior) {
          ownership = prior.ownership;
          backupPath = prior.backupPath;
        } else if (currentHash === null) {
          ownership = 'created';
        } else if (currentHash === entry.hash) {
          ownership = 'adopted';
        } else {
          ownership = 'replaced-with-backup';
          backupPath = path.join(home, BACKUPS_DIR, token(`${resource.id}:${target.path}`));
          if (!await fse.pathExists(backupPath)) {
            await fse.ensureDir(path.dirname(backupPath));
            if (target.section) {
              const original = extractSection(await fse.readFile(target.path, 'utf8'), target.section);
              if (original === null) throw new Error(`Cannot back up missing instruction section at ${target.path}`);
              await fse.writeFile(backupPath, original, 'utf8');
            } else {
              await fse.copy(target.path, backupPath, { overwrite: false });
            }
            journal.createdBackups.push(backupPath);
            await writeJournal(home, journal);
          }
        }
        if (currentHash !== entry.hash) {
          await recordOperation(home, journal, target.path, entry.payload, entry.root);
          result.applied.push(target.path);
          appliedCount++;
          if (options.failAfterApply !== undefined && appliedCount >= options.failAfterApply) throw new Error('Injected managed-resource failure');
        }
        records.push({ path: target.path, kind: target.kind, tool: target.tool, section: target.section, hash: entry.hash, ownership, backupPath });
      }
      // Empty desired targets mean "prune this resource". Keep the old record
      // until each stale target has passed its local-modification guard.
      if (resource.targets.length > 0) {
        next.resources[resource.id] = { id: resource.id, type: resource.type, targets: records };
      }
    }

    // A resource may be renamed while retaining the same on-disk target. Move
    // that ownership to the active resource instead of leaving duplicate claims.
    const activeIds = new Set(activeResources.map((resource) => resource.id));
    const activePaths = new Set(activeResources.flatMap((resource) => resource.targets.map((target) => target.path)));
    for (const [id, resource] of Object.entries(next.resources)) {
      if (activeIds.has(id)) continue;
      resource.targets = resource.targets.filter((target) => !activePaths.has(target.path));
    }

    for (const [id, oldResource] of Object.entries(manifest.resources)) {
      if (!shouldPrune(id, oldResource)) continue;
      const desired = desiredById.get(id);
      const wanted = new Set([...(desired?.targets.map((target) => target.path) ?? []), ...(desired?.retainTargetPaths ?? [])]);
      for (const oldTarget of oldResource.targets) {
        if (wanted.has(oldTarget.path) || desiredPaths.has(oldTarget.path)) continue;
        const currentHash = await hashPath(oldTarget.path, oldTarget.kind, oldTarget.section);
        if (currentHash !== null && currentHash !== oldTarget.hash) {
          result.conflicts.push(`${id}: ${oldTarget.path} was modified locally`);
          continue;
        }
        const currentNext = next.resources[id];
        // adopted is provenance, not a weaker lifecycle contract: once an
        // unchanged manual install is adopted it is removed on rename/uninstall
        // exactly like a created target. A changed hash above remains protected.
        let payload: string | null = null;
        let stagedRoot: string | undefined;
        let backupPath: string | null = null;
        if (oldTarget.ownership === 'replaced-with-backup') {
          if (!oldTarget.backupPath || !await fse.pathExists(oldTarget.backupPath)) {
            throw new Error(`Managed resource backup is missing for ${oldTarget.path}`);
          }
          backupPath = oldTarget.backupPath;
        }
        if (oldTarget.section) {
          let restore: string | undefined;
          if (backupPath) {
            restore = await fse.readFile(backupPath, 'utf8');
            journal.backupCleanup.push(backupPath);
          }
          const stagedRemoval = await stageSectionRemoval(oldTarget, transactionId, appliedCount, restore);
          payload = (await fse.readFile(stagedRemoval.payload, 'utf8')).trim() === '' ? null : stagedRemoval.payload;
          stagedRoot = stagedRemoval.root;
          journal.stagedRoots.push(stagedRoot);
          await writeJournal(home, journal);
        } else if (backupPath) {
          const root = await fse.mkdtemp(path.join(path.dirname(oldTarget.path), `.teamai-stage-${transactionId}-restore-`));
          payload = path.join(root, 'payload');
          await fse.copy(backupPath, payload);
          stagedRoot = root;
          journal.stagedRoots.push(root);
          journal.backupCleanup.push(backupPath);
          await writeJournal(home, journal);
        }
        await recordOperation(home, journal, oldTarget.path, payload, stagedRoot);
        result.removed.push(oldTarget.path);
        if (currentNext) currentNext.targets = currentNext.targets.filter((target) => target.path !== oldTarget.path);
      }
    }
    for (const [id, resource] of Object.entries(next.resources)) if (resource.targets.length === 0) delete next.resources[id];

    journal.nextManifestHash = digest(serialised(next));
    await writeJournal(home, journal);
    await writeJsonAtomic(path.join(home, MANIFEST_FILE), next);
    committed = true;
  } catch (error) {
    if (!committed) {
      await rollbackJournal(journal);
      journal.status = 'rolled-back';
      await writeJournal(home, journal).catch(() => undefined);
    }
    throw error;
  }

  // The manifest is now the commit point. Failure to record cleanup must leave a
  // recoverable committed journal, never roll back already-committed targets.
  journal.status = 'committed';
  try {
    await writeJournal(home, journal);
    await finishCommittedJournal(home, journal);
  } catch {
    // The next reconcile detects nextManifestHash and finishes harmless cleanup.
  }
  return result;
}

/** Manifest-first uninstall is only a filtered desired set passed back to the same transaction engine. */
export async function uninstallManagedResources(home: string, options: ManagedUninstallOptions = {}): Promise<ManagedReconcileResult> {
  const manifest = await loadManagedResourceManifest(home);
  const types = new Set<DesiredManagedResource['type']>(options.types ?? ['skills', 'agents', 'instructions']);
  const desired: DesiredManagedResource[] = [];
  for (const resource of Object.values(manifest.resources)) {
    if (!types.has(resource.type)) continue;
    const selected = resource.targets.filter((target) => !options.tool || target.tool === options.tool);
    if (selected.length === 0) continue;
    desired.push({
      id: resource.id,
      type: resource.type,
      targets: [],
      retainTargetPaths: options.tool ? resource.targets.filter((target) => target.tool !== options.tool).map((target) => target.path) : undefined,
    });
  }
  if (desired.length === 0) return { applied: [], removed: [], conflicts: [], planned: [] };
  return reconcileManagedResources(home, desired, {
    pruneTypes: [...types],
    pruneResourceIds: desired.map((resource) => resource.id),
    plan: options.plan,
  });
}
