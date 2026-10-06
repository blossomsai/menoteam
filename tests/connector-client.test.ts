import { expect, it, vi } from 'vitest';
import { WorkbenchConnectorClient } from '../src/connector/client.js';
import { collectSkillBundle, gitBlobHash, bytesHash } from '../src/workbench/skill-bundle.js';

const auth = { serverUrl: 'https://workbench.example.invalid', token: 'local-connector-token-'.padEnd(48, 'x') };

it('claim transport retains the exact frozen bundle and rejects tampering or divergent snapshots', async () => {
  const content='---\nname: fixture\ndescription: Fixture.\n---\nRead resources.';
  const bytes=Buffer.from(content);
  const bundle=await collectSkillBundle([{path:'fixture/SKILL.md',type:'blob',mode:'100644',sha:gitBlobHash(bytes),size:bytes.length}], 'fixture','a'.repeat(40),async()=>bytes);
  const execution={provider:'openai',method:'codex-host',profileId:'profile-fixture',profile:{id:'profile-fixture',name:'Frozen profile',data:{model:'gpt-6-luna',reasoning:'medium',skillIds:['s'],tools:[]}},connectionId:'provider-fixture',connectorId:'connector-fixture',model:'gpt-6-luna',legacy:false,tools:[],skills:[{id:'s',name:'Fixture',content,contentSha256:bytesHash(bytes),bundle}]};
  const payload={run:{id:'r',generation:1,model:'gpt-6-luna',reasoning:'medium',kind:'implementation',status:'running',execution},execution,project:{id:'p'},messages:[],settings:[]};
  const client=new WorkbenchConnectorClient(auth,async()=>Response.json(payload));
  const claim=await client.claim();
  expect(claim?.run.execution?.skills[0]?.bundle).toEqual(bundle);
  expect(claim?.execution).toEqual(execution);
  expect(claim?.run.execution).toEqual(execution);
  const unknown={...payload,execution:{...execution,unrecognizedIdentity:'must-not-bypass-strict'}};
  await expect(new WorkbenchConnectorClient(auth,async()=>Response.json(unknown)).claim()).rejects.toThrow();
  const tampered=structuredClone(payload); tampered.run.execution.skills[0]!.bundle.files[0]!.data='AA==';
  await expect(new WorkbenchConnectorClient(auth,async()=>Response.json(tampered)).claim()).rejects.toThrow();
  const divergent=structuredClone(payload); divergent.execution={...divergent.execution,skills:[]};
  await expect(new WorkbenchConnectorClient(auth,async()=>Response.json(divergent)).claim()).rejects.toThrow(/mismatch/u);
});

it('validates project-scoped Master tool results without treating them as Run records', async () => {
  const fetcher = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => new Response(JSON.stringify({ work: { id: 'work-1' }, revision: 1 }), { status: 200 }));
  const client = new WorkbenchConnectorClient(auth, fetcher as typeof fetch);
  await expect(client.tool('run-1', 3, 'create_work', { title: 'Plan' }, 'stable-request-id')).resolves.toEqual({ work: { id: 'work-1' }, revision: 1 });
  expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe('error');
});

it('allows only HTTPS outside literal loopback HTTP', () => {
  expect(() => new WorkbenchConnectorClient({ ...auth, serverUrl: 'http://remote.example' })).toThrow(/HTTPS/u);
  expect(() => new WorkbenchConnectorClient({ ...auth, serverUrl: 'ftp://localhost' })).toThrow(/HTTPS/u);
  expect(() => new WorkbenchConnectorClient({ ...auth, serverUrl: 'http://localhost:3200' })).not.toThrow();
});

it('can constrain a claim to run kinds without changing the default capability request', async () => {
  const fetcher = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => new Response(null, { status: 204 }));
  const client = new WorkbenchConnectorClient(auth, fetcher as typeof fetch);
  await client.claim(['master', 'implementation', 'master']);
  const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  expect(body.capabilities.runKinds).toEqual(['master', 'implementation']);
});

it('surfaces only safe validation paths and codes from API errors', async () => {
  const fetcher = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => new Response(JSON.stringify({
    message: 'Invalid request',
    issues: [{ path: ['prompt'], code: 'too_big', input: 'MUST NOT BE EXPOSED' }],
  }), { status: 400 }));
  const client = new WorkbenchConnectorClient(auth, fetcher as typeof fetch);
  const result = client.tool('run-1', 3, 'dispatch', { prompt: 'x' }, 'req-1');
  const error = await result.then(()=>{throw Error('Expected API rejection');}).catch(value => value as Error & { status?: number; issues?: unknown[] });
  expect(error).toMatchObject({ status: 400, issues: [{ path: 'prompt', code: 'too_big' }] });
  expect(error.message).toContain('prompt:too_big');
  expect(error.message).not.toContain('MUST NOT BE EXPOSED');
});

it('reports only the static route category, method, status, and bounded Retry-After on connector HTTP errors', async () => {
  const fetcher = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => new Response(JSON.stringify({
    message: 'body and credential values must stay private',
    token: 'secret-token',
  }), { status: 429, headers: { 'retry-after': '37' } }));
  const client = new WorkbenchConnectorClient(auth, fetcher as typeof fetch);
  const error = await client.createBridgeToken('private-run-id', 4).then(()=>{throw Error('Expected API rejection');}).catch(value => value as Error & {
    status?: number; method?: string; routeCategory?: string; retryAfterSeconds?: number; safeSummary?: string;
  });
  expect(error).toMatchObject({ status: 429, method: 'POST', routeCategory: 'connector.runs.bridge-token', retryAfterSeconds: 37 });
  expect(error.safeSummary).toBe('Connector HTTP failure method=POST route=connector.runs.bridge-token status=429 retryAfterSeconds=37');
  expect(error.safeSummary).not.toContain('private-run-id');
  expect(error.safeSummary).not.toContain('secret-token');
  expect(error.safeSummary).not.toContain('body and credential values');
  expect(error.routeCategory).not.toContain('private-run-id');
});

it('validates QA authorization envelopes and keeps rejection scoped to the fixed parent',async()=>{
  const fetcher=vi.fn(async(_url:URL|RequestInfo,_init?:RequestInit)=>Response.json({authorized:true}));
  const client=new WorkbenchConnectorClient(auth,fetcher as typeof fetch);
  await expect(client.authorizeQaEffect('assigned-run',2)).resolves.toEqual({authorized:true});
  expect(String(fetcher.mock.calls[0]?.[0])).toContain('/qa-authorize');
  const denied=new WorkbenchConnectorClient(auth,async()=>Response.json({message:'Assigned QA policy is unavailable, revoked or changed'},{status:409}));
  await expect(denied.authorizeQaEffect('assigned-run',2)).rejects.toMatchObject({status:409,routeCategory:'connector.runs.qa-authorize'});
  const forged=new WorkbenchConnectorClient(auth,async()=>Response.json({authorized:true,command:'model-selected'}));
  await expect(forged.authorizeQaEffect('assigned-run',2)).rejects.toThrow();
});
