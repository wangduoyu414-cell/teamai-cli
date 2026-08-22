import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import fse from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => '0.1.1-rc.1\n'),
}));

import { SkillsHandler } from '../resources/skills.js';
import { loadManagedResourceManifest, reconcileManagedResources } from '../managed-resources.js';
import { reconcileManagedInstructions, retainMissingUnselectedTargets } from '../pull.js';
import { resolveBaseDir, TeamaiConfigSchema, type LocalConfig, type TeamaiConfig } from '../types.js';
import { assertDshExactVersion, assertHostRootsStable, isHostSelected, normalizeHostId, normalizeHostRoots, prepareSelectedProjectHostRoots } from '../host-adapters.js';

const tempDirs: string[] = [];

async function fixture(): Promise<{ root: string; home: string; repo: string; dsh: string; workbuddy: string }> {
  const root = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai 中文 host '));
  tempDirs.push(root);
  const home = path.join(root, 'home');
  const repo = path.join(root, 'repo');
  const dsh = path.join(root, 'external-dsh');
  const workbuddy = path.join(root, 'external-workbuddy');
  await Promise.all([fse.ensureDir(home), fse.ensureDir(repo), fse.ensureDir(dsh), fse.ensureDir(workbuddy)]);
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  vi.stubEnv('HOME', home);
  return { root, home, repo, dsh, workbuddy };
}

function local(repo: string, enabledAgents: string[], hostRoots: Record<string, string>): LocalConfig {
  return {
    repo: { localPath: repo, remote: 'https://example.test/team.git' },
    username: 'test',
    scope: 'user',
    additionalRoles: [],
    enabledAgents,
    hostRoots: Object.fromEntries(Object.entries(hostRoots).map(([host, root]) => [host, fse.realpathSync.native(root)])),
  };
}

function config(toolPaths: TeamaiConfig['toolPaths']): TeamaiConfig {
  return TeamaiConfigSchema.parse({
    team: 'test', repo: 'https://example.test/team.git',
    sharing: { instructions: { source: 'AGENTS.md' } }, toolPaths,
  });
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fse.remove(dir)));
});

describe('special static hosts', () => {
  it('normalizes DeepSeek Harness aliases and requires an explicit opt-in', () => {
    expect(normalizeHostId('deepseek-harness')).toBe('dsh');
    expect(normalizeHostId('deepseekharness')).toBe('dsh');
    expect(isHostSelected({ enabledAgents: undefined, disabledAgents: undefined } as LocalConfig, 'dsh')).toBe(false);
    expect(isHostSelected({ enabledAgents: ['deepseek-harness'], disabledAgents: undefined } as LocalConfig, 'dsh')).toBe(true);
    expect(isHostSelected({ enabledAgents: ['dsh'], disabledAgents: ['deepseekharness'] } as LocalConfig, 'dsh')).toBe(false);
  });

  it('uses the operating-system home when HOME is absent, including Unicode and spaces', async () => {
    const { home, repo } = await fixture();
    vi.stubEnv('HOME', undefined);
    expect(resolveBaseDir(local(repo, [], {}))).toBe(home);
    expect(home).toMatch(/中文 host /);
  });

  it('rejects a DSH binary that is not the exact supported version before a sync can write', () => {
    vi.mocked(execFileSync).mockReturnValueOnce('0.1.1-rc.2\n');
    expect(() => assertDshExactVersion()).toThrow('DSH 0.1.1-rc.1 is required before syncing');
    expect(execFileSync).toHaveBeenCalledWith('dsh', ['--version'], expect.objectContaining({ encoding: 'utf8' }));
  });

  it('writes DSH skills and its exact user AGENTS.md under a persisted custom DSH_HOME', async () => {
    const { repo, dsh } = await fixture();
    vi.stubEnv('DSH_HOME', dsh);
    await fse.outputFile(path.join(repo, 'skills', 'example', 'SKILL.md'), '---\nname: example\ndescription: example\n---\n\nUse it.\n');
    await fse.writeFile(path.join(repo, 'AGENTS.md'), '# Team instructions\n');
    const localConfig = local(repo, ['deepseek-harness'], { dsh });
    const teamConfig = config({ dsh: { probe: '.dsh', skills: '.dsh/skills', instruction: '.dsh/AGENTS.md' } });

    const resource = await new SkillsHandler().buildManagedResource({
      name: 'example', type: 'skills', sourcePath: path.join(repo, 'skills', 'example'), relativePath: 'skills/example',
    }, teamConfig, localConfig);
    await reconcileManagedResources(path.join(os.homedir(), '.teamai'), [resource], { pruneTypes: ['skills'] });
    await reconcileManagedInstructions(teamConfig, localConfig, null, 'test');

    expect(await fse.pathExists(path.join(dsh, 'skills', 'example', 'SKILL.md'))).toBe(true);
    expect(await fse.readFile(path.join(dsh, 'AGENTS.md'), 'utf8')).toContain('Team instructions');
    const manifest = await loadManagedResourceManifest(path.join(os.homedir(), '.teamai'));
    expect(manifest.resources['skills:example'].targets[0]).toMatchObject({ tool: 'dsh', hostRoot: localConfig.hostRoots!.dsh });
    expect(manifest.resources['instructions:dsh'].targets[0]).toMatchObject({ tool: 'dsh', hostRoot: localConfig.hostRoots!.dsh });
  });

  it('allows WorkBuddy skills only in user scope and under its persisted root', async () => {
    const { repo, workbuddy } = await fixture();
    vi.stubEnv('WORKBUDDY_CONFIG_DIR', workbuddy);
    await fse.outputFile(path.join(repo, 'skills', 'example', 'SKILL.md'), '---\nname: example\ndescription: example\n---\n\nUse it.\n');
    const localConfig = local(repo, ['workbuddy'], { workbuddy });
    const teamConfig = config({ workbuddy: { probe: '.workbuddy', skills: '.workbuddy/skills' } });
    const resource = await new SkillsHandler().buildManagedResource({
      name: 'example', type: 'skills', sourcePath: path.join(repo, 'skills', 'example'), relativePath: 'skills/example',
    }, teamConfig, localConfig);
    await reconcileManagedResources(path.join(os.homedir(), '.teamai'), [resource], { pruneTypes: ['skills'] });
    expect(await fse.pathExists(path.join(workbuddy, 'skills', 'example', 'SKILL.md'))).toBe(true);
  });

  it('creates only the explicit DSH project root and rejects project WorkBuddy', async () => {
    const { root, repo } = await fixture();
    const project = path.join(root, 'project');
    await fse.ensureDir(project);
    const dshConfig: LocalConfig = {
      repo: { localPath: repo, remote: 'https://example.test/team.git' },
      username: 'test', scope: 'project', projectRoot: project, additionalRoles: [], enabledAgents: ['dsh'],
    };
    prepareSelectedProjectHostRoots(dshConfig);
    expect(await fse.pathExists(path.join(project, '.dsh'))).toBe(true);
    expect(normalizeHostRoots(dshConfig).hostRoots?.dsh).toBe(fse.realpathSync.native(path.join(project, '.dsh')));

    const workbuddyConfig: LocalConfig = { ...dshConfig, enabledAgents: ['workbuddy'], hostRoots: undefined };
    expect(() => prepareSelectedProjectHostRoots(workbuddyConfig)).toThrow('supported only in user scope');
    expect(await fse.pathExists(path.join(project, '.workbuddy'))).toBe(false);
  });

  it('preserves an unselected managed target and its ledger record during allowlist narrowing', async () => {
    const { home } = await fixture();
    const lifecycleHome = path.join(home, '.teamai');
    const codex = path.join(home, '.codex', 'skills', 'example');
    const claude = path.join(home, '.claude', 'skills', 'example');
    const source = path.join(home, 'source');
    await fse.outputFile(path.join(source, 'SKILL.md'), '---\nname: example\ndescription: example\n---\n');
    await reconcileManagedResources(lifecycleHome, [{
      id: 'skills:example', type: 'skills',
      targets: [
        { path: codex, kind: 'directory', tool: 'codex', sourcePath: source },
        { path: claude, kind: 'directory', tool: 'claude', sourcePath: source },
      ],
    }], { pruneTypes: ['skills'] });
    await reconcileManagedResources(lifecycleHome, [{
      id: 'skills:example', type: 'skills',
      targets: [{ path: codex, kind: 'directory', tool: 'codex', sourcePath: source }],
      retainTargetPaths: [claude],
    }], { pruneTypes: ['skills'] });
    expect(await fse.pathExists(claude)).toBe(true);
    expect((await loadManagedResourceManifest(lifecycleHome)).resources['skills:example'].targets.map((target) => target.path)).toContain(claude);
  });

  it('retains missing upstream resources only for hosts excluded from the pull', async () => {
    const { home } = await fixture();
    const lifecycleHome = path.join(home, '.teamai');
    const codexSkill = path.join(home, '.agents', 'skills', 'removed-skill');
    const dshSkill = path.join(home, '.dsh', 'skills', 'removed-skill');
    const source = path.join(home, 'source');
    await fse.outputFile(path.join(source, 'SKILL.md'), 'skill');
    await reconcileManagedResources(lifecycleHome, [{
      id: 'skills:removed-skill', type: 'skills', targets: [
        { path: codexSkill, kind: 'directory', tool: 'codex', sourcePath: source },
        { path: dshSkill, kind: 'directory', tool: 'dsh', hostRoot: path.join(home, '.dsh'), sourcePath: source },
      ],
    }], { pruneTypes: ['skills'] });

    const localConfig = local(path.join(home, 'repo'), ['codex'], { dsh: path.join(home, '.dsh') });
    const desired = await retainMissingUnselectedTargets(lifecycleHome, 'skills', [], localConfig);
    await reconcileManagedResources(lifecycleHome, desired, { pruneTypes: ['skills'] });

    expect(await fse.pathExists(codexSkill)).toBe(false);
    expect(await fse.pathExists(dshSkill)).toBe(true);
    expect((await loadManagedResourceManifest(lifecycleHome)).resources['skills:removed-skill'].targets)
      .toEqual([expect.objectContaining({ tool: 'dsh', path: dshSkill })]);
  });

  it('retains an unselected Agent target with its backup metadata instead of pruning it', async () => {
    const { home } = await fixture();
    const lifecycleHome = path.join(home, '.teamai');
    const codex = path.join(home, '.codex', 'agents', 'example.toml');
    const claude = path.join(home, '.claude', 'agents', 'example.md');
    await reconcileManagedResources(lifecycleHome, [{
      id: 'agents:example', type: 'agents',
      targets: [
        { path: codex, kind: 'file', tool: 'codex', content: 'codex' },
        { path: claude, kind: 'file', tool: 'claude', content: 'claude' },
      ],
    }], { pruneTypes: ['agents'] });
    await reconcileManagedResources(lifecycleHome, [{
      id: 'agents:example', type: 'agents',
      targets: [{ path: codex, kind: 'file', tool: 'codex', content: 'codex' }],
      retainTargetPaths: [claude],
    }], { pruneTypes: ['agents'] });
    expect(await fse.readFile(claude, 'utf8')).toBe('claude');
    expect((await loadManagedResourceManifest(lifecycleHome)).resources['agents:example'].targets.map((target) => target.path)).toContain(claude);
  });

  it('fails before writes when a selected host root drifts, but keeps a persisted old root representable', async () => {
    const { repo, dsh } = await fixture();
    const moved = path.join(dsh, 'moved');
    await fse.ensureDir(moved);
    vi.stubEnv('DSH_HOME', moved);
    const localConfig = local(repo, ['dsh'], { dsh });
    expect(() => assertHostRootsStable(localConfig)).toThrow('host root changed');
  });

  it('fails closed for a legacy external DSH target with no trusted host root', async () => {
    const { home } = await fixture();
    const lifecycleHome = path.join(home, '.teamai');
    await fse.ensureDir(lifecycleHome);
    await fse.writeJson(path.join(lifecycleHome, 'managed-resources.json'), {
      version: 1,
      resources: {
        'skills:example': {
          id: 'skills:example', type: 'skills', targets: [{
            path: path.join(home, '..', 'outside', 'skills', 'example'), kind: 'directory', tool: 'dsh',
            hash: '0'.repeat(64), ownership: 'created',
          }],
        },
      },
    });
    await expect(loadManagedResourceManifest(lifecycleHome)).rejects.toThrow('Only OpenClaw skills may use an external managed target');
  });
});
