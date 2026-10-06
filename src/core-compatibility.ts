import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { valid } from 'semver';
import { getCurrentPackageName, getCurrentVersion } from './package-info.js';

/** Repositories without this opt-in lock retain their existing update policy. */
export async function assertCompatibleCore(repoPath: string): Promise<void> {
  const filename = path.join(repoPath, 'teamai-core.lock.json');
  let text: string;
  try {
    text = await readFile(filename, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  let lock: { schema_version?: unknown; status?: unknown; fork?: { package?: unknown; version?: unknown } };
  try {
    lock = JSON.parse(text);
    if (!lock || lock.schema_version !== 1 || lock.status !== 'active'
      || typeof lock.fork?.package !== 'string'
      || !/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(lock.fork.package)
      || typeof lock.fork.version !== 'string' || !valid(lock.fork.version)) {
      throw new Error('unsupported lock');
    }
  } catch {
    throw new Error('Invalid teamai-core.lock.json; no resources were installed. Ask the team maintainer to repair the lock.');
  }
  const required = lock.fork!;
  const installed = { package: getCurrentPackageName(), version: getCurrentVersion() };
  if (required.package !== installed.package || required.version !== installed.version) {
    throw new Error(`This team requires ${required.package}@${required.version}; running ${installed.package}@${installed.version}. No resources were installed. Update the tool checkout to the approved team revision, run npm ci --ignore-scripts there, then retry npm exec -- teamai pull. Global installations must use the same approved Core.`);
  }
}
