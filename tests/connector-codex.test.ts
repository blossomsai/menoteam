import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CodexAppServer } from '../src/connector/codex.js';
import type { ClaimedRun } from '../src/connector/types.js';

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
    process.stdout.write(JSON.stringify({ id: message.id, result: message.method === 'model/list' ? { data: [{ id: 'gpt-6-luna' }] } : {} }) + '\\n');
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
