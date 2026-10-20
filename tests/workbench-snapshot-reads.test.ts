import { expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createWorkbenchApp } from '../src/workbench/app.js';
import { digest } from '../src/workbench/auth.js';

const projects=[{id:'project-a',name:'Visible A'},{id:'project-b',name:'Hidden B'}];
const settings=[
  {id:'global-provider',kind:'provider',name:'Global',data:{connectorId:'connector-1',enabled:true,default:true}},
  {id:'setting-a',kind:'preference',projectId:'project-a',name:'A setting',data:{value:'a'}},
  {id:'setting-b',kind:'preference',projectId:'project-b',name:'B setting',data:{value:'b'}}
];
const records={
  work:[
    {id:'work-a1',projectId:'project-a',updatedAt:'2026-01-01T00:00:00.000Z'},
    {id:'work-a2',projectId:'project-a',updatedAt:'2026-01-02T00:00:00.000Z'},
    {id:'work-b1',projectId:'project-b',updatedAt:'2026-01-03T00:00:00.000Z'}
  ],
  message:[
    {id:'message-a1',projectId:'project-a',updatedAt:'2026-01-01T00:00:00.000Z'},
    {id:'message-a2',projectId:'project-a',updatedAt:'2026-01-02T00:00:00.000Z'},
    {id:'message-b1',projectId:'project-b',updatedAt:'2026-01-03T00:00:00.000Z'}
  ],
  run:[
    {id:'run-a1',projectId:'project-a',updatedAt:'2026-01-01T00:00:00.000Z',status:'queued',kind:'master'},
    {id:'run-a2',projectId:'project-a',updatedAt:'2026-01-02T00:00:00.000Z',status:'completed',kind:'master',connectorId:'connector-1'},
    {id:'run-b1',projectId:'project-b',updatedAt:'2026-01-03T00:00:00.000Z',status:'completed',kind:'master'}
  ],
  artifact:[
    {id:'artifact-a1',projectId:'project-a',workId:'work-a1',kind:'note',revision:'a1'},
    {id:'artifact-b1',projectId:'project-b',workId:'work-b1',kind:'note',revision:'b1'}
  ]
};

function deferred<T>() {
  let resolve!:(value:T)=>void;
  const promise=new Promise<T>(r=>{resolve=r;});
  return {promise,resolve};
}

function fixture(role:'owner'|'member', visibleProjects:string[], deferAuthorization=false) {
  const counts={settings:0,connectors:0,evidence:0};
  const queryArgs:Array<{kind:string;projectIds?:string[];limit?:number}> = [];
  const fragments:unknown[][]=[];
  const events:string[]=[];
  const sessionGate=deferred<unknown[]>(), scopeGate=deferred<unknown[]>(), batchGate=deferred<unknown[]>();
  let scopeResolved=false, firstBatchActive=0, maxFirstBatchActive=0;
  const batchKinds:string[]=[];
  const member={id:`user-${role}`,email:'test@example.invalid',name:'Test',role};
  const connector={id:'connector-1',capabilities:{codexAppServer:true,localWorktrees:true,models:['gpt-6-luna']},last_seen:new Date().toISOString(),project_ids:['project-a','project-b']};
  const sql=(async(strings:TemplateStringsArray,...values:unknown[])=>{
    if(!('raw' in strings)){if(Array.isArray(strings))fragments.push([...strings]);return strings;}
    const query=strings.join('?');
    if(query.includes('FROM wb_sessions')) {
      const rows=values[0]===digest('snapshot-session')?[member]:[];
      if(query.includes('SELECT u.id FROM')) { events.push('rate-session');return rows.map(({id})=>({id})); }
      events.push('member-session');
      return deferAuthorization?sessionGate.promise.then(()=>rows):rows;
    }
    if(query.includes('SELECT project_id FROM wb_memberships')) {
      events.push('visible-scope');
      const rows=visibleProjects.map(project_id=>({project_id}));
      return deferAuthorization?scopeGate.promise.then(()=>{scopeResolved=true;return rows;}):(scopeResolved=true,rows);
    }
    if(query.includes('SELECT project_id,role FROM wb_memberships'))return maybeDefer('role',visibleProjects.map(project_id=>({project_id,role:'member'})));
    if(query.includes('FROM (SELECT data,updated_at,id FROM wb_records')) {
      const kind=String(values[0]), ids=values[1] as string[], limit=Number(values[2]);
      queryArgs.push({kind,projectIds:ids,limit});
      const rows=(records[kind as keyof typeof records]??[]).filter(row=>ids.includes(row.projectId)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||b.id.localeCompare(a.id)).slice(0,limit).sort((a,b)=>a.updatedAt.localeCompare(b.updatedAt)||a.id.localeCompare(b.id)).map(data=>({data}));
      return maybeDefer(kind,rows);
    }
    if(query.includes("data->>'kind'<>'diff_file_chunk'")) {
      queryArgs.push({kind:'artifact',projectIds:values[0] as string[],limit:200});
      return maybeDefer('artifact',records.artifact.filter(item=>(values[0] as string[]).includes(item.projectId)).sort((a,b)=>b.id.localeCompare(a.id)).map(data=>({data})));
    }
    if(query.includes("WHERE kind=? AND (?<>'artifact'")) {
      const kind=String(values[0]);
      if(kind==='project') {
        const rows=projects.map(data=>({data}));
        if(!scopeResolved){events.push('visible-owner-scope');scopeResolved=true;return rows;}
        return maybeDefer('project',rows);
      }
      if(kind==='setting') {
        counts.settings++;
        return maybeDefer('setting',settings.map(data=>({data})));
      }
      return [];
    }
    if(query.includes('FROM wb_connectors')) {
      counts.connectors++;
      const ids=values[0] as string[];
      queryArgs.push({kind:'connectors',projectIds:ids});
      return maybeDefer('connectors',ids.some(id=>connector.project_ids.includes(id))?[connector]:[]);
    }
    if(query.includes("data->>'status'='completed'")) {
      counts.evidence++;
      const ids=values[0] as string[];
      queryArgs.push({kind:'evidence',projectIds:ids});
      return maybeDefer('evidence',[]);
    }
    throw new Error(`Unexpected snapshot SQL: ${query}`);
  }) as unknown as Sql;

  function maybeDefer<T>(kind:string,rows:T):T|Promise<T> {
    if(!scopeResolved)throw new Error(`Post-scope query ${kind} started before authorization scope resolved`);
    if(deferAuthorization&&['role','project','work','message','run'].includes(kind)) {
      events.push(kind);batchKinds.push(kind);firstBatchActive++;
      maxFirstBatchActive=Math.max(maxFirstBatchActive,firstBatchActive);
      return batchGate.promise.then(()=>{firstBatchActive--;return rows;});
    }
    return rows;
  }

  return {sql,counts,queryArgs,fragments,events,batchKinds,member,connector,sessionGate,scopeGate,batchGate,
    get maxFirstBatchActive(){return maxFirstBatchActive;}};
}

async function snapshot(role:'owner'|'member', visibleProjects:string[]) {
  const f=fixture(role,visibleProjects);
  const app=await createWorkbenchApp({sql:f.sql});
  try {
    const response=await app.inject({url:'/api/workbench/snapshot',headers:{cookie:'menoteam_session=snapshot-session'}});
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    return {body:response.json(),fixture:f,response};
  } finally { await app.close(); }
}

function expected(role:'owner'|'member', visibleProjects:string[], connector:ReturnType<typeof fixture>['connector']) {
  const scopedProjects=projects.filter(project=>visibleProjects.includes(project.id));
  const scopedSettings=settings.filter(item=>!item.projectId||visibleProjects.includes(item.projectId));
  const scopedRecords=<T extends {projectId:string}>(items:T[])=>items.filter(item=>visibleProjects.includes(item.projectId)).sort((a,b)=>a.updatedAt.localeCompare(b.updatedAt)||a.id.localeCompare(b.id));
  const runtime=visibleProjects.length?[{
    provider:'openai',method:'codex-host',connectorId:connector.id,projectIds:connector.project_ids.filter(id=>visibleProjects.includes(id)),
    codexAppServer:true,localWorktrees:true,available:true,models:['gpt-6-luna'],lastSeen:connector.last_seen
  }]:[];
  const connectionSettings=scopedSettings.filter(item=>item.kind==='provider'&&!item.projectId);
  const providerConnections=connectionSettings.map(item=>{
    const endpoint=runtime.find(provider=>provider.connectorId===item.data.connectorId);
    return {id:item.id,name:item.name,connectorId:item.data.connectorId,default:true,enabled:true,status:endpoint?'available':'disconnected',
      ...(endpoint?{localWorktrees:true,models:['gpt-6-luna'],modelReasoningEfforts:{},projectIds:endpoint.projectIds}:{models:[],modelReasoningEfforts:{},projectIds:[]})};
  });
  const runs=scopedRecords(records.run).map(run=>run.status==='queued'&&run.kind!=='delivery'&&!run.connectorId?{...run,error:'Historical Connector identity is unresolved; this queued run cannot be dispatched or silently migrated'}:run);
  const artifacts=records.artifact.filter(item=>visibleProjects.includes(item.projectId)).sort((a,b)=>b.id.localeCompare(a.id));
  return {
    member:{id:`user-${role}`,email:'test@example.invalid',name:'Test',role},
    projectRoles:Object.fromEntries(visibleProjects.map(id=>[id,role==='owner'?'owner':'member'])),
    projects:scopedProjects,works:scopedRecords(records.work),messages:scopedRecords(records.message),runs,artifacts,settings:scopedSettings,
    runtimeProviders:runtime,providerConnections
  };
}

it('preserves exact scoped snapshot responses and bounded reads for owners, members, and empty scopes',async()=>{
  for(const [role,ids] of [['owner',['project-a','project-b']],['member',['project-a']],['member',[]]] as const) {
    const {body,fixture:f}=await snapshot(role,[...ids]);
    const expectedBody=expected(role,[...ids],f.connector);
    expect(body).toEqual(expectedBody);
    expect(JSON.stringify(body)).toBe(JSON.stringify(expectedBody));
    expect(f.counts).toEqual({settings:1,connectors:ids.length?1:0,evidence:ids.length?1:0});
    expect(f.queryArgs.filter(arg=>['work','message','run','artifact','connectors'].includes(arg.kind)).every(arg=>JSON.stringify(arg.projectIds)===JSON.stringify(ids))).toBe(true);
    if(ids.length)expect(f.fragments.some(fragment=>JSON.stringify(fragment)===JSON.stringify(ids))).toBe(true);
    expect(f.queryArgs.filter(arg=>['work','message','run'].includes(arg.kind)).every(arg=>arg.limit===500)).toBe(true);
    expect(f.queryArgs.find(arg=>arg.kind==='artifact')?.limit).toBe(200);
    expect(body.works.some((item:{id:string})=>item.id==='work-b1')).toBe(ids.includes('project-b'));
    expect(body.runs.some((item:{id:string})=>item.id==='run-b1')).toBe(ids.includes('project-b'));
  }
});

it('waits for authentication and visible scope, then starts at most five independent reads together',async()=>{
  const f=fixture('member',['project-a'],true);
  const app=await createWorkbenchApp({sql:f.sql});
  try {
    const pending=app.inject({url:'/api/workbench/snapshot',headers:{cookie:'menoteam_session=snapshot-session'}});
    await new Promise(resolve=>setImmediate(resolve));
    expect(f.events).toEqual(['rate-session','member-session']);
    f.sessionGate.resolve([]);
    await new Promise(resolve=>setImmediate(resolve));
    expect(f.events).toEqual(['rate-session','member-session','visible-scope']);
    f.scopeGate.resolve([]);
    for(let i=0;i<20&&f.batchKinds.length<5;i++)await new Promise(resolve=>setImmediate(resolve));
    expect(f.batchKinds.sort()).toEqual(['message','project','role','run','work'].sort());
    expect(f.maxFirstBatchActive).toBe(5);
    f.batchGate.resolve([]);
    const response=await pending;
    expect(response.statusCode).toBe(200);
  } finally { await app.close(); }
});

it('denies an unauthenticated snapshot before any scope or provider reads',async()=>{
  const f=fixture('member',['project-a']);
  const app=await createWorkbenchApp({sql:f.sql});
  try {
    const response=await app.inject('/api/workbench/snapshot');
    expect(response.statusCode).toBe(401);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(f.events).toEqual([]);
    expect(f.queryArgs).toEqual([]);
    expect(f.counts).toEqual({settings:0,connectors:0,evidence:0});
  } finally { await app.close(); }
});
