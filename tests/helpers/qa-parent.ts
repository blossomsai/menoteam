// Controlled real parent used only by process/recovery tests. No network or real credentials.
import { readFile } from 'node:fs/promises';
import { bindQaExecutor,acquireQaResource,claimQaResource,releaseQaResource,runQaCommand,type QaExecution } from '../../src/connector/qa-process.js';
import { writeSecureJson } from '../../src/connector/state.js';
import type { QaPolicy } from '../../src/workbench/local-qa.js';
const input=JSON.parse(await readFile(process.argv[2]!,'utf8')) as {state:QaExecution;policy:QaPolicy;stateFile:string;cwd:string;command:string[];secondCommand:string[];mode?:'lock'|'startup'|'between'};
await bindQaExecutor(input.state);
await writeSecureJson(input.stateFile+'.parent.json',input.state.executor);
// The fixture registers our identity before allowing any resource/QA effect.
const go=new Promise<void>(resolve=>process.once('message',()=>resolve()));
process.send!({ready:true});await go;
const save=async()=>{if(input.mode==='startup'&&input.state.phase==='running'){process.stdout.write('identity-ready\n');await new Promise<void>(()=>{});}await writeSecureJson(input.stateFile,input.state);};
const resume=()=>new Promise<void>(resolve=>process.stdin.once('data',()=>resolve()));
await acquireQaResource(input.state,input.policy);await save();
try {
  await claimQaResource(input.state,input.policy);await save();
  if(input.mode==='lock'){
    process.stdout.write('owned\n');await resume();
  }else{
    await runQaCommand(input.state,process.execPath,input.command,input.cwd,process.env,30_000,save,undefined,undefined,input.policy);
    if(input.mode==='between'){
      process.stdout.write('between-commands\n');await resume();
      await runQaCommand(input.state,process.execPath,input.secondCommand,input.cwd,process.env,30_000,save,undefined,undefined,input.policy);
    }
  }
  await releaseQaResource(input.state);await save();
}catch(error){process.stderr.write((error as Error).message);process.exitCode=1;}
process.disconnect();process.stdin.destroy();
