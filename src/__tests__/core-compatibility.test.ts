import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';
import { assertCompatibleCore } from '../core-compatibility.js';
import { getCurrentPackageName, getCurrentVersion } from '../package-info.js';

const roots: string[] = [];
async function repository(lock?: unknown): Promise<string> {
  const root = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-core-lock-'));
  roots.push(root);
  if (lock !== undefined) await fse.writeJson(path.join(root, 'teamai-core.lock.json'), lock);
  return root;
}
const current = () => ({ schema_version: 1, status: 'active', fork: { package: getCurrentPackageName(), version: getCurrentVersion() } });
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fse.remove(root))); });

describe('Core compatibility lock', () => {
  it('preserves repositories without a lock and accepts the approved package', async () => {
    await expect(assertCompatibleCore(await repository())).resolves.toBeUndefined();
    await expect(assertCompatibleCore(await repository(current()))).resolves.toBeUndefined();
  });
  it.each(['version', 'package'] as const)('rejects a different %s without changing repository files', async field => {
    const lock = current();
    lock.fork[field] = field === 'version' ? '999.0.0' : 'another-teamai';
    const root = await repository(lock);
    const before = await fse.readFile(path.join(root, 'teamai-core.lock.json'));
    await expect(assertCompatibleCore(root)).rejects.toThrow('No resources were installed');
    expect(await fse.readdir(root)).toEqual(['teamai-core.lock.json']);
    expect(await fse.readFile(path.join(root, 'teamai-core.lock.json'))).toEqual(before);
  });
  it.each([null, {}, { ...current(), schema_version: 2 }, { ...current(), status: 'draft' }, { ...current(), fork: { package: 'bad\npackage', version: 'latest' } }])('rejects malformed or inactive locks', async lock => {
    await expect(assertCompatibleCore(await repository(lock))).rejects.toThrow('Invalid teamai-core.lock.json');
  });
  it('rejects invalid JSON', async () => {
    const root = await repository();
    await fse.writeFile(path.join(root, 'teamai-core.lock.json'), '{');
    await expect(assertCompatibleCore(root)).rejects.toThrow('Invalid teamai-core.lock.json');
  });
});
