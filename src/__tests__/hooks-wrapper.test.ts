import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import { fileURLToPath } from 'node:url';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { reconcileHooksToAllTools } from '../hooks.js';

// Verify that reconcileHooksToAllTools (the pull/init main path) creates the
// teamai wrapper at $HOME/.teamai/bin/teamai when workbuddy or codebuddy is present.
//
// resolveTeamaiEntryScript() looks for index.js next to builtin-hooks.ts (src/).
// We create a stub src/index.js so resolution succeeds in the test environment.

const srcDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const stubIndexJs = path.join(srcDir, 'index.js');

describe('reconcileHooksToAllTools — wrapper creation on main inject path', () => {
  let tmp: string;
  let origHome: string | undefined;
  let stubCreated = false;

  beforeEach(async () => {
    tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'hooks-wrapper-'));
    origHome = process.env.HOME;
    process.env.HOME = tmp;

    // Create stub index.js so resolveTeamaiEntryScript() succeeds in test env
    if (!await fse.pathExists(stubIndexJs)) {
      await fse.writeFile(stubIndexJs, '// test stub\n');
      stubCreated = true;
    }
  });

  afterEach(async () => {
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    await fse.remove(tmp);
    if (stubCreated) {
      await fse.remove(stubIndexJs);
      stubCreated = false;
    }
  });

  it('creates a wrapper when codebuddy is in toolPaths', async () => {
    const settingsFile = '.codebuddy/settings.json';
    await fse.ensureDir(path.join(tmp, '.codebuddy'));

    await reconcileHooksToAllTools(
      { codebuddy: { settings: settingsFile } },
      tmp,
      [],
      path.join(tmp, 'managed-hooks.json'),
      {},
    );

    const wrapperPath = path.join(tmp, '.teamai', 'bin', 'teamai');
    expect(await fse.pathExists(wrapperPath)).toBe(true);

    const wrapperContent = await fse.readFile(wrapperPath, 'utf-8');
    expect(wrapperContent).toContain('exec');
    expect(wrapperContent).toContain('index.js');
  });

  it('does not create a hook wrapper for explicit-only WorkBuddy static sync', async () => {
    await fse.ensureDir(path.join(tmp, '.workbuddy'));

    await reconcileHooksToAllTools(
      { workbuddy: { settings: '.workbuddy/settings.json' } },
      tmp,
      [],
      path.join(tmp, 'managed-hooks.json'),
      {},
    );

    expect(await fse.pathExists(path.join(tmp, '.teamai', 'bin', 'teamai'))).toBe(false);
    expect(await fse.pathExists(path.join(tmp, '.workbuddy', 'settings.json'))).toBe(false);
  });

  it('does not throw when neither workbuddy nor codebuddy is present', async () => {
    const toolPaths: Record<string, { settings?: string }> = {
      claude: { settings: '.claude/settings.json' },
    };
    await fse.ensureDir(path.join(tmp, '.claude'));

    await expect(
      reconcileHooksToAllTools(toolPaths, tmp, [], path.join(tmp, 'managed-hooks.json'), {}),
    ).resolves.not.toThrow();
  });
});
