import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { WorkbenchStore } from './store.js';
import type { CanonicalFinal, Project, Run, RunOrigin, Setting } from './types.js';

export interface SlackReply {
    projectId: string; runId: string; generation: number; actorId: string;
    origin: RunOrigin; body: string; bodyHash: string; final: Omit<CanonicalFinal,'text'>;
    state: 'pending' | 'ambiguous' | 'sent' | 'failed' | 'blocked';
    attemptedAt?: string; cause?: string; ts?: string;
}
export type SlackTransport = (request: { token: string; channel: string; thread_ts: string; text: string }) => Promise<{status:number; body:unknown}>;
export async function enqueueSlackReply(tx: Sql, run: Run, final: CanonicalFinal): Promise<void> {
    if(run.kind!=='master'||run.status!=='completed'||!run.origin||!run.requestedBy)return;
    const {text,...identity}=final;
    const reply:SlackReply={projectId:run.projectId,runId:run.id,generation:run.generation,actorId:run.requestedBy,origin:structuredClone(run.origin),body:text,bodyHash:createHash('sha256').update(text).digest('hex'),final:identity,state:'pending'};
    await tx`INSERT INTO wb_requests(scope,request_id,result) VALUES (${`slack-reply:${run.projectId}`},${`${run.id}:${run.generation}`},${tx.json(reply as never)}) ON CONFLICT(scope,request_id) DO NOTHING`;
}
async function authorized(store: WorkbenchStore, reply: SlackReply, tx: Sql): Promise<boolean> {
    const origin=reply.origin;
    const mapping=(await store.list<Setting>('setting',undefined,tx)).filter(s=>s.kind==='connection'&&s.projectId&&s.data.provider==='slack'&&(s.data.purpose??'source')==='source'&&s.data.enabled!==false&&s.data.appId===origin.appId&&s.data.teamId===origin.teamId&&s.data.channelId===origin.channelId);
    if(mapping.length!==1||mapping[0]!.id!==origin.connectionId||mapping[0]!.projectId!==reply.projectId)return false;
    const project=await store.get<Project>('project',reply.projectId,tx);
    if(!project?.feedbackIntake?.enabled||project.feedbackIntake.actorId!==reply.actorId)return false;
    const user=await tx`SELECT role FROM wb_users WHERE id=${reply.actorId}`;
    if(!user[0])return false;
    if(user[0].role!=='owner'){
        const membership=await tx`SELECT role FROM wb_memberships WHERE user_id=${reply.actorId} AND project_id=${reply.projectId}`;
        if(!['owner','admin'].includes(String(membership[0]?.role)))return false;
    }
    const source=await tx`SELECT result FROM wb_requests WHERE scope=${`source:${reply.projectId}`} AND request_id=${origin.sourceId}`;
    const run=await store.get<Run>('run',reply.runId,tx);
    return Boolean(source[0]&&run?.kind==='master'&&run.status==='completed'&&run.generation===reply.generation&&run.requestedBy===reply.actorId&&isDeepStrictEqual(run.origin,origin)&&createHash('sha256').update(reply.body).digest('hex')===reply.bodyHash);
}
const httpTransport:SlackTransport=async request=>{
    const response=await fetch('https://slack.com/api/chat.postMessage',{method:'POST',headers:{authorization:`Bearer ${request.token}`,'content-type':'application/json'},body:JSON.stringify({channel:request.channel,thread_ts:request.thread_ts,text:request.text}),signal:AbortSignal.timeout(15000),redirect:'error'});
    let body:unknown;try{body=await response.json();}catch{body=undefined;}
    return {status:response.status,body};
};
/** One durable claim precedes each external attempt. Ambiguous records are never reclaimed. */
export async function processSlackReplies(store: WorkbenchStore, options:{token:string;transport?:SlackTransport}):Promise<number>{
    if(!options.token)return 0;
    const claim=await store.transaction('slack-reply-claim',async tx=>{
        const rows=await tx`SELECT scope,request_id,result FROM wb_requests WHERE scope LIKE 'slack-reply:%' AND result->>'state'='pending' ORDER BY scope,request_id LIMIT 1 FOR UPDATE SKIP LOCKED`;
        if(!rows[0])return;
        const row=rows[0],reply=row.result as SlackReply;
        if(!await authorized(store,reply,tx)){
            reply.state='blocked';reply.cause='Slack source mapping or intake actor grant is no longer authorized';
        }else{reply.state='ambiguous';reply.attemptedAt=new Date().toISOString();reply.cause='Attempt recorded; acknowledgment is not yet verified';}
        await tx`UPDATE wb_requests SET result=${tx.json(reply as never)} WHERE scope=${row.scope} AND request_id=${row.request_id}`;
        return {scope:String(row.scope),key:String(row.request_id),reply};
    });
    if(!claim||claim.reply.state!=='ambiguous')return 0;
    const reply=claim.reply;
    try{
        const response=await (options.transport??httpTransport)({token:options.token,channel:reply.origin.channelId,thread_ts:reply.origin.threadTs,text:reply.body});
        const body=response.body&&typeof response.body==='object'?response.body as Record<string,unknown>:undefined;
        if(response.status>=200&&response.status<300&&body?.ok===true&&body.channel===reply.origin.channelId&&typeof body.ts==='string'&&/^\d+\.\d{6}$/u.test(body.ts)){
            reply.state='sent';reply.ts=body.ts;delete reply.cause;
        }else if(response.status>=200&&response.status<500&&body?.ok===false){reply.state='failed';reply.cause='Slack explicitly rejected the reply';}
        else reply.cause='Slack acknowledgment was ambiguous; automatic retry is disabled';
    }catch{reply.cause='Slack transport outcome is ambiguous; automatic retry is disabled';}
    await store.transaction('slack-reply-result',async tx=>{
        await tx`UPDATE wb_requests SET result=${tx.json(reply as never)} WHERE scope=${claim.scope} AND request_id=${claim.key} AND result->>'state'='ambiguous'`;
    });
    return 1;
}
