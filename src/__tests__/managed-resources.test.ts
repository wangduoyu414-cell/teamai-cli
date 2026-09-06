import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadManagedResourceManifest,
  reconcileManagedResources,
  recoverManagedResourceTransaction,
  uninstallManagedResources,
  type DesiredManagedResource,
} from '../managed-resources.js';

const tempDirs: string[] = [];

async function fixture(): Promise<{ root: string; home: string }> {
  const root = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-managed-resources-'));
  tempDirs.push(root);
  const home = path.join(root, '.teamai');
  return { root, home };
}

function file(id: string, destination: string, content: string): DesiredManagedResource {
  return { id, type: 'agents', targets: [{ path: destination, kind: 'file', content }] };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fse.remove(dir)));
});

describe('managed resource lifecycle', () => {
  it('adopts an identical existing resource without taking a backup', async () => {
    const { root, home } = await fixture();
    const target = path.join(root, 'agent.md');
    await fse.writeFile(target, 'same');

    await reconcileManagedResources(home, [file('agents:a', target, 'same')], { pruneTypes: ['agents'] });

    const manifest = await loadManagedResourceManifest(home);
    expect(manifest.resources['agents:a'].targets[0].ownership).toBe('adopted');
    expect(manifest.resources['agents:a'].targets[0].backupPath).toBeUndefined();
  });

  it('removes an unchanged adopted target during rename and uninstall', async () => {
    const { root, home } = await fixture();
    const adopted = path.join(root, 'adopted.md');
    const renamed = path.join(root, 'renamed.md');
    await fse.writeFile(adopted, 'same');
    await reconcileManagedResources(home, [file('agents:a', adopted, 'same')], { pruneTypes: ['agents'] });
    await reconcileManagedResources(home, [file('agents:a', renamed, 'new')], { pruneTypes: ['agents'] });
    expect(await fse.pathExists(adopted)).toBe(false);

    await uninstallManagedResources(home);
    expect(await fse.pathExists(renamed)).toBe(false);
  });

  it('backs up an unrelated target, then restores and removes that backup on uninstall', async () => {
    const { root, home } = await fixture();
    const target = path.join(root, 'agent.md');
    await fse.writeFile(target, 'user original');

    await reconcileManagedResources(home, [file('agents:a', target, 'team version')], { pruneTypes: ['agents'] });
    const manifest = await loadManagedResourceManifest(home);
    const backupPath = manifest.resources['agents:a'].targets[0].backupPath!;
    expect(await fse.readFile(target, 'utf8')).toBe('team version');
    expect(await fse.readFile(backupPath, 'utf8')).toBe('user original');

    await uninstallManagedResources(home);
    expect(await fse.readFile(target, 'utf8')).toBe('user original');
    expect(await fse.pathExists(backupPath)).toBe(false);
  });

  it('restores an unrelated target and removes its new backup when apply rolls back', async () => {
    const { root, home } = await fixture();
    const target = path.join(root, 'agent.md');
    await fse.writeFile(target, 'user original');

    await expect(reconcileManagedResources(home, [file('agents:a', target, 'team version')], {
      pruneTypes: ['agents'], failAfterApply: 1,
    })).rejects.toThrow('Injected managed-resource failure');

    expect(await fse.readFile(target, 'utf8')).toBe('user original');
    expect(await fse.readdir(path.join(home, 'managed-resource-backups'))).toEqual([]);
    expect((await loadManagedResourceManifest(home)).resources).toEqual({});
  });

  it('blocks uninstall when a required original backup is missing', async () => {
    const { root, home } = await fixture();
    const target = path.join(root, 'agent.md');
    await fse.writeFile(target, 'user original');
    await reconcileManagedResources(home, [file('agents:a', target, 'team version')], { pruneTypes: ['agents'] });
    const manifest = await loadManagedResourceManifest(home);
    await fse.remove(manifest.resources['agents:a'].targets[0].backupPath!);

    await expect(uninstallManagedResources(home)).rejects.toThrow('backup is missing or corrupt');
    expect(await fse.readFile(target, 'utf8')).toBe('team version');
    expect((await loadManagedResourceManifest(home)).resources['agents:a']).toBeDefined();
  });

  it('blocks uninstall when a required original backup was modified', async () => {
    const { root, home } = await fixture();
    const target = path.join(root, 'agent.md');
    await fse.writeFile(target, 'user original');
    await reconcileManagedResources(home, [file('agents:a', target, 'team version')], { pruneTypes: ['agents'] });
    const manifest = await loadManagedResourceManifest(home);
    await fse.writeFile(manifest.resources['agents:a'].targets[0].backupPath!, 'tampered');

    await expect(uninstallManagedResources(home)).rejects.toThrow('backup is missing or corrupt');
    expect(await fse.readFile(target, 'utf8')).toBe('team version');
  });

  it('preserves a locally modified managed target and keeps its ledger record', async () => {
    const { root, home } = await fixture();
    const target = path.join(root, 'agent.md');
    await reconcileManagedResources(home, [file('agents:a', target, 'v1')], { pruneTypes: ['agents'] });
    await fse.writeFile(target, 'local edit');

    const result = await reconcileManagedResources(home, [file('agents:a', target, 'v2')], { pruneTypes: ['agents'] });
    expect(result.conflicts).toHaveLength(1);
    expect(await fse.readFile(target, 'utf8')).toBe('local edit');

    const uninstall = await uninstallManagedResources(home);
    expect(uninstall.conflicts).toHaveLength(1);
    expect((await loadManagedResourceManifest(home)).resources['agents:a']).toBeDefined();
  });

  it('removes stale targets when a resource target is renamed', async () => {
    const { root, home } = await fixture();
    const oldTarget = path.join(root, 'old.md');
    const newTarget = path.join(root, 'new.md');
    await reconcileManagedResources(home, [file('agents:a', oldTarget, 'v1')], { pruneTypes: ['agents'] });
    await reconcileManagedResources(home, [file('agents:a', newTarget, 'v2')], { pruneTypes: ['agents'] });

    expect(await fse.pathExists(oldTarget)).toBe(false);
    expect(await fse.readFile(newTarget, 'utf8')).toBe('v2');
  });

  it('replaces a managed directory atomically and removes deleted deep files', async () => {
    const { root, home } = await fixture();
    const sourceV1 = path.join(root, 'source-v1');
    const sourceV2 = path.join(root, 'source-v2');
    const target = path.join(root, 'skill');
    await fse.outputFile(path.join(sourceV1, 'nested', 'old.md'), 'old');
    await fse.outputFile(path.join(sourceV2, 'nested', 'new.md'), 'new');
    const resource = (sourcePath: string): DesiredManagedResource => ({
      id: 'skills:deep', type: 'skills', targets: [{ path: target, kind: 'directory', sourcePath }],
    });

    await reconcileManagedResources(home, [resource(sourceV1)], { pruneTypes: ['skills'] });
    await reconcileManagedResources(home, [resource(sourceV2)], { pruneTypes: ['skills'] });
    expect(await fse.pathExists(path.join(target, 'nested', 'old.md'))).toBe(false);
    expect(await fse.readFile(path.join(target, 'nested', 'new.md'), 'utf8')).toBe('new');

    await reconcileManagedResources(home, [], { pruneTypes: ['skills'] });
    expect(await fse.pathExists(target)).toBe(false);
  });

  it('rejects ambiguous duplicate ownership before writing', async () => {
    const { root, home } = await fixture();
    const target = path.join(root, 'agent.md');
    await expect(reconcileManagedResources(home, [
      file('agents:a', target, 'a'),
      file('agents:b', target, 'b'),
    ])).rejects.toThrow('claimed by both');
    expect(await fse.pathExists(home)).toBe(false);
  });

  it('keeps a locally modified old target in the manifest during a same-id rename', async () => {
    const { root, home } = await fixture();
    const oldTarget = path.join(root, 'old.md');
    const newTarget = path.join(root, 'new.md');
    await reconcileManagedResources(home, [file('agents:a', oldTarget, 'v1')], { pruneTypes: ['agents'] });
    await fse.writeFile(oldTarget, 'local edit');

    const result = await reconcileManagedResources(home, [file('agents:a', newTarget, 'v2')], { pruneTypes: ['agents'] });
    expect(result.conflicts).toHaveLength(1);
    expect((await loadManagedResourceManifest(home)).resources['agents:a'].targets.map((target) => target.path))
      .toEqual(expect.arrayContaining([oldTarget, newTarget]));
  });

  it('transfers a reused target to a renamed resource id without duplicate ownership', async () => {
    const { root, home } = await fixture();
    const target = path.join(root, 'agent.md');
    await reconcileManagedResources(home, [file('agents:old', target, 'v1')], { pruneTypes: ['agents'] });
    await reconcileManagedResources(home, [file('agents:new', target, 'v2')], { pruneTypes: ['agents'] });

    const manifest = await loadManagedResourceManifest(home);
    expect(manifest.resources['agents:old']).toBeUndefined();
    expect(manifest.resources['agents:new'].targets.map((entry) => entry.path)).toEqual([target]);
  });

  it('updates and uninstalls only a project instruction marker block', async () => {
    const { root, home } = await fixture();
    const target = path.join(root, 'AGENTS.md');
    const section = { start: '<!-- [teamai:instructions:start] -->', end: '<!-- [teamai:instructions:end] -->' };
    const managed = (body: string): DesiredManagedResource => ({
      id: 'instructions:project-agents',
      type: 'instructions',
      targets: [{ path: target, kind: 'file', section, content: `${section.start}\n${body}\n${section.end}` }],
    });
    await fse.writeFile(target, '# User rules\n');
    await reconcileManagedResources(home, [managed('team v1')], { pruneTypes: ['instructions'] });
    await fse.writeFile(target, `# User rules changed\n\n${await fse.readFile(target, 'utf8')}`);

    await reconcileManagedResources(home, [managed('team v2')], { pruneTypes: ['instructions'] });
    const updated = await fse.readFile(target, 'utf8');
    expect(updated).toContain('# User rules changed');
    expect(updated).toContain('team v2');

    await uninstallManagedResources(home);
    const uninstalled = await fse.readFile(target, 'utf8');
    expect(uninstalled).toContain('# User rules changed');
    expect(uninstalled).not.toContain(section.start);
  });

  it('removes an otherwise-empty project instruction file with its last managed section', async () => {
    const { root, home } = await fixture();
    const target = path.join(root, 'AGENTS.md');
    const section = { start: '<!-- [teamai:instructions:start] -->', end: '<!-- [teamai:instructions:end] -->' };
    await reconcileManagedResources(home, [{
      id: 'instructions:project-agents',
      type: 'instructions',
      targets: [{ path: target, kind: 'file', section, content: `${section.start}\nteam\n${section.end}` }],
    }], { pruneTypes: ['instructions'] });

    await uninstallManagedResources(home);
    expect(await fse.pathExists(target)).toBe(false);
  });

  it('preserves a pre-existing empty project instruction file after removing its managed section', async () => {
    const { root, home } = await fixture();
    const target = path.join(root, 'AGENTS.md');
    const section = { start: '<!-- [teamai:instructions:start] -->', end: '<!-- [teamai:instructions:end] -->' };
    await fse.writeFile(target, '');
    await reconcileManagedResources(home, [{
      id: 'instructions:project-agents',
      type: 'instructions',
      targets: [{ path: target, kind: 'file', section, content: `${section.start}\nteam\n${section.end}` }],
    }], { pruneTypes: ['instructions'] });

    await uninstallManagedResources(home);
    expect(await fse.pathExists(target)).toBe(true);
    expect(await fse.readFile(target, 'utf8')).toBe('');
  });

  it('rolls every already-replaced target back when a later replacement fails', async () => {
    const { root, home } = await fixture();
    const first = path.join(root, 'first.md');
    const second = path.join(root, 'second.md');

    await expect(reconcileManagedResources(home, [
      file('agents:first', first, 'first'),
      file('agents:second', second, 'second'),
    ], { pruneTypes: ['agents'], failAfterApply: 2 })).rejects.toThrow('Injected managed-resource failure');

    expect(await fse.pathExists(first)).toBe(false);
    expect(await fse.pathExists(second)).toBe(false);
    expect((await loadManagedResourceManifest(home)).resources).toEqual({});
  });

  it('recovers a crashed applying journal by restoring the previous target', async () => {
    const { root, home } = await fixture();
    const target = path.join(root, 'agent.md');
    const rollbackRoot = path.join(root, '.teamai-rollback-crashed-a');
    const previous = path.join(rollbackRoot, 'previous');
    await fse.ensureDir(rollbackRoot);
    await fse.writeFile(previous, 'old');
    await fse.writeFile(target, 'new');
    await fse.ensureDir(home);
    await fse.writeJson(path.join(home, 'managed-resources.journal.json'), {
      version: 1,
      transactionId: 'crashed',
      status: 'applying',
      resourceIds: ['agents:a'],
      operations: [{
        target, previous, rollbackRoot, hadPrevious: true, previousKind: 'file',
        previousHash: crypto.createHash('sha256').update('old').digest('hex'), phase: 'applied',
      }],
      stagedRoots: [],
      createdBackups: [],
      backupCleanup: [],
      updatedAt: new Date().toISOString(),
    });

    await recoverManagedResourceTransaction(home);
    expect(await fse.readFile(target, 'utf8')).toBe('old');
    expect((await fse.readJson(path.join(home, 'managed-resources.journal.json'))).status).toBe('rolled-back');
  });

  it('treats a manifest-matching interrupted journal as committed and keeps the target', async () => {
    const { root, home } = await fixture();
    const target = path.join(root, 'agent.md');
    await fse.writeFile(target, 'new');
    const manifest = { version: 1, resources: {} };
    const serialised = JSON.stringify(manifest, null, 2) + '\n';
    await fse.ensureDir(home);
    await fse.writeFile(path.join(home, 'managed-resources.json'), serialised);
    await fse.writeJson(path.join(home, 'managed-resources.journal.json'), {
      version: 1,
      transactionId: 'committed',
      status: 'applying',
      resourceIds: [],
      operations: [],
      stagedRoots: [],
      createdBackups: [],
      backupCleanup: [],
      nextManifestHash: crypto.createHash('sha256').update(serialised).digest('hex'),
      updatedAt: new Date().toISOString(),
    });

    await recoverManagedResourceTransaction(home);
    expect(await fse.readFile(target, 'utf8')).toBe('new');
    expect((await fse.readJson(path.join(home, 'managed-resources.journal.json'))).status).toBe('completed');
  });

  it('keeps rollback evidence and the applying journal when restoration is impossible', async () => {
    const { root, home } = await fixture();
    const target = path.join(root, 'agent.md');
    const rollbackRoot = path.join(root, '.teamai-rollback-broken-rollback-a');
    const previous = path.join(rollbackRoot, 'previous');
    await fse.writeFile(target, 'new');
    await fse.ensureDir(home);
    await fse.writeJson(path.join(home, 'managed-resources.journal.json'), {
      version: 1,
      transactionId: 'broken-rollback',
      status: 'applying',
      resourceIds: ['agents:a'],
      operations: [{
        target, previous, rollbackRoot, hadPrevious: true, previousKind: 'file',
        previousHash: crypto.createHash('sha256').update('old').digest('hex'), phase: 'applied',
      }],
      stagedRoots: [],
      createdBackups: [],
      backupCleanup: [],
      updatedAt: new Date().toISOString(),
    });

    await expect(recoverManagedResourceTransaction(home)).rejects.toThrow('rollback incomplete');
    expect((await fse.readJson(path.join(home, 'managed-resources.journal.json'))).status).toBe('applying');
  });

  it('persists partial rollback progress so a later recovery can finish', async () => {
    const { root, home } = await fixture();
    const targetA = path.join(root, 'a.md');
    const targetB = path.join(root, 'b.md');
    const rollbackA = path.join(root, '.teamai-rollback-retry-a');
    const rollbackB = path.join(root, '.teamai-rollback-retry-b');
    const previousA = path.join(rollbackA, 'previous');
    const previousB = path.join(rollbackB, 'previous');
    await fse.outputFile(previousA, 'old-a');
    await fse.writeFile(targetA, 'new-a');
    await fse.writeFile(targetB, 'new-b');
    await fse.ensureDir(home);
    await fse.writeJson(path.join(home, 'managed-resources.journal.json'), {
      version: 1,
      transactionId: 'retry',
      status: 'applying',
      resourceIds: ['agents:a', 'agents:b'],
      operations: [
        {
          target: targetB, previous: previousB, rollbackRoot: rollbackB, hadPrevious: true,
          previousKind: 'file', previousHash: crypto.createHash('sha256').update('old-b').digest('hex'), phase: 'applied',
        },
        {
          target: targetA, previous: previousA, rollbackRoot: rollbackA, hadPrevious: true,
          previousKind: 'file', previousHash: crypto.createHash('sha256').update('old-a').digest('hex'), phase: 'applied',
        },
      ],
      stagedRoots: [], createdBackups: [], backupCleanup: [], updatedAt: new Date().toISOString(),
    });

    await expect(recoverManagedResourceTransaction(home)).rejects.toThrow('rollback incomplete');
    expect(await fse.readFile(targetA, 'utf8')).toBe('old-a');
    const interrupted = await fse.readJson(path.join(home, 'managed-resources.journal.json'));
    expect(interrupted.operations[1].rollbackComplete).toBe(true);

    await fse.outputFile(previousB, 'old-b');
    await recoverManagedResourceTransaction(home);
    expect(await fse.readFile(targetA, 'utf8')).toBe('old-a');
    expect(await fse.readFile(targetB, 'utf8')).toBe('old-b');
    expect((await fse.readJson(path.join(home, 'managed-resources.journal.json'))).status).toBe('rolled-back');
  });

  it('plans without creating files, backups, journal, or manifest', async () => {
    const { root, home } = await fixture();
    const target = path.join(root, 'agent.md');
    const result = await reconcileManagedResources(home, [file('agents:a', target, 'planned')], { plan: true });

    expect(result.planned).toEqual([target]);
    expect(await fse.pathExists(target)).toBe(false);
    expect(await fse.pathExists(home)).toBe(false);
  });

  it('upgrades a legacy v1 backup hash from its backup payload only when a normal reconcile commits', async () => {
    const { root, home } = await fixture();
    const target = path.join(root, 'agent.md');
    const backupPath = path.join(home, 'managed-resource-backups', 'legacy-agent');
    await fse.writeFile(target, 'team version');
    await fse.outputFile(backupPath, 'user original');
    await fse.ensureDir(home);
    await fse.writeJson(path.join(home, 'managed-resources.json'), {
      version: 1,
      resources: {
        'agents:a': {
          id: 'agents:a', type: 'agents', targets: [{
            path: target, kind: 'file', hash: crypto.createHash('sha256').update('team version').digest('hex'),
            ownership: 'replaced-with-backup', backupPath,
          }],
        },
      },
    });
    const beforePlan = await fse.readFile(path.join(home, 'managed-resources.json'), 'utf8');

    await reconcileManagedResources(home, [file('agents:a', target, 'team version')], { plan: true });
    expect(await fse.readFile(path.join(home, 'managed-resources.json'), 'utf8')).toBe(beforePlan);

    await reconcileManagedResources(home, [file('agents:a', target, 'team version')], { pruneTypes: ['agents'] });
    const persisted = await fse.readJson(path.join(home, 'managed-resources.json'));
    expect(persisted.resources['agents:a'].targets[0].backupHash)
      .toBe(crypto.createHash('sha256').update('user original').digest('hex'));

    await uninstallManagedResources(home);
    expect(await fse.readFile(target, 'utf8')).toBe('user original');
  });

  it('upgrades legacy section ownership to preserve the pre-existing instruction file', async () => {
    const { root, home } = await fixture();
    const target = path.join(root, 'AGENTS.md');
    const section = { start: '<!-- [teamai:instructions:start] -->', end: '<!-- [teamai:instructions:end] -->' };
    const block = `${section.start}\nTeam rules\n${section.end}`;
    await fse.writeFile(target, `# Local rules\n\n${block}\n`);
    await fse.ensureDir(home);
    await fse.writeJson(path.join(home, 'managed-resources.json'), {
      version: 1,
      resources: {
        'instructions:project-agents': {
          id: 'instructions:project-agents', type: 'instructions', targets: [{
            path: target, kind: 'file', section,
            hash: crypto.createHash('sha256').update(block).digest('hex'), ownership: 'adopted',
          }],
        },
      },
    });
    const desired: DesiredManagedResource = {
      id: 'instructions:project-agents', type: 'instructions',
      targets: [{ path: target, kind: 'file', section, content: block }],
    };

    await reconcileManagedResources(home, [desired], { pruneTypes: ['instructions'] });
    const persisted = await fse.readJson(path.join(home, 'managed-resources.json'));
    expect(persisted.resources['instructions:project-agents'].targets[0].sectionFileExisted).toBe(true);

    await uninstallManagedResources(home);
    expect(await fse.readFile(target, 'utf8')).toBe('# Local rules\n');
  });

  it('recovers a legacy journal only after deriving its rollback metadata from the previous payload', async () => {
    const { root, home } = await fixture();
    const target = path.join(root, 'agent.md');
    const rollbackRoot = path.join(root, '.teamai-rollback-legacy-journal-a');
    const previous = path.join(rollbackRoot, 'previous');
    await fse.outputFile(previous, 'old');
    await fse.writeFile(target, 'new');
    await fse.ensureDir(home);
    await fse.writeJson(path.join(home, 'managed-resources.journal.json'), {
      version: 1, transactionId: 'legacy-journal', status: 'applying', resourceIds: ['agents:a'],
      operations: [{ target, previous, rollbackRoot, hadPrevious: true, phase: 'applied' }],
      stagedRoots: [], createdBackups: [], backupCleanup: [], updatedAt: new Date().toISOString(),
    });

    await recoverManagedResourceTransaction(home);
    expect(await fse.readFile(target, 'utf8')).toBe('old');
    const persisted = await fse.readJson(path.join(home, 'managed-resources.journal.json'));
    expect(persisted.status).toBe('rolled-back');
    expect(persisted.operations[0]).toMatchObject({
      previousKind: 'file', previousHash: crypto.createHash('sha256').update('old').digest('hex'),
    });
  });

  it('fails closed when an interrupted rollback payload was modified', async () => {
    const { root, home } = await fixture();
    const target = path.join(root, 'agent.md');
    const rollbackRoot = path.join(root, '.teamai-rollback-corrupt-rollback-a');
    const previous = path.join(rollbackRoot, 'previous');
    await fse.outputFile(previous, 'tampered');
    await fse.writeFile(target, 'new');
    await fse.ensureDir(home);
    await fse.writeJson(path.join(home, 'managed-resources.journal.json'), {
      version: 1, transactionId: 'corrupt-rollback', status: 'applying', resourceIds: ['agents:a'],
      operations: [{
        target, previous, rollbackRoot, hadPrevious: true,
        previousKind: 'file', previousHash: crypto.createHash('sha256').update('old').digest('hex'),
        phase: 'applied',
      }],
      stagedRoots: [], createdBackups: [], backupCleanup: [], updatedAt: new Date().toISOString(),
    });

    await expect(recoverManagedResourceTransaction(home)).rejects.toThrow('rollback incomplete');
    expect(await fse.readFile(target, 'utf8')).toBe('new');
    expect(await fse.readFile(previous, 'utf8')).toBe('tampered');
    expect((await fse.readJson(path.join(home, 'managed-resources.journal.json'))).status).toBe('applying');
  });

  it('recovers a legacy external OpenClaw journal by proving the target is inside its skills root', async () => {
    const { root, home } = await fixture();
    const externalRoot = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-openclaw-legacy-'));
    tempDirs.push(externalRoot);
    const stateDir = path.join(externalRoot, 'state');
    const workspace = path.join(externalRoot, 'workspace');
    const target = path.join(workspace, 'skills', 'legacy-skill');
    const rollbackRoot = path.join(workspace, 'skills', '.teamai-rollback-legacy-openclaw-a');
    const previous = path.join(rollbackRoot, 'previous');
    await fse.outputFile(path.join(previous, 'SKILL.md'), 'old');
    await fse.outputFile(path.join(target, 'SKILL.md'), 'new');
    await fse.outputJson(path.join(stateDir, 'openclaw.json'), { agents: { defaults: { workspace } } });
    await fse.ensureDir(home);
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      await fse.writeJson(path.join(home, 'managed-resources.journal.json'), {
        version: 1, transactionId: 'legacy-openclaw', status: 'applying', resourceIds: ['skills:legacy-skill'],
        operations: [{ target, previous, rollbackRoot, hadPrevious: true, phase: 'applied' }],
        stagedRoots: [], createdBackups: [], backupCleanup: [], updatedAt: new Date().toISOString(),
      });

      await recoverManagedResourceTransaction(home);
      expect(await fse.readFile(path.join(target, 'SKILL.md'), 'utf8')).toBe('old');
      const persisted = await fse.readJson(path.join(home, 'managed-resources.journal.json'));
      expect(persisted.operations[0]).toMatchObject({ tool: 'openclaw', resourceType: 'skills' });
    } finally {
      if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
  });

  it('rejects an unrelated external staged root before recovery can delete it', async () => {
    const { home } = await fixture();
    const dshRoot = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-dsh-journal-'));
    tempDirs.push(dshRoot);
    const target = path.join(dshRoot, 'skills', 'example');
    const rollbackRoot = path.join(dshRoot, 'skills', '.teamai-rollback-unsafe-stage-a');
    const credentials = path.join(dshRoot, 'credentials');
    await fse.outputFile(path.join(target, 'SKILL.md'), 'keep target');
    await fse.outputFile(path.join(credentials, 'token'), 'keep credential');
    await fse.ensureDir(home);
    await fse.writeJson(path.join(home, 'managed-resources.journal.json'), {
      version: 1, transactionId: 'unsafe-stage', status: 'applying', resourceIds: ['skills:example'],
      operations: [{
        target,
        previous: path.join(rollbackRoot, 'previous'),
        rollbackRoot,
        hostRoot: dshRoot,
        tool: 'dsh',
        resourceType: 'skills',
        hadPrevious: false,
        phase: 'applied',
      }],
      stagedRoots: [credentials], createdBackups: [], backupCleanup: [], updatedAt: new Date().toISOString(),
    });

    await expect(recoverManagedResourceTransaction(home)).rejects.toThrow('journal is invalid');
    expect(await fse.readFile(path.join(target, 'SKILL.md'), 'utf8')).toBe('keep target');
    expect(await fse.readFile(path.join(credentials, 'token'), 'utf8')).toBe('keep credential');
  });

  it('recovers a DSH transaction interrupted after external staging but before apply', async () => {
    const { home } = await fixture();
    const dshRoot = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-dsh-staging-'));
    tempDirs.push(dshRoot);
    const target = path.join(dshRoot, 'skills', 'example');
    const stageRoot = path.join(dshRoot, 'skills', '.teamai-stage-dsh-staging-0-safe');
    await fse.outputFile(path.join(stageRoot, 'payload', 'SKILL.md'), 'staged');
    await fse.ensureDir(home);
    await fse.writeJson(path.join(home, 'managed-resources.journal.json'), {
      version: 1, transactionId: 'dsh-staging', status: 'staging', resourceIds: ['skills:example'],
      operations: [],
      stagedRoots: [stageRoot],
      stagedTargets: [{ root: stageRoot, target, hostRoot: dshRoot, tool: 'dsh', resourceType: 'skills' }],
      createdBackups: [], backupCleanup: [], updatedAt: new Date().toISOString(),
    });

    await recoverManagedResourceTransaction(home);
    expect(await fse.pathExists(stageRoot)).toBe(false);
    expect((await fse.readJson(path.join(home, 'managed-resources.journal.json'))).status).toBe('rolled-back');
  });

  it('recovers external backup-restore staging before its prune operation is recorded', async () => {
    const { home } = await fixture();
    const dshRoot = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-dsh-restore-'));
    tempDirs.push(dshRoot);
    const target = path.join(dshRoot, 'AGENTS.md');
    const stageRoot = path.join(dshRoot, '.teamai-stage-dsh-restore-restore-safe');
    const backup = path.join(home, 'managed-resource-backups', 'a'.repeat(20));
    await fse.outputFile(path.join(stageRoot, 'payload'), '# Personal DSH instructions\n');
    await fse.outputFile(backup, '# Personal DSH instructions\n');
    await fse.writeJson(path.join(home, 'managed-resources.journal.json'), {
      version: 1, transactionId: 'dsh-restore', status: 'applying', resourceIds: ['instructions:dsh'],
      operations: [],
      stagedRoots: [stageRoot],
      stagedTargets: [{ root: stageRoot, target, hostRoot: dshRoot, tool: 'dsh', resourceType: 'instructions' }],
      createdBackups: [], backupCleanup: [backup], updatedAt: new Date().toISOString(),
    });

    await recoverManagedResourceTransaction(home);
    expect(await fse.pathExists(stageRoot)).toBe(false);
    expect(await fse.readFile(backup, 'utf8')).toBe('# Personal DSH instructions\n');
  });

  it('rejects a corrupt manifest instead of rebuilding it', async () => {
    const { root, home } = await fixture();
    await fse.ensureDir(home);
    await fse.writeFile(path.join(home, 'managed-resources.json'), '{not-json');

    await expect(reconcileManagedResources(home, [file('agents:a', path.join(root, 'agent.md'), 'a')]))
      .rejects.toThrow('manifest is invalid');
    expect(await fse.readFile(path.join(home, 'managed-resources.json'), 'utf8')).toBe('{not-json');
  });

  it('rejects a structurally corrupt manifest instead of losing ledger records', async () => {
    const { root, home } = await fixture();
    await fse.ensureDir(home);
    await fse.writeJson(path.join(home, 'managed-resources.json'), { version: 1, resources: [] });

    await expect(reconcileManagedResources(home, [file('agents:a', path.join(root, 'agent.md'), 'a')]))
      .rejects.toThrow('unsupported shape');
    expect(await fse.readJson(path.join(home, 'managed-resources.json'))).toEqual({ version: 1, resources: [] });
  });

  it('rejects an out-of-scope journal before touching its target', async () => {
    const { root, home } = await fixture();
    const outside = path.join(os.tmpdir(), `teamai-outside-${crypto.randomBytes(5).toString('hex')}`);
    await fse.writeFile(outside, 'keep');
    try {
      await fse.ensureDir(home);
      await fse.writeJson(path.join(home, 'managed-resources.journal.json'), {
        version: 1,
        transactionId: 'unsafe',
        status: 'applying',
        resourceIds: ['agents:a'],
        operations: [{
          target: outside,
          previous: path.join(root, '.teamai-rollback-unsafe-a', 'previous'),
          rollbackRoot: path.join(root, '.teamai-rollback-unsafe-a'),
          hadPrevious: false,
          phase: 'applied',
        }],
        stagedRoots: [], createdBackups: [], backupCleanup: [], updatedAt: new Date().toISOString(),
      });

      await expect(recoverManagedResourceTransaction(home)).rejects.toThrow('journal is invalid');
      expect(await fse.readFile(outside, 'utf8')).toBe('keep');
    } finally {
      await fse.remove(outside);
    }
  });

  it('rejects a journal path that escapes the managed scope through a symlink', async () => {
    const { root, home } = await fixture();
    const outsideRoot = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-outside-link-'));
    tempDirs.push(outsideRoot);
    const outside = path.join(outsideRoot, 'keep.md');
    const link = path.join(root, 'escape');
    const rollbackRoot = path.join(root, '.teamai-rollback-symlink-a');
    await fse.writeFile(outside, 'keep');
    await fse.symlink(outsideRoot, link, 'dir');
    await fse.ensureDir(home);
    await fse.writeJson(path.join(home, 'managed-resources.journal.json'), {
      version: 1,
      transactionId: 'symlink',
      status: 'applying',
      resourceIds: ['agents:a'],
      operations: [{
        target: path.join(link, 'keep.md'),
        previous: path.join(rollbackRoot, 'previous'),
        rollbackRoot,
        hadPrevious: false,
        phase: 'applied',
      }],
      stagedRoots: [], createdBackups: [], backupCleanup: [], updatedAt: new Date().toISOString(),
    });

    await expect(recoverManagedResourceTransaction(home)).rejects.toThrow('journal is invalid');
    expect(await fse.readFile(outside, 'utf8')).toBe('keep');
  });

  it('allows only the skills subtree of an external OpenClaw workspace', async () => {
    const { root, home } = await fixture();
    const externalRoot = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-openclaw-'));
    tempDirs.push(externalRoot);
    const stateDir = path.join(externalRoot, 'state');
    const workspace = path.join(externalRoot, 'workspace');
    const source = path.join(root, 'source');
    const target = path.join(workspace, 'skills', 'external');
    const workspaceInstructions = path.join(workspace, 'AGENTS.md');
    await fse.outputFile(path.join(source, 'SKILL.md'), 'skill');
    await fse.ensureDir(workspace);
    await fse.outputJson(path.join(stateDir, 'openclaw.json'), { agents: { defaults: { workspace } } });
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      await expect(reconcileManagedResources(home, [{
        id: 'instructions:external',
        type: 'instructions',
        targets: [{ path: workspaceInstructions, kind: 'file', tool: 'openclaw', content: 'unsafe' }],
      }])).rejects.toThrow('Only OpenClaw skills may use an external managed target');

      const desired: DesiredManagedResource = {
        id: 'skills:external',
        type: 'skills',
        targets: [{ path: target, kind: 'directory', tool: 'openclaw', sourcePath: source }],
      };
      await reconcileManagedResources(home, [desired], { pruneTypes: ['skills'] });
      await reconcileManagedResources(home, [desired], { pruneTypes: ['skills'] });
      expect(await fse.readFile(path.join(target, 'SKILL.md'), 'utf8')).toBe('skill');

      await fse.writeFile(workspaceInstructions, 'keep');
      const rollbackRoot = path.join(workspace, '.teamai-rollback-openclaw-a');
      await fse.writeJson(path.join(home, 'managed-resources.journal.json'), {
        version: 1,
        transactionId: 'openclaw',
        status: 'applying',
        resourceIds: ['skills:external'],
        operations: [{
          target: workspaceInstructions,
          previous: path.join(rollbackRoot, 'previous'),
          rollbackRoot,
          hadPrevious: false,
          phase: 'applied',
        }],
        stagedRoots: [], createdBackups: [], backupCleanup: [], updatedAt: new Date().toISOString(),
      });
      await expect(recoverManagedResourceTransaction(home)).rejects.toThrow('journal is invalid');
      expect(await fse.readFile(workspaceInstructions, 'utf8')).toBe('keep');
    } finally {
      if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
  });

  it('refuses to plan while a valid transaction still requires recovery', async () => {
    const { root, home } = await fixture();
    await fse.ensureDir(home);
    await fse.writeJson(path.join(home, 'managed-resources.journal.json'), {
      version: 1,
      transactionId: 'pending',
      status: 'applying',
      resourceIds: [], operations: [], stagedRoots: [], createdBackups: [], backupCleanup: [],
      updatedAt: new Date().toISOString(),
    });

    await expect(reconcileManagedResources(home, [file('agents:a', path.join(root, 'agent.md'), 'a')], { plan: true }))
      .rejects.toThrow('requires recovery before plan');
  });
});

describe('local-only Skill data', () => {
  async function setup() {
    const {root, home} = await fixture();
    const source = path.join(root, 'source');
    const target = path.join(root, 'skills', 'archive');
    await fse.outputFile(path.join(source, 'SKILL.md'), 'v1');
    await fse.ensureDir(path.join(source, 'assets', 'douyin-cookie-bridge'));
    const resource: DesiredManagedResource = {id:'skills:archive', type:'skills', targets:[{
      path:target, kind:'directory', sourcePath:source,
      preservePaths:['.runtime','assets/douyin-cookie-bridge/bridge-secret.local.json'],
    }]};
    return {root,home,source,target,resource};
  }
  it('adopts manual installs, preserves runtime/secret on updates, and leaves no-op pulls unchanged', async () => {
    const {home,source,target,resource} = await setup();
    await fse.copy(source,target);
    await fse.outputFile(path.join(target,'.runtime','python'),'local-runtime');
    const secret=path.join(target,'assets/douyin-cookie-bridge/bridge-secret.local.json');
    await fse.outputFile(secret,'local-secret');
    expect((await reconcileManagedResources(home,[resource])).applied).toEqual([]);
    await fse.outputFile(path.join(target,'.runtime','package'),'installed-later');
    await fse.outputFile(path.join(target,'assets','douyin-cookie-bridge','__pycache__','test.pyc'),'cache');
    await fse.writeFile(path.join(source,'SKILL.md'),'v2');
    expect((await reconcileManagedResources(home,[resource])).conflicts).toEqual([]);
    expect(await fse.readFile(secret,'utf8')).toBe('local-secret');
    expect(await fse.readFile(path.join(target,'.runtime','package'),'utf8')).toBe('installed-later');
    expect(await fse.readFile(path.join(target,'SKILL.md'),'utf8')).toBe('v2');
    expect((await reconcileManagedResources(home,[resource])).applied).toEqual([]);
    expect((await uninstallManagedResources(home)).conflicts.length).toBe(1);
    expect(await fse.pathExists(secret)).toBe(true);
  });
  it('retains actual source conflicts and rolls back both source and local data on failure', async () => {
    const {home,source,target,resource}=await setup();
    await reconcileManagedResources(home,[resource]);
    await fse.outputFile(path.join(target,'.runtime','keep'),'keep');
    await fse.writeFile(path.join(source,'SKILL.md'),'v2');
    await expect(reconcileManagedResources(home,[resource],{failAfterApply:1})).rejects.toThrow('Injected');
    expect(await fse.readFile(path.join(target,'SKILL.md'),'utf8')).toBe('v1');
    expect(await fse.readFile(path.join(target,'.runtime','keep'),'utf8')).toBe('keep');
    await fse.writeFile(path.join(target,'SKILL.md'),'user edit');
    expect((await reconcileManagedResources(home,[resource])).conflicts.length).toBe(1);
    expect(await fse.readFile(path.join(target,'SKILL.md'),'utf8')).toBe('user edit');
  });
  it('rejects remote runtime payloads and unapproved preservation paths', async () => {
    const {home,source,resource}=await setup();
    await fse.outputFile(path.join(source,'.runtime','bad'),'bad');
    await expect(reconcileManagedResources(home,[resource])).rejects.toThrow('local-only');
    resource.targets[0].preservePaths=['../escape'];
    await expect(reconcileManagedResources(home,[resource])).rejects.toThrow('Invalid');
  });
});
