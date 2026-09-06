import {afterEach, describe, expect, it, vi} from 'vitest';
vi.mock('node:child_process', () => ({spawnSync:vi.fn(), execSync:vi.fn()}));
import {spawnSync,execSync} from 'node:child_process';
import {isGhInstalled,ghRepoClone} from '../providers/github/gh-cli.js';
afterEach(()=>vi.resetAllMocks());
describe('portable GitHub sync',()=>{
  it('detects gh directly, without Unix which or shell quoting',()=>{
    vi.mocked(spawnSync).mockReturnValue({status:0,stdout:'gh version',stderr:''} as never);
    expect(isGhInstalled()).toBe(true);
    expect(spawnSync).toHaveBeenCalledWith('gh',['--version'],expect.anything());
    expect(execSync).not.toHaveBeenCalled();
  });
  it('reports a missing executable',()=>{
    vi.mocked(spawnSync).mockReturnValue({status:null,error:{code:'ENOENT'}} as never);
    expect(isGhInstalled()).toBe(false);
  });
  it('clones using separate arguments and never puts a token in the URL',()=>{
    vi.mocked(spawnSync).mockReturnValue({status:0,stdout:'',stderr:''} as never);
    ghRepoClone('owner/repo','C:\\Users\\中文 空格\\skills');
    expect(spawnSync).toHaveBeenCalledWith('gh',['repo','clone','owner/repo','C:\\Users\\中文 空格\\skills'],expect.anything());
    expect(spawnSync).toHaveBeenCalledWith('git',['-C','C:\\Users\\中文 空格\\skills','config','--local','--add','credential.https://github.com.helper','!gh auth git-credential'],expect.anything());
    expect(execSync).not.toHaveBeenCalled();
  });
});
