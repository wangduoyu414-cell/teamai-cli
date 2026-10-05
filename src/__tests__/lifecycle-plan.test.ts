import fse from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { init } from '../init.js';
import { pull } from '../pull.js';
import { uninstall } from '../uninstall.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('lifecycle plan mode', () => {
  it('short-circuits init, pull and uninstall before filesystem mutation', async () => {
    const writes = [
      vi.spyOn(fse, 'writeFile'),
      vi.spyOn(fse, 'rename'),
      vi.spyOn(fse, 'remove'),
      vi.spyOn(fse, 'ensureDir'),
      vi.spyOn(fse, 'copy'),
    ];

    await init({ repo: 'https://example.test/team.git', dryRun: true });
    await pull({ dryRun: true });
    await uninstall({ dryRun: true, force: true });

    for (const write of writes) expect(write).not.toHaveBeenCalled();
  });
});
