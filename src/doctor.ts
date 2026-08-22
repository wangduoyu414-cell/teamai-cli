import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { detectProjectConfig, loadLocalConfig, loadTeamConfig } from './config.js';
import { pathExists, readFileSafe } from './utils/fs.js';
import { log } from './utils/logger.js';
import type { GlobalOptions, LocalConfig, Scope } from './types.js';
import {
  TeamaiConfigSchema,
  TEAMAI_ENV_START,
  resolveBaseDir,
  type TeamaiConfig,
} from './types.js';
import { TEAMAI_HOOK_SUBCOMMANDS } from './hooks.js';
import {
  DSH_EXACT_VERSION,
  WORKBUDDY_VALIDATED_VERSION,
  homeDir,
  isHostSelected,
  resolveHostResourcePath,
  resolveHostRoot,
} from './host-adapters.js';
import { getAgentVersion } from './agent-version.js';

interface Check {
  name: string;
  check: () => Promise<boolean>;
  fix?: string;
}

interface SpecialHostDiagnostics {
  checks: Check[];
  notices: string[];
}

async function canonicalSkillNames(repoRoot: string): Promise<string[]> {
  const skillsRoot = path.join(repoRoot, 'skills');
  try {
    const entries = await readdir(skillsRoot, { withFileTypes: true });
    const names: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (await pathExists(path.join(skillsRoot, entry.name, 'SKILL.md'))) names.push(entry.name);
    }
    return names.sort();
  } catch {
    return [];
  }
}

async function filesMatch(left: string, right: string): Promise<boolean> {
  const [leftText, rightText] = await Promise.all([readFileSafe(left), readFileSafe(right)]);
  return leftText !== null && leftText === rightText;
}

async function buildSpecialHostDiagnostics(
  localConfig: LocalConfig | null,
  teamConfig: TeamaiConfig | null,
): Promise<SpecialHostDiagnostics> {
  const diagnostics: SpecialHostDiagnostics = { checks: [], notices: [] };
  if (!localConfig) return diagnostics;

  const selectedHosts = ['workbuddy', 'dsh'].filter((host) => isHostSelected(localConfig, host));
  if (selectedHosts.length === 0) return diagnostics;

  const skillNames = await canonicalSkillNames(localConfig.repo.localPath);
  for (const host of selectedHosts) {
    const root = localConfig.hostRoots?.[host]
      ?? resolveHostRoot(host, localConfig.scope, localConfig.projectRoot);
    const version = await getAgentVersion(host);
    const expectedVersion = host === 'dsh' ? DSH_EXACT_VERSION : WORKBUDDY_VALIDATED_VERSION;
    const displayName = host === 'dsh' ? 'DSH' : 'WorkBuddy';

    diagnostics.notices.push(
      `${displayName} support evidence: synchronized entrypoints are checked here; runtime loading is a separate host smoke check`,
    );
    diagnostics.checks.push(
      {
        name: `${displayName} host root is available (${root ?? 'unresolved'})`,
        check: async () => Boolean(root && await pathExists(root)),
        fix: `Run targeted uninstall, then re-run \`teamai init --agent ${host}\` to bind the current host root`,
      },
      {
        name: `${displayName} version matches ${expectedVersion} (detected: ${version || 'unavailable'})`,
        check: async () => version === expectedVersion,
        fix: host === 'dsh'
          ? `Install DSH ${expectedVersion} before syncing`
          : `Use WorkBuddy ${expectedVersion}, or revalidate the new version before treating it as supported`,
      },
      {
        name: `${displayName} has all ${skillNames.length} canonical Skill entrypoints`,
        check: async () => {
          if (!root || skillNames.length === 0) return false;
          const results = await Promise.all(
            skillNames.map((name) => pathExists(path.join(root, 'skills', name, 'SKILL.md'))),
          );
          return results.every(Boolean);
        },
        fix: 'Run `teamai pull` to restore missing managed Skill entrypoints',
      },
    );

    if (host === 'dsh') {
      const source = teamConfig?.sharing?.instructions?.source;
      const target = resolveHostResourcePath('dsh', 'instructions', localConfig);
      diagnostics.checks.push({
        name: 'DSH managed AGENTS.md matches the canonical instruction source',
        check: async () => Boolean(source && target && await filesMatch(path.join(localConfig.repo.localPath, source), target)),
        fix: 'Run `teamai pull` to restore the managed DSH instruction file',
      });

      const projectInstructions = path.join(process.cwd(), 'AGENTS.md');
      if (localConfig.scope === 'user' && target && await pathExists(projectInstructions)
        && await filesMatch(projectInstructions, target)) {
        diagnostics.notices.push(
          'DSH is loading identical user-level and project-level AGENTS.md content in this workspace; this is safe but duplicates context',
        );
      }
    }
  }
  return diagnostics;
}

/**
 * Build hook checks only for tools whose settings parent directory already
 * exists (i.e. the tool is installed). Tools that are not installed are skipped.
 */
async function buildHookChecks(toolPaths: TeamaiConfig['toolPaths'], baseDir: string): Promise<Check[]> {
  const checks: Check[] = [];
  for (const [tool, paths] of Object.entries(toolPaths)) {
    if (!paths.settings) continue;
    const settingsPath = path.join(baseDir, paths.settings);
    const parentDir = path.dirname(settingsPath);
    if (!await pathExists(parentDir)) continue;
    checks.push({
      name: `teamai hooks in ${tool} settings`,
      check: async () => {
        if (!await pathExists(settingsPath)) return false;
        const content = await readFileSafe(settingsPath);
        if (!content) return false;

        const missing = TEAMAI_HOOK_SUBCOMMANDS.filter(
          (sub) => !content.includes(`teamai ${sub}`),
        );
        return missing.length === 0;
      },
      fix: 'Run `teamai hooks inject` to inject/update hooks',
    });
  }
  return checks;
}

export async function doctor(options: GlobalOptions): Promise<void> {
  log.info('Running diagnostics...\n');
  const projectConfig = await detectProjectConfig();
  const localConfig = projectConfig ?? (await loadLocalConfig());
  const scope: Scope = localConfig?.scope ?? 'user';
  const configPathLabel = projectConfig
    ? `${projectConfig.projectRoot}/.teamai/config.yaml`
    : '~/.teamai/config.yaml';

  console.log(`  Scope: ${scope}${scope === 'project' && localConfig?.projectRoot ? ` (${localConfig.projectRoot})` : ''}\n`);
  const dshSelected = Boolean(localConfig && isHostSelected(localConfig, 'dsh'));
  const workbuddySelected = Boolean(localConfig && isHostSelected(localConfig, 'workbuddy'));
  const dshRoot = dshSelected
    ? localConfig?.hostRoots?.dsh ?? resolveHostRoot('dsh', scope, localConfig?.projectRoot)
    : undefined;
  const workbuddyRoot = workbuddySelected
    ? localConfig?.hostRoots?.workbuddy ?? resolveHostRoot('workbuddy', scope, localConfig?.projectRoot)
    : undefined;
  console.log(`  DSH: ${dshSelected ? `selected (${dshRoot})` : 'not selected'}`);
  console.log(`  WorkBuddy: ${workbuddySelected ? `selected (${workbuddyRoot})` : 'not selected'}`);
  if (dshSelected) {
    console.log(`  DSH shared Agents root: ${process.env.DSH_AGENTS_HOME?.trim() || '~/.agents'} (read-only compatibility path; TeamAI does not manage it as DSH)`);
  }
  console.log('');

  // Try to load team config for dynamic tool paths and provider
  let teamConfig: TeamaiConfig | null = null;
  if (localConfig) {
    teamConfig = await loadTeamConfig(localConfig.repo.localPath);
  }
  // Fall back to schema defaults if team config is unavailable
  const toolPaths = teamConfig?.toolPaths ?? TeamaiConfigSchema.shape.toolPaths.parse(undefined);
  const providerName = teamConfig?.provider ?? 'tgit';
  const baseDir = localConfig ? resolveBaseDir(localConfig) : homeDir();

  const checks: Check[] = [];
  const specialHostDiagnostics = await buildSpecialHostDiagnostics(localConfig, teamConfig);
  for (const notice of specialHostDiagnostics.notices) console.log(`  ⚠ ${notice}`);
  if (specialHostDiagnostics.notices.length > 0) console.log('');

  // Provider-specific checks: gf CLI only needed for TGit, gh CLI for GitHub
  if (providerName === 'tgit') {
    // Dynamic import to avoid loading gf-cli code when not needed
    const { isGfInstalled, gfIsAuthenticated } = await import('./providers/tgit/index.js');
    checks.push(
      {
        name: 'gf CLI is installed',
        check: async () => isGfInstalled(),
        fix: 'Run `teamai init` to install gf CLI automatically',
      },
      {
        name: 'gf CLI is authenticated',
        check: async () => gfIsAuthenticated(),
        fix: 'Run `teamai init` to authenticate via gf auth login',
      },
    );
  } else if (providerName === 'github') {
    // Dynamic import to avoid loading gh-cli code when not needed
    const { isGhInstalled, ghIsAuthenticated } = await import('./providers/github/index.js');
    checks.push(
      {
        name: 'gh CLI is installed',
        check: async () => isGhInstalled(),
        fix: 'Install from https://cli.github.com/ or run `brew install gh`',
      },
      {
        name: 'gh CLI is authenticated',
        check: async () => ghIsAuthenticated(),
        fix: 'Run `gh auth login` to authenticate',
      },
    );
  }

  checks.push(
    {
      name: `Local config exists (${configPathLabel})`,
      check: async () => localConfig !== null,
      fix: 'Run `teamai init` to initialize',
    },
    {
      name: 'Team repo exists locally',
      check: async () => {
        if (!localConfig) return false;
        return pathExists(localConfig.repo.localPath);
      },
      fix: 'Run `teamai init` to clone the team repo',
    },
    {
      name: 'Team config (teamai.yaml) is valid',
      check: async () => {
        if (!localConfig) return false;
        const config = await loadTeamConfig(localConfig.repo.localPath);
        return config !== null;
      },
      fix: 'Check teamai.yaml in team repo for syntax errors',
    },
    ...await buildHookChecks(toolPaths, baseDir),
    {
      name: teamConfig?.sharing?.env?.injectShellProfile === false
        ? 'Env variables are not injected (disabled by team policy)'
        : 'Env variables injected in shell profile',
      check: async () => {
        if (teamConfig?.sharing?.env?.injectShellProfile === false) return true;

        if (!localConfig) return true;
        const envYamlPath = path.join(localConfig.repo.localPath, 'env', 'env.yaml');
        if (!await pathExists(envYamlPath)) return true;

        const home = homeDir();

        const envShPath = path.join(home, '.teamai', 'env.sh');
        if (!await pathExists(envShPath)) return false;

        const shell = process.env.SHELL ?? '';
        const profilePath = shell.includes('zsh')
          ? path.join(home, '.zshrc')
          : path.join(home, '.bashrc');
        if (!await pathExists(profilePath)) return false;
        const content = await readFileSafe(profilePath);
        return content?.includes(TEAMAI_ENV_START) ?? false;
      },
      fix: 'Run `teamai pull` to inject env variables into shell profile',
    },
    ...specialHostDiagnostics.checks,
  );

  let allPassed = true;
  for (const { name, check, fix } of checks) {
    const ok = await check();
    if (ok) {
      console.log(`  ✔ ${name}`);
    } else {
      console.log(`  ✖ ${name}`);
      if (fix) console.log(`    → ${fix}`);
      allPassed = false;
    }
  }

  console.log('');
  if (allPassed) {
    log.success('All checks passed!');
  } else {
    log.warn('Some checks failed. See suggestions above.');
  }
}
