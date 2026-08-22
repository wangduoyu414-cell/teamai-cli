/**
 * Detect the installed version of AI coding agents.
 *
 * Each agent has its own detection strategy:
 *  - CLI-based agents: run `<binary> --version` and parse stdout.
 *  - Electron apps (macOS): read CFBundleShortVersionString from Info.plist.
 *  - WorkBuddy on Windows: read executable/Appx version metadata with PowerShell.
 *  - Fallback: return '' when detection fails (best-effort, never throws).
 */

import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { log } from './utils/logger.js';

const VERSION_CACHE = new Map<string, string>();

async function execVersion(
  bin: string,
  args: string[] = ['--version'],
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 5000, encoding: 'utf8', env: options.env }, (err, stdout) => {
      if (err) {
        resolve('');
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function fileExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

function normalizeDetectedVersion(raw: string): string {
  const match = raw.match(/\d+(?:[.,]\d+){1,3}/);
  if (!match) return raw.trim();
  const parts = match[0].split(/[.,]/);
  while (parts.length > 3 && parts.at(-1) === '0') parts.pop();
  return parts.join('.');
}

async function readPlistVersion(appPath: string): Promise<string> {
  const plistPath = path.join(appPath, 'Contents', 'Info.plist');
  try {
    const content = await readFile(plistPath, 'utf-8');
    const match = content.match(
      /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/,
    );
    return match?.[1] ?? '';
  } catch {
    return '';
  }
}

// ─── Per-agent detection ────────────────────────────────

async function detectClaudeVersion(): Promise<string> {
  const raw = await execVersion('claude');
  // "2.1.199 (Claude Code)" → "2.1.199"
  const match = raw.match(/^([\d.]+)/);
  return match?.[1] ?? raw;
}

async function detectCursorVersion(): Promise<string> {
  // cursor --version outputs multiple lines; version is on the first line
  const raw = await execVersion('cursor');
  return raw.split('\n')[0]?.trim() ?? '';
}

async function detectCodebuddyCliVersion(): Promise<string> {
  return execVersion('codebuddy');
}

const CODEBUDDY_IDE_PATHS = [
  '/Applications/CodeBuddy.app',
  '/Applications/CodeBuddy CN.app',
];

async function detectCodebuddyIdeVersion(): Promise<string> {
  for (const appPath of CODEBUDDY_IDE_PATHS) {
    const ver = await readPlistVersion(appPath);
    if (ver) return ver;
  }
  return '';
}

const WORKBUDDY_APP_PATHS = [
  path.join(os.homedir(), 'Applications', 'WorkBuddy.app'),
  '/Applications/WorkBuddy.app',
];

function workbuddyWindowsExePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates: string[] = [];
  const localAppData = env.LOCALAPPDATA?.trim();
  if (localAppData) {
    candidates.push(
      path.win32.join(localAppData, 'Programs', 'WorkBuddy', 'WorkBuddy.exe'),
      path.win32.join(localAppData, 'WorkBuddy', 'WorkBuddy.exe'),
    );
  }
  for (const value of [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432]) {
    const root = value?.trim();
    if (root) candidates.push(path.win32.join(root, 'WorkBuddy', 'WorkBuddy.exe'));
  }
  return [...new Set(candidates)];
}

async function queryPowerShell(command: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  for (const executable of ['powershell.exe', 'pwsh.exe']) {
    const output = await execVersion(
      executable,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      { env },
    );
    if (output) return output;
  }
  return '';
}

async function detectWorkbuddyWindowsVersion(): Promise<string> {
  for (const candidate of workbuddyWindowsExePaths()) {
    if (!await fileExists(candidate)) continue;
    const output = await queryPowerShell(
      '(Get-Item -LiteralPath $env:TEAMAI_WORKBUDDY_EXE).VersionInfo.ProductVersion',
      { ...process.env, TEAMAI_WORKBUDDY_EXE: candidate },
    );
    if (output) return normalizeDetectedVersion(output);
  }
  const appxVersion = await queryPowerShell(
    "Get-AppxPackage -Name '*WorkBuddy*' | Select-Object -First 1 -ExpandProperty Version",
  );
  return normalizeDetectedVersion(appxVersion);
}

async function detectWorkbuddyVersion(): Promise<string> {
  if (process.platform === 'win32') return detectWorkbuddyWindowsVersion();
  for (const appPath of WORKBUDDY_APP_PATHS) {
    const ver = await readPlistVersion(appPath);
    if (ver) return ver;
  }
  return '';
}

async function detectDshVersion(): Promise<string> {
  const raw = await execVersion('dsh');
  return raw.split(/\s+/)[0]?.trim() ?? '';
}

async function detectHermesVersion(): Promise<string> {
  const raw = await execVersion('hermes');
  // hermes --version may output "(2026.8.7)\nProject: ..." — extract from parens or leading digits.
  const match = raw.match(/^\(?(\d+(?:\.\d+)*)\)?/);
  return match?.[1] ?? '';
}

async function detectOpenclawVersion(): Promise<string> {
  const raw = await execVersion('openclaw');
  const match = raw.match(/^([\d.]+)/);
  return match?.[1] ?? '';
}

// ─── Registry ───────────────────────────────────────────

type VersionDetector = () => Promise<string>;

const DETECTORS: Record<string, VersionDetector> = {
  claude: detectClaudeVersion,
  cursor: detectCursorVersion,
  codebuddy: detectCodebuddyCliVersion,
  'codebuddy-ide': detectCodebuddyIdeVersion,
  workbuddy: detectWorkbuddyVersion,
  dsh: detectDshVersion,
  hermes: detectHermesVersion,
  openclaw: detectOpenclawVersion,
};

/**
 * Detect the version of a given agent. Returns '' on failure.
 * Results are cached for the process lifetime (version won't change mid-session).
 */
export async function getAgentVersion(agentType: string): Promise<string> {
  if (VERSION_CACHE.has(agentType)) return VERSION_CACHE.get(agentType)!;

  const detector = DETECTORS[agentType];
  let version = '';
  if (detector) {
    try {
      version = await detector();
    } catch {
      // best-effort
    }
  }

  VERSION_CACHE.set(agentType, version);
  log.debug(`[agent-version] ${agentType} → "${version}"`);
  return version;
}

/** Clear the version cache (for testing). */
export function clearVersionCache(): void {
  VERSION_CACHE.clear();
}

/** Exposed for testing: version normalization and WorkBuddy platform locations. */
export {
  readPlistVersion as _readPlistVersion,
  normalizeDetectedVersion as _normalizeDetectedVersion,
  WORKBUDDY_APP_PATHS as _workbuddyAppPaths,
  workbuddyWindowsExePaths as _workbuddyWindowsExePaths,
};
