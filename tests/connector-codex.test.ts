import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { CodexAppServer } from '../src/connector/codex.js';
import type { ClaimedRun } from '../src/connector/types.js';
import type { Run } from '../src/workbench/types.js';

async function generatedThreadBoundary(run:Partial<Run>,threadId?:string){
 const native=new CodexAppServer();let boundary:any;
 const internals=native as unknown as {child:unknown;events:EventEmitter;request:(method:string,params:any)=>Promise<any>};
 internals.child={};native.models=['gpt-6.1-sol'];
 internals.request=async(method,params)=>{
  if(method==='thread/start'||method==='thread/resume'){boundary={method,params};return{thread:{id:threadId??'configured-thread'}};}
  if(method==='turn/start'){setTimeout(()=>internals.events.emit('message',{method:'turn/completed',params:{turn:{id:'configured-turn',status:'completed'}}}),0);return{turn:{id:'configured-turn'}};}
  throw new Error('Unexpected RPC');
 };
 await native.run({run:{model:'gpt-6.1-sol',reasoning:'medium',...run}} as ClaimedRun,'/isolated-config','bounded request',threadId,()=>{},'/private-context.json');
 return boundary;
}
async function generatedThreadConfig(run:Partial<Run>){
 return (await generatedThreadBoundary(run)).params.config?.mcp_servers.menoteam;
}

it('enables the three registered staging tools in the generated Project Master config',async()=>{
 const config=await generatedThreadConfig({kind:'master'});
 const staging=['request_staging_deploy','request_staging_rollback','retire_staging_deploy'];
 expect(config.enabled_tools).toEqual(['read_context','read_work','read_run','create_work','update_work','dispatch','request_delivery','request_merge',...staging,'post_message','update_settings','create_skill']);
 const bridge=await readFile(new URL('../src/connector/mcp-bridge.ts',import.meta.url),'utf8');
 for(const tool of staging){expect(config.tools[tool]).toEqual({approval_mode:'approve'});expect(bridge).toContain(`tool('${tool}',`);}
});

it('limits generated Master config to its explicit allowedActions and keeps feedback staging unavailable',async()=>{
 expect((await generatedThreadConfig({kind:'master',allowedActions:['read_work','retire_staging_deploy']})).enabled_tools).toEqual(['read_work','retire_staging_deploy']);
 expect((await generatedThreadConfig({kind:'master',sourceIds:['untrusted-feedback'],allowedActions:['read_work','request_staging_deploy','request_staging_rollback','retire_staging_deploy']})).enabled_tools).toEqual(['read_work']);
 expect((await generatedThreadConfig({kind:'master',allowedActions:[]})).enabled_tools).toEqual([]);
});

it.each(['review','implementation','delivery'] as const)('does not expose staging tools to a %s native run',async kind=>{
 const config=await generatedThreadConfig({kind});
 if(kind==='review')expect(config.enabled_tools).toEqual(['read_work','read_run','read_diff_file','submit_review_result']);
 else expect(config).toBeUndefined();
});

it.each([['start',undefined],['resume','review-native-thread']] as const)('keeps review bridge read-only and scoped on native thread %s',async(_mode,threadId)=>{
 const boundary=await generatedThreadBoundary({kind:'review'},threadId);
 expect(boundary.method).toBe(threadId?'thread/resume':'thread/start');
 expect(boundary.params).toMatchObject({sandbox:'read-only',approvalPolicy:'never'});
 const config=boundary.params.config.mcp_servers.menoteam;
 expect(config.enabled_tools).toEqual(['read_work','read_run','read_diff_file','submit_review_result']);
 expect(Object.keys(config.tools).sort()).toEqual(['read_diff_file','read_run','read_work','submit_review_result'].sort());
 expect(config.tools.read_diff_file).toEqual({approval_mode:'approve'});
 expect(config.enabled_tools).not.toContain('read_context');
 expect(config.enabled_tools).not.toContain('create_work');
 expect(config.enabled_tools).not.toContain('request_delivery');
 expect(config.enabled_tools).not.toContain('request_merge');
 expect(config.enabled_tools).not.toContain('post_message');
 expect(config.enabled_tools).not.toContain('update_settings');
 expect(config.enabled_tools).not.toContain('create_skill');
});

it('resumes the same persisted native thread without hydrating its growing history response',async()=>{
 const native=new CodexAppServer();
 const calls:{method:string;params:any}[]=[];
 const internals=native as unknown as {child:unknown;events:EventEmitter;request:(method:string,params:any)=>Promise<any>};
 internals.child={};native.models=['gpt-6.1-sol'];
 internals.request=async(method,params)=>{
  calls.push({method,params});
  if(method==='thread/resume')return {thread:{id:params.threadId,turns:[]}};
  if(method==='turn/start'){
   setTimeout(()=>internals.events.emit('message',{method:'turn/completed',params:{turn:{id:'turn-one',status:'completed'}}}),0);
   return {turn:{id:'turn-one'}};
  }
  throw Error('Unexpected RPC');
 };
 const claim={run:{kind:'master',model:'gpt-6.1-sol',reasoning:'medium'}} as ClaimedRun;
 const events:unknown[]=[];
 const result=await native.run(claim,'/isolated-master','continue same task','durable-native-thread',event=>events.push(event),'/private-context-reference.json');
 expect(calls[0]?.method).toBe('thread/resume');
 expect(calls[0]?.params).toMatchObject({threadId:'durable-native-thread',excludeTurns:true,sandbox:'read-only',approvalPolicy:'never',model:'gpt-6.1-sol'});
 expect(calls[0]?.params).not.toHaveProperty('history');
 expect(calls[0]?.params.config.mcp_servers.menoteam.enabled_tools).toContain('read_work');
 expect(calls[1]?.params.threadId).toBe('durable-native-thread');
 expect(result.threadId).toBe('durable-native-thread');
 expect(events).toEqual([{type:'thread_started',text:'Native Codex thread durable-native-thread is active.',threadId:'durable-native-thread'}]);
});

it('applies an explicit handoff model to the resumed thread and its advertised effort to the new turn',async()=>{
 const native=new CodexAppServer();const calls:{method:string;params:any}[]=[];
 const internals=native as unknown as {child:unknown;events:EventEmitter;request:(method:string,params:any)=>Promise<any>};
 internals.child={};native.models=['target-model'];native.modelReasoningEfforts={'target-model':['advertised-effort']};
 internals.request=async(method,params)=>{calls.push({method,params});if(method==='thread/resume')return{thread:{id:params.threadId}};if(method==='turn/start'){setTimeout(()=>internals.events.emit('message',{method:'turn/completed',params:{turn:{id:'handoff-turn',status:'completed'}}}),0);return{turn:{id:'handoff-turn'}};}throw Error('Unexpected RPC');};
 const claim={run:{kind:'implementation',model:'target-model',reasoning:'advertised-effort',handoffFromRunId:'source-run'}} as ClaimedRun;
 const result=await native.run(claim,'/same-work-checkout','Continue with the explicit handoff','same-native-thread',()=>undefined);
 expect(calls[0]?.method).toBe('thread/resume');expect(calls[0]?.params).toMatchObject({threadId:'same-native-thread',model:'target-model'});
 expect(calls[0]?.params).not.toHaveProperty('effort');
 expect(calls[1]?.method).toBe('turn/start');expect(calls[1]?.params).toMatchObject({threadId:'same-native-thread',model:'target-model',effort:'advertised-effort'});
 expect(result.threadId).toBe('same-native-thread');
});

it('rejects an unadvertised handoff effort before resuming a native thread',async()=>{
 const native=new CodexAppServer();const methods:string[]=[];const internals=native as unknown as {child:unknown;request:(method:string,params:any)=>Promise<any>};
 internals.child={};native.models=['target-model'];native.modelReasoningEfforts={'target-model':['advertised-effort']};internals.request=async(method)=>{methods.push(method);return{};};
 await expect(native.run({run:{kind:'implementation',model:'target-model',reasoning:'unsupported-effort',handoffFromRunId:'source-run'}} as ClaimedRun,'/same-work-checkout','Continue','same-native-thread',()=>undefined)).rejects.toThrow(/reasoning effort is unavailable/u);
 expect(methods).toEqual([]);
});

it.skipIf(process.platform === 'win32')('keeps Connector delivery credentials out of the real Codex app-server child environment', async () => {
 const directory = await mkdtemp(path.join(os.tmpdir(), 'menoteam-codex-env-'));
 const executable = path.join(directory, 'fake-codex-app-server.mjs');
 const capture = path.join(directory, 'child-env.json');
 const previous = new Map(['MENOTEAM_GITHUB_TOKEN', 'MENOTEAM_CONNECTOR_CONFIG', 'OPENAI_API_KEY', 'MENOTEAM_TEST_CAPTURE'].map(name => [name, process.env[name]]));
 const restore = () => {
  for (const [name, value] of previous) {
   if (value === undefined) delete process.env[name];
   else process.env[name] = value;
  }
 };
 const source = `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { writeFile } from 'node:fs/promises';
await writeFile(process.env.MENOTEAM_TEST_CAPTURE, JSON.stringify({ githubToken: process.env.MENOTEAM_GITHUB_TOKEN, connectorConfig: process.env.MENOTEAM_CONNECTOR_CONFIG, openAiAuth: process.env.OPENAI_API_KEY }), { mode: 0o600 });
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.id !== undefined) {
    process.stdout.write(JSON.stringify({ id: message.id, result: message.method === 'model/list' ? { data: [{ id: 'gpt-6-luna', supportedReasoningEfforts: [{ reasoningEffort: 'catalog-effort', description: 'Fixture advertised effort' }] }] } : {} }) + '\\n');
    if (message.method === 'model/list') setTimeout(() => process.exit(0), 25);
  }
}
`;
 const appServer = new CodexAppServer(executable);
 try {
  process.env.MENOTEAM_GITHUB_TOKEN = 'synthetic-delivery-token-for-test';
  process.env.MENOTEAM_CONNECTOR_CONFIG = '/private/connector-config-with-credential.json';
  process.env.OPENAI_API_KEY = 'synthetic-codex-auth-for-test';
  process.env.MENOTEAM_TEST_CAPTURE = capture;
  await writeFile(executable, source, { mode: 0o700 });
  await chmod(executable, 0o700);
  expect(await appServer.start(directory)).toEqual(['gpt-6-luna']);
  expect(appServer.modelReasoningEfforts).toEqual({ 'gpt-6-luna': ['catalog-effort'] });
  const child = (appServer as unknown as { child: import('node:child_process').ChildProcess }).child;
  await new Promise<void>(resolve => child.once('close', () => resolve()));
  const childEnvironment = JSON.parse(await readFile(capture, 'utf8')) as Record<string, string | undefined>;
  expect(childEnvironment.githubToken).toBeUndefined();
  expect(childEnvironment.connectorConfig).toBeUndefined();
  expect(childEnvironment.openAiAuth).toBe('synthetic-codex-auth-for-test');
  expect(process.env.MENOTEAM_GITHUB_TOKEN).toBe('synthetic-delivery-token-for-test');
 } finally {
  try { await appServer.stop(); } finally {
   restore();
   await rm(directory, { recursive: true, force: true });
  }
 }
});

it('retains an unconfirmed native stop result across concurrent and repeated calls and refuses restart', async () => {
 const native = new CodexAppServer(); const pid = 678901;
 (native as unknown as { child: unknown }).child = { pid, stdin: { end: vi.fn() }, kill: vi.fn() };
 const originalKill = process.kill.bind(process); const kill = vi.spyOn(process, 'kill').mockImplementation((target, signal) => target === -pid ? true : originalKill(target, signal));
 vi.useFakeTimers();
 try {
  const first = native.stop(); const concurrent = native.stop(); expect(concurrent).toBe(first);
  const rejected = expect(first).rejects.toThrow('stop cannot be confirmed'); await vi.runAllTimersAsync(); await rejected;
  expect(native.stop()).toBe(first); await expect(native.stop()).rejects.toThrow('stop cannot be confirmed');
  await expect(native.start('/unused')).rejects.toThrow('stop cannot be confirmed');
 } finally { vi.useRealTimers(); kill.mockRestore(); }
});

it.skipIf(process.platform === 'win32')('stops real descendants after the native leader has already closed', async () => {
 const directory = await mkdtemp(path.join(os.tmpdir(), 'menoteam-codex-closed-leader-')); const executable = path.join(directory, 'fake-codex.mjs');
 const app = new CodexAppServer(executable); let child: import('node:child_process').ChildProcess | undefined;
 const source = `#!${process.execPath}\nimport {createInterface} from 'node:readline';import {spawn} from 'node:child_process';
for await(const line of createInterface({input:process.stdin})){const message=JSON.parse(line);if(message.id!==undefined){process.stdout.write(JSON.stringify({id:message.id,result:message.method==='model/list'?{data:[{id:'fixture'}]}:{}})+'\\n');if(message.method==='model/list'){spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});setTimeout(()=>process.exit(0),30);}}}`;
 try {
  await writeFile(executable, source, { mode: 0o700 }); await chmod(executable, 0o700); await app.start(directory);
  child = (app as unknown as { child: import('node:child_process').ChildProcess }).child;
  await new Promise<void>(resolve => child!.once('close', () => resolve())); expect(process.kill(-child.pid!, 0)).toBe(true);
  await app.stop(); expect(() => process.kill(-child!.pid!, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }));
 } finally { if(child?.pid){try{process.kill(-child.pid,'SIGKILL');}catch{}}await app.stop().catch(()=>undefined);await rm(directory,{recursive:true,force:true}); }
});
