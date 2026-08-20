import path from 'node:path';
import fse from 'fs-extra';
import matter from 'gray-matter';
import { requireInit, loadState, saveState, detectProjectConfig, loadLocalConfigForScope, loadTeamConfig, loadStateForScope, saveStateForScope } from './config.js';
import { pullRepo, getHeadRev } from './utils/git.js';
import { log, spinner } from './utils/logger.js';
import { pathExists, remove, listFiles, listDirs, readFileSafe } from './utils/fs.js';
import { injectClaudeMdSection } from './utils/claudemd.js';
import { getHandler, RulesHandler, DocsHandler, EnvHandler } from './resources/index.js';
import { ResourceHandler } from './resources/base.js';
import { loadTagsConfig, filterByTags } from './utils/tags.js';
import { BUILTIN_SKILL_NAMES } from './builtin-skills.js';
import type { GlobalOptions, ResourceType, ResourceItem, TeamaiConfig, LocalConfig, TagsConfig } from './types.js';
import {
  LEARNINGS_LOCAL_DIR,
  TEAMAI_CULTURE_START,
  TEAMAI_CULTURE_END,
  TEAMAI_CLAUDEMD_START,
  TEAMAI_CLAUDEMD_END,
  TEAMAI_RECALL_RULES_START,
  TEAMAI_RECALL_RULES_END,
  CultureFrontmatterSchema,
  resolveBaseDir,
  getTeamaiHome,
  isRecallEnabled,
  isBuiltinEnabled,
  isAgentDisabled,
} from './types.js';
import type { CultureFrontmatter } from './types.js';
import { loadRolesManifest, resolveRoleResourceNamespaces, type ResourceNamespaces } from './roles.js';
import { managedManifestTargetPaths, reconcileManagedResources, type DesiredManagedResource } from './managed-resources.js';

interface RolePullContext {
  activeNamespaces: ResourceNamespaces;
  activeSkillNames: Set<string>;
  inactiveSkillNames: Set<string>;
}

/**
 * Refresh the local team-repo tree, abstracting the two backends.
 *
 * - git:  `git pull` into localPath; version = current HEAD rev.
 * - http: nothing to clone — skills/rules/CLAUDE.md are delivered per-session via
 *         report/sync/ack (the local-agent bypass), not a repo snapshot. The
 *         `reportingOnly` flag tells the deploy step to skip git-tree sync.
 *
 * Returns a display label and the opaque version string used as the
 * incremental-sync cache key (state.lastPullRev). `version` is null only when
 * the git backend can't resolve a rev.
 */
async function refreshTeamRepo(
  localConfig: LocalConfig,
): Promise<{ label: string; version: string | null; reportingOnly: boolean }> {
  if (localConfig.repo.kind === 'http') {
    const { resolveApiKey } = await import('./api-key.js');
    const apiKey = resolveApiKey();
    if (!apiKey) {
      throw new Error('No API key configured. Re-run `teamai init --http <url> --token <key>` or set TEAMAI_API_TOKEN.');
    }
    // HTTP backends deliver resources through report/sync (own hook handler),
    // so there is no repo tree to pull here.
    return { label: 'HTTP (report/sync delivery)', version: null, reportingOnly: true };
  }

  if (localConfig.repo.kind === 'self') {
    // Single-repo mode: knowledge lives under <business-repo>/.teamai on main and
    // arrives with the business repo's own `git clone`/`git pull`. teamai must NOT
    // run `git pull` on localPath here — that would operate on the business repo
    // root and touch the user's active working tree. Just read the current HEAD as
    // the cache version and let the deploy step inject from the on-disk .teamai/.
    //
    // Self-heal an older .teamai/.gitignore that still ignores `env` (pre-beta.5),
    // which would keep team env vars off main. Best-effort; prompts the user to
    // commit the change.
    try {
      const { migrateSelfModeGitignore } = await import('./init.js');
      await migrateSelfModeGitignore(localConfig);
    } catch { /* best-effort */ }

    let version: string | null = null;
    try {
      version = await getHeadRev(localConfig.repo.localPath);
    } catch {
      version = null;
    }
    return { label: 'single-repo (knowledge on main)', version, reportingOnly: false };
  }

  const result = await pullRepo(localConfig.repo.localPath);
  let version: string | null = null;
  try {
    version = await getHeadRev(localConfig.repo.localPath);
  } catch {
    // Can't resolve a rev → skip the incremental fast-path and do a full sync.
    log.debug('Rev check failed, proceeding with full sync');
    version = null;
  }
  return { label: result, version, reportingOnly: false };
}

async function buildRolePullContext(localConfig: LocalConfig): Promise<RolePullContext | null> {
  if (!localConfig.primaryRole) return null;

  let manifest;
  try {
    manifest = await loadRolesManifest(localConfig.repo.localPath);
  } catch {
    log.warn('Could not load roles manifest. Skipping role-based filtering.');
    return null;
  }

  let activeNamespaces;
  try {
    activeNamespaces = resolveRoleResourceNamespaces({
      manifest,
      primaryRole: localConfig.primaryRole,
      additionalRoles: localConfig.additionalRoles ?? [],
    });
  } catch (e) {
    log.warn(`Role "${localConfig.primaryRole}" not found in manifest. Falling back to unfiltered sync.`);
    log.warn('Run `teamai roles set <role>` to pick a valid role.');
    return null;
  }

  const allSkillNamespaces = new Set(
    manifest.roles.flatMap((role) => role.resources.skills),
  );
  const inactiveSkillNamespaces = [...allSkillNamespaces].filter((namespace) => !activeNamespaces.skills.includes(namespace));
  const activeSkillNames = new Set<string>();
  const inactiveSkillNames = new Set<string>();

  for (const namespace of activeNamespaces.skills) {
    const namespaceDir = path.join(localConfig.repo.localPath, 'skills', namespace);
    const names = await listDirs(namespaceDir);
    for (const name of names) {
      activeSkillNames.add(name);
    }
  }

  for (const namespace of inactiveSkillNamespaces) {
    const namespaceDir = path.join(localConfig.repo.localPath, 'skills', namespace);
    const names = await listDirs(namespaceDir);
    for (const name of names) {
      inactiveSkillNames.add(name);
    }
  }

  return { activeNamespaces, activeSkillNames, inactiveSkillNames };
}

/**
 * Filter rules by the user's active knowledge namespaces.
 *
 * Rules whose name starts with a namespace path (e.g. "common/coding-style")
 * are filtered: only those in activeKnowledgeNamespaces pass through.
 * Root-level rules (no "/" in name) are always included.
 *
 * When knowledgeNamespaces is null (no role configured), all rules pass through.
 */
export function filterRulesByKnowledgeNamespaces(
  rules: ResourceItem[],
  knowledgeNamespaces: string[] | null,
): ResourceItem[] {
  if (!knowledgeNamespaces) return rules;

  return rules.filter((rule) => {
    const slashIndex = rule.name.indexOf('/');
    if (slashIndex === -1) return true; // root-level rule, always include
    const namespace = rule.name.slice(0, slashIndex);
    return knowledgeNamespaces.includes(namespace);
  });
}

export async function scanRoleAwareSkills(localConfig: LocalConfig, namespaces: ResourceNamespaces): Promise<ResourceItem[]> {
  const items = new Map<string, ResourceItem>();

  for (const namespace of namespaces.skills) {
    const namespaceDir = path.join(localConfig.repo.localPath, 'skills', namespace);
    const dirs = await listDirs(namespaceDir);
    for (const dir of dirs) {
      const existing = items.get(dir);
      if (existing) {
        throw new Error(`Duplicate skill "${dir}" found in active namespaces "${existing.namespace}" and "${namespace}"`);
      }

      items.set(dir, {
        name: dir,
        type: 'skills',
        sourcePath: path.join(namespaceDir, dir),
        relativePath: `skills/${namespace}/${dir}`,
        namespace,
      });
    }
  }

  return [...items.values()];
}

export async function cleanupInactiveNamespaceSkills(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  activeSkillNames: Set<string>,
  inactiveSkillNames: Set<string>,
): Promise<void> {
  const baseDir = resolveBaseDir(localConfig);

  for (const [tool, toolPath] of Object.entries(teamConfig.toolPaths)) {
    if (isAgentDisabled(localConfig, tool)) continue;
    if (!toolPath.skills) continue;
    if (!await ResourceHandler.isToolInstalled(toolPath.skills, baseDir, toolPath.probe)) continue;
    if (!await pathExists(path.join(baseDir, toolPath.skills))) continue;

    const localSkillNames = await listDirs(path.join(baseDir, toolPath.skills));
    for (const skillName of localSkillNames) {
      if (BUILTIN_SKILL_NAMES.has(skillName)) continue;
      if (activeSkillNames.has(skillName)) continue;
      if (!inactiveSkillNames.has(skillName)) continue;

      const localSkillDir = path.join(baseDir, toolPath.skills, skillName);
      await remove(localSkillDir);
      log.debug(`[${localConfig.scope}] Removed inactive role-scoped skill ${skillName} from ${tool}`);
    }
  }
}

/**
 * Collect names of resources that already exist locally (before pull).
 * Used to distinguish "new" vs "updated" items in pull output.
 */
async function getExistingLocalNames(
  type: ResourceType,
  items: ResourceItem[],
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
): Promise<Set<string>> {
  const existing = new Set<string>();
  const baseDir = resolveBaseDir(localConfig);

  if (type === 'skills') {
    // Check the first installed tool's skills directory
    for (const [_tool, toolPath] of Object.entries(teamConfig.toolPaths)) {
      if (!toolPath.skills) continue;
      const skillsDir = path.join(baseDir, toolPath.skills);
      if (!await pathExists(skillsDir)) continue;
      for (const item of items) {
        const skillDir = path.join(skillsDir, item.name);
        if (await pathExists(skillDir)) {
          existing.add(item.name);
        }
      }
      // Only need to check the first available target
      break;
    }
  }

  return existing;
}

/**
 * Format pull detail output showing new vs updated items.
 */
function logSyncDetail(
  type: ResourceType,
  items: ResourceItem[],
  existingNames: Set<string>,
  verbose: boolean,
  scopeLabel?: string,
  skippedCount?: number,
): void {
  const prefix = scopeLabel ? `[${scopeLabel}] ` : '';
  const added = items.filter(i => !existingNames.has(i.name));
  const updated = items.filter(i => existingNames.has(i.name));

  const skipSuffix = skippedCount && skippedCount > 0
    ? `, skipped ${skippedCount} by tags`
    : '';

  if (added.length === 0 && updated.length > 0) {
    log.success(`${prefix}Synced ${items.length} ${type} (all updated${skipSuffix})`);
  } else if (added.length > 0) {
    log.success(`${prefix}Synced ${items.length} ${type} (${added.length} new, ${updated.length} updated${skipSuffix})`);
    const addedNames = added.map(i => i.name);
    log.dim(`    new: ${addedNames.join(', ')}`);
  } else {
    log.success(`${prefix}Synced ${items.length} ${type}${skipSuffix ? ` (${skipSuffix.trim().replace(/^, /, '')})` : ''}`);
  }

  if (verbose && updated.length > 0) {
    const updatedNames = updated.map(i => i.name);
    log.dim(`    updated: ${updatedNames.join(', ')}`);
  }
}

/**
 * Pull resources for a single scope. This is the core sync logic extracted
 * from the original pull() function to support both user and project scope.
 */
async function pullForScope(
  localConfig: LocalConfig,
  options: GlobalOptions,
  policy: {
    resourceTypes?: readonly ResourceType[];
    revisionField?: 'lastPullRev' | 'lastInheritedPullRev';
  } = {},
): Promise<void> {
  const scopeLabel = localConfig.scope;
  const revisionField = policy.revisionField ?? 'lastPullRev';
  const teamConfig = await loadTeamConfig(localConfig.repo.localPath);
  if (!teamConfig) {
    log.warn(`[${scopeLabel}] Team config (teamai.yaml) not found. Skipping.`);
    return;
  }

  // Step 1: refresh team repo (git pull, or HTTP /repo materialization)
  const pullSpin = spinner(`[${scopeLabel}] Pulling team repo...`).start();
  let currentRev: string | null = null;
  // Reporting-only HTTP endpoints have no team repo to write to, so the
  // team-repo-dependent built-in skill (teamai-share-learnings) is useless
  // there and must not be injected.
  let reportingOnly = false;
  try {
    const { label, version, reportingOnly: ro } = await refreshTeamRepo(localConfig);
    currentRev = version;
    reportingOnly = ro;
    pullSpin.succeed(`[${scopeLabel}] Team repo: ${label}`);
  } catch (e) {
    pullSpin.fail(`[${scopeLabel}] Pull failed: ${(e as Error).message}`);
    return;
  }

  // Step 1b: Skip sync if the repo version hasn't changed since last pull
  if (!options.force && !options.dryRun) {
    try {
      const state = await loadStateForScope(localConfig.scope, localConfig.projectRoot);
      if (currentRev && state[revisionField] && state[revisionField] === currentRev) {
        log.success(`[${scopeLabel}] Already synced at ${currentRev}, skipping`);
        // 即使 repo 未变化，仍部署 CLI 内置资源（确保 CLI 升级后新版本 agent/rules 生效）
        if (!options.dryRun) {
          const cfg = await loadTeamConfig(localConfig.repo.localPath);
          if (cfg) {
            const skipRecall = !isRecallEnabled(localConfig, cfg);
            try { const { deployBuiltinAgents } = await import('./builtin-agents.js'); await deployBuiltinAgents(cfg, localConfig, { skipRecall }); } catch {}
            try { const { deployBuiltinRules } = await import('./builtin-rules.js'); await deployBuiltinRules(cfg, localConfig, { skipRecall }); } catch {}
            try { const { deployBuiltinSkills } = await import('./builtin-skills.js'); await deployBuiltinSkills(cfg, localConfig, { reportingOnly, skipRecall }); } catch {}
            // Instruction ownership is ledger-backed too, so a CLI update can
            // refresh it without reintroducing the old direct-write path.
            await reconcileManagedInstructions(cfg, localConfig, null, scopeLabel);
          }
        }
        return;
      }
    } catch {
      // If rev check fails, proceed with full sync
      log.debug(`[${scopeLabel}] Rev check failed, proceeding with full sync`);
    }
  }

  // Reload team config after pull (might have changed)
  const freshConfig = await loadTeamConfig(localConfig.repo.localPath);
  if (!freshConfig) {
    log.warn(`[${scopeLabel}] Team config disappeared after pull. Skipping.`);
    return;
  }

  // Load role context (if primaryRole configured)
  let roleContext: RolePullContext | null = null;
  try {
    roleContext = await buildRolePullContext(localConfig);
  } catch (e) {
    log.error(`[${scopeLabel}] ${(e as Error).message}`);
    return;
  }

  // Load tags config for filtering
  const tagsConfig = await loadTagsConfig(localConfig.repo.localPath);
  const subscribedTags = localConfig.subscribedTags;
  const excludedSkills = new Set(localConfig.excludedSkills ?? []);

  // Step 2: Sync each resource type
  const resourceTypes: readonly ResourceType[] = policy.resourceTypes
    ?? ['skills', 'rules', 'docs', 'env', 'agents'];
  let totalSynced = 0;
  let knownRepoSkillNames: Set<string> | null = null;

  for (const type of resourceTypes) {
    const handler = getHandler(type);

    if (type === 'rules') {
      const rulesHandler = handler as RulesHandler;
      const allItems = await rulesHandler.scanTeamForPull(freshConfig, localConfig);
      // Filter by role knowledge namespaces first, then by tags
      const knowledgeNs = roleContext ? roleContext.activeNamespaces.knowledge : null;
      const roleFiltered = filterRulesByKnowledgeNamespaces(allItems, knowledgeNs);
      const { included: items, skipped } = filterByTags(roleFiltered, tagsConfig, subscribedTags, 'rules');
      if (items.length > 0) {
        if (options.dryRun) {
          log.info(`[${scopeLabel}] [dry-run] Would sync ${items.length} rule(s)${skipped.length > 0 ? ` (skipped ${skipped.length} by tags)` : ''}`);
        } else {
          await rulesHandler.pullAllRules(freshConfig, localConfig, items);
          log.success(`[${scopeLabel}] Synced ${items.length} rule(s)${skipped.length > 0 ? ` (skipped ${skipped.length} by tags)` : ''}`);
        }
        totalSynced += items.length;
      }
      continue;
    }

    // Skills: directory (role namespace) first, then tags, union of both
    let items: ResourceItem[];
    let skippedByTags = 0;
    if (type === 'skills') {
      const directoryItems = roleContext
        ? await scanRoleAwareSkills(localConfig, roleContext.activeNamespaces)
        : await handler.scanTeamForPull(freshConfig, localConfig);

      const allTeamSkills = await handler.scanTeamForPull(freshConfig, localConfig);

      // Tag channel: only augment when subscriptions are actually active
      const hasActiveTagSubscriptions = tagsConfig != null
        && subscribedTags != null
        && subscribedTags.length > 0;

      let tagIncluded: ResourceItem[] = [];
      if (hasActiveTagSubscriptions) {
        const tagResult = filterByTags(allTeamSkills, tagsConfig, subscribedTags, 'skills');
        tagIncluded = tagResult.included;
        skippedByTags = tagResult.skipped.length;
      }

      // Union: merge directory items with tag-matched items
      const merged = new Map<string, ResourceItem>();
      for (const item of directoryItems) merged.set(item.name, item);
      for (const item of tagIncluded) {
        if (!merged.has(item.name)) merged.set(item.name, item);
      }
      items = [...merged.values()];
      if (excludedSkills.size > 0) {
        items = items.filter((item) => !excludedSkills.has(item.name));
      }
      knownRepoSkillNames = new Set(allTeamSkills.map((i) => i.name));
    } else {
      items = await handler.scanTeamForPull(freshConfig, localConfig);
    }
    if (type === 'skills' || type === 'agents') {
      const home = getTeamaiHome(localConfig.scope, localConfig.projectRoot);
      let resources: DesiredManagedResource[] = [];
      let complete = true;
      if (type === 'skills') {
        const skillsHandler = handler as import('./resources/skills.js').SkillsHandler;
        resources = await Promise.all(items.map((item) => skillsHandler.buildManagedResource(item, freshConfig, localConfig)));
      } else {
        const agentsHandler = handler as import('./resources/agents.js').AgentsHandler;
        const plans = await Promise.all(items.map((item) => agentsHandler.buildManagedResource(item, freshConfig, localConfig)));
        complete = plans.every((plan) => plan !== null);
        resources = plans.filter((plan): plan is DesiredManagedResource => plan !== null);
      }

      if (options.dryRun) {
        log.info(`[${scopeLabel}] [dry-run] Would reconcile ${items.length} ${type}`);
      } else {
        const result = await reconcileManagedResources(home, resources, {
          // A malformed agent is intentionally non-destructive: update the valid
          // ones, but wait to prune stale targets until every source rendered.
          pruneTypes: complete ? [type] : [],
        });
        for (const conflict of result.conflicts) log.warn(`[${scopeLabel}] Preserved local change: ${conflict}`);
        if (items.length > 0) {
          log.success(`[${scopeLabel}] Synced ${items.length} ${type}`);
        } else if (result.removed.length > 0) {
          log.success(`[${scopeLabel}] Removed ${result.removed.length} stale ${type}`);
        }
      }
      totalSynced += items.length;
      continue;
    }

    if (items.length === 0) continue;

    if (type === 'env') {
      const envHandler = handler as EnvHandler;
      const varCount = await envHandler.countEnvVars(items[0].sourcePath);
      if (varCount === 0) continue;

      if (options.dryRun) {
        log.info(`[${scopeLabel}] [dry-run] Would sync ${varCount} env variable(s)`);
      } else {
        await envHandler.pullItem(items[0], freshConfig, localConfig);
        const teamaiHome = getTeamaiHome(localConfig.scope, localConfig.projectRoot);
        log.success(`[${scopeLabel}] Synced ${varCount} env variable(s) to ${teamaiHome}/env.sh`);
      }
      totalSynced += 1;
      continue;
    }

    if (type === 'docs') {
      const docsHandler = handler as DocsHandler;
      const fileCount = await docsHandler.countDocFiles(items[0].sourcePath);

      if (options.dryRun) {
        log.info(`[${scopeLabel}] [dry-run] Would ${(freshConfig.sharing.docs.mode ?? 'copy') === 'index-only' ? 'index' : 'sync'} ${fileCount} docs`);
      } else {
        await docsHandler.pullItem(items[0], freshConfig, localConfig);
        log.success(`[${scopeLabel}] ${(freshConfig.sharing.docs.mode ?? 'copy') === 'index-only' ? 'Indexed' : 'Synced'} ${fileCount} docs${(freshConfig.sharing.docs.mode ?? 'copy') === 'index-only' ? ' (team checkout only)' : ''}`);
      }
      totalSynced += fileCount;
      continue;
    }

    // Collect existing local resource names before pulling
    const existingNames = await getExistingLocalNames(type, items, freshConfig, localConfig);

    if (options.dryRun) {
      const added = items.filter(i => !existingNames.has(i.name));
      const updated = items.filter(i => existingNames.has(i.name));

      log.info(`[${scopeLabel}] [dry-run] Would pull ${items.length} ${type}`);
      if (options.verbose) {
        for (const item of items) {
          log.dim(`  ${item.name}`);
        }
      }
    } else {
      for (const item of items) {
        await handler.pullItem(item, freshConfig, localConfig);
      }

      log.success(`[${scopeLabel}] Synced ${items.length} ${type}`);
    }

    totalSynced += items.length;
  }

  // Step 3: Clean up tombstoned resources
  if (!options.dryRun) {
    // Each entry maps a resource type to (a) the field on toolPath that names
    // the tool-side directory and (b) the filename suffix used for that
    // resource on disk (e.g. rules/wiki pages are files, skills are dirs).
    const tombstoneTypes: {
      type: ResourceType;
      ext?: string;
      toolPathField: 'rules' | 'skills' | 'agents';
    }[] = [
      { type: 'rules', ext: '.md', toolPathField: 'rules' },
      // Pre-ledger installations have no ownership record. Retain their legacy
      // tombstone cleanup, while ledger-owned targets are pruned transactionally
      // above and are never deleted through this inference path.
      { type: 'skills', toolPathField: 'skills' },
      { type: 'agents', ext: '.md', toolPathField: 'agents' },
    ];

    const baseDir = resolveBaseDir(localConfig);
    const managedPaths = await (await import('./managed-resources.js')).managedManifestTargetPaths(
      getTeamaiHome(localConfig.scope, localConfig.projectRoot),
    );
    for (const { type, ext, toolPathField } of tombstoneTypes) {
      const handler = getHandler(type);
      const tombstones = await handler.readTombstones(localConfig);
      if (tombstones.size === 0) continue;

      for (const [tool, toolPath] of Object.entries(freshConfig.toolPaths)) {
        const dir = toolPath[toolPathField];
        if (!dir) continue;
        if (!await ResourceHandler.isToolInstalled(dir, baseDir, toolPath.probe)) continue;
        if (isAgentDisabled(localConfig, tool)) continue;

        for (const name of tombstones) {
          const localPath = path.join(baseDir, dir, ext ? `${name}${ext}` : name);
          if (managedPaths.has(localPath)) continue;
          if (await pathExists(localPath)) {
            await remove(localPath);
            log.debug(`[${scopeLabel}] Cleaned up tombstoned ${type} ${name} from ${dir}`);
          }
        }
      }
    }

    // Keep the explicit exclusion contract for pre-ledger installations. Managed
    // targets are handled by the transaction engine (and retain its conflict
    // guard); an older untracked copy can still be removed on the user's request.
    if (excludedSkills.size > 0 && knownRepoSkillNames) {
      for (const [tool, toolPath] of Object.entries(freshConfig.toolPaths)) {
        if (isAgentDisabled(localConfig, tool) || !toolPath.skills) continue;
        if (!await ResourceHandler.isToolInstalled(toolPath.skills, baseDir, toolPath.probe)) continue;
        const skillsDir = path.join(baseDir, toolPath.skills);
        for (const name of excludedSkills) {
          if (!knownRepoSkillNames.has(name)) continue;
          const localPath = path.join(skillsDir, name);
          if (managedPaths.has(localPath)) continue;
          if (await pathExists(localPath)) await remove(localPath);
        }
      }
    }
  }

  if (totalSynced === 0) {
    log.info(`[${scopeLabel}] No resources to sync`);
  }

  // Step 3.5: Sync learnings and rebuild the multi-category search index
  // (Phase 1: covers learnings + docs + rules + skills). Both scopes supported.
  if (!options.dryRun) {
    try {
      const learningsRepoDir = path.join(localConfig.repo.localPath, 'learnings');
      const docsRepoDir = path.join(localConfig.repo.localPath, 'docs');
      const rulesRepoDir = path.join(localConfig.repo.localPath, 'rules');
      const skillsRepoDir = path.join(localConfig.repo.localPath, 'skills');
      // votes/ lives on the teamai-reports orphan branch in self mode (gitignored
      // under localPath), so vote-weighted recall must read it from the reports
      // worktree — otherwise ranking is silently disabled. Best-effort: fall back
      // to localPath/votes (empty) if the worktree can't be resolved.
      let votesDir = path.join(localConfig.repo.localPath, 'votes');
      if (localConfig.repo.kind === 'self') {
        try {
          const { ensureReportsWorktree } = await import('./utils/reports-branch.js');
          votesDir = path.join(await ensureReportsWorktree(localConfig), 'votes');
        } catch (e) {
          log.debug(`[self] reports worktree for votes unavailable: ${(e as Error).message}`);
        }
      }

      // user scope: sync learnings to ~/.teamai/learnings/ (legacy behavior)
      // project scope: use learnings directly from repo
      let learningsCount = 0;
      let effectiveLearningsDir: string | undefined;
      if (localConfig.scope === 'user') {
        if (await pathExists(learningsRepoDir)) {
          await fse.copy(learningsRepoDir, LEARNINGS_LOCAL_DIR, {
            overwrite: true,
            filter: (src: string) => !path.basename(src).startsWith('.'),
          });
          const allFiles = await listFiles(learningsRepoDir);
          learningsCount = allFiles.filter((f) => f.endsWith('.md')).length;
        }
        effectiveLearningsDir = await pathExists(LEARNINGS_LOCAL_DIR) ? LEARNINGS_LOCAL_DIR : undefined;
      } else {
        effectiveLearningsDir = await pathExists(learningsRepoDir) ? learningsRepoDir : undefined;
        if (effectiveLearningsDir) {
          const allFiles = await listFiles(learningsRepoDir);
          learningsCount = allFiles.filter((f) => f.endsWith('.md')).length;
        }
      }

      // teamwiki/ stays inside .teamai/team-repo/ — no copy to project root

      // Build the index when ANY of the four categories has content.
      const hasAnySource =
        effectiveLearningsDir ||
        await pathExists(docsRepoDir) ||
        await pathExists(rulesRepoDir) ||
        await pathExists(skillsRepoDir);

      // Resolve codebase directory (project cwd or team repo)
      const repoCodebaseDir = path.join(localConfig.repo.localPath, 'docs', 'team-codebase');
      const effectiveCodebaseDir = await pathExists(repoCodebaseDir) ? repoCodebaseDir : undefined;

      if (hasAnySource || effectiveCodebaseDir) {
        const votesExist = await pathExists(votesDir);
        const teamaiHome = getTeamaiHome(localConfig.scope, localConfig.projectRoot);
        const indexPath = path.join(teamaiHome, 'search-index.json');
        const { buildIndex } = await import('./utils/search-index.js');
        const elapsed = await buildIndex({
          learningsDir: effectiveLearningsDir,
          docsDir: await pathExists(docsRepoDir) ? docsRepoDir : undefined,
          rulesDir: await pathExists(rulesRepoDir) ? rulesRepoDir : undefined,
          skillsDir: await pathExists(skillsRepoDir) ? skillsRepoDir : undefined,
          codebaseDir: undefined, // codebase now served by teamwiki/ graph engine
          votesDir: votesExist ? votesDir : undefined,
          indexPath,
        });
        if (learningsCount > 0) {
          log.success(`Synced ${learningsCount} learnings (index: ${elapsed}ms)`);
        } else {
          log.debug(`[${scopeLabel}] Built multi-category search index in ${elapsed}ms`);
        }
      }
    } catch (e) {
      log.debug(`Learnings/index sync skipped: ${(e as Error).message}`);
    }
  }

  // Step 3.6–3.8: Reconcile team instructions through the ownership ledger.
  // User scope owns complete host instruction files; project scope only owns the
  // TeamAI marker blocks inside <project>/AGENTS.md.
  if (!options.dryRun) {
    await reconcileManagedInstructions(freshConfig, localConfig, roleContext, scopeLabel);
  }

  // Step 4: Deploy CLI built-in skills
  if (!options.dryRun) {
    try {
      const { deployBuiltinSkills } = await import('./builtin-skills.js');
      const skipRecallForSkills = !isRecallEnabled(localConfig, freshConfig);
      const deployed = await deployBuiltinSkills(freshConfig, localConfig, { reportingOnly, skipRecall: skipRecallForSkills });
      if (deployed > 0) {
        log.debug(`[${scopeLabel}] Deployed ${deployed} built-in skill(s)`);
      }
    } catch (e) {
      log.debug(`[${scopeLabel}] Built-in skills deployment skipped: ${(e as Error).message}`);
    }
  }

  // Step 4.5: Deploy CLI built-in rules
  if (!options.dryRun) {
    try {
      const { deployBuiltinRules } = await import('./builtin-rules.js');
      const skipRecall = !isRecallEnabled(localConfig, freshConfig);
      const deployed = await deployBuiltinRules(freshConfig, localConfig, { skipRecall });
      if (deployed > 0) {
        log.debug(`[${scopeLabel}] Deployed built-in rules to ${deployed} tool(s)`);
      }
    } catch (e) {
      log.debug(`[${scopeLabel}] Built-in rules deployment skipped: ${(e as Error).message}`);
    }
  }

  // Step 4.6: Deploy CLI built-in agents (e.g. teamai-recall subagent)
  if (!options.dryRun) {
    try {
      const { deployBuiltinAgents } = await import('./builtin-agents.js');
      const skipRecall = !isRecallEnabled(localConfig, freshConfig);
      const deployed = await deployBuiltinAgents(freshConfig, localConfig, { skipRecall });
      if (deployed > 0) {
        log.debug(`[${scopeLabel}] Deployed built-in agents to ${deployed} location(s)`);
      }
    } catch (e) {
      log.debug(`[${scopeLabel}] Built-in agents deployment skipped: ${(e as Error).message}`);
    }
  }

  // Record the revision only after every resource and knowledge phase has had
  // a chance to run. Inherited pulls use an independent marker so a partial,
  // safe sync can never suppress a later full user-scope pull.
  if (!options.dryRun) {
    const state = await loadStateForScope(localConfig.scope, localConfig.projectRoot);
    if (revisionField === 'lastPullRev') {
      state.lastPull = new Date().toISOString();
    }
    if (currentRev !== null) {
      state[revisionField] = currentRev;
    } else {
      try {
        state[revisionField] = await getHeadRev(localConfig.repo.localPath);
      } catch {
        state[revisionField] = null;
      }
    }
    await saveStateForScope(state, localConfig.scope, localConfig.projectRoot);
  }

  // Step 5: Auto-report usage data — handled centrally in pull() to avoid
  // double-truncation when both user and project scopes share events.
  // (no-op here; see pull() for the unified reporting logic)

  // Step 6: Show skill recommendations
  if (!options.silent && !options.dryRun) {
    try {
      const YAML = (await import('yaml')).default;
      const { listFiles, readFileSafe } = await import('./utils/fs.js');
      const { getRecommendations, displayRecommendations } = await import('./skill-recommend.js');
      // stats/ lives on the teamai-reports orphan branch in self mode (gitignored
      // under localPath), so recommendations must read it from the reports worktree
      // — otherwise they never appear. Best-effort fallback to localPath/stats.
      let statsDir = path.join(localConfig.repo.localPath, 'stats');
      if (localConfig.repo.kind === 'self') {
        try {
          const { ensureReportsWorktree } = await import('./utils/reports-branch.js');
          statsDir = path.join(await ensureReportsWorktree(localConfig), 'stats');
        } catch (e) {
          log.debug(`[self] reports worktree for stats unavailable: ${(e as Error).message}`);
        }
      }
      const files = await listFiles(statsDir);
      const teamStats = [];
      for (const file of files) {
        if (!file.endsWith('.yaml')) continue;
        const content = await readFileSafe(path.join(statsDir, file));
        if (!content) continue;
        try {
          const parsed = YAML.parse(content);
          if (parsed?.username && parsed?.skills) teamStats.push(parsed);
        } catch { /* skip */ }
      }
      if (teamStats.length > 0) {
        const recs = await getRecommendations(teamStats);
        displayRecommendations(recs);
      }
    } catch {
      // Recommendations are optional — don't fail pull
    }
  }
}

/**
/**
 * Compile culture.md frontmatter + body into a CLAUDE.md injection block.
 *
 * The culture.md file uses gray-matter frontmatter for structured data (company,
 * team) and markdown body for prose guidelines.
 *
 * Returns null if the culture.md cannot be parsed or has no useful content.
 */
export function compileCulture(raw: string): string | null {
    let parsed: { data: Record<string, unknown>; content: string };
    try {
        parsed = matter(raw);
    } catch {
        return null;
    }

    const fm = CultureFrontmatterSchema.safeParse(parsed.data);
    if (!fm.success) return null;

    const frontmatter: CultureFrontmatter = fm.data;
    const lines: string[] = [];

    // Company section
    if (frontmatter.company) {
        const c = frontmatter.company;
        lines.push(`## Company: ${c.name}`);
        if (c.mission) lines.push(`**Mission:** ${c.mission}`);
        if (c.vision) lines.push(`**Vision:** ${c.vision}`);
        if (c.values && c.values.length > 0) {
            lines.push(`**Values:** ${c.values.join(', ')}`);
        }
        lines.push('');
    }

    // Team section
    if (frontmatter.team) {
        const t = frontmatter.team;
        lines.push(`## Team: ${t.name}`);
        if (t.mission) lines.push(`**Mission:** ${t.mission}`);
        if (t.goals && t.goals.length > 0) {
            lines.push('**Goals:**');
            for (const g of t.goals) {
                lines.push(`- ${g}`);
            }
        }
        lines.push('');
    }

    // Body: include all prose content as-is
    const body = parsed.content.trim();
    if (body) {
        lines.push(body);
        lines.push('');
    }

    if (lines.length === 0) return null;

    const block = [
        TEAMAI_CULTURE_START,
        '<!-- DO NOT EDIT: This section is auto-managed by teamai -->',
        '',
        '## Team Culture (teamai)',
        '',
        ...lines,
        TEAMAI_CULTURE_END,
    ].join('\n');

    return block;
}

/**
 * Merge one or more claudemd markdown files into a single CLAUDE.md injection block.
 *
 * Unlike compileCulture(), no frontmatter parsing — content is injected as-is.
 * Returns null if all contents are empty.
 */
export function compileClaudemd(contents: string[]): string | null {
    const parts = contents
        .map((c) => c.trim())
        .filter(Boolean);
    if (parts.length === 0) return null;

    return [
        TEAMAI_CLAUDEMD_START,
        '<!-- DO NOT EDIT: This section is auto-managed by teamai -->',
        '',
        parts.join('\n\n'),
        '',
        TEAMAI_CLAUDEMD_END,
    ].join('\n');
}

/**
 * Build instruction destinations after every source is known, then apply them in
 * one transaction. This intentionally does not use injectClaudeMdSection: direct
 * marker writes could race a resource update and left no ownership evidence.
 */
export async function reconcileManagedInstructions(
  config: TeamaiConfig,
  localConfig: LocalConfig,
  roleContext: RolePullContext | null,
  scopeLabel: string,
  options: { plan?: boolean } = {},
): Promise<import('./managed-resources.js').ManagedReconcileResult> {
  try {
    const sourcePath = path.join(localConfig.repo.localPath, config.sharing.instructions?.source ?? 'AGENTS.md');
    let source = await readFileSafe(sourcePath);
    // Existing team repositories may not have adopted root AGENTS.md yet. Keep
    // their culture/claudemd behaviour as a read-only source compatibility path.
    if (!source) {
      const cultureRaw = await readFileSafe(path.join(localConfig.repo.localPath, 'culture.md'));
      const culture = cultureRaw ? compileCulture(cultureRaw) : null;
      const shared = compileClaudemd(await collectClaudemdFiles(localConfig.repo.localPath, roleContext));
      source = [culture, shared].filter((block): block is string => !!block).join('\n\n') || null;
    }
    const home = getTeamaiHome(localConfig.scope, localConfig.projectRoot);
    // Recall is a CLI-built-in instruction channel. Keep its established marker
    // updater for repositories that have not opted into a root AGENTS.md yet;
    // once a lifecycle ledger exists, absence of that source correctly prunes it.
    if (!source && !options.plan && localConfig.scope === 'user' && isRecallEnabled(localConfig, config)
      && (await managedManifestTargetPaths(home)).size === 0) {
      await injectRecallBlockIntoTools(config, localConfig, scopeLabel);
      return { applied: [], removed: [], conflicts: [], planned: [] };
    }
    const resources: DesiredManagedResource[] = [];
    const instructionSection = {
      start: '<!-- [teamai:instructions:start] -->',
      end: '<!-- [teamai:instructions:end] -->',
    };

    if (localConfig.scope === 'project') {
      if (source || isRecallEnabled(localConfig, config)) {
        const target = path.join(resolveBaseDir(localConfig), 'AGENTS.md');
        const body = [source, isRecallEnabled(localConfig, config) ? compileRecallRulesBlock() : null]
          .filter((block): block is string => !!block)
          .join('\n\n')
          .trim();
        resources.push({
          id: 'instructions:project-agents',
          type: 'instructions',
          targets: [{
            path: target,
            kind: 'file',
            section: instructionSection,
            content: `${instructionSection.start}\n<!-- DO NOT EDIT: This section is auto-managed by teamai -->\n\n${body}\n${instructionSection.end}`,
          }],
        });
      }
    } else {
      const baseDir = resolveBaseDir(localConfig);
      for (const [tool, toolPath] of Object.entries(config.toolPaths)) {
        const instructionPath = toolPath.instruction ?? toolPath.claudemd;
        if (isAgentDisabled(localConfig, tool) || !instructionPath || !source) continue;
        const installationPath = toolPath.skills ?? instructionPath;
        if (!await ResourceHandler.isToolInstalled(installationPath, baseDir)) continue;
        const blocks = [source, toolPath.agents && isRecallEnabled(localConfig, config) ? compileRecallRulesBlock() : null]
          .filter((block): block is string => !!block);
        resources.push({
          id: `instructions:${tool}`,
          type: 'instructions',
          targets: [{
            path: path.join(baseDir, instructionPath),
            kind: 'file',
            tool,
            // User scope's host instruction file is a complete TeamAI-managed file.
            content: `${blocks.join('\n\n').trim()}\n`,
          }],
        });
      }
    }

    const result = await reconcileManagedResources(home, resources, { pruneTypes: ['instructions'], plan: options.plan });
    for (const conflict of result.conflicts) log.warn(`[${scopeLabel}] Preserved local instruction: ${conflict}`);
    if (options.plan) {
      for (const target of result.planned) log.info(`[${scopeLabel}] [plan] instructions: ${target}`);
    } else if (resources.length > 0) {
      log.debug(`[${scopeLabel}] Reconciled ${resources.length} instruction host(s)`);
    }
    return result;
  } catch (error) {
    log.warn(`[${scopeLabel}] Instruction lifecycle failed: ${(error as Error).message}`);
    throw error;
  }
}

/**
 * Inject (or replace) the teamai-recall block into every Tier-1 tool's CLAUDE.md.
 *
 * Only injected for Tier-1 tools that have BOTH `agents` and `claudemd`
 * configured. Tools without subagent support (cursor / codex / openclaw /
 * workbuddy) are skipped — for them the recall flow runs purely via the
 * TodoWrite hint hook and the manual `teamai recall` command.
 *
 * Extracted so both the full-sync path (Step 3.8) and the "Already synced"
 * rev fast-path can call it — otherwise a CLI upgrade that ships a new recall
 * block never reaches CLAUDE.md when the team repo HEAD is unchanged.
 * No-op when recall is disabled for this scope.
 */
export async function injectRecallBlockIntoTools(
    config: TeamaiConfig,
    localConfig: LocalConfig,
    scopeLabel: string,
): Promise<void> {
    if (!isRecallEnabled(localConfig, config) || !isBuiltinEnabled(config, 'rules', 'teamai-recall')) return;
    try {
        const baseDir = resolveBaseDir(localConfig);
        const recallBlock = compileRecallRulesBlock();
        let injected = 0;
        for (const [tool, toolPath] of Object.entries(config.toolPaths)) {
            if (isAgentDisabled(localConfig, tool)) continue;
            if (!toolPath.claudemd || !toolPath.agents) continue;
            if (!await ResourceHandler.isToolInstalled(toolPath.agents, baseDir, toolPath.probe)) continue;

            const claudeMdPath = path.join(baseDir, toolPath.claudemd);
            try {
                await injectClaudeMdSection(
                    claudeMdPath,
                    TEAMAI_RECALL_RULES_START,
                    TEAMAI_RECALL_RULES_END,
                    recallBlock,
                );
                injected++;
                log.debug(`Injected recall rules into ${tool} CLAUDE.md`);
            } catch (e) {
                log.warn(`Failed to inject recall rules into ${tool} CLAUDE.md: ${(e as Error).message}`);
            }
        }
        if (injected > 0) {
            log.debug(`[${scopeLabel}] Injected recall rules into ${injected} tool(s) CLAUDE.md`);
        }
    } catch (e) {
        log.debug(`[${scopeLabel}] Recall rules injection skipped: ${(e as Error).message}`);
    }
}

/**
 * Build the CLAUDE.md block that instructs the main conversation to:
 *   1. Invoke the `teamai-recall` subagent before starting any task that
 *      involves code changes / troubleshooting / design.
 *   2. Declare which doc_ids were actually consulted at task completion.
 *
 * Only injected for Tier-1 tools (those with both `agents` and `claudemd`
 * paths configured) — see pull.ts Step 3.8.
 */
export function compileRecallRulesBlock(): string {
    const lines = [
        TEAMAI_RECALL_RULES_START,
        '<!-- DO NOT EDIT: This section is auto-managed by teamai -->',
        '',
        '## Team Knowledge Recall (teamai)',
        '',
        '**Before** starting a task that involves code changes, debugging,',
        'or design decisions, you **SHOULD** invoke the `teamai-recall`',
        'subagent via the Agent tool with a concise natural-language',
        'description of the task — unless one of these skip conditions applies:',
        '',
        '1. **User already provided context** — the user referenced specific files,',
        '   gave a solution, or said "the answer is in this directory/file".',
        '2. **Local files have the answer** — the task info is directly available',
        '   from the current workspace (e.g. fixing an obvious bug in the current file).',
        '3. **Trivial/local change** — small modifications to known files (typo fix,',
        '   parameter tweak, formatting) that need no additional knowledge.',
        '4. **Task domain is outside team knowledge coverage** — the task is',
        '   unrelated to this team\'s systems/workflows (e.g. generic language',
        '   questions, pure frontend styling with no team-specific context).',
        '   The recall subagent also runs a relevance precheck and returns fast',
        '   for unrelated tasks, but skipping outright saves a subagent round-trip.',
        '',
        'The subagent will return a compact summary of relevant team knowledge',
        '(skills, learnings, docs, rules) without polluting this conversation',
        'with raw content. For **feature/large tasks**, recall returns a',
        '"Candidate change files" list — check your planned changes cover all',
        'listed files before starting. For **bugfix/small tasks**, recall runs',
        'a lighter pass and you may skip it entirely per condition 2–3 above.',
        '',
        '**Important constraints on agent sequencing (when recall is invoked):**',
        '1. Invoke `teamai-recall` subagent **first and alone** — never',
        '   launch it in parallel with Explore or other research agents.',
        '2. After recall returns results, use Read to get full content of the',
        '   returned files if you need more detail. Do NOT launch Explore agents',
        '   to search for the same topics — recall results + Read is the complete',
        '   workflow for accessing team knowledge.',
        '3. Explore/research agents have their own scope and must NOT overlap',
        '   with recall:',
        '   - **recall subagent covers:** team learnings, codebase docs, skills,',
        '     rules, and anything under `.teamai/`, `learnings/`, `docs/team-codebase/`.',
        '   - **Explore agents cover:** navigating source code in the current',
        '     working directory, and web search for external information.',
        '   - Explore agents must never search paths covered by recall.',
        '',
        '**After** completing the task, in your final reply you **MUST**',
        'declare which knowledge entries were actually referenced, using an',
        'HTML comment of the form:',
        '',
        '```',
        '<!-- teamai:referenced-doc-ids: [doc-id-1, doc-id-2] -->',
        '```',
        '',
        'If the recall returned no relevant hits, declare an empty list',
        '(`<!-- teamai:referenced-doc-ids: [] -->`). Do not skip the',
        'declaration — downstream tooling parses it to credit knowledge use.',
        '',
        TEAMAI_RECALL_RULES_END,
    ];
    return lines.join('\n');
}

/**
 * Collect claudemd .md files filtered by the user's active knowledge namespaces.
 *
 * Walks claudemd/<namespace>/*.md for each active namespace.
 * Falls back to collecting ALL namespace dirs when no role context is available.
 */
async function collectClaudemdFiles(
    repoPath: string,
    roleContext: RolePullContext | null,
): Promise<string[]> {
    const claudemdDir = path.join(repoPath, 'claudemd');
    if (!await pathExists(claudemdDir)) return [];

    // Determine which namespace dirs to scan
    let namespaceDirs: string[];
    if (roleContext) {
        namespaceDirs = roleContext.activeNamespaces.knowledge;
    } else {
        // No role configured → scan all subdirectories
        namespaceDirs = await listDirs(claudemdDir);
    }

    const contents: string[] = [];
    for (const ns of namespaceDirs) {
        const nsDir = path.join(claudemdDir, ns);
        if (!await pathExists(nsDir)) continue;
        const files = (await listFiles(nsDir))
            .filter((f) => f.endsWith('.md'))
            .sort();
        for (const file of files) {
            const content = await readFileSafe(path.join(nsDir, file));
            if (content) contents.push(content);
        }
    }

    return contents;
}

/**
 * Auto-migrate hooks from old individual format to unified hook-dispatch format.
 * Runs at session start: if settings.json doesn't contain 'hook-dispatch' commands,
 * it means the user updated the CLI but hooks are still in old format.
 * Reinjects with the current version's hook definitions.
 */
async function autoMigrateHooksIfNeeded(): Promise<void> {
  const home = process.env.HOME ?? '';
  // Quick check: read the primary settings file and see if it has hook-dispatch
  const primarySettings = path.join(home, '.claude', 'settings.json');
  if (!await pathExists(primarySettings)) return;

  const content = await readFileSafe(primarySettings);
  if (!content) return;

  // If hook-dispatch is already present, no migration needed
  if (content.includes('hook-dispatch')) return;

  // If no teamai hooks at all (user never ran init), skip
  if (!content.includes('teamai')) return;

  // Old format detected — reinject all tools
  log.debug('Auto-migrating hooks to dispatch format...');
  const { autoDetectInit } = await import('./config.js');
  const { injectHooksToAllTools } = await import('./hooks.js');
  const { localConfig, teamConfig } = await autoDetectInit();
  const baseDir = resolveBaseDir(localConfig);
  const disabled = localConfig.disabledAgents;
  let hookFilter = localConfig.enabledAgents;
  if (disabled && disabled.length > 0) {
    const universe = hookFilter ?? Object.keys(teamConfig.toolPaths);
    hookFilter = universe.filter((t) => !disabled.includes(t));
  }
  await injectHooksToAllTools(teamConfig.toolPaths, baseDir, hookFilter);
  log.debug('Hooks migrated to dispatch format');
}

/** Read-only lifecycle preview using the already-present team checkout. */
async function planPullForScope(localConfig: LocalConfig, teamConfig: TeamaiConfig): Promise<void> {
  const scopeLabel = localConfig.scope;
  let roleContext: RolePullContext | null = null;
  try {
    roleContext = await buildRolePullContext(localConfig);
  } catch (error) {
    log.warn(`[${scopeLabel}] Cannot resolve role profile for plan: ${(error as Error).message}`);
  }
  const tagsConfig = await loadTagsConfig(localConfig.repo.localPath);
  const subscribedTags = localConfig.subscribedTags;
  const excludedSkills = new Set(localConfig.excludedSkills ?? []);
  const home = getTeamaiHome(localConfig.scope, localConfig.projectRoot);

  const skillHandler = getHandler('skills') as import('./resources/skills.js').SkillsHandler;
  const directoryItems = roleContext
    ? await scanRoleAwareSkills(localConfig, roleContext.activeNamespaces)
    : await skillHandler.scanTeamForPull(teamConfig, localConfig);
  const allSkills = await skillHandler.scanTeamForPull(teamConfig, localConfig);
  const tagged = tagsConfig && subscribedTags && subscribedTags.length > 0
    ? filterByTags(allSkills, tagsConfig, subscribedTags, 'skills').included
    : [];
  const skillItems = [...new Map([...directoryItems, ...tagged].map((item) => [item.name, item])).values()]
    .filter((item) => !excludedSkills.has(item.name));
  const skillResources = await Promise.all(skillItems.map((item) => skillHandler.buildManagedResource(item, teamConfig, localConfig)));
  const skillPlan = await reconcileManagedResources(home, skillResources, { pruneTypes: ['skills'], plan: true });
  for (const target of skillPlan.planned) log.info(`[${scopeLabel}] [plan] skills: ${target}`);
  for (const conflict of skillPlan.conflicts) log.warn(`[${scopeLabel}] [plan] conflict: ${conflict}`);

  const agentHandler = getHandler('agents') as import('./resources/agents.js').AgentsHandler;
  const agentItems = await agentHandler.scanTeamForPull(teamConfig, localConfig);
  const agentPlans = await Promise.all(agentItems.map((item) => agentHandler.buildManagedResource(item, teamConfig, localConfig)));
  const completeAgents = agentPlans.every((resource) => resource !== null);
  const agentResources = agentPlans.filter((resource): resource is DesiredManagedResource => resource !== null);
  const agentPlan = await reconcileManagedResources(home, agentResources, {
    pruneTypes: completeAgents ? ['agents'] : [], plan: true,
  });
  for (const target of agentPlan.planned) log.info(`[${scopeLabel}] [plan] agents: ${target}`);
  for (const conflict of agentPlan.conflicts) log.warn(`[${scopeLabel}] [plan] conflict: ${conflict}`);

  const instructionPlan = await reconcileManagedInstructions(teamConfig, localConfig, roleContext, scopeLabel, { plan: true });
  for (const conflict of instructionPlan.conflicts) log.warn(`[${scopeLabel}] [plan] conflict: ${conflict}`);
  if (skillPlan.planned.length + agentPlan.planned.length + instructionPlan.planned.length === 0) {
    log.info(`[${scopeLabel}] [plan] No managed resource changes`);
  }
}

/**
 * Main pull entry point.
 *
 * Scope isolation (issue #73) remains the default. A project may explicitly
 * inherit safe user-scope resources and knowledge with `inheritUserScope`.
 * Executable configuration (env, hooks, and MCP) stays isolated, and external
 * source skills are pulled only for the active project scope.
 */
export async function pull(options: GlobalOptions): Promise<void> {
  if (options.dryRun || options.plan) {
    // Do not auto-migrate hooks, auto-bootstrap self mode, refresh git, spawn a
    // provider command, or write a cache while planning.
    try {
      const { localConfig, teamConfig } = await (await import('./config.js')).autoDetectInit({ readOnly: true });
      await planPullForScope(localConfig, teamConfig);
      log.info('Plan — no Git refresh, bootstrap, hook migration, network, or file writes were performed.');
    } catch (error) {
      log.debug(`Plan scan skipped: ${(error as Error).message}`);
      log.info('Plan — pull would reconcile TeamAI resources if configured. No changes made.');
    }
    return;
  }
  // 0. Auto-migrate hooks if settings.json has old format (pre-dispatch era).
  //    This runs on the first session start after a CLI update — the new binary
  //    detects the old individual hooks and reinjects the merged dispatch format.
  try {
    await autoMigrateHooksIfNeeded();
  } catch {
    // Non-fatal — pull continues even if hook migration fails
  }

  // 1. Detect project scope first. Its presence decides whether user scope is
  //    processed at all (issue #73: project install isolates from user).
  let projectConfig: LocalConfig | null = null;
  try {
    projectConfig = await detectProjectConfig();
  } catch (e) {
    log.warn(`Project-scope detection error: ${(e as Error).message}`);
  }
  const projectMode = projectConfig !== null;
  const inheritUserScope = projectConfig?.inheritUserScope === true;

  // 2. User scope — distinguish an active user install from an inherited one.
  //    Only the active config may drive control-plane effects below.
  let activeUserConfig: LocalConfig | null = null;
  let inheritedUserConfig: LocalConfig | null = null;
  if (projectMode && !inheritUserScope) {
    log.info('project scope detected, skipped user scope');
  } else {
    try {
      const loadedUserConfig = await loadLocalConfigForScope('user');
      if (loadedUserConfig) {
        if (inheritUserScope) {
          inheritedUserConfig = loadedUserConfig;
          log.info('project scope detected, inheriting user-scope resources and knowledge');
          await pullForScope(inheritedUserConfig, options, {
            resourceTypes: ['skills', 'rules', 'docs', 'agents'],
            revisionField: 'lastInheritedPullRev',
          });
        } else {
          activeUserConfig = loadedUserConfig;
          await pullForScope(activeUserConfig, options);
        }
      } else if (inheritUserScope) {
        log.warn('user-scope inheritance is enabled, but user scope is not initialized');
      } else {
        log.debug('No user-scope config found, skipping user pull');
      }
    } catch (e) {
      log.warn(`User-scope pull error: ${(e as Error).message}`);
    }
  }

  // 3. Project scope.
  if (projectConfig) {
    try {
      await pullForScope(projectConfig, options);
    } catch (e) {
      log.warn(`Project-scope pull error: ${(e as Error).message}`);
    }
  }

  // 3.5. Reconcile built-in + team hooks for the active scope only. Runs OUTSIDE
  // pullForScope so it bypasses the "Already synced" rev fast-path — this is
  // what self-heals new built-in hooks and applies hooks.yaml changes on every
  // session start. In project mode user is null, even when safe resources are
  // inherited, so executable hook configuration is never composed implicitly.
  await reconcileHooksAllScopes(activeUserConfig, projectConfig, options);

  // 3.6. Reconcile team MCP servers. Outside pullForScope for the same reason as
  // hooks. User-scope MCP remains isolated in project mode.
  await reconcileMcpAllScopes(activeUserConfig, projectConfig, options);

  // 4. Auto-report usage data to all active scopes. Events live in a single
  //    shared file (~/.teamai/usage.jsonl), so we report to each repo with
  //    skipTruncate=true first, then truncate once at the end.
  //    Scope filtering: project scope only gets sessions whose cwd is under
  //    projectRoot; user scope excludes those sessions.
  if (!options.dryRun) {
    const usageConfigs = [projectConfig, activeUserConfig].filter((c): c is LocalConfig => !!c);
    const reportingConfigs = await Promise.all(usageConfigs.map(async (c) => ({ c, cfg: await loadTeamConfig(c.repo.localPath) })));
    const reportingEnabled = reportingConfigs.some(({ cfg }) => cfg?.sharing.usage?.enabled !== false && cfg?.sharing.usage?.autoReport !== false);
    if (!reportingEnabled) {
      log.debug('Usage reporting disabled by team policy');
    }
    if (reportingEnabled) try {
      const { reportUsageToTeam } = await import('./team-push.js');
      const { truncateUsageAfterReport, readUsageEvents } = await import('./usage-tracker.js');
      const targets: Array<{ repoPath: string; username: string; opts: { skipTruncate: true; projectRoot?: string; excludeProjectRoots?: string[]; selfConfig?: LocalConfig } }> = [];
      if (projectConfig && projectConfig.repo.kind !== 'http' && reportingConfigs.find(x => x.c === projectConfig)?.cfg?.sharing.usage?.enabled !== false && reportingConfigs.find(x => x.c === projectConfig)?.cfg?.sharing.usage?.autoReport !== false) {
        targets.push({
          repoPath: projectConfig.repo.localPath,
          username: projectConfig.username,
          opts: {
            skipTruncate: true,
            projectRoot: projectConfig.projectRoot,
            // Self mode routes stats/votes to the teamai-reports orphan branch.
            ...(projectConfig.repo.kind === 'self' ? { selfConfig: projectConfig } : {}),
          },
        });
      }
      if (activeUserConfig && activeUserConfig.repo.kind !== 'http' && reportingConfigs.find(x => x.c === activeUserConfig)?.cfg?.sharing.usage?.enabled !== false && reportingConfigs.find(x => x.c === activeUserConfig)?.cfg?.sharing.usage?.autoReport !== false) {
        targets.push({
          repoPath: activeUserConfig.repo.localPath,
          username: activeUserConfig.username,
          opts: {
            skipTruncate: true,
            excludeProjectRoots: projectConfig?.projectRoot ? [projectConfig.projectRoot] : [],
            // Self mode routes stats/votes to the teamai-reports orphan branch —
            // never reset/pull the business repo working tree.
            ...(activeUserConfig.repo.kind === 'self' ? { selfConfig: activeUserConfig } : {}),
          },
        });
      }

      const eventCount = (await readUsageEvents()).length;
      for (const t of targets) {
        try {
          await reportUsageToTeam(t.repoPath, t.username, t.opts);
        } catch (e) {
          log.error(`Auto-report to ${t.repoPath} skipped: ${(e as Error).message}`);
        }
      }
      if (eventCount > 0 && targets.length > 0) {
        await truncateUsageAfterReport(eventCount);
      }
    } catch (e) {
      log.debug(`Auto-report skipped: ${(e as Error).message}`);
    }
  }

  // 5. Pull cross-team source skills (always — even in project mode), against
  //    the active scope so deploys land in the right base dir.
  const sourceConfig = projectConfig ?? activeUserConfig;
  if (sourceConfig) {
    try {
      const { pullSources } = await import('./source.js');
      await pullSources(sourceConfig, options);
    } catch (e) {
      log.debug(`Source pull skipped: ${(e as Error).message}`);
    }
  }
}

/**
 * Reconcile built-in (A) + team (B) hooks across all active scopes. Bypasses the
 * rev fast-path so team hook changes and newly shipped built-in hooks apply even
 * when "Already synced, skipping" short-circuited pullForScope.
 */
async function reconcileHooksAllScopes(
  userConfig: LocalConfig | null,
  projectConfig: LocalConfig | null,
  options: GlobalOptions,
): Promise<void> {
  if (options.dryRun) return;
  const scopes = [userConfig, projectConfig].filter((c): c is LocalConfig => !!c);
  for (const localConfig of scopes) {
    try {
      const teamConfig = await loadTeamConfig(localConfig.repo.localPath);
      if (!teamConfig) continue;
      const { reconcileTeamHooksForConfig } = await import('./hooks.js');
      const teamDefs = await reconcileTeamHooksForConfig(teamConfig, localConfig, {
        auto: true,
        silent: options.silent,
        filterAgents: localConfig.enabledAgents,
      });
      if (teamDefs.length > 0) {
        log.debug(`[${localConfig.scope}] Reconciled ${teamDefs.length} team hook(s)`);
      }
    } catch (e) {
      log.debug(`[${localConfig.scope}] Hook reconcile skipped: ${(e as Error).message}`);
    }
  }
}

/**
 * Reconcile team MCP servers across all active scopes. MCP servers load at
 * session start, so a change applied here takes effect in the user's next
 * session — which is exactly when the SessionStart pull hook runs.
 */
async function reconcileMcpAllScopes(
  userConfig: LocalConfig | null,
  projectConfig: LocalConfig | null,
  options: GlobalOptions,
): Promise<void> {
  if (options.dryRun) return;
  const scopes = [userConfig, projectConfig].filter((c): c is LocalConfig => !!c);
  for (const localConfig of scopes) {
    try {
      const teamConfig = await loadTeamConfig(localConfig.repo.localPath);
      if (!teamConfig) continue;
      const { reconcileMcpForConfig } = await import('./mcp-reconcile.js');
      const { changes } = await reconcileMcpForConfig(teamConfig, localConfig);

      const applied = changes.filter((c) => c.action !== 'skipped');
      for (const c of changes) {
        if (c.action === 'skipped') log.debug(`[mcp] ${c.tool}/${c.server}: skipped — ${c.reason}`);
      }
      if (applied.length > 0 && !options.silent) {
        const servers = [...new Set(applied.map((c) => c.server))];
        log.info(`MCP: ${applied.length} change(s) across ${servers.length} server(s). Restart your AI tool session to load them.`);
      }
    } catch (e) {
      log.debug(`[${localConfig.scope}] MCP reconcile skipped: ${(e as Error).message}`);
    }
  }
}
