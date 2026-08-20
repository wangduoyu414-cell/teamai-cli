import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamaiConfigSchema, type LocalConfig } from '../types.js';
import { reconcileManagedInstructions } from '../pull.js';
import { uninstallManagedResources } from '../managed-resources.js';

const tempDirs: string[] = [];

async function fixture(): Promise<{ root: string; home: string; repo: string; project: string }> {
  const root = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-instruction-lifecycle-'));
  tempDirs.push(root);
  const home = path.join(root, 'home');
  const repo = path.join(root, 'repo');
  const project = path.join(root, 'project');
  await fse.ensureDir(repo);
  await fse.ensureDir(project);
  return { root, home, repo, project };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => fse.remove(dir)));
});

describe('instruction lifecycle integration', () => {
  it('reads root AGENTS.md and owns full Codex and Qwen host files in user scope', async () => {
    const { home, repo } = await fixture();
    vi.stubEnv('HOME', home);
    await fse.writeFile(path.join(repo, 'AGENTS.md'), '# Team instructions\nUse the shared workflow.\n');
    await fse.ensureDir(path.join(home, '.codex'));
    await fse.ensureDir(path.join(home, '.qwen'));
    const config = TeamaiConfigSchema.parse({
      team: 'test', repo: 'https://example.test/team.git',
      sharing: { instructions: { source: 'AGENTS.md' } },
      toolPaths: {
        codex: { instruction: '.codex/AGENTS.md' },
        qwen: { instruction: '.qwen/QWEN.md' },
      },
    });
    const localConfig: LocalConfig = {
      repo: { localPath: repo, remote: 'https://example.test/team.git' },
      username: 'test', scope: 'user', additionalRoles: [],
    };

    await reconcileManagedInstructions(config, localConfig, null, 'test');
    expect(await fse.readFile(path.join(home, '.codex/AGENTS.md'), 'utf8')).toContain('Team instructions');
    expect(await fse.readFile(path.join(home, '.qwen/QWEN.md'), 'utf8')).toContain('shared workflow');
  });

  it('uses the independent host probe when the instruction path has a different root', async () => {
    const { home, repo } = await fixture();
    vi.stubEnv('HOME', home);
    await fse.writeFile(path.join(repo, 'AGENTS.md'), '# Team instructions\n');
    await fse.ensureDir(path.join(home, '.codex'));
    const config = TeamaiConfigSchema.parse({
      team: 'test', repo: 'https://example.test/team.git',
      sharing: { instructions: { source: 'AGENTS.md' } },
      toolPaths: {
        codex: { probe: '.codex', skills: '.agents/skills', instruction: '.codex/AGENTS.md' },
      },
    });
    const localConfig: LocalConfig = {
      repo: { localPath: repo, remote: 'https://example.test/team.git' },
      username: 'test', scope: 'user', additionalRoles: [],
    };

    await reconcileManagedInstructions(config, localConfig, null, 'test');
    expect(await fse.readFile(path.join(home, '.codex/AGENTS.md'), 'utf8')).toContain('Team instructions');
  });

  it('updates only the TeamAI block in project AGENTS.md', async () => {
    const { repo, project } = await fixture();
    await fse.writeFile(path.join(repo, 'AGENTS.md'), '# Team v1\n');
    await fse.writeFile(path.join(project, 'AGENTS.md'), '# Local rules\n');
    const config = TeamaiConfigSchema.parse({
      team: 'test', repo: 'https://example.test/team.git',
      sharing: { instructions: { source: 'AGENTS.md' } },
      toolPaths: {},
    });
    const localConfig: LocalConfig = {
      repo: { localPath: repo, remote: 'https://example.test/team.git' },
      username: 'test', scope: 'project', projectRoot: project, additionalRoles: [],
    };

    await reconcileManagedInstructions(config, localConfig, null, 'test');
    await fse.appendFile(path.join(project, 'AGENTS.md'), '\n# Local addition\n');
    await fse.writeFile(path.join(repo, 'AGENTS.md'), '# Team v2\n');
    await reconcileManagedInstructions(config, localConfig, null, 'test');

    const target = path.join(project, 'AGENTS.md');
    expect(await fse.readFile(target, 'utf8')).toContain('# Local addition');
    expect(await fse.readFile(target, 'utf8')).toContain('# Team v2');
    await uninstallManagedResources(path.join(project, '.teamai'));
    expect(await fse.readFile(target, 'utf8')).toContain('# Local addition');
    expect(await fse.readFile(target, 'utf8')).not.toContain('[teamai:instructions:start]');
  });
});
