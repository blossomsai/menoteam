import { expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createWorkbenchApp } from '../src/workbench/app.js';
import { digest } from '../src/workbench/auth.js';

async function fixture(failResultSave=false) {
  const receipts=new Map<string,Record<string,unknown>>();
  const invites:Array<{id:string;projectId:unknown}>=[];
  let sends=0;
  // Exercise production HTTP handlers; this persistence fixture does not prove PostgreSQL locking.
  const sql=(async(strings:TemplateStringsArray,...values:unknown[])=>{
    const query=strings.join('?');
    if(query.includes('FROM wb_sessions'))return values[0]===digest('identity-session')?[{id:'owner',email:'owner@example.test',name:'Owner',role:'owner'}]:[];
    if(query.includes('FROM wb_records'))return [{data:{id:'project',name:'Project'}}];
    if(query.includes('pg_advisory_xact_lock'))return [];
    if(query.includes('SELECT result FROM wb_requests')){const result=receipts.get(`${values[0]}:${values[1]}`);return result?[{result}]:[];}
    if(query.includes('INSERT INTO wb_invites')){invites.push({id:String(values[0]),projectId:values[2]});return [];}
    if(query.includes('INSERT INTO wb_requests')){receipts.set(`${values[0]}:${values[1]}`,structuredClone(values[2] as Record<string,unknown>));return [];}
    if(query.includes('UPDATE wb_requests')){
      if(failResultSave)throw new Error('Fixture result save failed');
      receipts.get(`${values[1]}:${values[2]}`)!.delivery=values[0];return [{request_id:values[2]}];
    }
    throw new Error('Unexpected identity fixture query');
  }) as unknown as Sql;
  Object.assign(sql,{begin:async<T>(fn:(tx:Sql)=>Promise<T>)=>fn(sql),json:(value:unknown)=>value});
  const app=await createWorkbenchApp({sql,inviteOrigin:'https://workbench.example.test',inviteMailer:async()=>{sends++;return 'accepted';}});
  const post=(payload:unknown)=>app.inject({method:'POST',url:'/api/workbench/invites',headers:{cookie:'menoteam_session=identity-session'},payload});
  return {app,post,receipts,invites,sends:()=>sends};
}

it.each([false,true])('returns the exact stable invite ID on first response and replay (result save failure: %s)',async(failSave)=>{
  const f=await fixture(failSave);
  try {
    const payload={email:'recipient@example.test',projectId:'project',role:'member',requestId:'same-request',sendEmail:true};
    const first=await f.post(payload);expect(first.statusCode).toBe(200);
    const body=first.json();expect(body.inviteId).toBe(digest(body.token));expect(body.delivery).toBe(failSave?'unknown':'accepted');
    const replay=await f.post(payload);expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({inviteId:body.inviteId,token:null,replay:true,delivery:body.delivery});
    expect(f.invites.map(row=>row.id)).toEqual([body.inviteId]);expect(f.sends()).toBe(1);
    const receipt=[...f.receipts.values()][0]!;
    expect(Object.keys(receipt).sort()).toEqual(['delivery','expiresAt','inviteId','payloadHash']);
    expect(JSON.stringify(receipt)).not.toContain(body.token);expect(JSON.stringify(receipt)).not.toContain('https://');expect(JSON.stringify(receipt)).not.toContain(payload.email);
  } finally {await f.app.close();}
});

it('preserves legacy workspace/project link callers and identifies their stored digest',async()=>{
  const f=await fixture();
  try {
    for(const projectId of [undefined,'project']){
      const response=await f.post({email:'legacy@example.test',role:'member',...(projectId?{projectId}:{})});
      expect(response.statusCode).toBe(200);const body=response.json();
      expect(body).toMatchObject({inviteId:digest(body.token),delivery:'not_requested',replay:false});
      expect(f.invites.at(-1)).toEqual({id:body.inviteId,projectId:projectId??null});
    }
    expect(f.receipts.size).toBe(0);expect(f.sends()).toBe(0);
  } finally {await f.app.close();}
});

it('does not invent an invitation identity when replaying a receipt without inviteId',async()=>{
  const f=await fixture();
  try {
    const payload={email:'old-receipt@example.test',projectId:'project',role:'member',requestId:'old-request',sendEmail:false};
    expect((await f.post(payload)).statusCode).toBe(200);
    delete [...f.receipts.values()][0]!.inviteId;
    const replay=await f.post(payload);expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({inviteId:null,token:null,replay:true});expect(f.invites).toHaveLength(1);expect(f.sends()).toBe(0);
  } finally {await f.app.close();}
});
