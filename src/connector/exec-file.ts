import { execFile, type ExecFileOptions } from 'node:child_process';

type Options = Omit<ExecFileOptions, 'encoding'>;
export function execFileJoined(file:string,args:string[],options:Options&{encoding:'utf8'}):Promise<{stdout:string;stderr:string}>;
export function execFileJoined(file:string,args:string[],options:Options&{encoding:'buffer'}):Promise<{stdout:Buffer;stderr:Buffer}>;
/** Read-only commands settle only after the owned child closes, including abort/error paths. */
export function execFileJoined(file:string,args:string[],options:Options&{encoding:'utf8'|'buffer'}):Promise<{stdout:string|Buffer;stderr:string|Buffer}>{
  return new Promise((resolve,reject)=>{
    let result:{error:Error|null;stdout:Buffer;stderr:Buffer}|undefined;
    // Node's abort error callback can precede close. SIGKILL bounds cleanup for
    // these fixed read-only binaries; no completed callback alone is stop proof.
    const child=execFile(file,args,{...options,encoding:'buffer',killSignal:'SIGKILL'},(error,stdout,stderr)=>{result={error,stdout,stderr};});
    // execFile does not forward killSignal to spawn's AbortSignal handler.
    const abort=()=>{child.kill('SIGKILL');};
    options.signal?.addEventListener('abort',abort,{once:true});
    if(options.signal?.aborted)abort();
    child.once('close',()=>{
      options.signal?.removeEventListener('abort',abort);
      if(!result){reject(new Error('Read-only command closed without a result'));return;}
      if(result.error){reject(result.error);return;}
      resolve(options.encoding==='utf8'?{stdout:result.stdout.toString('utf8'),stderr:result.stderr.toString('utf8')}:{stdout:result.stdout,stderr:result.stderr});
    });
  });
}
