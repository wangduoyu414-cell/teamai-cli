import crypto from 'node:crypto';
import path from 'node:path';
import fse from 'fs-extra';
import { z } from 'zod';
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
  backupHash?: string;
  /** A section may own a block in a file that existed before TeamAI. */
  sectionFileExisted?: boolean;
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
  previousKind?: ManagedPathKind;
  previousHash?: string;
  phase: JournalPhase;
  rollbackComplete?: boolean;
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
const HASH_PATTERN = /^[0-9a-f]{64}$/;

const ManagedSectionSchema = z.object({ start: z.string().min(1), end: z.string().min(1) }).strict();
const ManagedTargetRecordSchema = z.object({
  path: z.string().min(1),
  kind: z.enum(['file', 'directory']),
  tool: z.string().min(1).optional(),
  section: ManagedSectionSchema.optional(),
  hash: z.string().regex(HASH_PATTERN),
  ownership: z.enum(['created', 'adopted', 'replaced-with-backup']),
  backupPath: z.string().min(1).optional(),
  backupHash: z.string().regex(HASH_PATTERN).optional(),
  sectionFileExisted: z.boolean().optional(),
}).strict().superRefine((target, context) => {
  const hasBackup = target.backupPath !== undefined || target.backupHash !== undefined;
  if (target.ownership === 'replaced-with-backup' && (!target.backupPath || !target.backupHash)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'replaced target requires backupPath and backupHash' });
  } else if (target.ownership !== 'replaced-with-backup' && hasBackup) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'non-replaced target must not carry backup metadata' });
  }
  if (target.section && target.sectionFileExisted === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'section target requires sectionFileExisted' });
  } else if (!target.section && target.sectionFileExisted !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'non-section target must not carry sectionFileExisted' });
  }
});
const ManagedResourceRecordSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['skills', 'agents', 'instructions']),
  targets: z.array(ManagedTargetRecordSchema),
}).strict();
const ManagedResourceManifestSchema = z.object({
  version: z.literal(1),
  resources: z.record(z.string().min(1), ManagedResourceRecordSchema),
}).strict();

const JournalOperationSchema = z.object({
  target: z.string().min(1),
  previous: z.string().min(1),
  rollbackRoot: z.string().min(1),
  stagedRoot: z.string().min(1).optional(),
  hadPrevious: z.boolean(),
  previousKind: z.enum(['file', 'directory']).optional(),
  previousHash: z.string().regex(HASH_PATTERN).optional(),
  phase: z.enum(['prepared', 'previous-moved', 'applied']),
  rollbackComplete: z.boolean().optional(),
}).strict().superRefine((operation, context) => {
  if (operation.hadPrevious && (!operation.previousKind || !operation.previousHash)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'operation with previous content requires kind and hash' });
  } else if (!operation.hadPrevious && (operation.previousKind || operation.previousHash)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'operation without previous content must not carry previous metadata' });
  }
});
const ManagedResourceJournalSchema = z.object({
  version: z.literal(1),
  transactionId: z.string().regex(/^[A-Za-z0-9-]+$/),
  status: z.enum(['staging', 'applying', 'committed', 'completed', 'rolled-back']),
  resourceIds: z.array(z.string().min(1)),
  operations: z.array(JournalOperationSchema),
  stagedRoots: z.array(z.string().min(1)),
  createdBackups: z.array(z.string().min(1)),
  backupCleanup: z.array(z.string().min(1)),
  nextManifestHash: z.string().regex(HASH_PATTERN).optional(),
  updatedAt: z.string().datetime(),
}).strict();

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function assertAbsoluteWithin(root: string, candidate: string, label: string): void {
  if (!path.isAbsolute(candidate) || !isWithin(root, candidate)) {
    throw new Error(`${label} is outside the managed scope: ${candidate}`);
  }
}

function validateManifestSemantics(home: string, manifest: ManagedResourceManifest): void {
  const scopeRoot = path.dirname(path.resolve(home));
  const backupRoot = path.join(path.resolve(home), BACKUPS_DIR);
  const seenTargets = new Set<string>();
  for (const [id, resource] of Object.entries(manifest.resources)) {
    if (resource.id !== id) throw new Error(`Managed resource key/id mismatch: ${id}`);
    for (const target of resource.targets) {
      assertAbsoluteWithin(scopeRoot, target.path, 'Managed target');
      if (seenTargets.has(target.path)) throw new Error(`Managed target is claimed more than once: ${target.path}`);
      seenTargets.add(target.path);
      if (target.backupPath) assertAbsoluteWithin(backupRoot, target.backupPath, 'Managed backup');
    }
  }
}

function validateJournalSemantics(home: string, journal: ManagedResourceJournal): void {
  const scopeRoot = path.dirname(path.resolve(home));
  const backupRoot = path.join(path.resolve(home), BACKUPS_DIR);
  const operationTargets = new Set<string>();
  for (const operation of journal.operations) {
    assertAbsoluteWithin(scopeRoot, operation.target, 'Journal target');
    assertAbsoluteWithin(scopeRoot, operation.rollbackRoot, 'Journal rollback root');
    if (operationTargets.has(operation.target)) throw new Error(`Journal target is duplicated: ${operation.target}`);
    operationTargets.add(operation.target);
    if (!path.basename(operation.rollbackRoot).startsWith(`.teamai-rollback-${journal.transactionId}-`)) {
      throw new Error(`Journal rollback root has an invalid transaction prefix: ${operation.rollbackRoot}`);
    }
    if (operation.previous !== path.join(operation.rollbackRoot, 'previous')) {
      throw new Error(`Journal previous path does not match rollback root: ${operation.previous}`);
    }
    if (operation.stagedRoot) assertAbsoluteWithin(scopeRoot, operation.stagedRoot, 'Journal staged root');
  }
  for (const stagedRoot of journal.stagedRoots) assertAbsoluteWithin(scopeRoot, stagedRoot, 'Journal staged root');
  for (const backup of [...journal.createdBackups, ...journal.backupCleanup]) {
    assertAbsoluteWithin(backupRoot, backup, 'Journal backup');
  }
}

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
  const result = ManagedResourceManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Managed resource manifest has an unsupported shape: ${manifestPath}`);
  }
  const manifest = result.data as ManagedResourceManifest;
  validateManifestSemantics(home, manifest);
  return manifest;
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
    const result = ManagedResourceJournalSchema.safeParse(JSON.parse(content));
    if (!result.success) throw new Error('shape');
    const journal = result.data as ManagedResourceJournal;
    validateJournalSemantics(home, journal);
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
  if (`${before}${after}`.trim() === '') return '';
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

async function snapshotPath(target: string): Promise<{ kind: ManagedPathKind; hash: string } | null> {
  try {
    const stat = await fse.lstat(target);
    const kind: ManagedPathKind = stat.isDirectory() ? 'directory' : 'file';
    const hash = await hashPath(target, kind);
    if (!hash || !HASH_PATTERN.test(hash)) throw new Error(`Could not hash ${target}`);
    return { kind, hash };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function validateManagedBackups(manifest: ManagedResourceManifest): Promise<void> {
  for (const resource of Object.values(manifest.resources)) {
    for (const target of resource.targets) {
      if (target.ownership !== 'replaced-with-backup') continue;
      const backupKind: ManagedPathKind = target.section ? 'file' : target.kind;
      const actual = await hashPath(target.backupPath!, backupKind);
      if (actual !== target.backupHash) throw new Error(`Managed resource backup is missing or corrupt for ${target.path}`);
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

async function createManagedBackup(
  home: string,
  journal: ManagedResourceJournal,
  resourceId: string,
  target: ManagedResourceTarget,
): Promise<{ path: string; hash: string }> {
  const backupPath = path.join(home, BACKUPS_DIR, token(`${resourceId}:${target.path}`));
  if (await fse.pathExists(backupPath)) {
    throw new Error(`Untracked managed resource backup already exists for ${target.path}`);
  }
  const stageRoot = path.join(home, BACKUPS_DIR, `.teamai-backup-stage-${journal.transactionId}-${token(target.path)}`);
  const payload = path.join(stageRoot, 'payload');
  journal.stagedRoots.push(stageRoot);
  journal.createdBackups.push(backupPath);
  await writeJournal(home, journal);
  await fse.ensureDir(stageRoot);
  if (target.section) {
    const original = extractSection(await fse.readFile(target.path, 'utf8'), target.section);
    if (original === null) throw new Error(`Cannot back up missing instruction section at ${target.path}`);
    await fse.writeFile(payload, original, 'utf8');
  } else {
    await fse.copy(target.path, payload, { overwrite: false });
  }
  const backupKind: ManagedPathKind = target.section ? 'file' : target.kind;
  const backupHash = await hashPath(payload, backupKind);
  if (!backupHash || !HASH_PATTERN.test(backupHash)) throw new Error(`Could not hash backup for ${target.path}`);
  await fse.ensureDir(path.dirname(backupPath));
  await fse.rename(payload, backupPath);
  return { path: backupPath, hash: backupHash };
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

async function rollbackJournal(home: string, journal: ManagedResourceJournal): Promise<void> {
  const failures: string[] = [];
  for (const operation of [...journal.operations].reverse()) {
    if (operation.rollbackComplete) continue;
    try {
      const previousExists = await fse.pathExists(operation.previous);
      if (previousExists) {
        if (await fse.pathExists(operation.target)) await fse.remove(operation.target);
        await fse.rename(operation.previous, operation.target);
      } else if (!operation.hadPrevious && await fse.pathExists(operation.target)) {
        // A crash after moving staged content but before recording phase must still
        // restore the original absence.
        await fse.remove(operation.target);
      } else if (operation.hadPrevious) {
        const current = await snapshotPath(operation.target);
        if (!current || current.kind !== operation.previousKind || current.hash !== operation.previousHash) {
          throw new Error(`missing rollback payload for ${operation.target}`);
        }
      }
      operation.rollbackComplete = true;
      await writeJournal(home, journal);
    } catch {
      failures.push(operation.target);
    }
  }
  if (failures.length > 0) {
    // Do not remove any remaining rollback/staging evidence or mark the journal
    // rolled back. A later invocation may regain access and complete recovery.
    throw new Error(`Managed resource rollback incomplete: ${failures.join(', ')}`);
  }
  await Promise.all([
    ...journal.stagedRoots,
    ...journal.operations.map((operation) => operation.rollbackRoot),
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
  await rollbackJournal(home, journal);
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
  const rollbackRoot = path.join(
    path.dirname(target),
    `.teamai-rollback-${journal.transactionId}-${token(`${target}:${journal.operations.length}`)}`,
  );
  if (await fse.pathExists(rollbackRoot)) throw new Error(`Managed rollback path already exists: ${rollbackRoot}`);
  const previous = path.join(rollbackRoot, 'previous');
  const previousSnapshot = await snapshotPath(target);
  const operation: JournalOperation = {
    target,
    previous,
    rollbackRoot,
    stagedRoot,
    hadPrevious: previousSnapshot !== null,
    ...(previousSnapshot ? { previousKind: previousSnapshot.kind, previousHash: previousSnapshot.hash } : {}),
    phase: 'prepared',
  };
  journal.operations.push(operation);
  await writeJournal(home, journal);
  await fse.ensureDir(rollbackRoot);
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
  if (options.plan) {
    const pending = await readJournal(home);
    if (pending && pending.status !== 'completed' && pending.status !== 'rolled-back') {
      throw new Error(`Managed resource transaction ${pending.transactionId} requires recovery before plan`);
    }
  } else {
    await recoverManagedResourceTransaction(home);
  }
  const manifest = await loadManagedResourceManifest(home);
  await validateManagedBackups(manifest);
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
        const targetExisted = await fse.pathExists(target.path);
        const currentHash = await hashPath(target.path, target.kind, target.section);
        let ownership: ManagedOwnership;
        let backupPath: string | undefined;
        let backupHash: string | undefined;
        const sectionFileExisted = target.section
          ? (prior?.section ? prior.sectionFileExisted : targetExisted)
          : undefined;
        if (prior) {
          ownership = prior.ownership;
          backupPath = prior.backupPath;
          backupHash = prior.backupHash;
        } else if (!targetExisted || (target.section && currentHash === null)) {
          ownership = 'created';
        } else if (currentHash === entry.hash) {
          ownership = 'adopted';
        } else {
          ownership = 'replaced-with-backup';
          const backup = await createManagedBackup(home, journal, resource.id, target);
          backupPath = backup.path;
          backupHash = backup.hash;
        }
        if (currentHash !== entry.hash) {
          await recordOperation(home, journal, target.path, entry.payload, entry.root);
          result.applied.push(target.path);
          appliedCount++;
          if (options.failAfterApply !== undefined && appliedCount >= options.failAfterApply) throw new Error('Injected managed-resource failure');
        }
        records.push({
          path: target.path,
          kind: target.kind,
          tool: target.tool,
          section: target.section,
          hash: entry.hash,
          ownership,
          backupPath,
          backupHash,
          sectionFileExisted,
        });
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
          backupPath = oldTarget.backupPath!;
        }
        if (oldTarget.section) {
          let restore: string | undefined;
          if (backupPath) {
            restore = await fse.readFile(backupPath, 'utf8');
            journal.backupCleanup.push(backupPath);
          }
          const stagedRemoval = await stageSectionRemoval(oldTarget, transactionId, appliedCount, restore);
          const empty = (await fse.readFile(stagedRemoval.payload, 'utf8')).trim() === '';
          payload = empty && oldTarget.sectionFileExisted === false ? null : stagedRemoval.payload;
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
      await rollbackJournal(home, journal);
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
