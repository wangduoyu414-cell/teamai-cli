import crypto from 'node:crypto';
import path from 'node:path';
import fse from 'fs-extra';
import { z } from 'zod';
import { openclawWorkspaceCandidates } from './openclaw-hooks.js';
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
  /** Canonical product-owned root for a narrow external host target. */
  hostRoot?: string;
  content?: string;
  sourcePath?: string;
  /** Optional destination-local normalization, run against the staged payload. */
  prepareStaged?: (payloadPath: string) => Promise<void>;
  /** A project instruction owns this block only, never the surrounding file. */
  section?: ManagedSection;
  /** Explicit local-only Skill paths: never supplied by the remote source. */
  preservePaths?: string[];
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
  hostRoot?: string;
  section?: ManagedSection;
  /** Explicit local-only Skill paths: never supplied by the remote source. */
  preservePaths?: string[];
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
  hostRoot?: string;
  tool?: string;
  resourceType?: DesiredManagedResource['type'];
  hadPrevious: boolean;
  previousKind?: ManagedPathKind;
  previousHash?: string;
  phase: JournalPhase;
  rollbackComplete?: boolean;
}
interface JournalStagedTarget {
  root: string;
  target: string;
  hostRoot?: string;
  tool?: string;
  resourceType?: DesiredManagedResource['type'];
}
interface ManagedResourceJournal {
  version: 1;
  transactionId: string;
  status: JournalStatus;
  resourceIds: string[];
  operations: JournalOperation[];
  stagedRoots: string[];
  /** Provenance for target-adjacent stages before an apply operation exists. */
  stagedTargets?: JournalStagedTarget[];
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
const BACKUP_NAME_PATTERN = /^[0-9a-f]{20}$/;

const ManagedSectionSchema = z.object({ start: z.string().min(1), end: z.string().min(1) }).strict();
/**
 * The v1 ledger originally omitted a few recovery facts. Keep the structural
 * shape strict, then derive only facts that existing on-disk evidence proves.
 */
const ManagedTargetRecordShapeSchema = z.object({
  path: z.string().min(1),
  kind: z.enum(['file', 'directory']),
  tool: z.string().min(1).optional(),
  hostRoot: z.string().min(1).optional(),
  section: ManagedSectionSchema.optional(),
  preservePaths: z.array(z.enum([".runtime", "assets/douyin-cookie-bridge/bridge-secret.local.json"])).optional(),
  hash: z.string().regex(HASH_PATTERN),
  ownership: z.enum(['created', 'adopted', 'replaced-with-backup']),
  backupPath: z.string().min(1).optional(),
  backupHash: z.string().regex(HASH_PATTERN).optional(),
  sectionFileExisted: z.boolean().optional(),
}).strict();
const ManagedTargetRecordSchema = ManagedTargetRecordShapeSchema.superRefine((target, context) => {
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
const LegacyManagedResourceManifestSchema = z.object({
  version: z.literal(1),
  resources: z.record(z.string().min(1), z.object({
    id: z.string().min(1),
    type: z.enum(['skills', 'agents', 'instructions']),
    targets: z.array(ManagedTargetRecordShapeSchema),
  }).strict()),
}).strict();

const JournalOperationShapeSchema = z.object({
  target: z.string().min(1),
  previous: z.string().min(1),
  rollbackRoot: z.string().min(1),
  stagedRoot: z.string().min(1).optional(),
  hostRoot: z.string().min(1).optional(),
  tool: z.string().min(1).optional(),
  resourceType: z.enum(['skills', 'agents', 'instructions']).optional(),
  hadPrevious: z.boolean(),
  previousKind: z.enum(['file', 'directory']).optional(),
  previousHash: z.string().regex(HASH_PATTERN).optional(),
  phase: z.enum(['prepared', 'previous-moved', 'applied']),
  rollbackComplete: z.boolean().optional(),
}).strict();
const JournalOperationSchema = JournalOperationShapeSchema.superRefine((operation, context) => {
  if (operation.hadPrevious && (!operation.previousKind || !operation.previousHash)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'operation with previous content requires kind and hash' });
  } else if (!operation.hadPrevious && (operation.previousKind || operation.previousHash)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'operation without previous content must not carry previous metadata' });
  }
});
const JournalStagedTargetSchema = z.object({
  root: z.string().min(1),
  target: z.string().min(1),
  hostRoot: z.string().min(1).optional(),
  tool: z.string().min(1).optional(),
  resourceType: z.enum(['skills', 'agents', 'instructions']).optional(),
}).strict();
const ManagedResourceJournalSchema = z.object({
  version: z.literal(1),
  transactionId: z.string().regex(/^[A-Za-z0-9-]+$/),
  status: z.enum(['staging', 'applying', 'committed', 'completed', 'rolled-back']),
  resourceIds: z.array(z.string().min(1)),
  operations: z.array(JournalOperationSchema),
  stagedRoots: z.array(z.string().min(1)),
  stagedTargets: z.array(JournalStagedTargetSchema).optional(),
  createdBackups: z.array(z.string().min(1)),
  backupCleanup: z.array(z.string().min(1)),
  nextManifestHash: z.string().regex(HASH_PATTERN).optional(),
  updatedAt: z.string().datetime(),
}).strict();
const LegacyManagedResourceJournalSchema = z.object({
  version: z.literal(1),
  transactionId: z.string().regex(/^[A-Za-z0-9-]+$/),
  status: z.enum(['staging', 'applying', 'committed', 'completed', 'rolled-back']),
  resourceIds: z.array(z.string().min(1)),
  operations: z.array(JournalOperationShapeSchema),
  stagedRoots: z.array(z.string().min(1)),
  stagedTargets: z.array(JournalStagedTargetSchema).optional(),
  createdBackups: z.array(z.string().min(1)),
  backupCleanup: z.array(z.string().min(1)),
  nextManifestHash: z.string().regex(HASH_PATTERN).optional(),
  updatedAt: z.string().datetime(),
}).strict();

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

async function nearestExistingRealPath(candidate: string): Promise<string> {
  let current = path.resolve(candidate);
  while (true) {
    try {
      return await fse.realpath(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function assertAbsoluteWithin(roots: string[], candidate: string, label: string): Promise<void> {
  if (path.isAbsolute(candidate)) {
    for (const root of roots) {
      if (!isWithin(root, candidate)) continue;
      const [realRoot, realCandidate] = await Promise.all([
        nearestExistingRealPath(root),
        nearestExistingRealPath(candidate),
      ]);
      if (isWithin(realRoot, realCandidate)) return;
    }
  }
  throw new Error(`${label} is outside the managed scope: ${candidate}`);
}

async function managedTargetRoots(home: string, candidates: string[], hostRoots: string[] = []): Promise<string[]> {
  const scopeRoot = path.dirname(path.resolve(home));
  const roots = [scopeRoot];
  if (candidates.some((candidate) => !path.isAbsolute(candidate) || !isWithin(scopeRoot, candidate))) {
    roots.push(...(await openclawWorkspaceCandidates())
      .filter((candidate) => path.isAbsolute(candidate))
      .map((candidate) => path.join(candidate, 'skills')));
  }
  roots.push(...hostRoots.filter((root) => path.isAbsolute(root)).map((root) => path.resolve(root)));
  return roots;
}

async function isOpenclawSkillTarget(candidate: string): Promise<boolean> {
  if (!path.isAbsolute(candidate)) return false;
  const roots = (await openclawWorkspaceCandidates())
    .filter((workspace) => path.isAbsolute(workspace))
    .map((workspace) => path.join(workspace, 'skills'));
  return roots.some((root) => isWithin(root, candidate));
}

function isNarrowHostTarget(
  type: DesiredManagedResource['type'], tool: string | undefined, target: string, hostRoot: string | undefined,
): boolean {
  if (!hostRoot || !path.isAbsolute(hostRoot)) return false;
  const root = path.resolve(hostRoot);
  const targetPath = path.resolve(target);
  if (tool === 'workbuddy') return type === 'skills' && isWithin(path.join(root, 'skills'), targetPath);
  if (tool === 'dsh') {
    return (type === 'skills' && isWithin(path.join(root, 'skills'), targetPath))
      || (type === 'instructions' && targetPath === path.join(root, 'AGENTS.md'));
  }
  return false;
}

async function validateManifestSemantics(home: string, manifest: ManagedResourceManifest): Promise<void> {
  const scopeRoot = path.dirname(path.resolve(home));
  const backupRoot = path.join(path.resolve(home), BACKUPS_DIR);
  const targets = Object.values(manifest.resources).flatMap((resource) => resource.targets);
  const targetRoots = await managedTargetRoots(home, targets.map((target) => target.path), targets.flatMap((target) => target.hostRoot ? [target.hostRoot] : []));
  const seenTargets = new Set<string>();
  for (const [id, resource] of Object.entries(manifest.resources)) {
    if (resource.id !== id) throw new Error(`Managed resource key/id mismatch: ${id}`);
    for (const target of resource.targets) {
      if (target.preservePaths && (resource.type !== 'skills' || target.kind !== 'directory')) throw new Error('Local-only paths require a Skill directory');
      const external = !path.isAbsolute(target.path) || !isWithin(scopeRoot, target.path);
      if (external && !(resource.type === 'skills' && target.tool === 'openclaw')
        && !isNarrowHostTarget(resource.type, target.tool, target.path, target.hostRoot)) {
        throw new Error(`Only OpenClaw skills may use an external managed target: ${target.path}`);
      }
      await assertAbsoluteWithin(targetRoots, target.path, 'Managed target');
      if (seenTargets.has(target.path)) throw new Error(`Managed target is claimed more than once: ${target.path}`);
      seenTargets.add(target.path);
      if (target.backupPath) await assertAbsoluteWithin([backupRoot], target.backupPath, 'Managed backup');
    }
  }
}

async function validateJournalSemantics(home: string, journal: ManagedResourceJournal): Promise<void> {
  const scopeRoot = path.dirname(path.resolve(home));
  const backupRoot = path.join(path.resolve(home), BACKUPS_DIR);
  const managedPaths = [
    ...journal.operations.flatMap((operation) => [operation.target, operation.rollbackRoot, ...(operation.stagedRoot ? [operation.stagedRoot] : [])]),
    ...(journal.stagedTargets ?? []).flatMap((staged) => [staged.target, staged.root]),
    ...journal.stagedRoots,
  ];
  const targetRoots = await managedTargetRoots(home, managedPaths, [
    ...journal.operations.flatMap((operation) => operation.hostRoot ? [operation.hostRoot] : []),
    ...(journal.stagedTargets ?? []).flatMap((staged) => staged.hostRoot ? [staged.hostRoot] : []),
  ]);
  const operationTargets = new Set<string>();
  const operationStageRoots = new Set<string>();
  for (const operation of journal.operations) {
    const external = !path.isAbsolute(operation.target) || !isWithin(scopeRoot, operation.target);
    if (external && !(operation.resourceType === 'skills' && operation.tool === 'openclaw')
      && !isNarrowHostTarget(operation.resourceType ?? 'skills', operation.tool, operation.target, operation.hostRoot)) {
      throw new Error(`Unsupported external journal target: ${operation.target}`);
    }
    await assertAbsoluteWithin(targetRoots, operation.target, 'Journal target');
    await assertAbsoluteWithin(targetRoots, operation.rollbackRoot, 'Journal rollback root');
    if (operationTargets.has(operation.target)) throw new Error(`Journal target is duplicated: ${operation.target}`);
    operationTargets.add(operation.target);
    if (path.dirname(path.resolve(operation.rollbackRoot)) !== path.dirname(path.resolve(operation.target))) {
      throw new Error(`Journal rollback root is not beside its target: ${operation.rollbackRoot}`);
    }
    if (!path.basename(operation.rollbackRoot).startsWith(`.teamai-rollback-${journal.transactionId}-`)) {
      throw new Error(`Journal rollback root has an invalid transaction prefix: ${operation.rollbackRoot}`);
    }
    if (operation.previous !== path.join(operation.rollbackRoot, 'previous')) {
      throw new Error(`Journal previous path does not match rollback root: ${operation.previous}`);
    }
    if (operation.stagedRoot) {
      await assertAbsoluteWithin(targetRoots, operation.stagedRoot, 'Journal staged root');
      if (path.dirname(path.resolve(operation.stagedRoot)) !== path.dirname(path.resolve(operation.target))
        || !path.basename(operation.stagedRoot).startsWith(`.teamai-stage-${journal.transactionId}-`)) {
        throw new Error(`Journal staged root is not a transaction stage beside its target: ${operation.stagedRoot}`);
      }
      operationStageRoots.add(path.resolve(operation.stagedRoot));
    }
  }
  const stagedTargetRoots = new Set<string>();
  for (const staged of journal.stagedTargets ?? []) {
    const external = !path.isAbsolute(staged.target) || !isWithin(scopeRoot, staged.target);
    if (external && !(staged.resourceType === 'skills' && staged.tool === 'openclaw')
      && !isNarrowHostTarget(staged.resourceType ?? 'skills', staged.tool, staged.target, staged.hostRoot)) {
      throw new Error(`Unsupported external staged target: ${staged.target}`);
    }
    await assertAbsoluteWithin(targetRoots, staged.target, 'Journal staged target');
    await assertAbsoluteWithin(targetRoots, staged.root, 'Journal staged root');
    const resolvedRoot = path.resolve(staged.root);
    if (path.dirname(resolvedRoot) !== path.dirname(path.resolve(staged.target))
      || !path.basename(resolvedRoot).startsWith(`.teamai-stage-${journal.transactionId}-`)) {
      throw new Error(`Journal staged target root is not beside its target: ${staged.root}`);
    }
    if (stagedTargetRoots.has(resolvedRoot)) throw new Error(`Journal staged target root is duplicated: ${staged.root}`);
    stagedTargetRoots.add(resolvedRoot);
  }
  for (const stagedRoot of journal.stagedRoots) {
    await assertAbsoluteWithin(targetRoots, stagedRoot, 'Journal staged root');
    const resolved = path.resolve(stagedRoot);
    const backupStage = path.dirname(resolved) === backupRoot
      && path.basename(resolved).startsWith(`.teamai-backup-stage-${journal.transactionId}-`);
    const ordinaryStage = path.basename(resolved).startsWith(`.teamai-stage-${journal.transactionId}-`)
      && (operationStageRoots.has(resolved) || stagedTargetRoots.has(resolved)
        || isWithin(scopeRoot, resolved) || await isOpenclawSkillTarget(resolved));
    if (!backupStage && !ordinaryStage) {
      throw new Error(`Journal staged root is not a managed transaction stage: ${stagedRoot}`);
    }
  }
  for (const backup of [...journal.createdBackups, ...journal.backupCleanup]) {
    await assertAbsoluteWithin([backupRoot], backup, 'Journal backup');
    const resolved = path.resolve(backup);
    if (path.dirname(resolved) !== backupRoot || !BACKUP_NAME_PATTERN.test(path.basename(resolved))) {
      throw new Error(`Journal backup path is not a managed backup: ${backup}`);
    }
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
  if (result.success) {
    const manifest = result.data as ManagedResourceManifest;
    await validateManifestSemantics(home, manifest);
    return manifest;
  }
  try {
    return await upgradeLegacyManifest(home, parsed);
  } catch {
    throw new Error(`Managed resource manifest has an unsupported shape: ${manifestPath}`);
  }
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
    const parsed = JSON.parse(content);
    return await upgradeLegacyJournal(home, parsed);
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

async function hashPath(target: string, kind: ManagedPathKind, section?: ManagedSection, preservePaths: string[] = []): Promise<string | null> {
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
    await hashDirectory(target, '', hash, preservePaths);
    return hash.digest('hex');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Recover only the two omissions emitted by the first v1 ledger writer. This
 * stays in memory until the caller's ordinary atomic manifest write; plans
 * therefore remain read-only.
 */
async function upgradeLegacyManifest(home: string, parsed: unknown): Promise<ManagedResourceManifest> {
  const legacy = LegacyManagedResourceManifestSchema.safeParse(parsed);
  if (!legacy.success) throw new Error('shape');
  await validateManifestSemantics(home, legacy.data as unknown as ManagedResourceManifest);
  const upgraded = JSON.parse(JSON.stringify(legacy.data)) as ManagedResourceManifest;
  for (const resource of Object.values(upgraded.resources)) {
    for (const target of resource.targets) {
      if (target.ownership === 'replaced-with-backup' && target.backupHash === undefined) {
        if (!target.backupPath) throw new Error(`missing backup path for ${target.path}`);
        const backupKind: ManagedPathKind = target.section ? 'file' : target.kind;
        const actual = await hashPath(target.backupPath, backupKind);
        if (!actual || !HASH_PATTERN.test(actual)) throw new Error(`unrecoverable backup for ${target.path}`);
        target.backupHash = actual;
      }
      if (target.section && target.sectionFileExisted === undefined) {
        // Legacy section replacement rejected pre-existing files without the
        // TeamAI block, so a created record proves there was no prior file.
        target.sectionFileExisted = target.ownership !== 'created';
      }
    }
  }
  const current = ManagedResourceManifestSchema.safeParse(upgraded);
  if (!current.success) throw new Error('shape');
  const manifest = current.data as ManagedResourceManifest;
  await validateManifestSemantics(home, manifest);
  return manifest;
}

/** Same narrow evidence-based upgrade for interruption rollback records. */
async function upgradeLegacyJournal(home: string, parsed: unknown): Promise<ManagedResourceJournal> {
  const legacy = LegacyManagedResourceJournalSchema.safeParse(parsed);
  if (!legacy.success) throw new Error('shape');
  const upgraded = JSON.parse(JSON.stringify(legacy.data)) as ManagedResourceJournal;
  const scopeRoot = path.dirname(path.resolve(home));
  for (const record of [...upgraded.operations, ...(upgraded.stagedTargets ?? [])]) {
    const external = !path.isAbsolute(record.target) || !isWithin(scopeRoot, record.target);
    if (external && (!record.tool || !record.resourceType || record.tool === 'openclaw')) {
      if (!await isOpenclawSkillTarget(record.target)) {
        throw new Error(`unproven external legacy journal target ${record.target}`);
      }
      record.tool = 'openclaw';
      record.resourceType = 'skills';
      delete record.hostRoot;
    }
  }
  for (const operation of upgraded.operations) {
    if (!operation.hadPrevious || (operation.previousKind && operation.previousHash)) continue;
    const previous = await snapshotPath(operation.previous);
    if (!previous) throw new Error(`unrecoverable rollback payload for ${operation.target}`);
    if ((operation.previousKind && operation.previousKind !== previous.kind)
      || (operation.previousHash && operation.previousHash !== previous.hash)) {
      throw new Error(`rollback metadata disagrees with payload for ${operation.target}`);
    }
    operation.previousKind = previous.kind;
    operation.previousHash = previous.hash;
  }
  const current = ManagedResourceJournalSchema.safeParse(upgraded);
  if (!current.success) throw new Error('shape');
  const journal = current.data as ManagedResourceJournal;
  await validateJournalSemantics(home, journal);
  return journal;
}

export async function managedManifestUnchangedTargetPaths(
  home: string,
  type: DesiredManagedResource['type'],
): Promise<Set<string>> {
  const manifest = await loadManagedResourceManifest(home);
  const unchanged = new Set<string>();
  for (const resource of Object.values(manifest.resources)) {
    if (resource.type !== type) continue;
    for (const target of resource.targets) {
      if (await hashPath(target.path, target.kind, target.section, target.preservePaths) === target.hash) {
        unchanged.add(path.resolve(target.path));
      }
    }
  }
  return unchanged;
}

async function hashDirectory(root: string, relative: string, hash: crypto.Hash, preservePaths: string[] = []): Promise<void> {
  const entries = await fse.readdir(path.join(root, relative), { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const rel = relative ? path.join(relative, entry.name) : entry.name;
    // Python bytecode is disposable runtime output, not a source edit.
    if (preservePaths.length && entry.name === "__pycache__" && entry.isDirectory()) continue;
    if (preservePaths.includes(rel.split(path.sep).join("/"))) continue;
    const fullPath = path.join(root, rel);
    if (entry.isDirectory()) {
      hash.update(`d:${rel}\0`);
      await hashDirectory(root, rel, hash, preservePaths);
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
    for (const local of target.preservePaths ?? []) {
      const localPath = path.join(payload, local);
      const present = await fse.lstat(localPath).then(() => true, (e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return false; throw e; });
      if (present) throw new Error(`Remote source contains local-only path: ${local}`);
      await assertAbsoluteWithin([payload], localPath, 'Local-only staged path');
    }
    if (target.prepareStaged) await target.prepareStaged(payload);
    const hash = target.section ? digest(target.content!) : await hashPath(payload, target.kind, undefined, target.preservePaths);
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

function addStagedTargetEvidence(
  journal: ManagedResourceJournal,
  root: string,
  target: Pick<ManagedTargetRecord, 'path' | 'hostRoot' | 'tool'>,
  resourceType: DesiredManagedResource['type'],
): void {
  journal.stagedRoots.push(root);
  (journal.stagedTargets ??= []).push({
    root,
    target: target.path,
    hostRoot: target.hostRoot,
    tool: target.tool,
    resourceType,
  });
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
        const previous = await snapshotPath(operation.previous);
        if (!operation.hadPrevious || !previous
          || previous.kind !== operation.previousKind || previous.hash !== operation.previousHash) {
          throw new Error(`rollback payload is corrupt for ${operation.target}`);
        }
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
  hostRoot?: string,
  tool?: string,
  resourceType?: DesiredManagedResource['type'],
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
    hostRoot,
    tool,
    resourceType,
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
  for (const resource of desiredResources) for (const target of resource.targets) {
    if (target.preservePaths && (resource.type !== 'skills' || target.kind !== 'directory'
      || target.preservePaths.some(p => !['.runtime', 'assets/douyin-cookie-bridge/bridge-secret.local.json'].includes(p)))) {
      throw new Error('Invalid local-only Skill paths');
    }
  }
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
  const scopeRoot = path.dirname(path.resolve(home));
  const desiredTargetPaths = desiredResources.flatMap((resource) => resource.targets.map((target) => target.path));
  const targetRoots = await managedTargetRoots(home, desiredTargetPaths, desiredResources.flatMap((resource) => resource.targets.flatMap((target) => target.hostRoot ? [target.hostRoot] : [])));
  for (const resource of desiredResources) {
    if (desiredIds.has(resource.id)) throw new Error(`Managed resource id is duplicated: ${resource.id}`);
    desiredIds.add(resource.id);
    for (const target of resource.targets) {
      const external = !path.isAbsolute(target.path) || !isWithin(scopeRoot, target.path);
      if (external && !(resource.type === 'skills' && target.tool === 'openclaw')
        && !isNarrowHostTarget(resource.type, target.tool, target.path, target.hostRoot)) {
        throw new Error(`Only OpenClaw skills may use an external managed target: ${target.path}`);
      }
      await assertAbsoluteWithin(targetRoots, target.path, 'Managed target');
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
      const currentHash = await hashPath(target.path, prior.kind, prior.section, prior.preservePaths);
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
    operations: [], stagedRoots: [], stagedTargets: [], createdBackups: [], backupCleanup: [], updatedAt: new Date().toISOString(),
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
        addStagedTargetEvidence(journal, entry.root, target, resource.type);
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
        const currentHash = await hashPath(target.path, target.kind, target.section, target.preservePaths);
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
          // Copy local data only when source changes. Unchanged pulls neither
          // traverse nor copy the virtual environment. The existing transaction
          // captures the complete old directory for rollback.
          for (const local of target.preservePaths ?? []) {
            const from = path.join(target.path, local);
            if (await fse.pathExists(from)) {
              const resolved = await fse.realpath(from);
              const base = await fse.realpath(target.path);
              if (!isWithin(base, resolved) || (await fse.lstat(from)).isSymbolicLink()) throw new Error(`Local-only path escapes Skill: ${local}`);
              await fse.copy(from, path.join(entry.payload, local), { dereference: false });
            }
          }
          await recordOperation(home, journal, target.path, entry.payload, entry.root, target.hostRoot, target.tool, resource.type);
          result.applied.push(target.path);
          appliedCount++;
          if (options.failAfterApply !== undefined && appliedCount >= options.failAfterApply) throw new Error('Injected managed-resource failure');
        }
        records.push({
          path: target.path,
          kind: target.kind,
          tool: target.tool,
          hostRoot: target.hostRoot,
          section: target.section,
          preservePaths: target.preservePaths,
          hash: entry.hash,
          ownership,
          backupPath,
          backupHash,
          sectionFileExisted,
        });
      }
      // Empty desired targets normally prune this resource. Retained targets are
      // an explicit allowlist-lifecycle hold and must keep their ledger/backups.
      if (records.length > 0) {
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
        if ((await Promise.all((oldTarget.preservePaths ?? []).map(local => fse.pathExists(path.join(oldTarget.path, local))))).some(Boolean)) {
          result.conflicts.push(`${id}: local runtime/data retained at ${oldTarget.path}; move it outside the Skill before uninstall or rename`);
          continue;
        }
        const currentHash = await hashPath(oldTarget.path, oldTarget.kind, oldTarget.section, oldTarget.preservePaths);
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
          addStagedTargetEvidence(journal, stagedRoot, oldTarget, oldResource.type);
          await writeJournal(home, journal);
        } else if (backupPath) {
          const root = await fse.mkdtemp(path.join(path.dirname(oldTarget.path), `.teamai-stage-${transactionId}-restore-`));
          payload = path.join(root, 'payload');
          await fse.copy(backupPath, payload);
          stagedRoot = root;
          addStagedTargetEvidence(journal, root, oldTarget, oldResource.type);
          journal.backupCleanup.push(backupPath);
          await writeJournal(home, journal);
        }
        await recordOperation(home, journal, oldTarget.path, payload, stagedRoot, oldTarget.hostRoot, oldTarget.tool, oldResource.type);
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
