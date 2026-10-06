import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';
import { loadManagedResourceManifest, reconcileManagedResources, uninstallManagedResources, type DesiredManagedResource } from '../managed-resources.js';

const roots: string[] = [];
const section = { start: '<!-- [teamai:instructions:start] -->', end: '<!-- [teamai:instructions:end] -->' };
const block = (version: string) => `${section.start}\n# Team ${version}\n${section.end}`;
async function fixture(personal?: string, legacy = '# Team old\n') {
  const root = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-instruction-migration-'));
  roots.push(root);
  const home = path.join(root, '.teamai');
  const target = path.join(root, 'AGENTS.md');
  if (personal !== undefined) await fse.writeFile(target, personal);
  const whole: DesiredManagedResource = { id: 'instructions:codex', type: 'instructions', targets: [{ path: target, kind: 'file', content: legacy }] };
  const desired = (version = 'new'): DesiredManagedResource => ({ ...whole, targets: [{ path: target, kind: 'file', section, content: block(version) }] });
  await reconcileManagedResources(home, [whole]);
  const prior = (await loadManagedResourceManifest(home)).resources[whole.id].targets[0];
  return { root, home, target, whole, desired, prior };
}
async function snapshot(root: string): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  async function visit(dir: string) {
    for (const item of await fse.readdir(dir, { withFileTypes: true })) {
      const filename = path.join(dir, item.name);
      if (item.isDirectory()) await visit(filename);
      else values[path.relative(root, filename)] = (await fse.readFile(filename)).toString('base64');
    }
  }
  await visit(root);
  return values;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fse.remove(root))); });

describe('whole-file instruction migration', () => {
  it('restores personal content even when the old whole file already contains the desired block', async () => {
    const { home, target, desired, prior } = await fixture('# Original personal rules\n', `${block('new')}\n`);
    await reconcileManagedResources(home, [desired()]);
    expect(await fse.readFile(target, 'utf8')).toBe(`# Original personal rules\n\n${block('new')}\n`);
    expect(await fse.pathExists(prior.backupPath!)).toBe(false);
    await uninstallManagedResources(home);
    expect(await fse.readFile(target, 'utf8')).toBe('# Original personal rules\n');
  });

  it('restores the original personal body once and keeps later personal edits through update and uninstall', async () => {
    const { root, home, target, desired, prior } = await fixture('# My personal rules\n');
    const before = await snapshot(root);
    await reconcileManagedResources(home, [desired()], { plan: true });
    expect(await snapshot(root)).toEqual(before);
    await reconcileManagedResources(home, [desired()]);
    expect(await fse.readFile(target, 'utf8')).toBe(`# My personal rules\n\n${block('new')}\n`);
    expect(await fse.pathExists(prior.backupPath!)).toBe(false);
    const migrated = (await loadManagedResourceManifest(home)).resources['instructions:codex'].targets[0];
    expect(migrated).toMatchObject({ ownership: 'created', section, sectionFileExisted: true });
    expect(migrated.backupPath).toBeUndefined();
    await fse.appendFile(target, '\n# New personal rule\n');
    await reconcileManagedResources(home, [desired('next')]);
    await uninstallManagedResources(home);
    const personal = await fse.readFile(target, 'utf8');
    expect(personal).toContain('# My personal rules');
    expect(personal).toContain('# New personal rule');
    expect(personal).not.toContain('# Team');
    expect(personal).not.toContain(section.start);
  });

  it.each([undefined, '# Team old\n'])('preserves created/adopted whole-file uninstall semantics (%s)', async personal => {
    const { home, target, desired } = await fixture(personal);
    await reconcileManagedResources(home, [desired()]);
    expect(await fse.readFile(target, 'utf8')).toBe(`${block('new')}\n`);
    await uninstallManagedResources(home);
    expect(await fse.pathExists(target)).toBe(false);
  });

  it('keeps an originally empty personal file on uninstall', async () => {
    const { home, target, desired } = await fixture('');
    await reconcileManagedResources(home, [desired()]);
    await uninstallManagedResources(home);
    expect(await fse.readFile(target, 'utf8')).toBe('');
  });

  it.each(['# Private edit\n', block('new')])('does not reinterpret an edited legacy file as personal or converged content', async edited => {
    const { home, target, desired, prior } = await fixture('# Original\n');
    await fse.writeFile(target, edited);
    const result = await reconcileManagedResources(home, [desired()]);
    expect(result.conflicts).toHaveLength(1);
    expect(await fse.readFile(target, 'utf8')).toBe(edited);
    expect((await loadManagedResourceManifest(home)).resources['instructions:codex'].targets[0]).toEqual(prior);
    expect(await fse.readFile(prior.backupPath!, 'utf8')).toBe('# Original\n');
  });

  it('rolls a failed migration back to the old file, record and intact backup', async () => {
    const { home, target, desired, prior } = await fixture('# Original\n');
    const oldManifest = await fse.readFile(path.join(home, 'managed-resources.json'));
    await expect(reconcileManagedResources(home, [desired()], { failAfterApply: 1 })).rejects.toThrow('Injected');
    expect(await fse.readFile(target, 'utf8')).toBe('# Team old\n');
    expect(await fse.readFile(path.join(home, 'managed-resources.json'))).toEqual(oldManifest);
    expect(await fse.readFile(prior.backupPath!, 'utf8')).toBe('# Original\n');
    await reconcileManagedResources(home, [desired()]);
    expect(await fse.readFile(target, 'utf8')).toContain('# Original');
  });

  it('rejects ambiguous marker-bearing personal backups even during plan', async () => {
    const { root, home, desired } = await fixture(block('original'));
    const before = await snapshot(root);
    await expect(reconcileManagedResources(home, [desired()], { plan: true })).rejects.toThrow('backup contains a managed block');
    expect(await snapshot(root)).toEqual(before);
  });

  it.each([`${section.start}\nLocal edit`, `${block('new')}\n${block('duplicate')}`])('preserves malformed or duplicate marker files', async edited => {
    const { root, home, target, desired } = await fixture();
    await reconcileManagedResources(home, [desired()]);
    await fse.writeFile(target, edited);
    const before = await snapshot(root);
    await expect(reconcileManagedResources(home, [desired()], { plan: true })).rejects.toThrow('markers');
    await expect(reconcileManagedResources(home, [desired()])).rejects.toThrow('markers');
    expect(await snapshot(root)).toEqual(before);
  });

  it('rejects generated nested markers and a switch back to whole-file ownership', async () => {
    const { home, desired, whole } = await fixture();
    const invalid = desired();
    invalid.targets[0].content = `${block('new')}\n${block('nested')}`;
    await expect(reconcileManagedResources(home, [invalid])).rejects.toThrow('markers');
    await reconcileManagedResources(home, [desired()]);
    await expect(reconcileManagedResources(home, [whole])).rejects.toThrow('Cannot expand section ownership');
  });
});
