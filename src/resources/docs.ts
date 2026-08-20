import path from 'node:path';
import fse from 'fs-extra';
import { ResourceHandler } from './base.js';
import type { ResourceItem, TeamaiConfig, LocalConfig } from '../types.js';
import { pathExists, listFiles, expandHome } from '../utils/fs.js';
import { log } from '../utils/logger.js';

export class DocsHandler extends ResourceHandler {
  readonly type = 'docs' as const;

  async scanLocalForPush(_teamConfig: TeamaiConfig, _localConfig: LocalConfig): Promise<ResourceItem[]> {
    // Docs are managed directly in team repo
    return [];
  }

  async scanTeamForPull(_teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<ResourceItem[]> {
    const docsDir = path.join(localConfig.repo.localPath, 'docs');
    if (!await pathExists(docsDir)) return [];

    // Check if there are actual doc files (ignore .gitkeep and other dot files)
    const files = await listFiles(docsDir);
    const realFiles = files.filter(f => !f.startsWith('.'));
    if (realFiles.length === 0) return [];

    return [{
      name: 'docs',
      type: 'docs',
      sourcePath: docsDir,
      relativePath: 'docs/',
    }];
  }

  async countDocFiles(sourcePath: string): Promise<number> {
    const files = await listFiles(sourcePath);
    return files.filter(f => !f.startsWith('.')).length;
  }

  async pushItem(_item: ResourceItem, _teamConfig: TeamaiConfig, _localConfig: LocalConfig): Promise<void> {
    // No-op
  }

  async pullItem(item: ResourceItem, teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<void> {
    if (teamConfig.sharing.docs.mode === 'index-only') return;
    const configured = teamConfig.sharing.docs.localDir;
    const localDir = localConfig.scope === 'project' && localConfig.projectRoot && configured.startsWith('~/')
      ? path.join(localConfig.projectRoot, configured.slice(2))
      : expandHome(configured);
    try {
      await fse.copy(item.sourcePath, localDir, {
        overwrite: true,
        filter: (sourcePath: string) => !path.basename(sourcePath).startsWith('.'),
      });
      log.debug(`Synced docs → ${localDir}`);
    } catch (error) {
      log.warn(`Failed to sync docs: ${(error as Error).message}`);
    }
  }

  async removeItem(_name: string, _teamConfig: TeamaiConfig, _localConfig: LocalConfig): Promise<string[]> {
    log.warn('Removing docs is not supported via remove command. Delete from team repo directly.');
    return [];
  }
}
