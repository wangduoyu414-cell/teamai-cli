import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('node:child_process', () => ({ spawnSync: vi.fn(), execSync: vi.fn() }));
vi.mock('cross-spawn', () => ({ default: { sync: vi.fn() } }));
vi.mock('../utils/cli-path.js', () => ({ resolveCliPath: vi.fn() }));
import { spawnSync, execSync } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import { resolveCliPath } from '../utils/cli-path.js';
import { isGhInstalled, ghRepoClone } from '../providers/github/gh-cli.js';
afterEach(() => vi.resetAllMocks());
describe('portable GitHub sync', () => {
  it('uses the platform-native CLI resolver without shell command interpolation', () => {
    vi.mocked(resolveCliPath).mockReturnValue('/native/gh');
    expect(isGhInstalled()).toBe(true);
    expect(resolveCliPath).toHaveBeenCalledWith('gh');
    expect(execSync).not.toHaveBeenCalled();
  });
  it('reports a missing executable', () => {
    vi.mocked(resolveCliPath).mockReturnValue(null);
    expect(isGhInstalled()).toBe(false);
  });
  it('clones with separate arguments and keeps credentials out of the URL', () => {
    vi.mocked(resolveCliPath).mockReturnValue('/native/gh');
    vi.mocked(crossSpawn.sync).mockReturnValue({ status: 0, stdout: '', stderr: '' } as never);
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: '', stderr: '' } as never);
    const destination = 'C:/Users/中文 空格/skills';
    ghRepoClone('owner/repo', destination);
    expect(crossSpawn.sync).toHaveBeenCalledWith('/native/gh', ['repo', 'clone', 'owner/repo', destination], expect.anything());
    expect(spawnSync).toHaveBeenCalledWith('git', ['-C', destination, 'config', '--local', '--add', 'credential.https://github.com.helper', '!gh auth git-credential'], expect.anything());
    expect(execSync).not.toHaveBeenCalled();
  });
});
