import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { LocalConfig } from './types.js';

/** Hosts whose resource locations are product contracts rather than HOME-relative conventions. */
export const EXPLICIT_ONLY_HOSTS = new Set(['workbuddy', 'dsh']);

export type StaticResourceKind = 'skills' | 'agents' | 'rules' | 'instructions';

const AGENT_ALIASES: Record<string, string> = {
  'deepseek-harness': 'dsh',
  deepseekharness: 'dsh',
};

/** Node's platform-aware home is required on Windows, where HOME is often unset. */
export function homeDir(): string {
  return os.homedir();
}

/** Canonicalize command/config aliases before they participate in selection or ownership. */
export function normalizeHostId(value: string): string {
  const normalized = value.trim().toLowerCase();
  return AGENT_ALIASES[normalized] ?? normalized;
}

function normalizedHostList(values: readonly string[] | undefined): string[] | undefined {
  return values === undefined ? undefined : [...new Set(values.map(normalizeHostId).filter(Boolean))];
}

/**
 * Static materialization selection.  Legacy hosts retain the historical
 * "all installed" default; WorkBuddy and DSH are opt-in even for old configs.
 * A disabled entry always wins.
 */
export function isHostSelected(config: Pick<LocalConfig, 'enabledAgents' | 'disabledAgents'>, tool: string): boolean {
  const host = normalizeHostId(tool);
  const disabled = normalizedHostList(config.disabledAgents) ?? [];
  if (disabled.includes(host)) return false;
  const enabled = normalizedHostList(config.enabledAgents);
  if (EXPLICIT_ONLY_HOSTS.has(host)) return enabled?.includes(host) ?? false;
  return enabled === undefined || enabled.includes(host);
}

/** Do not infer unsupported static channels from WorkBuddy/DSH implementation details. */
export function supportsStaticResource(tool: string, resource: StaticResourceKind, scope: LocalConfig['scope']): boolean {
  const host = normalizeHostId(tool);
  if (host === 'workbuddy') return scope === 'user' && resource === 'skills';
  if (host === 'dsh') {
    if (resource === 'skills') return true;
    return scope === 'user' && resource === 'instructions';
  }
  return true;
}

/** Resolve product-owned roots with the same environment precedence as their hosts. */
export function resolveHostRoot(tool: string, scope: LocalConfig['scope'], projectRoot?: string): string | undefined {
  const host = normalizeHostId(tool);
  if (host === 'workbuddy') {
    if (scope !== 'user') return undefined;
    return path.resolve(process.env.WORKBUDDY_CONFIG_DIR?.trim() || path.join(homeDir(), '.workbuddy'));
  }
  if (host === 'dsh') {
    if (scope === 'project') {
      if (!projectRoot) throw new Error('DSH project root is required for project-scope resources');
      return path.resolve(projectRoot, '.dsh');
    }
    const configured = process.env.DSH_HOME;
    return path.resolve(configured && configured.trim() ? expandHome(configured) : path.join(homeDir(), '.dsh'));
  }
  return undefined;
}

function expandHome(value: string): string {
  if (value === '~') return homeDir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(homeDir(), value.slice(2));
  return value;
}

/** Resolve the one supported static destination for a special host/channel. */
export function resolveHostResourcePath(
  tool: string,
  resource: Extract<StaticResourceKind, 'skills' | 'instructions'>,
  config: LocalConfig,
): string | undefined {
  const host = normalizeHostId(tool);
  const root = config.hostRoots?.[host] ?? resolveHostRoot(host, config.scope, config.projectRoot);
  if (!root || !supportsStaticResource(tool, resource, config.scope)) return undefined;
  return resource === 'skills' ? path.join(root, 'skills') : path.join(root, 'AGENTS.md');
}

function canonicalExistingRoot(host: string, root: string): string {
  try {
    return fs.realpathSync.native(root);
  } catch (error) {
    throw new Error(`${host} host root is unavailable: ${root} (${(error as Error).message})`);
  }
}

/** DSH is preview-only; a materially different binary must never receive managed files. */
export function assertDshExactVersion(): void {
  let output: string;
  try {
    output = execFileSync('dsh', ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // npm exposes command shims as .cmd files on native Windows.
      shell: process.platform === 'win32',
    }).trim();
  } catch (error) {
    throw new Error(`DSH ${DSH_EXACT_VERSION} is required before syncing: ${(error as Error).message}`);
  }
  if (output !== DSH_EXACT_VERSION) {
    throw new Error(`DSH ${DSH_EXACT_VERSION} is required before syncing; detected ${JSON.stringify(output)}`);
  }
}

/** Explicit project init is the only flow allowed to create DSH's project root. */
export function prepareSelectedProjectHostRoots(config: LocalConfig): void {
  if (config.scope !== 'project') return;
  if (isHostSelected(config, 'workbuddy')) {
    throw new Error('WorkBuddy static Skills are supported only in user scope');
  }
  if (isHostSelected(config, 'dsh')) {
    assertDshExactVersion();
    const root = resolveHostRoot('dsh', config.scope, config.projectRoot);
    if (!root) throw new Error('DSH project root is unavailable');
    fs.mkdirSync(root, { recursive: true });
  }
}

/** A persisted root prevents a moved host configuration from receiving writes by surprise. */
export function normalizeHostRoots(config: LocalConfig): LocalConfig {
  const existing = config.hostRoots ?? {};
  const next = { ...existing };
  for (const host of EXPLICIT_ONLY_HOSTS) {
    const selected = isHostSelected(config, host);
    const current = resolveHostRoot(host, config.scope, config.projectRoot);
    if (!current || (!selected && !existing[host])) continue;
    // Saving an unrelated config change must not silently rebind an installed
    // host. Keep a persisted root until an explicit uninstall/rebind workflow.
    if (!selected) {
      next[host] = path.resolve(existing[host]);
      continue;
    }
    const canonical = canonicalExistingRoot(host, current);
    if (existing[host] && path.resolve(existing[host]) !== canonical) {
      throw new Error(`${host} host root changed from ${existing[host]} to ${canonical}; run targeted uninstall before rebinding`);
    }
    if (host === 'dsh') assertDshExactVersion();
    next[host] = canonical;
  }
  return Object.keys(next).length === 0 ? config : { ...config, hostRoots: next };
}

/** Fail before resource writes when the process environment no longer matches persisted host roots. */
export function assertHostRootsStable(config: LocalConfig): void {
  for (const host of EXPLICIT_ONLY_HOSTS) {
    if (!isHostSelected(config, host)) continue;
    if (!config.hostRoots?.[host]) {
      throw new Error(`${host} has no persisted host root; run teamai init --agent ${host} before syncing`);
    }
    const current = resolveHostRoot(host, config.scope, config.projectRoot);
    const persisted = path.resolve(config.hostRoots[host]);
    const canonical = current ? canonicalExistingRoot(host, current) : undefined;
    if (canonical && canonical !== persisted) {
      throw new Error(`${host} host root changed from ${persisted} to ${canonical}; run targeted uninstall before rebinding`);
    }
    if (host === 'dsh') assertDshExactVersion();
  }
}

/** Product version baselines used for warnings and contract tests; no runtime installation is attempted. */
export const DSH_EXACT_VERSION = '0.1.1-rc.1';
export const WORKBUDDY_VALIDATED_VERSION = '5.3.13';
