import { EventEmitter } from 'node:events';
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
