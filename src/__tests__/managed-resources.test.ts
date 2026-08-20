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
    const rollbackRoot = path.join(root, '.rollback');
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
      operations: [{ target, previous, rollbackRoot, hadPrevious: true, phase: 'applied' }],
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
    const rollbackRoot = path.join(root, '.rollback');
    const previous = path.join(rollbackRoot, 'previous');
    await fse.writeFile(target, 'new');
    await fse.ensureDir(home);
    await fse.writeJson(path.join(home, 'managed-resources.journal.json'), {
      version: 1,
      transactionId: 'broken-rollback',
      status: 'applying',
      resourceIds: ['agents:a'],
      operations: [{ target, previous, rollbackRoot, hadPrevious: true, phase: 'applied' }],
      stagedRoots: [],
      createdBackups: [],
      backupCleanup: [],
      updatedAt: new Date().toISOString(),
    });

    await expect(recoverManagedResourceTransaction(home)).rejects.toThrow('rollback incomplete');
    expect((await fse.readJson(path.join(home, 'managed-resources.journal.json'))).status).toBe('applying');
  });

  it('plans without creating files, backups, journal, or manifest', async () => {
    const { root, home } = await fixture();
    const target = path.join(root, 'agent.md');
    const result = await reconcileManagedResources(home, [file('agents:a', target, 'planned')], { plan: true });

    expect(result.planned).toEqual([target]);
    expect(await fse.pathExists(target)).toBe(false);
    expect(await fse.pathExists(home)).toBe(false);
  });
});
