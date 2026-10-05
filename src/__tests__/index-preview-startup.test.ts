import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Runtime discovery logs on Windows before the command action starts. Exercise
// that startup boundary on every platform with the real file logger.
vi.mock('../bundled-runtime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../bundled-runtime.js')>();
  const { log } = await import('../utils/logger.js');
  return { ...actual, ensureBundledRuntimeOnPath: vi.fn(() => log.debug('runtime discovery')) };
});
vi.mock('../init.js', () => ({ init: vi.fn(async () => {}) }));
vi.mock('../mcp-cmd.js', () => ({ mcpInject: vi.fn(async () => {}) }));
vi.mock('../migrate.js', () => ({ maybeMigrate: vi.fn(async () => undefined), queueKeptInCheckout: vi.fn(async () => null) }));

import { ensureBundledRuntimeOnPath } from '../bundled-runtime.js';
import { _resetState } from '../utils/logger.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-preview-startup-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('TEAMAI_COMMAND_TABLE_ONLY', '1');
  _resetState();
  vi.mocked(ensureBundledRuntimeOnPath).mockClear();
});
afterEach(() => {
  _resetState();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('CLI preview startup', () => {
  it.each(['--plan', '--dry-run', 'write'])('prepares the runtime under the %s logging policy', async (mode) => {
    const { program } = await import('../index.js');
    program.setOptionValue('plan', false).setOptionValue('dryRun', false);
    await program.parseAsync(['node', 'teamai', ...(mode === 'write' ? [] : [mode]), 'init', 'acme/team', '--scope', 'user']);
    expect(ensureBundledRuntimeOnPath).toHaveBeenCalledOnce();
    if (mode === 'write') {
      expect(fs.readFileSync(path.join(home, '.teamai/debug.log'), 'utf8')).toContain('runtime discovery');
    } else {
      expect(fs.readdirSync(home)).toEqual([]);
    }
  });

  it.each(['--plan', '--dry-run'])('honors a subcommand-local %s before startup and forwards dryRun', async (flag) => {
    const { program } = await import('../index.js');
    program.setOptionValue('plan', false).setOptionValue('dryRun', false);
    await program.parseAsync(['node', 'teamai', 'mcp', 'inject', flag]);
    expect(ensureBundledRuntimeOnPath).toHaveBeenCalledOnce();
    expect(fs.readdirSync(home)).toEqual([]);
    const { mcpInject } = await import('../mcp-cmd.js');
    expect(mcpInject).toHaveBeenLastCalledWith(expect.objectContaining({ dryRun: true }));
  });
});
