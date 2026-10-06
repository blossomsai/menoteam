// Fixed parent launcher. The repository command is gated by a durable identity handshake.
import { spawn } from 'node:child_process';
import { readProcessIdentity } from './codex.js';
import { writeSecureJson } from './state.js';
const identityFile=process.argv[2];
if(!identityFile||!process.send)throw new Error('QA child requires its parent IPC');
const identity=await readProcessIdentity(process.pid);
if(!identity||identity.processGroupId!==process.pid)throw new Error('QA process identity unavailable');
await writeSecureJson(identityFile,identity);
let started=false,stopping=false;
const keepAlive=setInterval(()=>{},1000);
function stop(){if(stopping)return;stopping=true;if(!started){clearInterval(keepAlive);process.exit(0);}try{process.kill(-process.pid,'SIGTERM');}catch{/* Parent recovery must prove group stopped before release. */}}
process.on('SIGTERM',stop);
process.on('disconnect',stop);
process.on('message',(message:{executable:string;args:string[];cwd:string})=>{
  if(started||stopping)return;
  started=true;
  const child=spawn(message.executable,message.args,{cwd:message.cwd,env:process.env,stdio:['ignore','pipe','pipe'],shell:false,detached:false});
  child.stdout.on('data',chunk=>process.stdout.write(chunk));child.stderr.on('data',chunk=>process.stderr.write(chunk));
  child.on('error',()=>process.send?.({exitCode:null}));
  child.on('close',(code,signal)=>process.send?.({exitCode:signal?null:code}));
});
process.send({ready:true});
// Without a GO, no repository code runs, even in the spawn/persistence crash window.
setTimeout(()=>{if(!started)stop();},15_000).unref();
