import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { pathExists, readFileSafe } from './utils/fs.js';
import type { LocalConfig, Scope, TeamaiConfig } from './types.js';
import type { Check } from './doctor.js';
import { DSH_EXACT_VERSION, WORKBUDDY_VALIDATED_VERSION, isHostSelected, resolveHostResourcePath, resolveHostRoot } from './host-adapters.js';
import { getAgentVersion } from './agent-version.js';

export interface DoctorHostReport {
  selected: boolean;
  root: string | null;
  detectedVersion: string | null;
  expectedVersion: string;
  managedResources: string[];
  runtimeSmoke: 'manual' | 'opt-in-read-only';
}

interface SpecialHostDiagnostics {
  checks: Array<Check & { id: string }>;
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

export async function buildSpecialHostReports(localConfig: LocalConfig | null): Promise<Record<'workbuddy' | 'dsh', DoctorHostReport>> {
  const scope: Scope = localConfig?.scope ?? 'user';
  const build = async (host: 'workbuddy' | 'dsh'): Promise<DoctorHostReport> => {
    const selected = Boolean(localConfig && isHostSelected(localConfig, host));
    const root = selected
      ? localConfig?.hostRoots?.[host] ?? resolveHostRoot(host, scope, localConfig?.projectRoot) ?? null
      : null;
    const detectedVersion = selected ? await getAgentVersion(host) || null : null;
    return {
      selected,
      root,
      detectedVersion,
      expectedVersion: host === 'dsh' ? DSH_EXACT_VERSION : WORKBUDDY_VALIDATED_VERSION,
      managedResources: host === 'dsh' && scope === 'user' ? ['skills', 'instructions'] : ['skills'],
      runtimeSmoke: host === 'dsh' ? 'opt-in-read-only' : 'manual',
    };
  };
  const [workbuddy, dsh] = await Promise.all([build('workbuddy'), build('dsh')]);
  return { workbuddy, dsh };
}

export async function buildSpecialHostDiagnostics(
  localConfig: LocalConfig | null,
  teamConfig: TeamaiConfig | null,
  hosts: Record<'workbuddy' | 'dsh', DoctorHostReport>,
): Promise<SpecialHostDiagnostics> {
  const diagnostics: SpecialHostDiagnostics = { checks: [], notices: [] };
  if (!localConfig) return diagnostics;

  const selectedHosts = (['workbuddy', 'dsh'] as const).filter((host) => hosts[host].selected);
  if (selectedHosts.length === 0) return diagnostics;

  const skillNames = await canonicalSkillNames(localConfig.repo.localPath);
  for (const host of selectedHosts) {
    const { root, detectedVersion: version, expectedVersion } = hosts[host];
    const displayName = host === 'dsh' ? 'DSH' : 'WorkBuddy';

    diagnostics.notices.push(
      `${displayName}: selected (${root ?? "unresolved"})`,
      `${displayName} support evidence: synchronized entrypoints are checked here; runtime loading is a separate host smoke check`,
    );
    diagnostics.checks.push(
      {
        source: 'local',
        id: `host.${host}.root`,
        name: `${displayName} host root is available (${root ?? 'unresolved'})`,
        check: async () => Boolean(root && await pathExists(root)),
        fix: `Run targeted uninstall, then re-run \`teamai init --agent ${host}\` to bind the current host root`,
      },
      {
        source: 'local',
        id: `host.${host}.version`,
        name: `${displayName} version matches ${expectedVersion} (detected: ${version ?? 'unavailable'})`,
        check: async () => version === expectedVersion,
        fix: host === 'dsh'
          ? `Install DSH ${expectedVersion} before syncing`
          : `Use WorkBuddy ${expectedVersion}, or revalidate the new version before treating it as supported`,
      },
      {
        source: 'local',
        id: `host.${host}.skills`,
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
        source: 'local',
        id: 'host.dsh.instructions',
        name: 'DSH managed AGENTS.md matches the canonical instruction source',
        check: async () => Boolean(source && target && await filesMatch(path.join(localConfig.repo.localPath, source), target)),
        fix: 'Run `teamai pull` to restore the managed DSH instruction file',
      });

      const projectInstructions = path.join(process.cwd(), 'AGENTS.md');
      if (localConfig.scope === 'user' && target && await pathExists(projectInstructions)
        && await filesMatch(projectInstructions, target)) {
        diagnostics.notices.push(
      `${displayName}: selected (${root ?? "unresolved"})`,
          'Identical user-level and project-level AGENTS.md files exist in this workspace; TeamAI does not infer duplicate DSH runtime loading from file presence alone',
        );
      }
    }
  }
  return diagnostics;
}
