import { describe, expect, it } from 'vitest';
import { execFileJoined } from '../src/connector/exec-file.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const options={encoding:'utf8' as const,maxBuffer:4096,timeout:5_000,env:{PATH:'/usr/bin:/bin'}};
describe('joined read-only child execution',()=>{
  it('returns output only after ordinary child exit and rejects a failed spawn',async()=>{
    expect((await execFileJoined(process.execPath,['-e',"process.stdout.write('receipt')"],options)).stdout).toBe('receipt');
    await expect(execFileJoined('/nonexistent-menoteam-command',[],options)).rejects.toMatchObject({code:'ENOENT'});
  });
  it('joins an aborted child even when it ignores SIGTERM, before permitting stop proof',async()=>{
    const directory=await mkdtemp(path.join(os.tmpdir(),'menoteam-child-join-'));
    const pidFile=path.join(directory,'pid');const controller=new AbortController();
    try{
      const pending=execFileJoined(process.execPath,['-e',"require('node:fs').writeFileSync(process.argv[1],String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",pidFile],{...options,signal:controller.signal});
      // Attach rejection before abort; the owned PID is independently observed.
      const rejected=expect(pending).rejects.toMatchObject({name:'AbortError'});
      let pid:number|undefined;
      for(let count=0;count<100&&!pid;count++){try{pid=Number(await readFile(pidFile,'utf8'));}catch{await new Promise(resolve=>setTimeout(resolve,10));}}
      expect(pid).toBeGreaterThan(1);controller.abort();await rejected;
      expect(()=>process.kill(pid!,0)).toThrow(expect.objectContaining({code:'ESRCH'}));
    }finally{controller.abort();await rm(directory,{recursive:true,force:true});}
  });
});
