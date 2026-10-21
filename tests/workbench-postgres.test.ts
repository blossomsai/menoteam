import { gitBlobHash, verifyBundle, freezeSkillBundle } from '../src/workbench/skill-bundle.js';
import { mergePullRequest } from '../src/connector/github-merge-pr.js';
import { requiredQaFixture,qaPolicyFixture } from './helpers/local-qa-fixture.js';
import { qaPolicySnapshot } from '../src/workbench/local-qa.js';
import { mergeClaim,mergeFixture,localBase,base,mergeSha } from './helpers/merge-pr-fixture.js';
import { createHash, randomUUID } from 'node:crypto';
import { digest } from '../src/workbench/auth.js';
import { rateLimitKey } from '../src/workbench/rate-limit.js';
import type { FastifyRequest } from 'fastify';
import postgres from "postgres";
import { createHmac } from "node:crypto";
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { createWorkbenchApp } from "../src/workbench/app.js";
import { WorkbenchStore } from "../src/workbench/store.js";
import { WorkbenchConnectorClient } from "../src/connector/client.js";
import type { Artifact, Project, Run, SnapshotRun, Setting, Work } from "../src/workbench/types.js";
import { enqueueSlackReply, processSlackReplies, type SlackTransport } from '../src/workbench/slack-replies.js';
const url = process.env.WORK_MAP_TEST_DATABASE_URL;

async function discardPersistedChunkAck(response: Response): Promise<never> {
    await response.arrayBuffer();
    throw new Error('Fixture ACK loss after PostgreSQL persisted the chunk');
}

it('consumes the persisted chunk response body before simulating ACK loss', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream<Uint8Array>({ start(value) {
        controller = value;
        controller.enqueue(new TextEncoder().encode('{"persisted":true}'));
    } }));
    const events: string[] = [];
    const consume = response.arrayBuffer.bind(response);
    vi.spyOn(response, 'arrayBuffer').mockImplementation(async () => {
        const bytes = await consume();
        events.push('body consumed');
        return bytes;
    });
    const ackLoss = discardPersistedChunkAck(response).catch(error => {
        events.push('ACK lost');
        throw error;
    });
    const rejection = expect(ackLoss).rejects.toThrow('Fixture ACK loss after PostgreSQL persisted the chunk');
    await Promise.resolve();
    expect(response.bodyUsed).toBe(true);
    expect(events).toEqual([]);
    controller.close();
    await rejection;
    expect(events).toEqual(['body consumed', 'ACK lost']);
});

describe.skipIf(!url)("Real workbench PostgreSQL", () => {
    let sql: ReturnType<typeof postgres>;
    let app: Awaited<ReturnType<typeof createWorkbenchApp>>;
    let cookie = "";
    let projectId = "";
    let connectorToken = "";
    let scenarioAddress = 1;
    beforeEach(() => { scenarioAddress += 1; });
    let sourceFetch: typeof fetch = globalThis.fetch;
    beforeAll(async () => {
        const location = new URL(url!);
        if (!["localhost", "127.0.0.1"].includes(location.hostname) || !location.pathname.endsWith("_test"))
            throw new Error("Workbench destructive fixtures require loopback *_test database");
        await migrate(url!);
        sql = postgres(url!);
        await sql `TRUNCATE wb_bridge_tokens,wb_records,wb_sessions,wb_memberships,wb_invites,wb_connectors,wb_requests,wb_users CASCADE`;
        process.env.WORKBENCH_SLACK_SIGNING_SECRET = "test-slack-signing-secret";
        process.env.WORKBENCH_GITHUB_WEBHOOK_SECRET = "test-github-signing-secret";
        app = await createWorkbenchApp({
            sql,
            bootstrapEmail: "owner@test.example",
            bootstrapPassword: "workbench-test-password",
            sourceFetcher: (...args) => sourceFetch(...args)
        });
        const r = await app.inject({
            method: "POST",
            url: "/api/workbench/session",
            payload: {
                email: "owner@test.example",
                password: "workbench-test-password"
            }
        });
        expect(r.statusCode).toBe(200);
        cookie = String(r.headers["set-cookie"]).split(";")[0]!;
    });
    beforeEach(async () => {
        // Keep durable fixtures/session continuity, but isolate each test's real rate-limit bucket.
        await app.close();
        app = await createWorkbenchApp({sql, sourceFetcher: (...args) => sourceFetch(...args)});
    });
    const checkedJson = (response: {statusCode: number; body: string; json(): any}, status = 200) => {
        expect(response.statusCode, response.statusCode === status ? undefined : response.statusCode >= 400 ? response.body : "Unexpected success response; credential-bearing body withheld").toBe(status);
        return response.json();
    };
    afterAll(async () => {
        await app?.close();
        await sql?.end();
    });
    const user = (method: "GET" | "POST" | "PATCH" | "DELETE", path: string, payload?: unknown) => app.inject({
        method,
        url: "/api/workbench" + path,
        remoteAddress: `127.0.0.${scenarioAddress}`,
        headers: {
            cookie
        },
        payload: connectorFixturePayload(path,payload) as never
    });
    const conn = (method: "GET" | "POST", path: string, payload?: unknown) => app.inject({
        method,
        url: "/api/workbench/connector" + path,
        remoteAddress: `127.0.0.${scenarioAddress}`,
        headers: {
            authorization: `Bearer ${connectorToken}`
        },
        payload: connectorFixturePayload(path,payload) as never
    });
    const fixtureCapabilities={codexAppServer:true,localWorktrees:true,models:['gpt-6-luna','gpt-6.1-sol']};
    const connectorFixturePayload=(path:string,payload:unknown)=>path==='/claim'?{
        ...(payload as Record<string,unknown>??{}),
        capabilities:{...fixtureCapabilities,...((payload as {capabilities?:Record<string,unknown>}|undefined)?.capabilities??{})}
    }:payload;
    const fixtureConnections=new Map<string,string>();
    // Enroll, discover and bind through actual HTTP before a scenario requests execution.
    // Scope is exactly the scenario's project(s); this never adds grants to another fixture.
    async function enrollProvider(connectorId:string,projectIds:string[]){
        const enrolled=checkedJson(await user('POST','/connectors',{id:connectorId,projectIds}));
        const discovery=await app.inject({method:'POST',url:'/api/workbench/connector/claim',headers:{authorization:`Bearer ${enrolled.token}`},payload:{capabilities:{...fixtureCapabilities,runKinds:[]}}});
        expect(discovery.statusCode).toBe(204);
        const connection=checkedJson(await user('POST','/settings',{kind:'provider',name:`Fixture ${connectorId}`,data:{provider:'openai',method:'codex-host',connectorId,enabled:true,default:true}}));
        fixtureConnections.set(connectorId,connection.id);
        return enrolled;
    }
    async function selectExistingProvider(connectorId:string,bearer:string){
        const discovered=await app.inject({method:'POST',url:'/api/workbench/connector/claim',headers:{authorization:`Bearer ${bearer}`},payload:{capabilities:{...fixtureCapabilities,runKinds:[]}}});
        expect(discovered.statusCode).toBe(204);
        checkedJson(await user('PATCH',`/settings/${fixtureConnections.get(connectorId)!}`,{data:{default:true}}));
    }
    it("persists project and conversation, idempotent submission and scoped login", async () => {
        expect((await app.inject("/api/workbench/snapshot")).statusCode).toBe(401);
        const p = await user("POST", "/projects", {
            name: "Dogfood",
            instructions: "Build from evidence"
        });
        projectId = p.json().id;
        connectorToken=(await enrollProvider('test-connector',[projectId])).token;
        const b = {
            text: "Plan a real feature",
            requestId: "request-001"
        };
        const first = await user("POST", `/projects/${projectId}/messages`, b);
        const duplicate = await user("POST", `/projects/${projectId}/messages`, b);
        expect(duplicate.json().run.id).toBe(first.json().run.id);
        const snapshot = await user("GET", "/snapshot");
        expect(snapshot.json().messages).toHaveLength(1);
    });
    it("rejects stale Project Instructions saves at the persistence boundary without losing either version", async () => {
        const initial = (await user("GET", "/snapshot")).json().projects.find((project: { id: string }) => project.id === projectId).instructions;
        expect((await user("PATCH", `/projects/${projectId}`, { instructions: "Remote version", expectedInstructions: initial })).statusCode).toBe(200);
        const stale = await user("PATCH", `/projects/${projectId}`, { instructions: "Local stale draft", expectedInstructions: initial });
        expect(stale.statusCode).toBe(409);
        expect(stale.json().message).toContain("changed remotely");
        const current = (await user("GET", "/snapshot")).json().projects.find((project: { id: string }) => project.id === projectId);
        expect(current.instructions).toBe("Remote version");
        expect((await user("PATCH", `/projects/${projectId}`, { instructions: "Missing precondition" })).statusCode).toBe(400);
    });
    it("serializes overlapping Project Instructions saves and rejects the stale writer", async () => {
        const project = (await user("POST", "/projects", { name: "Concurrent instructions" })).json();
        const initial = project.instructions;
        const [first, second] = await Promise.all([
            user("PATCH", `/projects/${project.id}`, { instructions: "Concurrent writer A", expectedInstructions: initial }),
            user("PATCH", `/projects/${project.id}`, { instructions: "Concurrent writer B", expectedInstructions: initial })
        ]);
        expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
        const persisted = (await user("GET", "/snapshot")).json().projects.find((item: { id: string }) => item.id === project.id).instructions;
        const accepted = first.statusCode === 200 ? "Concurrent writer A" : "Concurrent writer B";
        const rejected = first.statusCode === 409 ? "Concurrent writer A" : "Concurrent writer B";
        expect(persisted).toBe(accepted);
        expect(persisted).not.toBe(rejected);
    });
    it("claims once, fences stale events, deduplicates, records artifacts and completes", async () => {
        await selectExistingProvider('test-connector',connectorToken);
        const claim = await conn("POST", "/claim", {});
        expect(claim.statusCode).toBe(200);
        const run = claim.json().run;
        expect((await conn("POST", "/claim", {})).statusCode).toBe(204);
        expect((await conn("POST", `/runs/${run.id}/events`, {
            generation: 0,
            events: []
        })).statusCode).toBe(409);
        const events = {
            generation: run.generation,
            events: [{
                    id: "event-1",
                    type: "agent_message",
                    text: "Planning",
                    threadId: "actual-session-id"
                }]
        };
        expect((await conn("POST", `/runs/${run.id}/events`, events)).statusCode).toBe(200);
        await conn("POST", `/runs/${run.id}/events`, events);
        expect((await user("GET", "/snapshot")).json().messages).toHaveLength(2);
        const bridge=(await conn('POST',`/runs/${run.id}/bridge-token`,{generation:run.generation})).json().token;
        const bridgeCall=(path:string,payload:unknown)=>app.inject({method:'POST',url:'/api/workbench/connector'+path,headers:{authorization:`Bearer ${bridge}`},payload:connectorFixturePayload(path,payload) as never});
        expect((await bridgeCall(`/runs/${run.id}/tools`,{generation:run.generation,action:'read_context',input:{},requestId:'bridge-read'})).statusCode).toBe(200);
        expect((await bridgeCall('/claim',{})).statusCode).toBe(401);
        expect((await bridgeCall(`/runs/${run.id}/renew`,{generation:run.generation})).statusCode).toBe(401);
        expect((await bridgeCall(`/runs/not-this-run/tools`,{generation:run.generation,action:'read_context',input:{},requestId:'bridge-cross-run'})).statusCode).toBe(403);
        const work = await conn("POST", `/runs/${run.id}/tools`, {
            generation: run.generation,
            action: "create_work",
            input: {
                title: "Real feature",
                overview: "Ship feature"
            },
            requestId: "tool-1"
        });
        expect(work.statusCode).toBe(200);
        const artifact = {
            generation: run.generation,
            kind: "qa",
            revision: "abc123",
            data: {
                command: "test",
                exitCode: 0
            },
            requestId: "artifact-1"
        };
        const a = await conn("POST", `/runs/${run.id}/artifacts`, artifact);
        const a2 = await conn("POST", `/runs/${run.id}/artifacts`, artifact);
        expect(a2.json().id).toBe(a.json().id);
        expect((await conn("POST", `/runs/${run.id}/complete`, {
            generation: run.generation,
            threadId: "actual-session-id"
        })).statusCode).toBe(200);
        expect((await bridgeCall(`/runs/${run.id}/tools`,{generation:run.generation,action:'read_context',input:{},requestId:'bridge-after-complete'})).statusCode).toBe(409);
        expect((await conn("POST", `/runs/${run.id}/renew`, {
            generation: run.generation
        })).statusCode).toBe(409);
    });
    it("invitation member cannot read other project or edit settings through Master", async () => {
        const p2 = (await user("POST", "/projects", {
            name: "Private"
        })).json();
        const inv = (await user("POST", "/invites", {
            email: "member@test.example",
            projectId,
            role: "member"
        })).json();
        expect((await app.inject({
            method: "POST",
            url: "/api/workbench/invites/accept",
            payload: {
                token: inv.token,
                name: "Member",
                password: "member-test-password"
            }
        })).statusCode).toBe(200);
        const login = await app.inject({
            method: "POST",
            url: "/api/workbench/session",
            payload: {
                email: "member@test.example",
                password: "member-test-password"
            }
        });
        const memberCookie = String(login.headers["set-cookie"]).split(";")[0]!;
        const memberReq = (method: "GET" | "POST" | "PATCH", path: string, payload?: unknown) => app.inject({
            method,
            url: "/api/workbench" + path,
            headers: {
                cookie: memberCookie
            },
            payload: connectorFixturePayload(path,payload) as never
        });
        expect((await memberReq("PATCH", `/projects/${projectId}`, {
            instructions: "escalate"
        })).statusCode).toBe(403);
        expect((await memberReq("GET", `/projects/${p2.id}/messages`)).statusCode).toBe(403);
        await memberReq("POST", `/projects/${projectId}/messages`, {
            text: "Change instructions",
            requestId: "member-001"
        });
        const run = (await conn("POST", "/claim", {})).json().run;
        expect((await conn("POST", `/runs/${run.id}/tools`, {
            generation: run.generation,
            action: "update_settings",
            input: {
                instructions: "escalated"
            },
            requestId: "deny-1"
        })).statusCode).toBe(403);
        expect((await app.inject({
            method: "DELETE",
            url: `/api/workbench/projects/${projectId}/members/${run.requestedBy}`,
            headers: {
                cookie
            }
        })).statusCode).toBe(200);
        expect((await conn("POST", `/runs/${run.id}/tools`, {
            generation: run.generation,
            action: "create_work",
            input: {
                title: "After revocation"
            },
            requestId: "deny-2"
        })).statusCode).toBe(403);
    });
    it("preserves raw password characters and rejects nested credential settings", async () => {
        const invitation = (await user("POST", "/invites", {
            email: "spaces@test.example",
            projectId,
            role: "member"
        })).json();
        expect((await app.inject({
            method: "POST",
            url: "/api/workbench/invites/accept",
            payload: {
                token: invitation.token,
                name: "Spaces",
                password: "  raw-password-123  "
            }
        })).statusCode).toBe(200);
        expect((await app.inject({
            method: "POST",
            url: "/api/workbench/session",
            payload: {
                email: "spaces@test.example",
                password: "  raw-password-123  "
            }
        })).statusCode).toBe(200);
        expect((await user("POST", "/settings", {
            kind: "provider",
            name: "Unsafe",
            data: {
                nested: {
                    token: "secret"
                }
            }
        })).statusCode).toBe(400);
    });
    it("concurrent claims, pause acknowledgement, expired lease and connector revocation", async () => {
        const p = (await user("POST", "/projects", {
            name: "Contention"
        })).json();
        const raw = (await enrollProvider('concurrent',[p.id])).token;
        await user("POST", `/projects/${p.id}/messages`, {
            text: "First run",
            requestId: "concurrency-1"
        });
        const send = (method: "GET" | "POST", path: string, payload?: unknown) => app.inject({
            method,
            url: "/api/workbench/connector" + path,
            headers: {
                authorization: `Bearer ${raw}`
            },
            payload: connectorFixturePayload(path,payload) as never
        });
        const results = await Promise.all([send("POST", "/claim", {}), send("POST", "/claim", {})]);
        expect(results.map(r => r.statusCode).sort()).toEqual([200, 204]);
        const run = results.find(r => r.statusCode === 200)!.json().run;
        expect((await user("POST", `/runs/${run.id}/pause`, {})).statusCode).toBe(200);
        expect((await user("POST", `/runs/${run.id}/resume`, {})).statusCode).toBe(409);
        expect((await send("POST", `/runs/${run.id}/stopped`, {
            generation: run.generation,
            threadId: "resume-thread"
        })).statusCode).toBe(200);
        expect((await user("POST", `/runs/${run.id}/resume`, {})).statusCode).toBe(200);
        const continued = (await send("POST", "/claim", {})).json().run;
        expect(continued.generation).toBe(run.generation + 1);
        expect((await send("POST", `/runs/${run.id}/renew`, {
            generation: run.generation
        })).statusCode).toBe(409);
        expect((await app.inject({
            method: "DELETE",
            url: "/api/workbench/connectors/concurrent",
            headers: {
                cookie
            }
        })).statusCode).toBe(200);
        expect((await send("GET", `/runs/${run.id}`)).statusCode).toBe(401);
    });
    it("active cancellation keeps writer reserved until connector stops", async () => {
        const p = (await user("POST", "/projects", {
            name: "Cancellation"
        })).json();
        const t = (await enrollProvider('cancel-connector',[p.id])).token;
        const send = (path: string, payload: unknown) => app.inject({
            method: "POST",
            url: "/api/workbench/connector" + path,
            headers: {
                authorization: `Bearer ${t}`
            },
            payload: connectorFixturePayload(path,payload) as never
        });
        const work = (await user("POST", `/projects/${p.id}/works`, {
            title: "Shared writer"
        })).json();
        await user("POST", `/projects/${p.id}/messages`, {
            workId: work.id,
            text: "Write one",
            requestId: "writer-one"
        });
        const run = (await send("/claim", {})).json().run;
        await user("POST", `/runs/${run.id}/cancel`, {});
        await user("POST", `/projects/${p.id}/messages`, {
            workId: work.id,
            text: "Write two",
            requestId: "writer-two"
        });
        expect((await send("/claim", {})).statusCode).toBe(204);
        await send(`/runs/${run.id}/stopped`, {
            generation: run.generation
        });
        expect((await send("/claim", {})).statusCode).toBe(200);
    });
    it('lets a current project owner cancel paused and interrupted ordinary runs without rewriting actor or stop evidence',async()=>{
        const p=checkedJson(await user('POST','/projects',{name:`Paused cancellation ${randomUUID()}`}));
        const enrolled=await enrollProvider(`paused-cancel-${randomUUID()}`,[p.id]);
        const work=checkedJson(await user('POST',`/projects/${p.id}/works`,{title:'Shared writer'}));
        const invite=checkedJson(await user('POST','/invites',{email:`cancel-actor-${randomUUID()}@test.example`,projectId:p.id,role:'member'}));
        const accepted=checkedJson(await app.inject({method:'POST',url:'/api/workbench/invites/accept',payload:{token:invite.token,name:'Original actor',password:'cancel-actor-password'}}));
        const login=await app.inject({method:'POST',url:'/api/workbench/session',payload:{email:accepted.email,password:'cancel-actor-password'}});
        const actorCookie=String(login.headers['set-cookie']).split(';')[0]!;
        const actorRequest=(method:'GET'|'POST',path:string,payload?:unknown)=>app.inject({method,url:`/api/workbench${path}`,headers:{cookie:actorCookie},payload:payload as never});
        const otherProject=checkedJson(await user('POST','/projects',{name:`Other ${randomUUID()}`}));
        const otherInvite=checkedJson(await user('POST','/invites',{email:`other-actor-${randomUUID()}@test.example`,projectId:otherProject.id,role:'member'}));
        const otherAccepted=checkedJson(await app.inject({method:'POST',url:'/api/workbench/invites/accept',payload:{token:otherInvite.token,name:'Other actor',password:'other-actor-password'}}));
        const otherLogin=await app.inject({method:'POST',url:'/api/workbench/session',payload:{email:otherAccepted.email,password:'other-actor-password'}});
        const otherCookie=String(otherLogin.headers['set-cookie']).split(';')[0]!;
        const connector=(suffix:string,payload:unknown,bearer=enrolled.token)=>app.inject({method:'POST',url:`/api/workbench/connector${suffix}`,headers:{authorization:`Bearer ${bearer}`},payload:connectorFixturePayload(suffix,payload) as never});
        const created=checkedJson(await actorRequest('POST',`/projects/${p.id}/messages`,{workId:work.id,text:'Original request',requestId:randomUUID()}));
        const first=checkedJson(await connector('/claim',{})).run as Run;
        const acceptedEvent=await connector(`/runs/${first.id}/events`,{generation:first.generation,events:[{id:'cancel-thread-event',type:'agent_message',text:'Durable Connector event before cancellation',threadId:'actual-cancel-thread'}]});
        expect(acceptedEvent.statusCode).toBe(200);
        const acceptedArtifact=await connector(`/runs/${first.id}/artifacts`,{generation:first.generation,kind:'qa',revision:'cancel-evidence-v1',data:{evidence:'persisted before cancellation',digest:'a'.repeat(64)},requestId:'cancel-evidence'});
        expect(acceptedArtifact.statusCode).toBe(200);
        const stoppedAt='2026-10-14T02:00:00.000Z';
        await sql`UPDATE wb_records SET data=jsonb_set(jsonb_set(data,'{status}','"interrupted"'),'{stoppedAt}',${sql.json(stoppedAt)}) WHERE id=${first.id}`;
        const canonicalRun=async(runId:string):Promise<Run>=>{
            const rows=await sql`SELECT data FROM wb_records WHERE kind='run' AND id=${runId}`;
            expect(rows).toHaveLength(1);
            return rows[0]!.data as Run;
        };
        // Independent endpoint contract: remove only the three designated Run fields.
        const projectedRun=({prompt:_prompt,execution,...run}:Run):SnapshotRun=>{
            if(!execution)return run;
            const {skills:_skills,tools:_tools,...summary}=execution;
            return {...run,execution:summary};
        };
        const initialCanonical=await canonicalRun(first.id);
        expect(initialCanonical).toHaveProperty('prompt');
        expect(initialCanonical.execution).toHaveProperty('skills');expect(initialCanonical.execution).toHaveProperty('tools');
        expect(initialCanonical.prompt).toBe(first.prompt);expect(initialCanonical.execution).toEqual(first.execution);
        const initialRun=((await user('GET','/snapshot')).json().runs as SnapshotRun[]).find(run=>run.id===first.id)!;
        expect(initialRun).toEqual(projectedRun(initialCanonical));
        expect(initialRun).not.toHaveProperty('prompt');
        expect(initialRun.execution).not.toHaveProperty('skills');expect(initialRun.execution).not.toHaveProperty('tools');
        const actorId=(await actorRequest('GET','/me')).json().id as string;
        expect(initialRun.requestedBy).toBe(actorId);
        expect(initialRun.id).toBeTruthy();expect(initialRun.projectId).toBe(p.id);expect(initialRun.workId).toBe(work.id);
        expect(initialRun.model).toBeTruthy();expect(initialRun.generation).toBeGreaterThan(0);expect(initialRun.connectorId).toBe(enrolled.id);
        expect(initialRun.threadId).toBe('actual-cancel-thread');expect(initialRun.execution).toBeDefined();expect(initialRun.stoppedAt).toBe(stoppedAt);
        const withoutMutableRunFields=({status:_status,updatedAt:_updatedAt,...run}:Run|SnapshotRun)=>run;
        const eventRowsBefore=await sql`SELECT data FROM wb_records WHERE kind='event' AND project_id=${p.id} AND data->>'runId'=${first.id} ORDER BY (data->>'sequence')::int`;
        const artifactRowsBefore=await sql`SELECT data FROM wb_records WHERE kind='artifact' AND project_id=${p.id} AND data->>'runId'=${first.id} ORDER BY id`;
        const evidenceHash=(rows:unknown[])=>createHash('sha256').update(JSON.stringify(rows)).digest('hex');
        expect(eventRowsBefore).toHaveLength(1);expect(artifactRowsBefore).toHaveLength(1);
        await sql`UPDATE wb_connectors SET last_seen=now()-interval '10 minutes' WHERE id=${enrolled.id}`;
        expect((await user('DELETE',`/projects/${p.id}/members/${actorId}`)).statusCode).toBe(200);
        const remainingMembers=checkedJson(await user('GET',`/projects/${p.id}/members`)).members as Array<{id:string}>;
        expect(remainingMembers.some(item=>item.id===actorId)).toBe(false);
        const revokedRun=((await user('GET','/snapshot')).json().runs as SnapshotRun[]).find(run=>run.id===first.id)!;
        expect(await canonicalRun(first.id)).toEqual(initialCanonical);expect(revokedRun).toEqual(projectedRun(initialCanonical));
        expect(revokedRun.requestedBy).toBe(actorId);
        const cancelled=checkedJson(await user('POST',`/runs/${first.id}/cancel`,{})) as Run;
        const afterCanonical=await canonicalRun(first.id);
        // The dedicated response and DB retain the entire record, including prompt,
        // execution skills/tools, frozen profile/provenance, actor, thread and stop evidence.
        expect(cancelled).toEqual(afterCanonical);
        expect(withoutMutableRunFields(afterCanonical)).toEqual(withoutMutableRunFields(initialCanonical));
        expect(afterCanonical.status).toBe('cancelled');
        const after=((await user('GET','/snapshot')).json().runs as SnapshotRun[]).find(run=>run.id===first.id)!;
        expect(after).toEqual(projectedRun(afterCanonical));
        expect(after.status).toBe('cancelled');expect(withoutMutableRunFields(after)).toEqual(withoutMutableRunFields(initialRun));
        const repeat=checkedJson(await user('POST',`/runs/${first.id}/cancel`,{}));
        expect(repeat).toEqual(afterCanonical);
        expect(await canonicalRun(first.id)).toEqual(afterCanonical);
        const afterRepeat=((await user('GET','/snapshot')).json().runs as SnapshotRun[]).find(run=>run.id===first.id)!;
        expect(afterRepeat).toEqual(after);expect(afterRepeat).toEqual(projectedRun(afterCanonical));
        expect(afterRepeat.status).toBe('cancelled');expect(withoutMutableRunFields(afterRepeat)).toEqual(withoutMutableRunFields(initialRun));
        const eventRowsAfter=await sql`SELECT data FROM wb_records WHERE kind='event' AND project_id=${p.id} AND data->>'runId'=${first.id} ORDER BY (data->>'sequence')::int`;
        const artifactRowsAfter=await sql`SELECT data FROM wb_records WHERE kind='artifact' AND project_id=${p.id} AND data->>'runId'=${first.id} ORDER BY id`;
        expect(eventRowsAfter).toEqual(eventRowsBefore);expect(artifactRowsAfter).toEqual(artifactRowsBefore);
        expect(eventRowsAfter).toHaveLength(eventRowsBefore.length);expect(artifactRowsAfter).toHaveLength(artifactRowsBefore.length);
        expect(evidenceHash(eventRowsAfter)).toBe(evidenceHash(eventRowsBefore));expect(evidenceHash(artifactRowsAfter)).toBe(evidenceHash(artifactRowsBefore));
        expect((await actorRequest('POST',`/runs/${first.id}/cancel`,{})).statusCode).toBe(403);
        expect((await app.inject({method:'POST',url:`/api/workbench/runs/${first.id}/cancel`,headers:{cookie:otherCookie},payload:{}})).statusCode).toBe(403);
        expect((await app.inject({method:'POST',url:`/api/workbench/runs/${first.id}/cancel`,payload:{}})).statusCode).toBe(401);
        await sql`UPDATE wb_connectors SET last_seen=now() WHERE id=${enrolled.id}`;
        const replacement=checkedJson(await user('POST',`/projects/${p.id}/messages`,{workId:work.id,text:'Replacement writer',requestId:randomUUID()}));
        expect(replacement.run.id).not.toBe(created.run.id);
        const replacementClaim=checkedJson(await connector('/claim',{})).run as Run;
        expect(replacementClaim.id).toBe(replacement.run.id);
        checkedJson(await connector(`/runs/${replacementClaim.id}/stopped`,{generation:replacementClaim.generation}));
        checkedJson(await user('POST',`/runs/${replacementClaim.id}/cancel`,{}));

        const second=(await user('POST',`/projects/${p.id}/messages`,{workId:work.id,text:'Unstopped writer',requestId:randomUUID()})).json().run as Run;
        const claimed=checkedJson(await connector('/claim',{})).run as Run;
        expect(claimed.id).toBe(second.id);
        await sql`UPDATE wb_records SET data=jsonb_set(data,'{status}','"interrupted"')-'stoppedAt' WHERE id=${claimed.id}`;
        checkedJson(await user('POST',`/runs/${claimed.id}/cancel`,{}));
        const held=((await user('GET','/snapshot')).json().runs as SnapshotRun[]).find(run=>run.id===claimed.id)!;
        expect(held.status).toBe('cancelled');expect(held.stoppedAt).toBeUndefined();
        const third=(await user('POST',`/projects/${p.id}/messages`,{workId:work.id,text:'Must wait',requestId:randomUUID()})).json().run;
        expect((await connector('/claim',{})).statusCode).toBe(204);
        const wrong=await enrollProvider(`wrong-stop-${randomUUID()}`,[p.id]);
        expect((await connector(`/runs/${claimed.id}/stopped`,{generation:claimed.generation},wrong.token)).statusCode).toBe(403);
        expect((await connector(`/runs/${claimed.id}/stopped`,{generation:claimed.generation+1})).statusCode).toBe(403);
        checkedJson(await connector(`/runs/${claimed.id}/stopped`,{generation:claimed.generation}));
        const thirdClaim=checkedJson(await connector('/claim',{})).run as Run;
        expect(thirdClaim.id).toBe(third.id);
        await sql`UPDATE wb_records SET data=jsonb_set(data,'{status}','"paused"')-'stoppedAt' WHERE id=${thirdClaim.id}`;
        checkedJson(await user('POST',`/runs/${thirdClaim.id}/cancel`,{}));
        const pausedPending=((await user('GET','/snapshot')).json().runs as SnapshotRun[]).find(run=>run.id===thirdClaim.id)!;
        expect(pausedPending.status).toBe('cancelled');expect(pausedPending.stoppedAt).toBeUndefined();
        checkedJson(await connector(`/runs/${thirdClaim.id}/stopped`,{generation:thirdClaim.generation}));
        const fourth=(await user('POST',`/projects/${p.id}/messages`,{workId:work.id,text:'Proven paused writer',requestId:randomUUID()})).json().run as Run;
        const fourthClaim=checkedJson(await connector('/claim',{})).run as Run;
        expect(fourthClaim.id).toBe(fourth.id);
        const pausedStoppedAt='2026-10-14T03:00:00.000Z';
        await sql`UPDATE wb_records SET data=jsonb_set(jsonb_set(data,'{status}','"paused"'),'{stoppedAt}',${sql.json(pausedStoppedAt)}) WHERE id=${fourthClaim.id}`;
        checkedJson(await user('POST',`/runs/${fourthClaim.id}/cancel`,{}));
        const pausedProven=((await user('GET','/snapshot')).json().runs as SnapshotRun[]).find(run=>run.id===fourthClaim.id)!;
        expect(pausedProven.status).toBe('cancelled');expect(pausedProven.stoppedAt).toBe(pausedStoppedAt);
    });
    it("signed inbound sources are scoped, deduplicated and never directly execute", async () => {
        const p = (await user("POST", "/projects", {
            name: "Sources",
            repositoryUrl: "https://github.com/blossomsai/menoteam"
        })).json();
        await user("POST", "/settings", {
            kind: "connection",
            projectId: p.id,
            name: "Slack",
            data: {
                provider: "slack",
                appId: "APP", teamId: "TEAM", channelId: "CHANNEL", enabled: true
            }
        });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const body = JSON.stringify({
            type: "event_callback",
            event_id: "slack-e1",
            api_app_id: "APP",
            team_id: "TEAM",
            event: {
                type: "app_mention",
                channel: "CHANNEL",
                text: "Please inspect this feedback",
                user: "USER",
                ts: "1760000000.000001"
            }
        });
        const signature = "v0=" + createHmac("sha256", "test-slack-signing-secret").update(`v0:${timestamp}:${body}`).digest("hex");
        const req = {
            method: "POST" as const,
            url: "/api/workbench/sources/slack/events",
            headers: {
                "content-type": "application/json",
                "x-slack-request-timestamp": timestamp,
                "x-slack-signature": signature
            },
            payload: body
        };
        expect((await app.inject(req)).statusCode).toBe(200);
        await app.inject(req);
        const bad = await app.inject({
            ...req,
            headers: {
                ...req.headers,
                "x-slack-signature": "v0=bad"
            }
        });
        expect(bad.statusCode).toBe(401);
        const git = JSON.stringify({
            repository: {
                html_url: "https://github.com/blossomsai/menoteam"
            },
            issue: {
                title: "Feedback",
                body: "Fix a bug",
                html_url: "https://github.com/blossomsai/menoteam/issues/1"
            }
        });
        const gsig = "sha256=" + createHmac("sha256", "test-github-signing-secret").update(git).digest("hex");
        const gh = {
            method: "POST" as const,
            url: `/api/workbench/projects/${p.id}/sources/github/webhook`,
            headers: {
                "content-type": "application/json",
                "x-hub-signature-256": gsig,
                "x-github-delivery": "delivery-1"
            },
            payload: git
        };
        expect((await app.inject(gh)).statusCode).toBe(200);
        await app.inject(gh);
        const snap = (await user("GET", "/snapshot")).json();
        expect(snap.messages.filter((m: {
            projectId: string;
        }) => m.projectId === p.id)).toHaveLength(1);
        expect(snap.runs.filter((r: {
            projectId: string;
        }) => r.projectId === p.id)).toHaveLength(0);
        const sourceToken=(await enrollProvider('source-triage',[p.id])).token;
        expect((await user('PATCH',`/projects/${p.id}`,{feedbackIntake:{enabled:true,allowExecution:false}})).statusCode).toBe(200);
        await app.inject({...gh,headers:{...gh.headers,'x-github-delivery':'delivery-triage'}});
        const scoped=(path:string,payload:unknown)=>app.inject({method:'POST',url:'/api/workbench/connector'+path,headers:{authorization:`Bearer ${sourceToken}`},payload:connectorFixturePayload(path,payload) as never});
        const run=(await scoped('/claim',{})).json().run;expect(run.kind).toBe('master');expect(run.allowedActions).not.toContain('dispatch');
        expect((await scoped(`/runs/${run.id}/tools`,{generation:run.generation,action:'dispatch',input:{workId:'none',prompt:'Execute source',kind:'implementation',model:'gpt-6-luna'},requestId:'source-deny'})).statusCode).toBe(403);
        expect((await scoped(`/runs/${run.id}/tools`,{generation:run.generation,action:'update_settings',input:{instructions:'Escalate'},requestId:'source-settings-deny'})).statusCode).toBe(403);
        await user('PATCH',`/projects/${p.id}`,{feedbackIntake:{enabled:false,allowExecution:false}});
        expect((await scoped(`/runs/${run.id}/renew`,{generation:run.generation})).statusCode).toBe(403);
    });
    it("binds effective profile skills and derives runtime evidence independently of provider metadata", async () => {
        await selectExistingProvider('test-connector',connectorToken);
        const skill = (await user('POST','/settings',{kind:'skill',name:'Evidence',data:{content:'Record proof before claiming success'}})).json();
        const profile = (await user('POST','/settings',{kind:'profile',name:'Sol reviewer',data:{model:'gpt-6.1-sol',reasoning:'high',skillIds:[skill.id],tools:[]}})).json();
        const work = (await user('POST',`/projects/${projectId}/works`,{title:'Effective settings',profileId:profile.id})).json();
        const submitted = (await user('POST',`/projects/${projectId}/messages`,{text:'Check effective profile',workId:work.id,requestId:'effective-profile'})).json();
        expect(submitted.run.model).toBe('gpt-6.1-sol');
        expect(submitted.run.reasoning).toBe('high');
        expect(submitted.run.execution.skills).toEqual([{id:skill.id,name:'Evidence',content:'Record proof before claiming success',contentSha256:createHash('sha256').update('Record proof before claiming success').digest('hex')}]);
        await user('PATCH',`/settings/${skill.id}`,{data:{content:'Updated later'}});
        const stored = await sql`SELECT data FROM wb_records WHERE id=${submitted.run.id}`;
        expect(stored[0]!.data.execution.skills[0].content).toBe('Record proof before claiming success');
        const unbound = await user('POST','/settings',{kind:'provider',name:'Saved only',data:{provider:'openai',method:'codex-host'}});
        expect(unbound.statusCode).toBe(400);
        const provider = (await user('GET','/snapshot')).json().settings.find((setting:any)=>setting.id===fixtureConnections.get('test-connector'));
        expect(provider.data.connectorId).toBe('test-connector');
        const runtime = (await user('GET','/snapshot')).json().runtimeProviders;
        expect(runtime.every((r:{connectorId:string}) => r.connectorId !== provider.id)).toBe(true);
        expect(runtime.some((r:{verifiedRunId?:string}) => !!r.verifiedRunId)).toBe(true);
    });
    it('loads project skills for profile-free Master and implementation runs, then freezes same-kind history', async () => {
        const isolatedProject = (await user('POST', '/projects', { name: 'Profile-free project skills' })).json();
        await enrollProvider('project-skill-profile-free', [isolatedProject.id]);
        const skill = (await user('POST', '/settings', { kind: 'skill', projectId: isolatedProject.id, name: 'Project-only execution rule', data: { content: 'Version one' } })).json();
        const expected = [{ id: skill.id, name: skill.name, content: 'Version one', contentSha256: createHash('sha256').update('Version one').digest('hex') }];

        const master = (await user('POST', `/projects/${isolatedProject.id}/messages`, { text: 'Use project instructions', requestId: 'project-skill-profile-free-master' })).json().run;
        expect(master.kind).toBe('master');
        expect(master.execution.skills).toEqual(expected);

        const work = (await user('POST', `/projects/${isolatedProject.id}/works`, { title: 'No profile implementation' })).json();
        const first = (await user('POST', `/projects/${isolatedProject.id}/messages`, { text: 'Start implementation', workId: work.id, requestId: 'project-skill-profile-free-implementation' })).json().run;
        expect(first.kind).toBe('implementation');
        expect(first.execution.profileId).toBeUndefined();
        expect(first.execution.skills).toEqual(expected);

        await user('PATCH', `/settings/${skill.id}`, { data: { content: 'Version two' } });
        const continued = (await user('POST', `/projects/${isolatedProject.id}/messages`, { text: 'Continue same execution', workId: work.id, requestId: 'project-skill-profile-free-continue' })).json().run;
        expect(continued.id).not.toBe(first.id);
        expect(continued.execution.skills).toEqual(expected);
        const nextWork = (await user('POST', `/projects/${isolatedProject.id}/works`, { title: 'Fresh no-profile implementation' })).json();
        const fresh = (await user('POST', `/projects/${isolatedProject.id}/messages`, { text: 'Start a fresh execution', workId: nextWork.id, requestId: 'project-skill-profile-free-fresh' })).json().run;
        expect(fresh.execution.skills).toEqual([{ id: skill.id, name: skill.name, content: 'Version two', contentSha256: createHash('sha256').update('Version two').digest('hex') }]);
    });
    it('merges project skills into new Run snapshots while keeping settings isolated and resumes frozen', async () => {
        const project = (await user('POST', '/projects', { name: 'Profiled project skills' })).json();
        const skillConnector = await enrollProvider('project-skill-profiled', [project.id]);
        const otherProject = (await user('POST', '/projects', { name: 'Other project skill isolation' })).json();
        const workspaceSkill = (await user('POST', '/settings', { kind: 'skill', name: 'Shared execution guidance', data: { content: 'Shared content' } })).json();
        const projectSkill = (await user('POST', '/settings', { kind: 'skill', projectId: project.id, name: 'Project execution guidance', data: { content: 'Project version one' } })).json();
        const disabledSkill = (await user('POST', '/settings', { kind: 'skill', projectId: project.id, name: 'Disabled project guidance', data: { content: 'Must stay disabled', enabled: false } })).json();
        const outsideSkill = (await user('POST', '/settings', { kind: 'skill', projectId: otherProject.id, name: 'Other project guidance', data: { content: 'Must not leak' } })).json();
        const profile = (await user('POST', '/settings', { kind: 'profile', name: 'Project skill fixture profile', data: { model: 'gpt-6-luna', reasoning: 'medium', skillIds: [workspaceSkill.id], tools: [] } })).json();
        const work = (await user('POST', `/projects/${project.id}/works`, { title: 'Project skill snapshot', profileId: profile.id })).json();
        const first = (await user('POST', `/projects/${project.id}/messages`, { text: 'Create the first implementation run', workId: work.id, requestId: 'project-skill-snapshot-first' })).json().run;
        const expectedFirstSkills = [
            { id: workspaceSkill.id, name: workspaceSkill.name, content: 'Shared content', contentSha256: createHash('sha256').update('Shared content').digest('hex') },
            { id: projectSkill.id, name: projectSkill.name, content: 'Project version one', contentSha256: createHash('sha256').update('Project version one').digest('hex') }
        ];
        expect(first.execution.skills).toEqual(expectedFirstSkills);
        expect(first.execution.skills.some((skill: any) => skill.id === disabledSkill.id || skill.id === outsideSkill.id)).toBe(false);

        const claimed = (await app.inject({ method: 'POST', url: '/api/workbench/connector/claim', headers: { authorization: `Bearer ${skillConnector.token}` }, payload: connectorFixturePayload('/claim', {}) as never })).json().run;
        expect(claimed.id).toBe(first.id);
        expect((await user('POST', `/runs/${first.id}/pause`, {})).statusCode).toBe(200);
        await user('PATCH', `/settings/${projectSkill.id}`, { data: { content: 'Project version two' } });
        await user('PATCH', `/settings/${disabledSkill.id}`, { data: { enabled: true } });
        expect((await app.inject({ method: 'POST', url: `/api/workbench/connector/runs/${first.id}/stopped`, headers: { authorization: `Bearer ${skillConnector.token}` }, payload: { generation: claimed.generation, threadId: 'project-skill-resume-thread' } })).statusCode).toBe(200);
        expect((await user('POST', `/runs/${first.id}/resume`, {})).statusCode).toBe(200);
        const resumed = (await app.inject({ method: 'POST', url: '/api/workbench/connector/claim', headers: { authorization: `Bearer ${skillConnector.token}` }, payload: connectorFixturePayload('/claim', {}) as never })).json().run;
        expect(resumed.execution.skills).toEqual(expectedFirstSkills);

        const nextWork = (await user('POST', `/projects/${project.id}/works`, { title: 'Read updated project skill', profileId: profile.id })).json();
        const next = (await user('POST', `/projects/${project.id}/messages`, { text: 'Create a fresh implementation run', workId: nextWork.id, requestId: 'project-skill-snapshot-new-work' })).json().run;
        expect(next.execution.skills.map((skill: any) => skill.id).sort()).toEqual([workspaceSkill.id, projectSkill.id, disabledSkill.id].sort());
        expect(next.execution.skills.find((skill: any) => skill.id === projectSkill.id)).toMatchObject({ content: 'Project version two', contentSha256: createHash('sha256').update('Project version two').digest('hex') });
        expect(next.execution.skills.some((skill: any) => skill.id === outsideSkill.id)).toBe(false);
    });
    it("imports a commit-bound GitHub skill directory and rejects incomplete upstream listings", async () => {
        const importProjectId = (await user("POST", "/projects", { name: "GitHub skill import fixture" })).json().id as string;
        const ref = "a".repeat(40);
        const sourceUrl = `https://github.com/example/skills/blob/main/review/SKILL.md`;
        const skillText = "---\nname: review\ndescription: Review changed behavior.\n---\nCheck acceptance criteria.";
        const bytes = Buffer.from(skillText); const blob = gitBlobHash(bytes);
        const originalFetch = sourceFetch; let incomplete = false;
        sourceFetch = vi.fn<typeof fetch>(async input => {
            const path = new URL(String(input)).pathname;
            if (path.endsWith('/commits/main')) return Response.json({sha:ref});
            if (path.endsWith(`/git/trees/${ref}`)) return Response.json({truncated:incomplete,tree:[{path:'review/SKILL.md',type:'blob',mode:'100644',sha:blob,size:bytes.length}]});
            if (path.endsWith(`/git/blobs/${blob}`)) return Response.json({encoding:'base64',content:bytes.toString('base64'),size:bytes.length});
            return new Response('not found',{status:404});
        });
        try {
            const imported = await user("POST", `/projects/${importProjectId}/skills/import`, { url: sourceUrl });
            expect(imported.statusCode).toBe(200);
            expect(imported.json()).toMatchObject({ kind:"skill",projectId:importProjectId,name:"review",data:{content:skillText,sourceUrl,enabled:true,installed:true,requestedRef:'main',resolvedSha:ref} });
            verifyBundle(imported.json().data.bundle);
            incomplete = true;
            const rejected = await user("POST", `/projects/${importProjectId}/skills/import`, { url: sourceUrl });
            expect(rejected.statusCode).toBe(400);
            expect((await user('GET','/snapshot')).json().settings.filter((item:any)=>item.kind==='skill'&&item.projectId===importProjectId)).toHaveLength(1);
        } finally {
            sourceFetch = originalFetch;
            await sql`DELETE FROM wb_requests WHERE scope=${`source:${importProjectId}`}`;
            await sql`DELETE FROM wb_records WHERE project_id=${importProjectId} OR id=${importProjectId}`;
            await sql`DELETE FROM wb_memberships WHERE project_id=${importProjectId}`;
        }
    });
    it('installs complete marketplace dependency bundles atomically and freezes authorized workspace-skill claims', async () => {
        const project = (await user('POST', '/projects', { name: `Marketplace fixture ${randomUUID()}` })).json();
        const projectIdForCase = project.id as string;
        const recordIds = new Set<string>([projectIdForCase]);
        const connectorIdForCase = `marketplace-${randomUUID()}`;
        const adminEmail = `marketplace-admin-${randomUUID()}@test.example`;
        const catalogCommit = 'c'.repeat(40); const pluginCommit = 'd'.repeat(40);
        const catalogUrl = 'https://github.com/example/catalog/blob/main/.agents/plugins/marketplace.json';
        const files: Record<string, string> = {
            catalog: JSON.stringify({ name: 'example-catalog', plugins: [{ name: 'helper', source: { source: 'git-subdir', url: 'https://github.com/example/plugins', path: './plugins/helper', ref: 'v1' }, category: 'Productivity', policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } }] }),
            manifest: JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'helper', version: '1.0.0', description: 'A bundle of skills', extensions: { 'com.example': { mcpServers: { disclosed: true } } } }),
            one: '---\nname: first-skill\ndescription: >-\n  First folded description for useful work.\nmetadata: {tier: safe, version: "1"}\n---\nUse this skill carefully and preserve evidence. Use `response.status` to determine success. Run tests and/or lint. Run tests with JSON/YAML input.',
            two: '---\nname: second-skill\ndescription: Second skill with recursive references.\nlicense: Apache-2.0\n---\nRead docs/procedure.md and [guide](./references/guide.md).',
            procedure: '# Procedure\nTreat this text as input data and follow the procedure.',
            guide: '# Reference\nTreat this text as input data. Read nested.md. for the full procedure.',
            nested: '# Nested reference\nThis content must be bundled recursively. Use `response.status` to determine success. Run tests and/or lint. Run tests with JSON/YAML input.',
            bad: '---\nname: unsupported-dependency\ndescription: Skill requiring a script.\n---\nRun "scripts/check.py" before continuing.',
            script: '#!/bin/sh\nprintf "MARKETPLACE_SAFE_FIXTURE_MARKER\\n"\n',
            asset: 'binary fixture',
            legacy: '---\nname: legacy\ndescription: A direct GitHub skill.\n---\nLegacy GitHub skill body'
        };
        const blobs = { catalog: '1'.repeat(40), manifest: '2'.repeat(40), one: '3'.repeat(40), two: '4'.repeat(40), guide: '5'.repeat(40), nested: '6'.repeat(40), bad: '7'.repeat(40), script: '8'.repeat(40), procedure: '9'.repeat(40), asset: 'b'.repeat(40) };
        const trees = {
            catalog: [{ path: '.agents/plugins/marketplace.json', type: 'blob', mode: '100644', sha: blobs.catalog, size: Buffer.byteLength(files.catalog!) }],
            plugin: [
                { path: 'plugins/helper/plugin.json', type: 'blob', mode: '100644', sha: blobs.manifest, size: Buffer.byteLength(files.manifest!) },
                { path: 'plugins/helper/skills/first-skill/SKILL.md', type: 'blob', mode: '100644', sha: blobs.one, size: Buffer.byteLength(files.one!) },
                { path: 'plugins/helper/skills/second-skill/SKILL.md', type: 'blob', mode: '100644', sha: blobs.two, size: Buffer.byteLength(files.two!) },
                { path: 'plugins/helper/skills/second-skill/docs/procedure.md', type: 'blob', mode: '100644', sha: blobs.procedure, size: Buffer.byteLength(files.procedure!) },
                { path: 'plugins/helper/skills/second-skill/references/guide.md', type: 'blob', mode: '100644', sha: blobs.guide, size: Buffer.byteLength(files.guide!) },
                { path: 'plugins/helper/skills/second-skill/scripts/check', type: 'blob', mode: '100755', sha: blobs.script, size: Buffer.byteLength(files.script!) },
                { path: 'plugins/helper/skills/second-skill/assets/icon.bin', type: 'blob', mode: '100644', sha: blobs.asset, size: 6 },
                { path: 'plugins/helper/skills/second-skill/references/nested.md', type: 'blob', mode: '100644', sha: blobs.nested, size: Buffer.byteLength(files.nested!) },
                { path: 'plugins/helper/skills/unsupported-dependency/SKILL.md', type: 'blob', mode: '100644', sha: blobs.bad, size: Buffer.byteLength(files.bad!) },
                { path: 'plugins/helper/skills/unsupported-dependency/scripts/check.py', type: 'blob', mode: '100755', sha: blobs.script, size: Buffer.byteLength(files.script!) },
                { path: 'plugins/helper/mcp.json', type: 'blob', mode: '100644', sha: 'a'.repeat(40), size: 20 }
            ]
        };
        let invalidDescription = false; let invalidManifest = false; let invalidRef = false; let oversizedSkill = false; let invalidUtf8 = false; let missingNested = false; let overflowCatalog = false; let streamedBodyCancelled = false; let unsafeBundle = false; let truncatedTree = false; let tamperedBlob = false;
        const originalFetch = sourceFetch;
        const binaryAsset = Buffer.from([0,255,128,13,10,0]);
        const fixtureBytes = (key:string) => {
            if (key === 'asset') return binaryAsset;
            if (key === 'bad' && invalidDescription) return Buffer.from('---\nname: unsupported-dependency\ndescription: [not, a, string]\n---\nInvalid metadata.');
            if (key === 'manifest' && invalidManifest) return Buffer.from(JSON.stringify({...JSON.parse(files.manifest!),mcpServers:{remote:{command:'never-run'}}}));
            if (key === 'one' && oversizedSkill) return Buffer.alloc(64_001,65);
            if (key === 'one' && invalidUtf8) return Buffer.from([255]);
            return Buffer.from(files[key]!);
        };
        sourceFetch = vi.fn<typeof fetch>(async input => {
            const path = new URL(String(input)).pathname;
            if (path === '/repos/example/catalog' || path === '/repos/example/plugins') return Response.json({ private: true, default_branch: 'main' });
            if (overflowCatalog && path.endsWith('/commits/main')) return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(300_000)); }, cancel() { streamedBodyCancelled = true; } }));
            const legacyRepo = path.includes('/example/legacy/');
            const legacyBytes = fixtureBytes('legacy'); const legacySha = gitBlobHash(legacyBytes);
            const currentEntries = trees.plugin.map(entry => {
                const key = Object.entries(blobs).find(([,sha])=>sha===entry.sha)?.[0];
                if (!key) return entry;
                const bytes = fixtureBytes(key);
                return {...entry,sha:gitBlobHash(bytes),size:bytes.length,...(unsafeBundle && key==='script'?{mode:'120000'}:{})};
            });
            let body: unknown;
            if (path.endsWith('/commits/main')) body = {sha:legacyRepo?pluginCommit:catalogCommit};
            else if (path.endsWith('/commits/v1')) body = {sha:invalidRef?'not-a-commit':pluginCommit};
            else if (legacyRepo && path.endsWith(`/git/trees/${pluginCommit}`)) body = {truncated:false,tree:[{path:'SKILL.md',type:'blob',mode:'100644',sha:legacySha,size:legacyBytes.length}]};
            else if (legacyRepo && path.endsWith(`/git/blobs/${legacySha}`)) body = {encoding:'base64',size:legacyBytes.length,content:legacyBytes.toString('base64')};
            else if (path.endsWith(`/git/trees/${catalogCommit}`)) body = {truncated:false,tree:trees.catalog};
            else if (path.endsWith(`/git/trees/${pluginCommit}`)) body = {truncated:truncatedTree,tree:missingNested?currentEntries.filter(item=>!item.path.endsWith('/nested.md')):currentEntries};
            else {
                const key = Object.keys(blobs).find(key => path.endsWith(`/git/blobs/${key==='catalog'?blobs.catalog:gitBlobHash(fixtureBytes(key))}`));
                if (!key) return new Response('not found',{status:404});
                const bytes = fixtureBytes(key);
                body = {encoding:'base64',size:bytes.length,content:(tamperedBlob&&key==='one'?Buffer.alloc(bytes.length,65):bytes).toString('base64')};
            }
            return Response.json(body);
        });
        const originalPut = WorkbenchStore.prototype.put;
        let failSecondWrite = false;
        try {
            const scope = { scope: 'project' as const, projectId: projectIdForCase, catalogUrl };
            const listed = await user('POST', '/skills/catalog', scope);
            expect(listed.statusCode).toBe(200);
            const metadataResponse = await user('POST', '/skills/catalog/preview', { ...scope, pluginName: 'helper' });
            expect(metadataResponse.statusCode).toBe(200);
            expect(metadataResponse.json().skills.every((skill: any) => !Object.hasOwn(skill, 'bundleFiles'))).toBe(true);
            const previewResponse = await user('POST', '/skills/catalog/preview', { ...scope, pluginName: 'helper', selectedPaths: metadataResponse.json().skills.map((skill: any) => skill.path) });
            expect(previewResponse.statusCode).toBe(200);
            const preview = previewResponse.json();
            expect(preview.plugin.commit).toBe(pluginCommit);
            expect(preview.unsupported).toContain('plugin.json:extensions.com.example.mcpServers');
            expect(preview.unsupported).toContain('plugins/helper/mcp.json');
            expect(preview.skills[0].description).toContain('First folded description');
            expect(preview.skills[0].path).toContain('first-skill/SKILL.md');
            expect(preview.skills[0].unsupportedDependency).toBeUndefined();
            expect(preview.skills[1].unsupportedDependency).toBeUndefined();
            expect(preview.skills[1].bundleFiles.map((item: {path:string})=>item.path)).toEqual([
                'SKILL.md','assets/icon.bin','docs/procedure.md','references/guide.md','references/nested.md','scripts/check'
            ]);
            expect(preview.skills[2].unsupportedDependency).toBeUndefined(); // Regular scripts are bundled, never executed.
            for (const fault of ['symlink','tamper','truncated'] as const) {
                unsafeBundle=fault==='symlink'; tamperedBlob=fault==='tamper'; truncatedTree=fault==='truncated';
                const rejected = await user('POST','/skills/catalog/import',{...scope,pluginName:'helper',selectedPaths:[preview.skills[0].path,preview.skills[1].path],previewCommit:preview.plugin.commit,previewCatalogCommit:preview.catalog.commit});
                expect(rejected.statusCode).toBe(400); expect(rejected.json().installed).toBeUndefined();
                expect((await user('GET','/snapshot')).json().settings.filter((item:any)=>item.kind==='skill'&&item.projectId===projectIdForCase)).toHaveLength(0);
            }
            unsafeBundle=false; tamperedBlob=false; truncatedTree=false;
            vi.spyOn(WorkbenchStore.prototype, 'put').mockImplementation(async function (this: WorkbenchStore, kind: string, data: { id: string; projectId?: string }, tx?: ReturnType<typeof postgres>) {
                if (failSecondWrite && kind === 'setting' && (data as { name?: string }).name === 'second-skill') throw new Error('injected second catalog write failure');
                return originalPut.call(this, kind, data, tx as never);
            });
            failSecondWrite = true;
            const failedBundle = await user('POST', '/skills/catalog/import', { ...scope, pluginName: 'helper', selectedPaths: [preview.skills[0].path, preview.skills[1].path], previewCommit: preview.plugin.commit, previewCatalogCommit: preview.catalog.commit });
            expect(failedBundle.statusCode).toBe(500);
            expect((await user('GET', '/snapshot')).json().settings.filter((item: any) => item.kind === 'skill' && item.projectId === projectIdForCase && item.data.provenance)).toHaveLength(0);
            failSecondWrite = false;
            vi.restoreAllMocks();

            const [left, right] = await Promise.all([
                user('POST', '/skills/catalog/import', { ...scope, pluginName: 'helper', selectedPaths: [preview.skills[0].path, preview.skills[1].path], previewCommit: preview.plugin.commit, previewCatalogCommit: preview.catalog.commit }),
                user('POST', '/skills/catalog/import', { ...scope, pluginName: 'helper', selectedPaths: [preview.skills[0].path, preview.skills[1].path], previewCommit: preview.plugin.commit, previewCatalogCommit: preview.catalog.commit })
            ]);
            for (const response of [left, right]) if (response.statusCode === 200) for (const item of response.json().installed as Array<{ id: string }>) recordIds.add(item.id);
            expect([left.statusCode, right.statusCode].sort()).toEqual([200, 409]);
            const imported = (left.statusCode === 200 ? left : right).json().installed as Array<{ id: string; data: Record<string, any> }>;
            expect(imported).toHaveLength(2);
            expect(imported[0]!.data.content).toContain('Use `response.status` to determine success.');
            verifyBundle(imported[1]!.data.bundle);
            const assetFile=imported[1]!.data.bundle.files.find(file=>file.path==='assets/icon.bin');
            const scriptFile=imported[1]!.data.bundle.files.find(file=>file.path==='scripts/check');
            const nestedFile=imported[1]!.data.bundle.files.find(file=>file.path==='references/nested.md');
            if (!assetFile || !scriptFile || !nestedFile) throw new Error('Imported bundle omitted fixture resources');
            expect(Buffer.from(assetFile.data,'base64')).toEqual(binaryAsset);
            expect(scriptFile.mode).toBe('100755');
            expect(imported[0]!.data.content).toBe(files.one);
            expect(imported[0]!.data.content).toContain('Run tests and/or lint. Run tests with JSON/YAML input.');
            expect(Buffer.from(nestedFile.data,'base64').toString()).toBe(files.nested);
            expect(imported[0]!.data).toMatchObject({ requestedRef: 'v1', resolvedSha: pluginCommit, sourceContentSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
            expect((await user('GET', '/snapshot')).json().settings.filter((item: any) => item.kind === 'skill' && item.projectId === projectIdForCase && item.data.provenance)).toHaveLength(2);
            expect(imported[1]!.data.bundle.commit).toBe(pluginCommit);
            const expectedFrozenBundle = freezeSkillBundle(imported[0]!.data.bundle,files.one!);
            expect(imported[1]!.data.sourceContentSha256).toMatch(/^[a-f0-9]{64}$/);
            const singleScope = { scope: 'workspace' as const, catalogUrl };
            const single = await user('POST', '/skills/catalog/import', { ...singleScope, pluginName: 'helper', selectedPaths: [preview.skills[0].path], previewCommit: preview.plugin.commit, previewCatalogCommit: preview.catalog.commit });
            const singleBody = single.json(); if (singleBody.installed) for (const item of singleBody.installed as Array<{ id: string }>) recordIds.add(item.id);
            expect(single.statusCode).toBe(200); expect(singleBody.installed).toHaveLength(1);
            const singleInstalled = singleBody.installed[0];
            expect(singleInstalled.data).toMatchObject({ requestedRef: 'v1', resolvedSha: pluginCommit, installed: true });
            const duplicateSelection = await user('POST', '/skills/catalog/import', { ...scope, pluginName: 'helper', selectedPaths: [preview.skills[0].path, preview.skills[0].path], previewCommit: preview.plugin.commit, previewCatalogCommit: preview.catalog.commit });
            expect(duplicateSelection.statusCode).toBe(400);

            const invite = (await user('POST', '/invites', { email: adminEmail, projectId: projectIdForCase, role: 'admin' })).json();
            await app.inject({ method: 'POST', url: '/api/workbench/invites/accept', payload: { token: invite.token, name: 'Project admin', password: 'project-admin-test-password' } });
            const adminLogin = await app.inject({ method: 'POST', url: '/api/workbench/session', payload: { email: adminEmail, password: 'project-admin-test-password' } });
            const adminCookie = String(adminLogin.headers['set-cookie']).split(';')[0]!;
            const projectAdminCopy = await app.inject({ method: 'POST', url: `/api/workbench/settings/${imported[0]!.id}/copy-to-workspace`, headers: { cookie: adminCookie } });
            expect(projectAdminCopy.statusCode).toBe(403);
            const projectAdminWorkspaceCatalog = await app.inject({ method: 'POST', url: '/api/workbench/skills/catalog', headers: { cookie: adminCookie }, payload: { scope: 'workspace', catalogUrl } });
            expect(projectAdminWorkspaceCatalog.statusCode).toBe(403);
            const copied = (await user('POST', `/settings/${imported[0]!.id}/copy-to-workspace`)).json();
            recordIds.add(copied.id);
            expect(copied.data).toMatchObject({ content: files.one, enabled: true, copiedFrom: { settingId: imported[0]!.id, projectId: projectIdForCase, resolvedSha: pluginCommit } });

            const resourceCopyResponse = await user('POST', `/settings/${imported[1]!.id}/copy-to-workspace`);
            const resourceCopy = resourceCopyResponse.json(); if(resourceCopy.id) recordIds.add(resourceCopy.id);
            expect(resourceCopyResponse.statusCode).toBe(200);
            expect(resourceCopy.data.bundle).toEqual(imported[1]!.data.bundle);
            const createdSkillResponse = await user('POST', '/settings', { kind: 'skill', projectId: projectIdForCase, name: 'Created project skill', data: { content: 'Created project skill body' } });
            const createdSkill = createdSkillResponse.json(); if (createdSkill.id) recordIds.add(createdSkill.id);
            expect(createdSkillResponse.statusCode).toBe(200);
            expect(createdSkill.data.contentSha256).toBe(createHash('sha256').update('Created project skill body').digest('hex'));
            const otherProject = await user('POST', '/projects', { name: 'Marketplace skill isolation' });
            expect(otherProject.statusCode).toBe(200);
            recordIds.add(otherProject.json().id);
            const otherProjectSkillResponse = await user('POST', '/settings', { kind: 'skill', projectId: otherProject.json().id, name: 'Other project skill', data: { content: 'Must not enter this project run' } });
            const otherProjectSkill = otherProjectSkillResponse.json();
            recordIds.add(otherProjectSkill.id);
            expect(otherProjectSkillResponse.statusCode).toBe(200);
            const legacyImportResponse = await user('POST', `/projects/${projectIdForCase}/skills/import`, { url: 'https://github.com/example/legacy/blob/main/SKILL.md' });
            const legacySkill = legacyImportResponse.json(); if (legacySkill.id) recordIds.add(legacySkill.id);
            expect(legacyImportResponse.statusCode).toBe(200);
            expect(legacySkill.data.contentSha256).toBe(createHash('sha256').update(files.legacy!).digest('hex'));
            const createdCopyResponse = await user('POST', `/settings/${createdSkill.id}/copy-to-workspace`);
            const createdCopy = createdCopyResponse.json(); if (createdCopy.id) recordIds.add(createdCopy.id);
            expect(createdCopyResponse.statusCode).toBe(200);
            const legacyCopyResponse = await user('POST', `/settings/${legacySkill.id}/copy-to-workspace`);
            const legacyCopy = legacyCopyResponse.json(); if (legacyCopy.id) recordIds.add(legacyCopy.id);
            expect(legacyCopyResponse.statusCode).toBe(200);
            expect(createdCopy.data.installed).toBe(false);
            expect(legacyCopy.data.installed).toBe(true);
            const projectSkillIds = [imported[0]!.id, imported[1]!.id, createdSkill.id, legacySkill.id].sort();
            const allWorkspaceCopyIds = [copied.id, resourceCopy.id, createdCopy.id, legacyCopy.id].sort();
            const expectRunSkillIds = (skills: Array<{ id: string }>, workspaceCopyIds: string[]) => {
                expect(skills.map(skill => skill.id).sort()).toEqual([...projectSkillIds, ...workspaceCopyIds].sort());
                expect(skills.some(skill => skill.id === otherProjectSkill.id)).toBe(false);
            };
            const createdEdit = await user('PATCH', `/settings/${createdCopy.id}`, { data: { content: 'Edited created skill' } });
            const legacyEdit = await user('PATCH', `/settings/${legacyCopy.id}`, { data: { content: 'Edited legacy GitHub skill' } });
            expect(createdEdit.statusCode).toBe(200);
            expect(legacyEdit.statusCode).toBe(200);
            expect(createdEdit.json().data.contentSha256).toBe(createHash('sha256').update('Edited created skill').digest('hex'));
            expect(legacyEdit.json().data.contentSha256).toBe(createHash('sha256').update('Edited legacy GitHub skill').digest('hex'));
            expect(createdEdit.json().data.copiedFrom).toEqual(createdCopy.data.copiedFrom);
            expect(legacyEdit.json().data.copiedFrom).toMatchObject({ sourceUrl: legacySkill.data.sourceUrl, contentSha256: createHash('sha256').update(files.legacy!).digest('hex') });

            const forgedProfile = await user('POST', '/settings', { kind: 'profile', projectId: projectIdForCase, name: 'Forbidden project profile', data: { model: 'gpt-6-luna', skillIds: [imported[0]!.id] } });
            expect(forgedProfile.statusCode).toBe(400);
            const profile = (await user('POST', '/settings', { kind: 'profile', name: 'Marketplace reusable', data: { model: 'gpt-6-luna', reasoning: 'medium', skillIds: [copied.id, resourceCopy.id, createdCopy.id, legacyCopy.id] } })).json();
            recordIds.add(profile.id);
            const adminUserId = String((await sql`SELECT id FROM wb_users WHERE email=${adminEmail}`)[0]!.id);
            // This isolated fixture must enroll/discover/bind its own project before requesting Work execution.
            // An unrelated suite default cannot authorize this newly created project.
            const connector = checkedJson(await user('POST', '/connectors', { id: connectorIdForCase, projectIds: [projectIdForCase] }));
            const connectorTokenForCase = connector.token as string;
            const discovery = await app.inject({ method: 'POST', url: '/api/workbench/connector/claim', headers: { authorization: `Bearer ${connectorTokenForCase}` }, payload: { capabilities: { ...fixtureCapabilities, runKinds: [] } } });
            expect(discovery.statusCode).toBe(204);
            const provider = checkedJson(await user('POST', '/settings', { kind: 'provider', name: 'Marketplace fixture connection', data: { provider: 'openai', method: 'codex-host', connectorId: connectorIdForCase, enabled: true, default: false } }));
            recordIds.add(provider.id);
            const guardedWorkResponse = await user('POST', `/projects/${projectIdForCase}/works`, { title: 'Authorization recheck fixture', connectionId: provider.id });
            const guardedWork = guardedWorkResponse.json(); if (guardedWork.id) recordIds.add(guardedWork.id);
            expect(guardedWorkResponse.statusCode).toBe(200);
            const waitForWorkbenchLock = async () => {
                for (let attempt = 0; attempt < 10000; attempt++) {
                    const waiting = await sql`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%' AND query LIKE '%menoteam-workbench-state%'`;
                    if (waiting.length) return;
                    await new Promise<void>(resolve => setImmediate(resolve));
                }
                throw new Error('Timed out waiting for the request to reach the workbench transaction lock');
            };
            const revokeWhileWaiting = async (request: () => Promise<{ statusCode: number; body: string; json(): any }>) => {
                let lockAcquired!: () => void; let revoke!: () => void;
                const acquired = new Promise<void>(resolve => { lockAcquired = resolve; });
                const release = new Promise<void>(resolve => { revoke = resolve; });
                const holder = sql.begin(async tx => {
                    await tx`SELECT pg_advisory_xact_lock(hashtext('menoteam-workbench-state'))`;
                    lockAcquired(); await release;
                    await tx`DELETE FROM wb_memberships WHERE user_id=${adminUserId} AND project_id=${projectIdForCase}`;
                });
                await acquired;
                const pendingRequest = request();
                try { await waitForWorkbenchLock(); }
                catch (error) { revoke(); await holder; await pendingRequest.catch(() => undefined); throw error; }
                revoke(); await holder;
                return pendingRequest;
            };
            const adminRequest = (method: 'POST' | 'PATCH', path: string, payload: unknown) => app.inject({ method, url: `/api/workbench${path}`, remoteAddress: `127.0.0.${scenarioAddress}`, headers: { cookie: adminCookie }, payload: payload as never });
            const deniedAssignment = await revokeWhileWaiting(() => adminRequest('PATCH', `/works/${guardedWork.id}`, { revision: guardedWork.revision, profileId: profile.id }));
            expect(deniedAssignment.statusCode).toBe(403);
            expect((await user('GET', `/works/${guardedWork.id}`)).json().work.profileId).toBe('');
            await sql`INSERT INTO wb_memberships(user_id,project_id,role) VALUES (${adminUserId},${projectIdForCase},'admin') ON CONFLICT(user_id,project_id) DO UPDATE SET role='admin'`;
            const deniedRun = await revokeWhileWaiting(() => adminRequest('POST', `/projects/${projectIdForCase}/messages`, { text: 'Must not queue after revocation', workId: guardedWork.id, requestId: `revoked-${randomUUID()}` }));
            expect(deniedRun.statusCode).toBe(403);
            const me = (await user('GET', '/me')).json();
            const claim = async () => {
                // Each claim replaces discovery; send the full capability contract, not just models.
                const response = await app.inject({ method: 'POST', url: '/api/workbench/connector/claim', headers: { authorization: `Bearer ${connectorTokenForCase}` }, payload: { capabilities: { ...fixtureCapabilities, runKinds: ['implementation'] } } });
                expect(response.statusCode, response.body).toBe(200);
                expect(response.body).not.toBe('');
                return response.json();
            };
            const submitWork = async (title: string, requestId: string) => {
                const created = await user('POST', `/projects/${projectIdForCase}/works`, { title, connectionId: provider.id });
                const work = created.json(); if (work.id) recordIds.add(work.id);
                expect(created.statusCode).toBe(200);
                const assigned = await user('PATCH', `/works/${work.id}`, { revision: work.revision, profileId: profile.id });
                expect(assigned.statusCode).toBe(200);
                const submitted = (await user('POST', `/projects/${projectIdForCase}/messages`, { text: title, workId: work.id, requestId })).json();
                recordIds.add(submitted.run.id); recordIds.add(submitted.message.id);
                return submitted.run;
            };
            const run1 = await submitWork('Frozen original', `marketplace-${randomUUID()}`);
            expect(run1.requestedBy).toBe(me.id);
            const claimed1 = await claim();
            expect(claimed1.run.id).toBe(run1.id);
            expect(claimed1.run.requestedBy).toBe(me.id);
            expect(claimed1.run.connectorId).toBe(connectorIdForCase);
            expectRunSkillIds(claimed1.execution.skills, allWorkspaceCopyIds);
            expect(run1.execution.skills[0].bundle).toEqual(expectedFrozenBundle);
            expect(claimed1.execution.skills.find((skill:any)=>skill.id===resourceCopy.id).bundle).toEqual(imported[1]!.data.bundle);
            verifyBundle(claimed1.execution.skills.find((skill:any)=>skill.id===resourceCopy.id).bundle);
            expect((await user('PATCH', `/settings/${resourceCopy.id}`, {data:{bundle:{version:1}}})).statusCode).toBe(400);
            expect(claimed1.execution.skills[0]).toMatchObject({ id: copied.id, content: files.one, contentSha256: copied.data.contentSha256, copiedFrom: { resolvedSha: pluginCommit, sourcePath: preview.skills[0].path, contentSha256: imported[0]!.data.contentSha256 } });

            const disabled = await user('PATCH', `/settings/${copied.id}`, { data: { content: 'Edited after run one', enabled: false } });
            expect(disabled.statusCode).toBe(200);
            const run2 = await submitWork('Disabled next run', `marketplace-${randomUUID()}`);
            const remainingWorkspaceCopyIds = [resourceCopy.id, createdCopy.id, legacyCopy.id].sort();
            expectRunSkillIds(run2.execution.skills, remainingWorkspaceCopyIds);
            const claimed2 = await claim();
            expect(claimed2.run.id).toBe(run2.id);
            expectRunSkillIds(claimed2.execution.skills, remainingWorkspaceCopyIds);
            const enabled = await user('PATCH', `/settings/${copied.id}`, { data: { content: 'Edited and re-enabled for a new run', enabled: true } });
            expect(enabled.statusCode).toBe(200);
            expect(enabled.json().data.contentSha256).toBe(createHash('sha256').update('Edited and re-enabled for a new run').digest('hex'));
            const run3 = await submitWork('Updated next run', `marketplace-${randomUUID()}`);
            expect(run3.execution.skills[0].content).toBe('Edited and re-enabled for a new run');
            const claimed3 = await claim();
            expect(claimed3.run.id).toBe(run3.id);
            expectRunSkillIds(claimed3.execution.skills, allWorkspaceCopyIds);
            expect(claimed3.execution.skills[0]).toMatchObject({ id: copied.id, content: 'Edited and re-enabled for a new run', copiedFrom: copied.data.copiedFrom });
            const createdRunSkill = claimed3.execution.skills.find((skill: any) => skill.id === createdCopy.id);
            const legacyRunSkill = claimed3.execution.skills.find((skill: any) => skill.id === legacyCopy.id);
            expect(createdRunSkill).toMatchObject({ content: 'Edited created skill', contentSha256: createHash('sha256').update('Edited created skill').digest('hex'), copiedFrom: createdEdit.json().data.copiedFrom });
            expect(legacyRunSkill).toMatchObject({ content: 'Edited legacy GitHub skill', contentSha256: createHash('sha256').update('Edited legacy GitHub skill').digest('hex'), copiedFrom: legacyEdit.json().data.copiedFrom });
            expect((await user('PATCH', `/settings/${createdCopy.id}`, { data: { content: 'Create copy edited after run' } })).statusCode).toBe(200);
            expect((await user('PATCH', `/settings/${legacyCopy.id}`, { data: { content: 'Legacy copy edited after run' } })).statusCode).toBe(200);
            const run4 = await submitWork('Copied source edits are frozen', `marketplace-${randomUUID()}`);
            const claimed4 = await claim();
            expect(claimed4.run.id).toBe(run4.id);
            expectRunSkillIds(claimed4.execution.skills, allWorkspaceCopyIds);
            expect(claimed4.execution.skills.find((skill: any) => skill.id === createdCopy.id)).toMatchObject({ content: 'Create copy edited after run', contentSha256: createHash('sha256').update('Create copy edited after run').digest('hex') });
            expect(claimed4.execution.skills.find((skill: any) => skill.id === legacyCopy.id)).toMatchObject({ content: 'Legacy copy edited after run', contentSha256: createHash('sha256').update('Legacy copy edited after run').digest('hex') });
            const frozenCopiedRun = (await sql`SELECT data FROM wb_records WHERE id=${run3.id} AND kind='run'`)[0]!.data as Run;
            expect(frozenCopiedRun.execution!.skills.find(skill => skill.id === createdCopy.id)).toMatchObject({ content: 'Edited created skill', contentSha256: createHash('sha256').update('Edited created skill').digest('hex') });
            expect(frozenCopiedRun.execution!.skills.find(skill => skill.id === legacyCopy.id)).toMatchObject({ content: 'Edited legacy GitHub skill', contentSha256: createHash('sha256').update('Edited legacy GitHub skill').digest('hex') });
            const frozenRun = (await sql`SELECT data FROM wb_records WHERE id=${run1.id} AND kind='run'`)[0]!.data as Run;
            expect(frozenRun.execution!.skills[0]!.content).toBe(files.one);
            expect(frozenRun.execution!.skills[0]!.bundle).toEqual(expectedFrozenBundle);
            expect(frozenRun.execution!.skills[0]!.contentSha256).toBe(createHash('sha256').update(files.one!).digest('hex'));
            expect(frozenRun.requestedBy).toBe(me.id);

            const malformedRef = await user('POST', '/skills/catalog/import', { ...scope, pluginName: 'helper', selectedPaths: ['../escape/SKILL.md'], previewCommit: preview.plugin.commit, previewCatalogCommit: preview.catalog.commit });
            expect(malformedRef.statusCode).toBe(400);
            missingNested = true;
            const reducedPreview = (await user('POST','/skills/catalog/preview',{...scope,pluginName:'helper',selectedPaths:[preview.skills[1].path]})).json();
            expect(reducedPreview.skills[1].bundleFiles.some((file:any)=>file.path==='references/nested.md')).toBe(false);
            missingNested = false;
            const expectRejectedSkillPreview = async (enable: () => void, disable: () => void, selectedPath: string, message: RegExp) => {
                const before = (await user('GET', '/snapshot')).json().settings.filter((item: any) => item.kind === 'skill' && item.projectId === projectIdForCase).map((item: any) => item.id).sort();
                enable();
                const rejected = await user('POST', '/skills/catalog/preview', { ...scope, pluginName: 'helper', selectedPaths: [selectedPath] });
                expect(rejected.statusCode).toBe(400);
                expect(rejected.json().message).toMatch(message);
                expect(rejected.json().installed).toBeUndefined();
                const after = (await user('GET', '/snapshot')).json().settings.filter((item: any) => item.kind === 'skill' && item.projectId === projectIdForCase).map((item: any) => item.id).sort();
                expect(after).toEqual(before);
                disable();
            };
            await expectRejectedSkillPreview(() => { invalidDescription = true; }, () => { invalidDescription = false; }, 'plugins/helper/skills/unsupported-dependency/SKILL.md', /frontmatter/u);
            invalidDescription = false; invalidManifest = true; expect((await user('POST', '/skills/catalog/preview', { ...scope, pluginName: 'helper' })).statusCode).toBe(400);
            invalidManifest = false; invalidRef = true; expect((await user('POST', '/skills/catalog/preview', { ...scope, pluginName: 'helper' })).statusCode).toBe(502);
            invalidRef = false;
            await expectRejectedSkillPreview(() => { oversizedSkill = true; }, () => { oversizedSkill = false; }, 'plugins/helper/skills/first-skill/SKILL.md', /too large/u);
            await expectRejectedSkillPreview(() => { invalidUtf8 = true; }, () => { invalidUtf8 = false; }, 'plugins/helper/skills/first-skill/SKILL.md', /UTF-8/u);
            invalidUtf8 = false; overflowCatalog = true;
            expect((await user('POST', '/skills/catalog', scope)).statusCode).toBe(400);
            expect(streamedBodyCancelled).toBe(true);
        } finally {
            vi.restoreAllMocks(); sourceFetch = originalFetch;
            await app.close();
            try {
                await sql`DELETE FROM wb_records WHERE project_id=${projectIdForCase} OR id = ANY(${[...recordIds]})`;
                await sql`DELETE FROM wb_requests WHERE scope=${`message:${projectIdForCase}`}`;
                await sql`DELETE FROM wb_connectors WHERE id=${connectorIdForCase}`;
                await sql`DELETE FROM wb_memberships WHERE project_id=${projectIdForCase}`;
                await sql`DELETE FROM wb_invites WHERE email=${adminEmail}`;
                await sql`DELETE FROM wb_sessions WHERE user_id IN (SELECT id FROM wb_users WHERE email=${adminEmail})`;
                await sql`DELETE FROM wb_users WHERE email=${adminEmail}`;
            } finally { app = await createWorkbenchApp({ sql, sourceFetcher: (...args) => sourceFetch(...args) }); }
        }
    });
    it('keeps revoked actor context private while original Connector/generation can read minimal stop control',async()=>{
        const p=checkedJson(await user('POST','/projects',{name:'Revoked recovery control'}));
        const enrolled=await enrollProvider(`recovery-control-${randomUUID()}`,[p.id]);
        const invite=checkedJson(await user('POST','/invites',{email:`recovery-${randomUUID()}@test.example`,projectId:p.id,role:'member'}));
        const member=checkedJson(await app.inject({method:'POST',url:'/api/workbench/invites/accept',payload:{token:invite.token,name:'Recovery member',password:'recovery-test-password'}}));
        const login=await app.inject({method:'POST',url:'/api/workbench/session',payload:{email:member.email,password:'recovery-test-password'}});
        expect(login.statusCode).toBe(200);
        const memberCookie=String(login.headers['set-cookie']).split(';')[0]!;
        const me=await app.inject({method:'GET',url:'/api/workbench/me',headers:{cookie:memberCookie}});
        expect(me.statusCode).toBe(200);
        const actor=checkedJson(me);expect(actor.role).toBe('member');expect(actor.email).toBe(member.email);
        expect(actor.id).toEqual(expect.any(String));expect(actor.id.length).toBeGreaterThan(0);
        const request=await app.inject({method:'POST',url:`/api/workbench/projects/${p.id}/messages`,headers:{cookie:memberCookie},payload:{text:'Private recovery prompt',requestId:randomUUID()}});
        expect(request.statusCode).toBe(200);
        const headers={authorization:`Bearer ${enrolled.token}`};
        const claim=checkedJson(await app.inject({method:'POST',url:'/api/workbench/connector/claim',headers,payload:{capabilities:fixtureCapabilities}})).run as Run;
        expect(claim.id).toBe(request.json().run.id);expect(claim.requestedBy).toBe(actor.id);
        const send=(suffix:string,generation=claim.generation)=>app.inject({method:'POST',url:`/api/workbench/connector/runs/${claim.id}/${suffix}`,headers,payload:{generation}});
        const policy=qaPolicyFixture(p.id); // Contract-only snapshot; not execution evidence.
        await sql`UPDATE wb_records SET data=jsonb_set(data,'{qaPolicySnapshot}',${sql.json(policy as never)}) WHERE id=${claim.id}`;
        checkedJson(await user('DELETE',`/projects/${p.id}/members/${actor.id}`));
        expect((await app.inject({method:'GET',url:`/api/workbench/connector/runs/${claim.id}`,headers})).statusCode).toBe(403);
        expect((await send('renew')).statusCode).toBe(403);
        expect((await send('bridge-token')).statusCode).toBe(403);
        expect((await send('complete')).statusCode).toBe(403);
        expect((await app.inject({method:'POST',url:`/api/workbench/connector/runs/${claim.id}/tools`,headers,payload:{generation:claim.generation,action:'read_context',input:{},requestId:randomUUID()}})).statusCode).toBe(403);
        const control=await send('recovery-state');expect(control.statusCode).toBe(200);
        expect(control.json()).toEqual({id:claim.id,generation:claim.generation,status:'running',preEffectStaging:false,stagingRetired:false,merged:false,qaResourcePolicy:{resource:policy.resource}});
        expect((await send('recovery-state',claim.generation+1)).statusCode).toBe(409);
        const otherProject=checkedJson(await user('POST','/projects',{name:'Other control project'}));
        const other=await enrollProvider(`other-control-${randomUUID()}`,[p.id,otherProject.id]);
        expect((await app.inject({method:'POST',url:`/api/workbench/connector/runs/${claim.id}/recovery-state`,headers:{authorization:`Bearer ${other.token}`},payload:{generation:claim.generation}})).statusCode).toBe(403);
        const restricted=await enrollProvider(`restricted-control-${randomUUID()}`,[otherProject.id]);
        expect((await app.inject({method:'POST',url:`/api/workbench/connector/runs/${claim.id}/recovery-state`,headers:{authorization:`Bearer ${restricted.token}`},payload:{generation:claim.generation}})).statusCode).toBe(403);
        expect((await send('stopped',claim.generation+1)).statusCode).toBe(403);
        const stopped=checkedJson(await send('stopped'));expect(stopped.stoppedAt).toBeTruthy();
        expect(checkedJson(await send('recovery-state'))).toEqual({...control.json(),status:'interrupted',stoppedAt:stopped.stoppedAt});
        await sql`UPDATE wb_connectors SET project_ids=${[otherProject.id]} WHERE id=${enrolled.id}`;
        expect((await send('recovery-state')).statusCode).toBe(403);
    });
    it('requires connector stop proof before browser reconciliation',async()=>{
        const p=(await user('POST','/projects',{name:'Recovery proof'})).json();
        const credential=(await enrollProvider('recovery-connector',[p.id])).token;
        await user('POST',`/projects/${p.id}/messages`,{text:'Recover safely',requestId:'recovery-run'});
        const send=(path:string,payload:unknown)=>app.inject({method:'POST',url:'/api/workbench/connector'+path,headers:{authorization:`Bearer ${credential}`},payload:connectorFixturePayload(path,payload) as never});
        const r=(await send('/claim',{})).json().run;
        await sql`UPDATE wb_records SET data=jsonb_set(data,'{status}','"interrupted"') WHERE id=${r.id}`;
        expect((await user('POST',`/runs/${r.id}/reconcile`,{stopped:true})).statusCode).toBe(409);
        expect((await send(`/runs/${r.id}/stopped`,{generation:r.generation})).statusCode).toBe(200);
        expect((await user('POST',`/runs/${r.id}/reconcile`,{stopped:true})).json().status).toBe('queued');
        const resumed=(await send('/claim',{})).json().run;
        const stopped=(await send(`/runs/${r.id}/stopped`,{generation:resumed.generation})).json();
        expect(stopped.status).toBe('interrupted');expect(stopped.stoppedAt).toBeTruthy();
    });
    it('Master and UI share scoped optimistic settings updates with original actor authority',async()=>{
        const fixture={projectId:'',memberEmail:'settings-member@test.example',memberDigest:'',settingIds:[] as string[]};
        const deniedProjectName=`Denied project ${randomUUID()}`;
        const deniedWorkspaceName=`Denied workspace ${randomUUID()}`;
        const preservedMemberships=(await sql`SELECT user_id,role FROM wb_memberships WHERE project_id=${projectId} ORDER BY user_id`).map(row=>[String(row.user_id),String(row.role)]);
        try{
        const p=(await user('POST','/projects',{name:'Settings operations'})).json();
        fixture.projectId=p.id;
        const credential=(await enrollProvider('settings-connector',[p.id])).token;
        const skill=(await user('POST','/settings',{projectId:p.id,kind:'skill',name:'Original',data:{content:'Original instructions'}})).json();
        fixture.settingIds.push(skill.id);
        const outside=(await user('POST','/settings',{projectId,kind:'skill',name:'Outside project',data:{content:'Protected'}})).json();
        fixture.settingIds.push(outside.id);
        const profile=(await user('POST','/settings',{kind:'profile',name:'Workspace profile',data:{model:'gpt-6-luna',reasoning:'medium',skillIds:[]}})).json();
        fixture.settingIds.push(profile.id);
        await user('POST',`/projects/${p.id}/messages`,{text:'Update the project skill',requestId:'settings-owner-master'});
        const send=(path:string,payload:unknown)=>app.inject({method:'POST',url:'/api/workbench/connector'+path,headers:{authorization:`Bearer ${credential}`},payload:connectorFixturePayload(path,payload) as never});
        const run=(await send('/claim',{})).json().run;
        const tool=(r:any,input:unknown,requestId:string)=>send(`/runs/${r.id}/tools`,{generation:r.generation,action:'update_settings',input,requestId});
        const masterInstructions=await tool(run,{instructions:'Master version',expectedInstructions:p.instructions},'master-instructions-first');
        expect(masterInstructions.statusCode).toBe(200);
        expect((await user('PATCH',`/projects/${p.id}`,{instructions:'UI version',expectedInstructions:'Master version'})).statusCode).toBe(200);
        expect((await tool(run,{instructions:'Stale Master version',expectedInstructions:p.instructions},'master-instructions-stale')).statusCode).toBe(409);
        expect((await user('GET','/snapshot')).json().projects.find((project:any)=>project.id===p.id).instructions).toBe('UI version');
        const context=(await send(`/runs/${run.id}/tools`,{generation:run.generation,action:'read_context',input:{},requestId:'settings-read'})).json();
        expect(context.settings.some((s:any)=>s.id===skill.id)).toBe(true);
        const updated=(await tool(run,{settingId:skill.id,expectedUpdatedAt:skill.updatedAt,data:{content:'Updated by Master'}},'settings-update')).json();
        expect(updated.data.content).toBe('Updated by Master');
        expect((await tool(run,{settingId:skill.id,expectedUpdatedAt:skill.updatedAt,name:'Stale rename'},'settings-stale')).statusCode).toBe(409);
        expect((await tool(run,{settingId:outside.id,expectedUpdatedAt:outside.updatedAt,name:'Cross scope'},'settings-cross')).statusCode).toBe(403);
        expect((await user('PATCH',`/settings/${skill.id}`,{expectedUpdatedAt:updated.updatedAt,name:'UI follows Master'})).statusCode).toBe(200);
        await send(`/runs/${run.id}/complete`,{generation:run.generation,threadId:'settings-thread'});
        const invite=(await user('POST','/invites',{email:'settings-member@test.example',projectId:p.id,role:'member'})).json();
        const accepted=await app.inject({method:'POST',url:'/api/workbench/invites/accept',payload:{token:invite.token,name:'Member',password:'member-test-password'}});
        expect(accepted.json().email).toBe('settings-member@test.example');
        const login=await app.inject({method:'POST',url:'/api/workbench/session',payload:{email:accepted.json().email,password:'member-test-password'}});
        const memberCookie=String(login.headers['set-cookie']).split(';')[0]!;
        fixture.memberDigest=digest(memberCookie.slice('menoteam_session='.length));
        const memberMessage=await app.inject({method:'POST',url:`/api/workbench/projects/${p.id}/messages`,headers:{cookie:memberCookie},payload:{text:'Change settings',requestId:'settings-member-master'}});
        expect(memberMessage.statusCode).toBe(200);
        const memberRun=(await send('/claim',{})).json().run;
        const memberId=(await app.inject({method:'GET',url:'/api/workbench/me',headers:{cookie:memberCookie}})).json().id;
        expect(memberRun).toMatchObject({kind:'master',projectId:p.id,requestedBy:memberId,id:memberMessage.json().run.id});
        const connectorGrant=await sql`SELECT project_ids FROM wb_connectors WHERE id='settings-connector'`;
        expect(connectorGrant[0]?.project_ids).toContain(p.id);
        const memberSkill=(scope:string,requestId:string)=>send(`/runs/${memberRun.id}/tools`,{generation:memberRun.generation,action:'create_skill',input:{scope,name:scope==='project'?deniedProjectName:deniedWorkspaceName,data:{content:'Must not persist'}},requestId});
        expect((await memberSkill('project','member-skill-project')).statusCode).toBe(403);
        expect((await memberSkill('workspace','member-skill-workspace')).statusCode).toBe(403);
        expect((await tool(memberRun,{settingId:profile.id,expectedUpdatedAt:profile.updatedAt,name:'Escalate'},'member-workspace')).statusCode).toBe(403);
        expect((await tool(memberRun,{settingId:skill.id,expectedUpdatedAt:updated.updatedAt,name:'Escalate'},'member-project')).statusCode).toBe(403);
        expect(await sql`SELECT id FROM wb_records WHERE kind='setting' AND data->>'name'=ANY(${[deniedProjectName,deniedWorkspaceName]})`).toHaveLength(0);
        expect(await sql`SELECT request_id FROM wb_requests WHERE scope=${`tools:${memberRun.id}`} AND request_id IN ('member-skill-project','member-skill-workspace','member-workspace','member-project')`).toHaveLength(0);
        const afterDenied=await send(`/runs/${memberRun.id}/tools`,{generation:memberRun.generation,action:'read_context',input:{},requestId:'member-skill-readback-context'});
        expect(afterDenied.json().settings.some((setting:any)=>setting.name===deniedProjectName||setting.name===deniedWorkspaceName)).toBe(false);
        const memberWork=await app.inject({method:'POST',url:`/api/workbench/projects/${p.id}/works`,headers:{cookie:memberCookie},payload:{title:'Member created Work'}});
        expect(memberWork.statusCode).toBe(200);
        const workMessage=await app.inject({method:'POST',url:`/api/workbench/projects/${p.id}/messages`,headers:{cookie:memberCookie},payload:{workId:memberWork.json().id,text:'Member can continue Work',requestId:'settings-member-work-message'}});
        expect(workMessage.statusCode).toBe(200);
        const completedMember=await send(`/runs/${memberRun.id}/complete`,{generation:memberRun.generation,threadId:'settings-member-thread'});
        expect(completedMember.statusCode).toBe(200);
        const workRun=workMessage.json().run as Run;
        const claimedWorkRun=checkedJson(await send('/claim',{})).run as Run;
        expect(claimedWorkRun.id).toBe(workRun.id);
        expect((await send(`/runs/${claimedWorkRun.id}/complete`,{generation:claimedWorkRun.generation,threadId:'settings-member-work-thread'})).statusCode).toBe(200);
        }finally{
            if(fixture.projectId){
                const runs=await sql`SELECT id FROM wb_records WHERE kind='run' AND project_id=${fixture.projectId}`;
                const runIds=runs.map(row=>String(row.id));
                await sql`DELETE FROM wb_bridge_tokens WHERE run_id=ANY(${runIds})`;
                await sql`DELETE FROM wb_requests WHERE scope=${`message:${fixture.projectId}`} OR scope=ANY(${runIds.map(id=>`tools:${id}`)})`;
                await sql`DELETE FROM wb_records WHERE project_id=${fixture.projectId}`;
                await sql`DELETE FROM wb_records WHERE id=${fixture.projectId} AND kind='project'`;
                await sql`DELETE FROM wb_records WHERE id=ANY(${fixture.settingIds}) AND kind='setting'`;
                await sql`DELETE FROM wb_records WHERE kind='setting' AND ((project_id=${fixture.projectId} AND data->>'name'=${deniedProjectName}) OR (project_id IS NULL AND data->>'name'=${deniedWorkspaceName}))`;
                const providerSettingId=fixtureConnections.get('settings-connector');
                if(providerSettingId)await sql`DELETE FROM wb_records WHERE id=${providerSettingId} AND kind='setting'`;
                await sql`DELETE FROM wb_records WHERE kind='setting' AND project_id IS NULL AND data->>'name'='Fixture settings-connector'`;
                await sql`DELETE FROM wb_connectors WHERE id='settings-connector'`;
                await sql`DELETE FROM wb_invites WHERE email=${fixture.memberEmail} AND project_id=${fixture.projectId}`;
                await sql`DELETE FROM wb_sessions WHERE digest=${fixture.memberDigest} OR user_id IN (SELECT id FROM wb_users WHERE email=${fixture.memberEmail})`;
                await sql`DELETE FROM wb_memberships WHERE project_id=${fixture.projectId}`;
                await sql`DELETE FROM wb_users WHERE email=${fixture.memberEmail}`;
                expect(await sql`SELECT user_id FROM wb_memberships WHERE project_id=${fixture.projectId}`).toHaveLength(0);
                expect((await sql`SELECT user_id,role FROM wb_memberships WHERE project_id=${projectId} ORDER BY user_id`).map(row=>[String(row.user_id),String(row.role)])).toEqual(preservedMemberships);
            }
        }
    });
    it('creates Master skills only in an explicitly authorized scope and reads back the same setting ID',async()=>{
        const projectAdminWorkspaceSkillName=`Project admin escalation ${randomUUID()}`;
        const projectAdminUiWorkspaceSkillName=`Project role workspace escalation ${randomUUID()}`;
        const adminWorkspaceSkillName=`Admin workspace skill ${randomUUID()}`;
        const fixture={projectId:'',settingIds:[] as string[],projectAdminEmail:'explicit-project-admin@test.example',workspaceAdminEmail:'explicit-workspace-admin@test.example',projectAdminDigest:'',workspaceAdminDigest:''};
        const preservedMemberships=(await sql`SELECT user_id,role FROM wb_memberships WHERE project_id=${projectId} ORDER BY user_id`).map(row=>[String(row.user_id),String(row.role)]);
        try{
        const p=checkedJson(await user('POST','/projects',{name:'Explicit skill scope'})) as Project;
        fixture.projectId=p.id;
        const credential=(await enrollProvider('explicit-skill-scope-connector',[p.id])).token;
        await user('POST',`/projects/${p.id}/messages`,{text:'Create two scoped skills',requestId:'explicit-skill-scopes'});
        const send=(path:string,payload:unknown)=>app.inject({method:'POST',url:'/api/workbench/connector'+path,headers:{authorization:`Bearer ${credential}`},payload:connectorFixturePayload(path,payload) as never});
        const run=checkedJson(await send('/claim',{})).run as Run;
        const create=(input:unknown,requestId:string)=>send(`/runs/${run.id}/tools`,{generation:run.generation,action:'create_skill',input,requestId});
        expect((await create({name:'Implicit scope',data:{content:'Rejected without scope'}},'skill-no-scope')).statusCode).toBe(400);
        expect((await create({scope:'workspace',projectId:p.id,name:'Mismatched scope',data:{content:'Rejected mismatch'}},'skill-mismatch')).statusCode).toBe(400);
        const projectSkill=checkedJson(await create({scope:'project',name:'Project guidance',data:{content:'Project only'}},'skill-project'));
        const workspaceSkill=checkedJson(await create({scope:'workspace',name:'Shared guidance',data:{content:'Workspace reusable'}},'skill-workspace'));
        fixture.settingIds.push(workspaceSkill.id);
        expect(checkedJson(await create({scope:'project',name:'Project guidance',data:{content:'Project only'}},'skill-project')).id).toBe(projectSkill.id);
        expect(checkedJson(await create({scope:'workspace',name:'Shared guidance',data:{content:'Workspace reusable'}},'skill-workspace')).id).toBe(workspaceSkill.id);
        expect((await create({scope:'workspace',name:'Project guidance',data:{content:'Project only'}},'skill-project')).statusCode).toBe(409);
        expect((await create({scope:'project',name:'Shared guidance',data:{content:'Workspace reusable'}},'skill-workspace')).statusCode).toBe(409);
        expect((await create({scope:'project',name:'Project guidance renamed',data:{content:'Project only'}},'skill-project')).statusCode).toBe(409);
        expect((await create({scope:'project',name:'Project guidance',data:{content:'Changed'}},'skill-project')).statusCode).toBe(409);
        expect(await sql`SELECT id FROM wb_records WHERE kind='setting' AND data->>'name' IN ('Project guidance','Shared guidance')`).toHaveLength(2);
        expect(await sql`SELECT request_id FROM wb_requests WHERE scope=${`tools:${run.id}`} AND request_id IN ('skill-project','skill-workspace')`).toHaveLength(2);
        expect(projectSkill).toMatchObject({kind:'skill',projectId:p.id,name:'Project guidance'});
        expect(workspaceSkill).toMatchObject({kind:'skill',name:'Shared guidance'});
        expect(workspaceSkill).not.toHaveProperty('projectId');
        const context=checkedJson(await send(`/runs/${run.id}/tools`,{generation:run.generation,action:'read_context',input:{},requestId:'explicit-skill-readback'}));
        expect(context.settings.find((setting:any)=>setting.id===projectSkill.id)).toMatchObject({id:projectSkill.id,projectId:p.id});
        expect(context.settings.find((setting:any)=>setting.id===workspaceSkill.id)).toMatchObject({id:workspaceSkill.id,name:'Shared guidance'});
        expect(context.settings.find((setting:any)=>setting.id===workspaceSkill.id)).not.toHaveProperty('projectId');
        const legacyProjectSkill={...projectSkill,id:'legacy-skill-project-replay',name:'Legacy scoped project',data:{content:'Legacy project content',enabled:true}};
        const legacyWorkspaceSkill={...workspaceSkill,id:'legacy-skill-workspace-replay',name:'Legacy scoped workspace',data:{content:'Legacy workspace content',enabled:true}};
        const legacyRequestIds=['legacy-project-request','legacy-workspace-request'];
        const legacyRunScope=`tools:${run.id}`;
        let actorDemoted=false;
        let projectMembershipRole:string|undefined;
        let projectMembershipDemoted=false;
        try {
            await sql`INSERT INTO wb_records(id,kind,project_id,data) VALUES (${legacyProjectSkill.id},'setting',${p.id},${sql.json(legacyProjectSkill as never)})`;
            await sql`INSERT INTO wb_requests(scope,request_id,result) VALUES (${legacyRunScope},${legacyRequestIds[0]},${sql.json(legacyProjectSkill as never)})`;
            await sql`INSERT INTO wb_records(id,kind,project_id,data) VALUES (${legacyWorkspaceSkill.id},'setting',NULL,${sql.json(legacyWorkspaceSkill as never)})`;
            await sql`INSERT INTO wb_requests(scope,request_id,result) VALUES (${legacyRunScope},${legacyRequestIds[1]},${sql.json(legacyWorkspaceSkill as never)})`;
            expect(checkedJson(await create({scope:'project',name:legacyProjectSkill.name,data:{content:'Legacy project content'}},legacyRequestIds[0])).id).toBe(legacyProjectSkill.id);
            expect(checkedJson(await create({scope:'workspace',name:legacyWorkspaceSkill.name,data:{content:'Legacy workspace content'}},legacyRequestIds[1])).id).toBe(legacyWorkspaceSkill.id);
            expect(checkedJson(await create({name:legacyProjectSkill.name,data:{content:'Legacy project content'}},legacyRequestIds[0])).id).toBe(legacyProjectSkill.id);
            expect((await create({name:legacyWorkspaceSkill.name,data:{content:'Legacy workspace content'}},legacyRequestIds[1])).statusCode).toBe(409);
            expect((await create({scope:'workspace',name:legacyProjectSkill.name,data:{content:'Legacy project content'}},legacyRequestIds[0])).statusCode).toBe(409);
            expect((await create({scope:'project',name:legacyWorkspaceSkill.name,data:{content:'Legacy workspace content'}},legacyRequestIds[1])).statusCode).toBe(409);
            expect((await create({scope:'project',name:'Changed legacy name',data:{content:'Legacy project content'}},legacyRequestIds[0])).statusCode).toBe(409);
            expect((await create({scope:'workspace',name:legacyWorkspaceSkill.name,data:{content:'Changed legacy content'}},legacyRequestIds[1])).statusCode).toBe(409);
            const projectMembership=await sql`SELECT role FROM wb_memberships WHERE project_id=${p.id} AND user_id=${run.requestedBy}`;
            expect(projectMembership).toHaveLength(1);
            projectMembershipRole=String(projectMembership[0]!.role);
            expect(['owner','admin']).toContain(projectMembershipRole);
            projectMembershipDemoted=true;
            await sql`UPDATE wb_memberships SET role='member' WHERE project_id=${p.id} AND user_id=${run.requestedBy}`;
            actorDemoted=true;
            await sql`UPDATE wb_users SET role='member' WHERE id=${run.requestedBy}`;
            expect((await create({scope:'project',name:legacyProjectSkill.name,data:{content:'Legacy project content'}},legacyRequestIds[0])).statusCode).toBe(403);
            expect((await create({scope:'workspace',name:legacyWorkspaceSkill.name,data:{content:'Legacy workspace content'}},legacyRequestIds[1])).statusCode).toBe(403);
            expect(await sql`SELECT id FROM wb_records WHERE id=ANY(${[legacyProjectSkill.id,legacyWorkspaceSkill.id]}) AND kind='setting'`).toHaveLength(2);
            const unchangedLegacyRequests=await sql`SELECT request_id,result FROM wb_requests WHERE scope=${legacyRunScope} AND request_id=ANY(${legacyRequestIds})`;
            expect(unchangedLegacyRequests).toHaveLength(2);
            expect(unchangedLegacyRequests.every(row=>!(row.result as Record<string,unknown>).__toolRequest)).toBe(true);
            expect((await create({name:'Fresh implicit scope',data:{content:'Must not create'}},'fresh-implicit-scope')).statusCode).toBe(400);
            expect(await sql`SELECT id FROM wb_records WHERE id=ANY(${[legacyProjectSkill.id,legacyWorkspaceSkill.id]}) AND kind='setting'`).toHaveLength(2);
            expect(await sql`SELECT request_id FROM wb_requests WHERE scope=${legacyRunScope} AND request_id=ANY(${legacyRequestIds})`).toHaveLength(2);
            expect(await sql`SELECT request_id FROM wb_requests WHERE scope=${legacyRunScope} AND request_id='fresh-implicit-scope'`).toHaveLength(0);
            expect(await sql`SELECT id FROM wb_records WHERE kind='setting' AND data->>'name'='Fresh implicit scope'`).toHaveLength(0);
        } finally {
            if(projectMembershipDemoted&&projectMembershipRole)await sql`UPDATE wb_memberships SET role=${projectMembershipRole} WHERE project_id=${p.id} AND user_id=${run.requestedBy}`;
            if(actorDemoted)await sql`UPDATE wb_users SET role='owner' WHERE id=${run.requestedBy}`;
            await sql`DELETE FROM wb_requests WHERE scope=${legacyRunScope} AND request_id=ANY(${legacyRequestIds})`;
            await sql`DELETE FROM wb_records WHERE kind='setting' AND ((id=${legacyProjectSkill.id} AND project_id=${p.id}) OR (id=${legacyWorkspaceSkill.id} AND project_id IS NULL))`;
        }
        await send(`/runs/${run.id}/complete`,{generation:run.generation,threadId:'explicit-skill-scope-thread'});
        const projectAdminInvite=checkedJson(await user('POST','/invites',{email:'explicit-project-admin@test.example',projectId:p.id,role:'admin'}));
        checkedJson(await app.inject({method:'POST',url:'/api/workbench/invites/accept',payload:{token:projectAdminInvite.token,name:'Project Admin',password:'explicit-project-admin-password'}}));
        const projectAdminLogin=await app.inject({method:'POST',url:'/api/workbench/session',payload:{email:'explicit-project-admin@test.example',password:'explicit-project-admin-password'}});
        const projectAdminCookie=String(projectAdminLogin.headers['set-cookie']).split(';')[0]!;
        fixture.projectAdminDigest=digest(projectAdminCookie.slice('menoteam_session='.length));
        await app.inject({method:'POST',url:`/api/workbench/projects/${p.id}/messages`,headers:{cookie:projectAdminCookie},payload:{text:'Create project scoped skill',requestId:'project-admin-skill'}});
        const projectAdminRun=checkedJson(await send('/claim',{})).run as Run;
        const projectAdminTool=(input:unknown,requestId:string)=>send(`/runs/${projectAdminRun.id}/tools`,{generation:projectAdminRun.generation,action:'create_skill',input,requestId});
        expect((await projectAdminTool({scope:'workspace',name:projectAdminWorkspaceSkillName,data:{content:'Forbidden'}},'project-admin-workspace')).statusCode).toBe(403);
        expect(checkedJson(await projectAdminTool({scope:'project',name:'Project admin skill',data:{content:'Allowed'}},'project-admin-project'))).toMatchObject({projectId:p.id,name:'Project admin skill'});
        expect((await app.inject({method:'POST',url:'/api/workbench/settings',headers:{cookie:projectAdminCookie},payload:{kind:'skill',name:projectAdminUiWorkspaceSkillName,data:{content:'Forbidden'}}})).statusCode).toBe(403);
        expect(await sql`SELECT id FROM wb_records WHERE kind='setting' AND project_id IS NULL AND data->>'name'=ANY(${[projectAdminWorkspaceSkillName,projectAdminUiWorkspaceSkillName]})`).toHaveLength(0);
        expect(await sql`SELECT request_id FROM wb_requests WHERE scope=${`tools:${projectAdminRun.id}`} AND request_id='project-admin-workspace'`).toHaveLength(0);
        await send(`/runs/${projectAdminRun.id}/complete`,{generation:projectAdminRun.generation,threadId:'project-admin-skill-thread'});
        const workspaceAdminInvite=checkedJson(await user('POST','/invites',{email:'explicit-workspace-admin@test.example',role:'admin'}));
        checkedJson(await app.inject({method:'POST',url:'/api/workbench/invites/accept',payload:{token:workspaceAdminInvite.token,name:'Workspace Admin',password:'explicit-scope-admin-password'}}));
        const adminLogin=await app.inject({method:'POST',url:'/api/workbench/session',payload:{email:'explicit-workspace-admin@test.example',password:'explicit-scope-admin-password'}});
        const adminCookie=String(adminLogin.headers['set-cookie']).split(';')[0]!;
        fixture.workspaceAdminDigest=digest(adminCookie.slice('menoteam_session='.length));
        expect(adminLogin.statusCode).toBe(200);
        const adminSkill=await app.inject({method:'POST',url:'/api/workbench/settings',headers:{cookie:adminCookie},payload:{kind:'skill',name:adminWorkspaceSkillName,data:{content:'Authorized'}}});
        if(adminSkill.statusCode===200)fixture.settingIds.push(String(adminSkill.json().id));
        expect(adminSkill.statusCode).toBe(200);
        expect(adminSkill.json()).toMatchObject({kind:'skill',name:adminWorkspaceSkillName});
        expect(adminSkill.json()).not.toHaveProperty('projectId');
        const adminSnapshot=await app.inject({method:'GET',url:'/api/workbench/snapshot',headers:{cookie:adminCookie}});
        expect(adminSnapshot.json().settings.find((setting:any)=>setting.id===adminSkill.json().id)).toMatchObject({id:adminSkill.json().id,kind:'skill',name:adminWorkspaceSkillName});
        expect(adminSnapshot.json().settings.find((setting:any)=>setting.id===adminSkill.json().id)).not.toHaveProperty('projectId');
        }finally{
            if(fixture.projectId){
                const runs=await sql`SELECT id FROM wb_records WHERE kind='run' AND project_id=${fixture.projectId}`;
                const runIds=runs.map(row=>String(row.id));
                await sql`DELETE FROM wb_bridge_tokens WHERE run_id=ANY(${runIds})`;
                await sql`DELETE FROM wb_requests WHERE scope=${`message:${fixture.projectId}`} OR scope=ANY(${runIds.map(id=>`tools:${id}`)})`;
                await sql`DELETE FROM wb_records WHERE project_id=${fixture.projectId}`;
                await sql`DELETE FROM wb_records WHERE id=${fixture.projectId} AND kind='project'`;
                await sql`DELETE FROM wb_records WHERE id=ANY(${fixture.settingIds}) AND kind='setting'`;
                await sql`DELETE FROM wb_records WHERE kind='setting' AND project_id IS NULL AND data->>'name'=ANY(${[projectAdminWorkspaceSkillName,projectAdminUiWorkspaceSkillName,adminWorkspaceSkillName]})`;
                const providerSettingId=fixtureConnections.get('explicit-skill-scope-connector');
                if(providerSettingId)await sql`DELETE FROM wb_records WHERE id=${providerSettingId} AND kind='setting'`;
                await sql`DELETE FROM wb_records WHERE kind='setting' AND project_id IS NULL AND data->>'name'='Fixture explicit-skill-scope-connector'`;
                await sql`DELETE FROM wb_connectors WHERE id='explicit-skill-scope-connector'`;
                await sql`DELETE FROM wb_invites WHERE email=${fixture.projectAdminEmail} AND project_id=${fixture.projectId}`;
                await sql`DELETE FROM wb_invites WHERE email=${fixture.workspaceAdminEmail} AND project_id IS NULL`;
                await sql`DELETE FROM wb_sessions WHERE digest IN (${fixture.projectAdminDigest||null},${fixture.workspaceAdminDigest||null}) OR user_id IN (SELECT id FROM wb_users WHERE email=ANY(${[fixture.projectAdminEmail,fixture.workspaceAdminEmail]}))`;
                await sql`DELETE FROM wb_memberships WHERE project_id=${fixture.projectId}`;
                await sql`DELETE FROM wb_users WHERE email=ANY(${[fixture.projectAdminEmail,fixture.workspaceAdminEmail]})`;
                expect(await sql`SELECT user_id FROM wb_memberships WHERE project_id=${fixture.projectId}`).toHaveLength(0);
                expect((await sql`SELECT user_id,role FROM wb_memberships WHERE project_id=${projectId} ORDER BY user_id`).map(row=>[String(row.user_id),String(row.role)])).toEqual(preservedMemberships);
            }
        }
    });
    it('revalidates the live session and current role after waiting for the settings transaction lock',async()=>{
        const logoutSettingName=`Revoked session barrier ${randomUUID()}`;
        const roleSettingName=`Demoted role barrier ${randomUUID()}`;
        const ownerLogin=async(remote:string)=>app.inject({method:'POST',url:'/api/workbench/session',remoteAddress:remote,payload:{email:'owner@test.example',password:'workbench-test-password'}});
        const waitForSettingsLock=async(before:Set<number>,blockerPid:number)=>{
            for(let attempt=0;attempt<200;attempt++){
                const waiting=await sql`SELECT pid,query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%'`;
                const newWaiters=waiting.filter(row=>Number(row.pid)!==blockerPid&&!before.has(Number(row.pid))&&String(row.query).includes('pg_advisory_xact_lock'));
                if(newWaiters.length===1)return Number(newWaiters[0]!.pid);
                await new Promise<void>(resolve=>setImmediate(resolve));
            }
            throw new Error('The single new settings request did not reach its advisory-lock barrier');
        };
        let ownerSessionDigest='';
        let ownerId='';
        let blocker:Awaited<ReturnType<typeof sql.reserve>>|undefined;
        let pending:Promise<Awaited<ReturnType<typeof app.inject>>>|undefined;
        try{
            const ownerLoginResponse=await ownerLogin('127.0.0.61');
            expect(checkedJson(ownerLoginResponse).authenticated).toBe(true);
            const ownerCookie=String(ownerLoginResponse.headers['set-cookie']).split(';')[0]!;
            ownerSessionDigest=digest(ownerCookie.slice('menoteam_session='.length));
            ownerId=(await app.inject({method:'GET',url:'/api/workbench/me',headers:{cookie:ownerCookie}})).json().id as string;
            blocker=await sql.reserve();
            await blocker`BEGIN`;
            await blocker`SELECT pg_advisory_xact_lock(hashtext('menoteam-workbench-state'))`;
            const blockerPid=Number((await blocker`SELECT pg_backend_pid() AS pid`)[0]!.pid);
            const existing=await sql`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%'`;
            const before=new Set(existing.map(row=>Number(row.pid)));
            pending=app.inject({method:'POST',url:'/api/workbench/settings',remoteAddress:'127.0.0.63',headers:{cookie:ownerCookie},payload:{kind:'skill',name:logoutSettingName,data:{content:'Must not persist'}}});
            expect(await waitForSettingsLock(before,blockerPid)).toBeGreaterThan(0);
            expect((await app.inject({method:'POST',url:'/api/workbench/logout',remoteAddress:'127.0.0.64',headers:{cookie:ownerCookie}})).statusCode).toBe(200);
            await blocker`COMMIT`;
            expect((await pending).statusCode).toBe(401);
            expect(await sql`SELECT id FROM wb_records WHERE kind='setting' AND project_id IS NULL AND data->>'name'=${logoutSettingName}`).toHaveLength(0);
        }finally{
            if(blocker){try{await blocker`ROLLBACK`;}catch{}blocker.release();}
            if(pending)try{await pending;}catch{}
            if(ownerSessionDigest)await sql`DELETE FROM wb_sessions WHERE digest=${ownerSessionDigest}`;
            await sql`DELETE FROM wb_records WHERE kind='setting' AND project_id IS NULL AND data->>'name'=${logoutSettingName}`;
        }
        let refreshedSessionDigest='';
        let roleSettingId='';
        let roleBlocker:Awaited<ReturnType<typeof sql.reserve>>|undefined;
        let rolePending:Promise<Awaited<ReturnType<typeof app.inject>>>|undefined;
        let actorDemoted=false;
        try{
            const refreshed=await ownerLogin('127.0.0.65');
            const refreshedCookie=String(refreshed.headers['set-cookie']).split(';')[0]!;
            refreshedSessionDigest=digest(refreshedCookie.slice('menoteam_session='.length));
            const roleSettingResponse=await app.inject({method:'POST',url:'/api/workbench/settings',remoteAddress:'127.0.0.67',headers:{cookie:refreshedCookie},payload:{kind:'skill',name:roleSettingName,data:{content:'Before role revocation'}}});
            const roleSetting=checkedJson(roleSettingResponse);
            roleSettingId=roleSetting.id;
            roleBlocker=await sql.reserve();
            await roleBlocker`BEGIN`;
            await roleBlocker`SELECT pg_advisory_xact_lock(hashtext('menoteam-workbench-state'))`;
            const blockerPid=Number((await roleBlocker`SELECT pg_backend_pid() AS pid`)[0]!.pid);
            const existing=await sql`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%'`;
            const before=new Set(existing.map(row=>Number(row.pid)));
            rolePending=app.inject({method:'PATCH',url:`/api/workbench/settings/${roleSetting.id}`,remoteAddress:'127.0.0.66',headers:{cookie:refreshedCookie},payload:{expectedUpdatedAt:roleSetting.updatedAt,data:{content:'Must not persist'}}});
            const waiterPid=await waitForSettingsLock(before,blockerPid);
            expect(waiterPid).toBeGreaterThan(0);
            await sql`UPDATE wb_users SET role='member' WHERE id=${ownerId}`;
            actorDemoted=true;
            await roleBlocker`COMMIT`;
            expect((await rolePending).statusCode).toBe(403);
            expect((await sql`SELECT data FROM wb_records WHERE id=${roleSetting.id} AND kind='setting'`)[0]?.data).toMatchObject({name:roleSettingName,data:{content:'Before role revocation'}});
        }finally{
            if(roleBlocker){try{await roleBlocker`ROLLBACK`;}catch{}roleBlocker.release();}
            if(rolePending)try{await rolePending;}catch{}
            if(actorDemoted)await sql`UPDATE wb_users SET role='owner' WHERE id=${ownerId}`;
            if(refreshedSessionDigest)await sql`DELETE FROM wb_sessions WHERE digest=${refreshedSessionDigest}`;
            if(roleSettingId)await sql`DELETE FROM wb_records WHERE id=${roleSettingId} AND kind='setting' AND project_id IS NULL`;
            await sql`DELETE FROM wb_records WHERE kind='setting' AND project_id IS NULL AND data->>'name'=${roleSettingName}`;
        }
    });
    it('reflects active Work progress and kind-filtered capacity without treating a turn as done',async()=>{
        const p=(await user('POST','/projects',{name:'Work activity proof'})).json();
        const credential=(await enrollProvider('activity-connector',[p.id])).token;
        const work=(await user('POST',`/projects/${p.id}/works`,{title:'Current progress'})).json();
        await user('POST',`/projects/${p.id}/messages`,{workId:work.id,text:'Implement one step',requestId:'activity-implementation'});
        const send=(path:string,payload:unknown)=>app.inject({method:'POST',url:'/api/workbench/connector'+path,headers:{authorization:`Bearer ${credential}`},payload:connectorFixturePayload(path,payload) as never});
        expect((await send('/claim',{capabilities:{runKinds:['master']}})).statusCode).toBe(204);
        const run=(await send('/claim',{capabilities:{runKinds:['implementation','review']}})).json().run;
        expect((await user('GET',`/works/${work.id}`)).json().work.status).toBe('in_progress');
        await user('POST',`/runs/${run.id}/pause`,{});
        expect((await user('GET',`/works/${work.id}`)).json().work.status).toBe('paused');
        await send(`/runs/${run.id}/stopped`,{generation:run.generation});
        await user('POST',`/runs/${run.id}/resume`,{});
        const resumed=(await send('/claim',{capabilities:{runKinds:['implementation']}})).json().run;
        expect((await user('GET',`/works/${work.id}`)).json().work.status).toBe('in_progress');
        await send(`/runs/${run.id}/complete`,{generation:resumed.generation,threadId:'activity-thread'});
        expect((await user('GET',`/works/${work.id}`)).json().work.status).toBe('in_progress');
        expect((await send('/claim',{capabilities:{runKinds:['implementation']}})).statusCode).toBe(204);
        expect((await send('/claim',{capabilities:{runKinds:['master']}})).json().run.kind).toBe('master');
    });
    it('strictly queues one authorized delivery Run for the exact candidate and fences retry generations',async()=>{
        const p=checkedJson((await user('POST','/projects',{name:'Draft PR idempotency',repositoryUrl:'https://github.com/example/draft-pr'}))) as Project;
        const connector=await enrollProvider('draft-pr-connector',[p.id]);
        const work=checkedJson((await user('POST',`/projects/${p.id}/works`,{title:'Create a bounded draft'}))) as Work;
        const connRequest=(path:string,payload:unknown)=>app.inject({method:'POST',url:'/api/workbench/connector'+path,headers:{authorization:`Bearer ${connector.token}`},payload:connectorFixturePayload(path,payload) as never});
        expect((await connRequest('/claim',{capabilities:{git:true,githubWrite:true,deliveryActions:['create_draft_pr']}})).statusCode).toBe(204);
        const connection=await user('POST','/settings',{projectId:p.id,kind:'connection',name:'Draft PR delivery',data:{provider:'github',url:p.repositoryUrl,purpose:'delivery',baseBranch:'main',allowDraftPr:true}});
        expect(connection.statusCode).toBe(200);
        const sourceConnection=await user('POST','/settings',{projectId:p.id,kind:'connection',name:'GitHub source',data:{provider:'github',url:p.repositoryUrl}});
        expect(sourceConnection.statusCode).toBe(200);
        const invite=checkedJson((await user('POST','/invites',{email:'draft-pr-member@test.example',projectId:p.id,role:'member'})));
        const accepted=await app.inject({method:'POST',url:'/api/workbench/invites/accept',payload:{token:invite.token,name:'Draft PR member',password:'draft-pr-password'}});
        checkedJson(accepted);const login=await app.inject({method:'POST',url:'/api/workbench/session',payload:{email:'draft-pr-member@test.example',password:'draft-pr-password'}});checkedJson(login);const memberCookie=String(login.headers['set-cookie']).split(';')[0]!;
        const memberReq=(method:'GET'|'POST'|'PATCH',path:string,payload?:unknown)=>app.inject({method,url:'/api/workbench'+path,headers:{cookie:memberCookie},payload:connectorFixturePayload(path,payload) as never});
        const member=checkedJson((await memberReq('GET','/me')));const candidateId=crypto.randomUUID();const commitSha='a'.repeat(40);const baseRevision='b'.repeat(40);const revision=createHash('sha256').update(baseRevision).update('\0').update(commitSha).digest('hex');const fingerprint='c'.repeat(64);
        const candidate:Run={id:candidateId,projectId:p.id,workId:work.id,prompt:'Implement bounded change',requestedBy:member.id,kind:'implementation',model:'gpt-6-luna',reasoning:'medium',status:'completed',connectorId:'draft-pr-connector',generation:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
        const diff:Artifact={id:`artifact:${candidateId}:diff`,projectId:p.id,workId:work.id,runId:candidateId,kind:'diff',revision,data:{source:'git',candidateRevision:commitSha,baseRevision,files:[{path:'src/example.ts'}]},createdAt:new Date().toISOString()};
        const qa:Artifact={id:`artifact:${candidateId}:qa`,projectId:p.id,workId:work.id,runId:candidateId,kind:'qa',revision,data:{candidateFingerprint:fingerprint,checks:[{name:'focused',exitCode:1}],stale:false},createdAt:new Date().toISOString()};
        await sql`INSERT INTO wb_records(id,kind,project_id,data) VALUES (${candidate.id},'run',${p.id},${sql.json(candidate as never)}),(${diff.id},'artifact',${p.id},${sql.json(diff as never)}),(${qa.id},'artifact',${p.id},${sql.json(qa as never)})`;
        await user('POST',`/projects/${p.id}/messages`,{text:'Request an exact-candidate draft PR',requestId:'draft-pr-master-message'});
        const masterClaim=await connRequest('/claim',{capabilities:{runKinds:['master'],git:true,githubWrite:true,deliveryActions:['create_draft_pr']}});expect(masterClaim.statusCode).toBe(200);const master=checkedJson(masterClaim).run as Run;
        const bridge=checkedJson((await connRequest(`/runs/${master.id}/bridge-token`,{generation:master.generation}))).token;
        const masterSettings=await app.inject({method:'POST',url:`/api/workbench/connector/runs/${master.id}/tools`,headers:{authorization:`Bearer ${bridge}`},payload:{generation:master.generation,action:'update_settings',input:{settingId:checkedJson(sourceConnection).id,expectedUpdatedAt:checkedJson(sourceConnection).updatedAt,data:{purpose:'delivery',allowDraftPr:true,baseBranch:'release'}},requestId:'master-cannot-expand-delivery-policy'} as never});expect(masterSettings.statusCode).toBe(403);
        const masterTool=await app.inject({method:'POST',url:`/api/workbench/connector/runs/${master.id}/tools`,headers:{authorization:`Bearer ${bridge}`},payload:{generation:master.generation,action:'request_delivery',input:{workId:work.id,candidateRunId:candidateId,candidateRevision:revision,action:'create_draft_pr',requestId:'delivery-from-master'},requestId:'master-tool-delivery'} as never});
        expect(masterTool.statusCode).toBe(200);
        expect((await app.inject({method:'POST',url:`/api/workbench/connector/runs/${master.id}/tools`,headers:{authorization:`Bearer ${bridge}`},payload:{generation:master.generation,action:'request_delivery',input:{workId:work.id,candidateRunId:candidateId,candidateRevision:revision,action:'create_draft_pr',requestId:'delivery-from-master',targetId:'forbidden'},requestId:'master-tool-extra'} as never})).statusCode).toBe(400);
        const other=checkedJson((await user('POST','/projects',{name:'Other candidate scope'}))) as Project;await enrollProvider('other-candidate-connector',[other.id]);const otherWork=checkedJson((await user('POST',`/projects/${other.id}/works`,{title:'Other project candidate'}))) as Work;
        const crossMaster=await app.inject({method:'POST',url:`/api/workbench/connector/runs/${master.id}/tools`,headers:{authorization:`Bearer ${bridge}`},payload:{generation:master.generation,action:'request_delivery',input:{workId:otherWork.id,candidateRunId:candidateId,candidateRevision:revision,action:'create_draft_pr',requestId:'master-cross-project'},requestId:'master-cross-project'} as never});expect(crossMaster.statusCode).toBe(403);
        await connRequest(`/runs/${master.id}/complete`,{generation:master.generation,threadId:'draft-pr-master-thread'});
        const request=(requestId:string,input:Record<string,unknown>={candidateRunId:candidateId,candidateRevision:revision,action:'create_draft_pr',requestId})=>memberReq('POST',`/works/${work.id}/delivery`,input);
        expect((await request('strict-extra',{candidateRunId:candidateId,candidateRevision:revision,action:'create_draft_pr',requestId:'strict-extra',targetConnectorId:'forged'})).statusCode).toBe(400);
        expect((await request('forged-revision',{candidateRunId:candidateId,candidateRevision:'f'.repeat(64),action:'create_draft_pr',requestId:'forged-revision'})).statusCode).toBe(409);
        const [first,concurrent]=await Promise.all([request('delivery-first'),request('delivery-concurrent')]);
        expect(first.statusCode).toBe(200);expect(concurrent.statusCode).toBe(200);expect(checkedJson(concurrent).run.id).toBe(checkedJson(first).run.id);
        expect(checkedJson(first).run.id).toBe(checkedJson(masterTool).run.id);
        expect(checkedJson((await request('delivery-first'))).run.id).toBe(checkedJson(first).run.id);
        const count=await sql`SELECT count(*)::int AS count FROM wb_records WHERE kind='run' AND data->>'kind'='delivery' AND data->>'workId'=${work.id}`;
        expect(count[0]!.count).toBe(1);
        const queued=checkedJson(first).run as Run;
        const owner=checkedJson(await user('GET','/me'));
        expect(queued.requestedBy).toBe(owner.id);expect(queued.operation?.actorId).toBe(owner.id);
        const persistedDelivery = async (runId:string) => (await sql`SELECT data FROM wb_records WHERE id=${runId} AND kind='run'`)[0]!.data as Run;
        expect(await persistedDelivery(queued.id)).toMatchObject({requestedBy:owner.id,operation:{actorId:owner.id}});
        const secondId=crypto.randomUUID();const secondSha='d'.repeat(40);const secondBase='e'.repeat(40);const secondRevision=createHash('sha256').update(secondBase).update('\0').update(secondSha).digest('hex');const second:Run={...candidate,id:secondId};const secondDiff:Artifact={...diff,id:`artifact:${secondId}:diff`,runId:secondId,revision:secondRevision,data:{source:'git',candidateRevision:secondSha,baseRevision:secondBase,files:[{path:'src/second.ts'}]}};const secondQa:Artifact={...qa,id:`artifact:${secondId}:qa`,runId:secondId,revision:secondRevision,data:{candidateFingerprint:'d'.repeat(64),checks:[],stale:false}};await sql`INSERT INTO wb_records(id,kind,project_id,data) VALUES (${second.id},'run',${p.id},${sql.json(second as never)}),(${secondDiff.id},'artifact',${p.id},${sql.json(secondDiff as never)}),(${secondQa.id},'artifact',${p.id},${sql.json(secondQa as never)})`;
        const queuedSecond=await request('delivery-second',{candidateRunId:secondId,candidateRevision:secondRevision,action:'create_draft_pr',requestId:'delivery-second'});expect(queuedSecond.statusCode).toBe(200);expect(checkedJson(queuedSecond).run.id).not.toBe(queued.id);
        const secondQueued=checkedJson(queuedSecond).run as Run;
        expect(await persistedDelivery(secondQueued.id)).toMatchObject({requestedBy:member.id,operation:{actorId:member.id}});
        const ownerDedup=checkedJson(await user('POST',`/works/${work.id}/delivery`,{candidateRunId:secondId,candidateRevision:secondRevision,action:'create_draft_pr',requestId:'owner-dedups-member-delivery'}));
        expect(ownerDedup.run.id).toBe(secondQueued.id);
        expect(await persistedDelivery(secondQueued.id)).toMatchObject({requestedBy:member.id,operation:{actorId:member.id}});
        const firstClaim=await connRequest('/claim',{capabilities:{runKinds:['delivery'],git:true,githubWrite:true,deliveryActions:['create_draft_pr']}});expect(firstClaim.statusCode).toBe(200);const claimed=checkedJson(firstClaim).run as Run;expect(claimed.id).toBe(queued.id);expect(claimed.generation).toBe(queued.generation+1);
        const serverUrl=await app.listen({port:0,host:'127.0.0.1'});
        const deliveryClient=new WorkbenchConnectorClient({serverUrl,token:connector.token});
        const authorizePath=`/runs/${claimed.id}/delivery-authorize`;
        await expect(deliveryClient.authorizeDeliveryEffect(claimed.id,claimed.generation)).resolves.toMatchObject({authorized:true,repositoryUrl:p.repositoryUrl});
        await expect(deliveryClient.authorizeDeliveryEffect(claimed.id,claimed.generation+1)).rejects.toMatchObject({status:409});
        expect((await connRequest(authorizePath,{generation:claimed.generation})).statusCode).toBe(200);
        const changedPolicy=await user('PATCH',`/settings/${checkedJson(connection).id}`,{expectedUpdatedAt:checkedJson(connection).updatedAt,data:{purpose:'source'}});expect(changedPolicy.statusCode).toBe(200);
        await expect(deliveryClient.authorizeDeliveryEffect(claimed.id,claimed.generation)).rejects.toMatchObject({status:403,routeCategory:'connector.runs.delivery-authorize'});
        expect((await connRequest(authorizePath,{generation:claimed.generation})).statusCode).toBe(403);
        const restorePolicy=await user('PATCH',`/settings/${checkedJson(connection).id}`,{expectedUpdatedAt:checkedJson(changedPolicy).updatedAt,data:{purpose:'delivery'}});expect(restorePolicy.statusCode).toBe(200);
        await sql`UPDATE wb_records SET data=jsonb_set(data,'{repositoryUrl}','"https://github.com/example/changed"'::jsonb) WHERE id=${p.id}`;
        expect((await connRequest(authorizePath,{generation:claimed.generation})).statusCode).toBe(409);
        await sql`UPDATE wb_records SET data=jsonb_set(data,'{repositoryUrl}',${sql.json(p.repositoryUrl as never)}) WHERE id=${p.id}`;
        await sql`DELETE FROM wb_memberships WHERE project_id=${p.id} AND user_id=${member.id}`;
        // The implementation author is not the immutable OWNER delivery actor.
        expect(checkedJson(await connRequest(authorizePath,{generation:claimed.generation}))).toMatchObject({authorized:true});
        expect(await persistedDelivery(claimed.id)).toMatchObject({requestedBy:owner.id,operation:{actorId:owner.id}});
        await sql`INSERT INTO wb_memberships(project_id,user_id,role) VALUES (${p.id},${member.id},'member')`;
        for(const status of ['interrupted','cancelled']){
            await sql`UPDATE wb_records SET data=jsonb_set(data,'{status}',${sql.json(status as never)})-'stoppedAt' WHERE id=${queued.id}`;
            expect((await request(`retry-before-stopped-proof-${status}`)).statusCode).toBe(409);
        }
        await sql`UPDATE wb_records SET data=jsonb_set(data,'{stoppedAt}',to_jsonb(now()::text)) WHERE id=${queued.id}`;
        const changedBase=await user('PATCH',`/settings/${checkedJson(connection).id}`,{expectedUpdatedAt:checkedJson(restorePolicy).updatedAt,data:{baseBranch:'release'}});expect(changedBase.statusCode).toBe(200);
        expect((await request('retry-after-base-branch-change')).statusCode).toBe(409);
        const restoredBase=await user('PATCH',`/settings/${checkedJson(connection).id}`,{expectedUpdatedAt:checkedJson(changedBase).updatedAt,data:{baseBranch:'main'}});expect(restoredBase.statusCode).toBe(200);
        const retry=checkedJson((await request('delivery-retry'))).run as Run;
        expect(retry.id).toBe(queued.id);expect(retry.status).toBe('queued');expect(retry.generation).toBe(claimed.generation+1);expect(retry.operation?.phase).toBe('queued');
        expect((await connRequest(`/runs/${queued.id}/delivery-progress`,{generation:queued.generation,phase:'published',remoteHeadSha:commitSha})).statusCode).toBe(409);
        const retryClaim=await connRequest('/claim',{capabilities:{runKinds:['delivery'],git:true,githubWrite:true,deliveryActions:['create_draft_pr']}});expect(retryClaim.statusCode).toBe(200);expect(checkedJson(retryClaim).run.id).toBe(queued.id);expect(checkedJson(retryClaim).run.generation).toBe(retry.generation+1);
        expect((await connRequest(`/runs/${queued.id}/delivery-progress`,{generation:claimed.generation,phase:'published',remoteHeadSha:commitSha})).statusCode).toBe(409);
        expect((await connRequest('/claim',{capabilities:{runKinds:['delivery'],git:true,githubWrite:true,deliveryActions:['create_draft_pr']}})).statusCode).toBe(204);
        const active=checkedJson(retryClaim).run as Run;expect((await connRequest(`/runs/${active.id}/complete`,{generation:active.generation})).statusCode).toBe(200);
        const next=await connRequest('/claim',{capabilities:{runKinds:['delivery'],git:true,githubWrite:true,deliveryActions:['create_draft_pr']}});expect(next.statusCode).toBe(200);expect(checkedJson(next).run.id).toBe(checkedJson(queuedSecond).run.id);
        const memberDelivery=checkedJson(next).run as Run;
        expect(memberDelivery.requestedBy).toBe(member.id);expect(memberDelivery.operation?.actorId).toBe(member.id);
        const memberAuthorize=`/runs/${memberDelivery.id}/delivery-authorize`;
        await expect(deliveryClient.authorizeDeliveryEffect(memberDelivery.id,memberDelivery.generation)).resolves.toMatchObject({authorized:true,repositoryUrl:p.repositoryUrl});
        const assertMemberEffect = async (status:number) => checkedJson(await connRequest(memberAuthorize,{generation:memberDelivery.generation}),status);
        expect(await assertMemberEffect(200)).toMatchObject({authorized:true});
        const published=await deliveryClient.deliveryProgress(memberDelivery.id,memberDelivery.generation,{phase:'published',remoteHeadSha:secondSha});
        expect(published).toMatchObject({run:{id:memberDelivery.id,generation:memberDelivery.generation},artifact:{kind:'delivery',revision:secondRevision,data:{phase:'published'}}});
        const prCreated=await deliveryClient.deliveryProgress(memberDelivery.id,memberDelivery.generation,{phase:'pr_created',pullRequestNumber:42,pullRequestUrl:`${p.repositoryUrl}/pull/42`,headSha:secondSha,baseSha:'b'.repeat(40),pullRequestNodeId:'PR_fixture42'});
        expect(prCreated).toMatchObject({run:{id:memberDelivery.id,generation:memberDelivery.generation,operation:{phase:'pr_created'}},artifact:{kind:'delivery',revision:secondRevision,data:{phase:'pr_created',pullRequestNumber:42}}});
        const canonicalDeliveryScope=`delivery-candidate:${p.id}:${work.id}:${secondId}:${secondSha}:create_draft_pr`;
        const deliveryBefore=await persistedDelivery(memberDelivery.id);
        expect(deliveryBefore.operation).toMatchObject({phase:'pr_created',external:{pullRequestNumber:42,pullRequestUrl:`${p.repositoryUrl}/pull/42`}});
        const reservationBefore=await sql`SELECT result FROM wb_requests WHERE scope=${canonicalDeliveryScope} AND request_id='canonical'`;
        const deliveryArtifactsBefore=await sql`SELECT data FROM wb_records WHERE kind='artifact' AND project_id=${p.id} AND data->>'runId'=${memberDelivery.id} ORDER BY id`;
        expect(reservationBefore).toHaveLength(1);expect(deliveryArtifactsBefore.length).toBeGreaterThan(0);
        await sql`UPDATE wb_records SET data=jsonb_set(data,'{status}','"interrupted"')-'stoppedAt' WHERE id=${memberDelivery.id}`;
        const interruptedDelivery=await persistedDelivery(memberDelivery.id);
        expect(interruptedDelivery.status).toBe('interrupted');expect(interruptedDelivery.stoppedAt).toBeUndefined();
        expect(checkedJson(await user('POST',`/runs/${memberDelivery.id}/cancel`,{}))).toEqual(interruptedDelivery);
        expect(await persistedDelivery(memberDelivery.id)).toEqual(interruptedDelivery);
        expect(await sql`SELECT result FROM wb_requests WHERE scope=${canonicalDeliveryScope} AND request_id='canonical'`).toEqual(reservationBefore);
        expect(await sql`SELECT data FROM wb_records WHERE kind='artifact' AND project_id=${p.id} AND data->>'runId'=${memberDelivery.id} ORDER BY id`).toEqual(deliveryArtifactsBefore);
        await sql`UPDATE wb_records SET data=jsonb_set(data,'{status}','"running"') WHERE id=${memberDelivery.id}`;
        await expect(deliveryClient.deliveryProgress(memberDelivery.id,memberDelivery.generation,{phase:'pr_created',pullRequestNumber:43,pullRequestUrl:`${p.repositoryUrl}/pull/43`,headSha:'f'.repeat(40)})).rejects.toMatchObject({status:409,routeCategory:'connector.runs.delivery-progress'});
        // Reauthorize before each subsequent effect, including reconciliation after publication.
        for(const phase of ['queued','published','pr_created']){
            await sql`UPDATE wb_records SET data=jsonb_set(data,'{operation,phase}',${sql.json(phase as never)}) WHERE id=${memberDelivery.id}`;
            await sql`DELETE FROM wb_memberships WHERE project_id=${p.id} AND user_id=${member.id}`;
            await expect(deliveryClient.authorizeDeliveryEffect(memberDelivery.id,memberDelivery.generation)).rejects.toMatchObject({status:403});
            await assertMemberEffect(403);
            expect((await request(`revoked-actor-retry-${phase}`,{candidateRunId:secondId,candidateRevision:secondRevision,action:'create_draft_pr',requestId:`revoked-actor-retry-${phase}`})).statusCode).toBe(403);
            expect(await persistedDelivery(memberDelivery.id)).toMatchObject({requestedBy:member.id,generation:memberDelivery.generation,operation:{actorId:member.id,phase}});
            await sql`INSERT INTO wb_memberships(project_id,user_id,role) VALUES (${p.id},${member.id},'member')`;
            await expect(deliveryClient.authorizeDeliveryEffect(memberDelivery.id,memberDelivery.generation)).resolves.toMatchObject({authorized:true});
            expect(await assertMemberEffect(200)).toMatchObject({authorized:true});
        }
        expect((await connRequest(`/runs/${memberDelivery.id}/complete`,{generation:memberDelivery.generation})).statusCode).toBe(200);
        expect((await user('DELETE',`/projects/${p.id}/members/${member.id}`)).statusCode).toBe(200);
        expect((await request('delivery-after-revocation')).statusCode).toBe(403);
        const cross=(await memberReq('POST',`/works/${otherWork.id}/delivery`,{candidateRunId:candidateId,candidateRevision:revision,action:'create_draft_pr',requestId:'cross-project'}));
        expect(cross.statusCode).toBe(403);
    });
    it('retires only stopped pre-effect staging reservations without reviving their canonical source',async()=>{
        const p=checkedJson(await user('POST','/projects',{name:'Staging retirement proof',repositoryUrl:'https://github.com/example/retire-proof'})) as Project;
        const enrolled=await enrollProvider('staging-retire-connector',[p.id]);
        const work=checkedJson(await user('POST',`/projects/${p.id}/works`,{title:'Retire old source'})) as Work;
        const actorId=checkedJson(await user('GET','/me')).id as string;
        const caps={...fixtureCapabilities,runKinds:[],git:true,githubWrite:true,deliveryActions:['deploy_staging'],deploymentTargets:['staging']};
        const connectorPost=(path:string,payload:unknown)=>app.inject({method:'POST',url:'/api/workbench/connector'+path,headers:{authorization:`Bearer ${enrolled.token}`},payload:payload as never});
        expect((await connectorPost('/claim',{capabilities:caps})).statusCode).toBe(204);
        const policy=checkedJson(await user('POST','/settings',{projectId:p.id,kind:'connection',name:'Retire delivery policy',data:{provider:'github',url:p.repositoryUrl,purpose:'delivery',baseBranch:'main',allowDraftPr:true,allowStagingDeploy:true,stagingTargets:['staging'],configuredBy:actorId}}));
        const source=(sha:string):Run=>({id:randomUUID(),projectId:p.id,workId:work.id,prompt:'verified merged source',requestedBy:actorId,kind:'delivery',model:'internal',reasoning:'none',status:'completed',generation:1,connectorId:enrolled.id,targetConnectorId:enrolled.id,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),operation:{action:'merge_pr',actorId,candidateRunId:randomUUID(),candidateRevision:'fixture',artifactRevision:'fixture',commitSha:'a'.repeat(40),candidateFingerprint:'b'.repeat(64),repositoryUrl:p.repositoryUrl,baseRevision:'c'.repeat(40),baseBranch:'main',remoteBranch:'codex/retire',workTitle:work.title,changeSummary:'verified',qaStatus:'current',phase:'merged',effectIntentGeneration:1,external:{mergeSha:sha}}});
        const a=source('d'.repeat(40)),b=source('e'.repeat(40));
        for(const run of [a,b])await sql`INSERT INTO wb_records(id,kind,project_id,data) VALUES (${run.id},'run',${p.id},${sql.json(run as never)})`;
        const request=(sourceMergeRunId:string,requestId:string)=>user('POST',`/works/${work.id}/staging`,{sourceMergeRunId,targetId:'staging',requestId});
        const retire=(run:Run)=>user('POST',`/runs/${run.id}/staging/retire`,{generation:run.generation});
        const reservationScope=`staging-target:${p.id}:staging`;
        const reserved=async()=>sql`SELECT result FROM wb_requests WHERE scope=${reservationScope} AND request_id='reservation'`;
        const read=async(id:string)=>(await sql`SELECT data FROM wb_records WHERE id=${id} AND kind='run'`)[0]!.data as Run;
        checkedJson(await request(a.id,'retire-a'));
        const claimed=checkedJson(await connectorPost('/claim',{capabilities:{...caps,runKinds:['delivery']}})).run as Run;
        checkedJson(await connectorPost(`/runs/${claimed.id}/staging-build-status`,{generation:claimed.generation,status:'failed'}));
        checkedJson(await connectorPost(`/runs/${claimed.id}/complete`,{generation:claimed.generation,error:'old source has no fixed build'}));
        expect((await retire(claimed)).statusCode).toBe(409); // Failed/expired lease alone is never stop proof.
        expect((await request(b.id,'blocked-b')).statusCode).toBe(409);
        checkedJson(await connectorPost(`/runs/${claimed.id}/stopped`,{generation:claimed.generation}));
        const disabled=checkedJson(await user('PATCH',`/settings/${policy.id}`,{expectedUpdatedAt:policy.updatedAt,data:{enabled:false}}));
        const [retired,lateGrant]=await Promise.all([retire(claimed),connectorPost(`/runs/${claimed.id}/staging-authorize`,{generation:claimed.generation,effect:'provenance'})]);
        expect(lateGrant.statusCode).toBe(409);
        const saved=checkedJson(retired).run as Run;
        expect(saved).toMatchObject({status:'failed',generation:claimed.generation+1,operation:{phase:'build_discovery',stagingRetired:{by:actorId,generation:claimed.generation},buildStatus:'failed'}});
        expect(await reserved()).toHaveLength(0);
        expect(checkedJson(await retire(claimed)).run).toEqual(saved); // Same-generation retirement retry is idempotent.
        expect((await request(a.id,'retire-a')).statusCode).toBe(409);
        expect((await request(a.id,'retire-a-new-request')).statusCode).toBe(409);
        expect((await connectorPost(`/runs/${claimed.id}/staging-build-status`,{generation:claimed.generation,status:'discovering'})).statusCode).toBe(409);
        const receipt={schemaVersion:1,repository:'blossomsai/menoteam',repositoryId:'123',workflowPath:'.github/workflows/build-workbench-image.yml',runId:123,runAttempt:1,artifactId:456,archiveDigest:`sha256:${'1'.repeat(64)}`,artifactExpiresAt:new Date(Date.now()+86400000).toISOString(),sourceSha:a.operation!.external!.mergeSha,imageRepository:'ghcr.io/blossomsai/menoteam-work-map',imageDigest:`sha256:${'2'.repeat(64)}`,runUrl:'https://github.com/blossomsai/menoteam/actions/runs/123'};
        expect((await connectorPost(`/runs/${claimed.id}/staging-build-receipt`,{generation:claimed.generation,receipt})).statusCode).toBe(409);
        checkedJson(await user('PATCH',`/settings/${policy.id}`,{expectedUpdatedAt:disabled.updatedAt,data:{enabled:true}}));
        const next=checkedJson(await request(b.id,'unblocked-b')).run as Run;
        expect(next.id).not.toBe(claimed.id);expect((await reserved())[0]!.result).toMatchObject({runId:next.id});
        checkedJson(await user('POST',`/runs/${next.id}/cancel`)); // Unclaimed queue can confirm its own local stop.
        await sql`UPDATE wb_requests SET result=${sql.json({runId:'foreign-operation'} as never)} WHERE scope=${reservationScope} AND request_id='reservation'`;
        expect((await retire(next)).statusCode).toBe(409);expect((await reserved())[0]!.result).toMatchObject({runId:'foreign-operation'});
        await sql`UPDATE wb_requests SET result=${sql.json({runId:next.id} as never)} WHERE scope=${reservationScope} AND request_id='reservation'`;
        const cancelled=await read(next.id);
        for(const delta of [{phase:'deploy_unknown',effectIntentGeneration:next.generation},{phase:'deploy_intent',effectIntentGeneration:0},{stagingEffectStage:'transport_intent'},{stagingReceipt:{phase:'unknown'}}]){
            const altered={...cancelled,operation:{...cancelled.operation!,...delta}};
            await sql`UPDATE wb_records SET data=${sql.json(altered as never)} WHERE id=${next.id}`;
            expect((await retire(next)).statusCode).toBe(409);expect((await reserved())[0]!.result).toMatchObject({runId:next.id});
        }
        await sql`UPDATE wb_records SET data=${sql.json(cancelled as never)} WHERE id=${next.id}`;
        const invitation=checkedJson(await user('POST','/invites',{email:'retire-workspace-admin@test.example',role:'admin'}));
        checkedJson(await app.inject({method:'POST',url:'/api/workbench/invites/accept',payload:{token:invitation.token,name:'Retire Admin',password:'retire-admin-password'}}));
        const adminSession=await app.inject({method:'POST',url:'/api/workbench/session',payload:{email:'retire-workspace-admin@test.example',password:'retire-admin-password'}});
        const adminCookie=String(adminSession.headers['set-cookie']).split(';')[0]!;
        const adminId=(await sql`SELECT id FROM wb_users WHERE email='retire-workspace-admin@test.example'`)[0]!.id as string;
        const adminRetire=()=>app.inject({method:'POST',url:`/api/workbench/runs/${next.id}/staging/retire`,headers:{cookie:adminCookie},payload:{generation:next.generation}});
        expect((await adminRetire()).statusCode).toBe(403);
        await sql`INSERT INTO wb_memberships(user_id,project_id,role) VALUES (${adminId},${p.id},'member')`;
        expect((await adminRetire()).statusCode).toBe(403);
        await sql`UPDATE wb_memberships SET role='admin' WHERE user_id=${adminId} AND project_id=${p.id}`;
        checkedJson(await adminRetire());expect(await reserved()).toHaveLength(0);
        const c=source('f'.repeat(40));await sql`INSERT INTO wb_records(id,kind,project_id,data) VALUES (${c.id},'run',${p.id},${sql.json(c as never)})`;
        checkedJson(await request(c.id,'intent-wins-c'));
        const intentClaim=checkedJson(await connectorPost('/claim',{capabilities:{...caps,runKinds:['delivery']}})).run as Run;
        checkedJson(await connectorPost(`/runs/${intentClaim.id}/staging-build-receipt`,{generation:intentClaim.generation,receipt:{...receipt,sourceSha:c.operation!.external!.mergeSha}}));
        checkedJson(await connectorPost(`/runs/${intentClaim.id}/staging-authorize`,{generation:intentClaim.generation,effect:'provenance'}));
        checkedJson(await user('POST',`/runs/${intentClaim.id}/cancel`));
        checkedJson(await connectorPost(`/runs/${intentClaim.id}/stopped`,{generation:intentClaim.generation}));
        expect((await retire(intentClaim)).statusCode).toBe(409);expect((await reserved())[0]!.result).toMatchObject({runId:intentClaim.id});
        const canonical=await sql`SELECT result FROM wb_requests WHERE scope=${`staging-operation:${p.id}:staging:${a.id}`} AND request_id='canonical'`;
        expect(canonical).toHaveLength(1);expect(canonical[0]!.result.run.id).toBe(claimed.id);
    });
    it('reserves staging by target, authorizes effects against the merged receipt, and keeps revoked intents read-only',async()=>{
        const p=checkedJson(await user('POST','/projects',{name:'Staging authorization proof',repositoryUrl:'https://github.com/example/staging-proof'})) as Project;
        const otherProject=checkedJson(await user('POST','/projects',{name:'Other staging project',repositoryUrl:'https://github.com/example/other-staging-proof'})) as Project;
        const enrolled=await enrollProvider('staging-proof-connector',[p.id,otherProject.id]);
        const work=checkedJson(await user('POST',`/projects/${p.id}/works`,{title:'Exact staging candidate'})) as Work;
        const rollbackWork=checkedJson(await user('POST',`/projects/${p.id}/works`,{title:'Rollback from another Work'})) as Work;
        const caps={runKinds:[],git:true,githubWrite:true,deliveryActions:['deploy_staging','rollback_staging'],deploymentTargets:['staging']};
        expect((await app.inject({method:'POST',url:'/api/workbench/connector/claim',headers:{authorization:`Bearer ${enrolled.token}`},payload:{capabilities:{...fixtureCapabilities,...caps}}})).statusCode).toBe(204);
        const policy=checkedJson(await user('POST','/settings',{projectId:p.id,kind:'connection',name:'Staging delivery policy',data:{provider:'github',url:p.repositoryUrl,purpose:'delivery',baseBranch:'main',allowDraftPr:true,allowStagingDeploy:true,stagingTargets:['staging'],configuredBy:(await user('GET','/me')).json().id}}));
        const mergedSha='a'.repeat(40),candidateSha='b'.repeat(40),candidateBase='c'.repeat(40),candidateRevision=createHash('sha256').update(candidateBase).update('\0').update(candidateSha).digest('hex');
        const merged:Run={id:randomUUID(),projectId:p.id,workId:work.id,prompt:'merged source receipt',requestedBy:(await user('GET','/me')).json().id,kind:'delivery',model:'internal',reasoning:'none',status:'completed',generation:1,connectorId:'staging-proof-connector',targetConnectorId:'staging-proof-connector',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),operation:{action:'merge_pr',actorId:(await user('GET','/me')).json().id,candidateRunId:randomUUID(),candidateRevision,artifactRevision:candidateRevision,commitSha:candidateSha,candidateFingerprint:'d'.repeat(64),repositoryUrl:p.repositoryUrl,baseRevision:candidateBase,baseBranch:'main',remoteBranch:'codex/staging-proof',workTitle:work.title,changeSummary:'verified change',qaStatus:'current',phase:'merged',effectIntentGeneration:1,external:{pullRequestNumber:17,pullRequestUrl:`${p.repositoryUrl}/pull/17`,pullRequestNodeId:'PR_staging_17',headSha:candidateSha,baseSha:'e'.repeat(40),mergeSha:mergedSha}}};
        merged.targetRunId=merged.operation!.candidateRunId;merged.targetRevision=candidateRevision;merged.operation!.reviewRunId=randomUUID();merged.operation!.qaPolicySnapshot=qaPolicyFixture(p.id,p.repositoryUrl);merged.createdAt=new Date(Date.now()-120_000).toISOString();merged.updatedAt=merged.createdAt;
        await sql`INSERT INTO wb_records(id,kind,project_id,data) VALUES (${merged.id},'run',${p.id},${sql.json(merged as never)})`;
        const imageDigestForTest=`sha256:${'f'.repeat(64)}`;
        const request=(requestId:string)=>user('POST',`/works/${work.id}/staging`,{sourceMergeRunId:merged.id,targetId:'staging',requestId});
        const queued=checkedJson(await request('staging-first'));expect(queued.run).toMatchObject({kind:'delivery',targetConnectorId:'staging-proof-connector',operation:{action:'deploy_staging',phase:'build_discovery',buildStatus:'discovering',sourceMergeRunId:merged.id,commitSha:mergedSha,targetId:'staging',expectedCurrentDeploymentId:null}});expect(queued.run.operation.effectIntentGeneration).toBeUndefined();expect(queued.run.operation.imageDigest).toBeUndefined();
        expect(checkedJson(await request('staging-dedup')).run.id).toBe(queued.run.id);
        expect((await user('POST',`/works/${work.id}/staging`,{sourceMergeRunId:merged.id,targetId:'staging',imageDigest:`sha256:${'1'.repeat(64)}`,requestId:'forged-digest'})).statusCode).toBe(400);
        const reservationScope=`staging-target:${p.id}:staging`;
        const reserved=await sql`SELECT result FROM wb_requests WHERE scope=${reservationScope} AND request_id='reservation'`;
        expect(reserved[0]?.result).toMatchObject({runId:queued.run.id,action:'deploy_staging'});
        let claimed=checkedJson(await app.inject({method:'POST',url:'/api/workbench/connector/claim',headers:{authorization:`Bearer ${enrolled.token}`},payload:{capabilities:{...fixtureCapabilities,...caps,runKinds:['delivery']}}})).run as Run;
        expect(claimed.id).toBe(queued.run.id);
        const conn=(path:string,payload:unknown)=>app.inject({method:'POST',url:'/api/workbench/connector'+path,headers:{authorization:`Bearer ${enrolled.token}`},payload:connectorFixturePayload(path,payload) as never});
        const client=new WorkbenchConnectorClient({serverUrl:'http://localhost:4313',token:enrolled.token},async(input,init)=>{
            const url=new URL(String(input));const response=await app.inject({method:(init?.method??'GET') as 'GET'|'POST',url:url.pathname,headers:init?.headers as never,payload:init?.body?JSON.parse(String(init.body)):undefined,remoteAddress:`127.0.0.${scenarioAddress}`} as never);
            return new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}});
        });
        await client.stagingBuildStatus(claimed.id,claimed.generation,'failed');
        expect((await conn(`/runs/${claimed.id}/complete`,{generation:claimed.generation,error:'fixed workflow build failed'})).statusCode).toBe(200);
        const discoveryRetry=checkedJson(await request('staging-retry')) as {run:Run};
        expect(discoveryRetry.run).toMatchObject({id:claimed.id,generation:claimed.generation+1,status:'queued',operation:{phase:'build_discovery',buildStatus:'discovering'}});
        claimed=checkedJson(await app.inject({method:'POST',url:'/api/workbench/connector/claim',headers:{authorization:`Bearer ${enrolled.token}`},payload:{capabilities:{...fixtureCapabilities,...caps,runKinds:['delivery']}}})).run as Run;
        await expect(client.authorizeStagingEffect(claimed.id,claimed.generation,'discovery')).resolves.toMatchObject({authorized:true,action:'discover'});
        const buildReceipt={schemaVersion:1 as const,repository:'blossomsai/menoteam' as const,repositoryId:'12345678',workflowPath:'.github/workflows/build-workbench-image.yml' as const,runId:123,runAttempt:1,artifactId:456,archiveDigest:`sha256:${'e'.repeat(64)}`,artifactExpiresAt:new Date(Date.now()+86400000).toISOString(),sourceSha:mergedSha,imageRepository:'ghcr.io/blossomsai/menoteam-work-map' as const,imageDigest:imageDigestForTest,runUrl:'https://github.com/blossomsai/menoteam/actions/runs/123'};
        const receiptResult=await client.stagingBuildReceipt(claimed.id,claimed.generation,buildReceipt);
        expect(receiptResult.run.operation).toMatchObject({phase:'build_discovery',buildStatus:'verified',imageDigest:imageDigestForTest,buildReceipt:{runId:123,runAttempt:1,artifactId:456,sourceSha:mergedSha,imageDigest:imageDigestForTest}});
        expect(receiptResult.artifact.data).toMatchObject({phase:'build_verified',receipt:{artifactId:456}});
        await expect(client.authorizeStagingEffect(claimed.id,claimed.generation,'provenance')).resolves.toMatchObject({authorized:true,action:'deploy'});
        expect((await sql`SELECT data FROM wb_records WHERE id=${claimed.id} AND kind='run'`)[0]!.data).toMatchObject({operation:{phase:'deploy_intent',effectIntentGeneration:claimed.generation,stagingEffectStage:'intent'}});
        await expect(client.authorizeStagingEffect(claimed.id,claimed.generation,'transport')).resolves.toMatchObject({authorized:true,action:'deploy'});
        expect((await sql`SELECT data FROM wb_records WHERE id=${claimed.id} AND kind='run'`)[0]!.data).toMatchObject({operation:{stagingEffectStage:'transport_intent'}});
        const forged={operationId:claimed.id,targetId:'staging',phase:'health_passed',deploymentId:'deploy_forged',commitSha:mergedSha,imageDigest:imageDigestForTest,activeCommitSha:mergedSha,activeImageDigest:`sha256:${'0'.repeat(64)}`,checkedAt:new Date().toISOString()};
        await expect(client.stagingProgress(claimed.id,claimed.generation,forged as never)).rejects.toMatchObject({status:409});
        expect((await sql`SELECT result FROM wb_requests WHERE scope=${reservationScope} AND request_id='reservation'`)).toHaveLength(1);
        const changed=checkedJson(await user('PATCH',`/settings/${policy.id}`,{expectedUpdatedAt:policy.updatedAt,data:{enabled:false}}));
        expect((await app.inject({method:'POST',url:'/api/workbench/connector/claim',headers:{authorization:`Bearer ${enrolled.token}`},payload:{capabilities:{...fixtureCapabilities,runKinds:['delivery']}}})).statusCode).toBe(204);
        await expect(client.authorizeStagingEffect(claimed.id,claimed.generation,'transport')).rejects.toMatchObject({status:409});
        await expect(client.authorizeStagingEffect(claimed.id,claimed.generation,'status')).resolves.toMatchObject({authorized:true,action:'status'});
        const unknown={operationId:claimed.id,targetId:'staging',phase:'unknown',commitSha:mergedSha,imageDigest:imageDigestForTest,checkedAt:new Date().toISOString()};
        const saved=await client.stagingProgress(claimed.id,claimed.generation,unknown as never);expect(saved.run.operation?.phase).toBe('deploy_unknown');
        expect((await sql`SELECT result FROM wb_requests WHERE scope=${reservationScope} AND request_id='reservation'`)).toHaveLength(1);
        expect((await conn(`/runs/${claimed.id}/complete`,{generation:claimed.generation,error:'unknown remote result'})).statusCode).toBe(200);
        expect((await sql`SELECT data FROM wb_records WHERE id=${claimed.id} AND kind='run'`)[0]!.data).toMatchObject({status:'failed',operation:{phase:'deploy_unknown'}});
        expect((await sql`SELECT result FROM wb_requests WHERE scope=${reservationScope} AND request_id='reservation'`)).toHaveLength(1);
        const statusRetry=checkedJson(await request('staging-status-retry')) as {run:Run};
        expect(statusRetry.run).toMatchObject({id:claimed.id,generation:claimed.generation+1,status:'queued',operation:{phase:'deploy_unknown',effectIntentGeneration:claimed.generation}});
        const readonlyClaim=checkedJson(await app.inject({method:'POST',url:'/api/workbench/connector/claim',headers:{authorization:`Bearer ${enrolled.token}`},payload:{capabilities:{...fixtureCapabilities,runKinds:['delivery'],deploymentTargets:['staging']}}})).run as Run;
        expect(readonlyClaim.id).toBe(claimed.id);
        await expect(client.renew(readonlyClaim.id,readonlyClaim.generation)).resolves.toMatchObject({status:'running',generation:readonlyClaim.generation});
        await expect(client.authorizeStagingEffect(readonlyClaim.id,readonlyClaim.generation,'status')).resolves.toMatchObject({authorized:true,action:'status'});
        await expect(client.authorizeStagingEffect(readonlyClaim.id,readonlyClaim.generation,'transport')).resolves.toMatchObject({authorized:true,action:'status'});
        expect((await sql`SELECT result FROM wb_requests WHERE scope=${reservationScope} AND request_id='reservation'`)[0]?.result).toMatchObject({runId:claimed.id,action:'deploy_staging'});
        expect((await conn(`/runs/${readonlyClaim.id}/complete`,{generation:readonlyClaim.generation,error:'status remains unknown'})).statusCode).toBe(200);
        await sql`DELETE FROM wb_requests WHERE scope=${reservationScope} AND request_id='reservation' AND result->>'runId'=${claimed.id}`;

        // Seed only the two previously health-verified immutable receipts needed to request a rollback.
        const enabledPolicy=checkedJson(await user('PATCH',`/settings/${policy.id}`,{expectedUpdatedAt:changed.updatedAt,data:{...policy.data,enabled:true}}));
        const previousId=randomUUID(),currentId=randomUUID(),previousDigest=`sha256:${'2'.repeat(64)}`,currentDigest=`sha256:${'3'.repeat(64)}`;
        const actorId=(await user('GET','/me')).json().id as string;
        const revisionB=createHash('sha256').update(candidateBase).update('\0').update('7'.repeat(40)).digest('hex');
        const sourceB:Run={...merged,id:randomUUID(),workId:rollbackWork.id,targetRevision:revisionB,createdAt:new Date(Date.now()-30_000).toISOString(),operation:{...merged.operation!,candidateRunId:randomUUID(),candidateRevision:revisionB,artifactRevision:revisionB,candidateFingerprint:'6'.repeat(64),commitSha:'7'.repeat(40),reviewRunId:randomUUID(),workTitle:rollbackWork.title,remoteBranch:'codex/staging-proof-b',changeSummary:'verified change B',external:{...merged.operation!.external,pullRequestNumber:18,pullRequestUrl:`${p.repositoryUrl}/pull/18`,pullRequestNodeId:'PR_staging_18',headSha:'7'.repeat(40),mergeSha:'8'.repeat(40)}}};
        sourceB.targetRunId=sourceB.operation!.candidateRunId;sourceB.updatedAt=sourceB.createdAt;
        await sql`INSERT INTO wb_records(id,kind,project_id,data) VALUES (${sourceB.id},'run',${p.id},${sql.json(sourceB as never)})`;
        const verifiedDeployment=(source:Run,id:string,digest:string,updatedAt:string,receipt:{deploymentId:string;previousDeploymentId?:string;previousImageDigest?:string}):Run=>({
            id,projectId:p.id,workId:source.workId,targetRunId:source.targetRunId,targetRevision:source.targetRevision,prompt:'previous staging receipt',requestedBy:actorId,kind:'delivery',model:'internal',reasoning:'none',status:'completed',generation:1,connectorId:'staging-proof-connector',targetConnectorId:'staging-proof-connector',createdAt:updatedAt,updatedAt,
            operation:{...source.operation!,action:'deploy_staging',actorId,commitSha:source.operation!.external!.mergeSha!,phase:'health_passed',sourceMergeRunId:source.id,targetId:'staging',targetPolicyVersion:enabledPolicy.updatedAt,imageDigest:digest,buildStatus:'verified',buildReceipt:{...buildReceipt,sourceSha:source.operation!.external!.mergeSha!,imageDigest:digest,verifiedAt:updatedAt,verifiedGeneration:1},stagingReceipt:{operationId:id,targetId:'staging',phase:'health_passed',deploymentId:receipt.deploymentId,commitSha:source.operation!.external!.mergeSha!,imageDigest:digest,activeCommitSha:source.operation!.external!.mergeSha!,activeImageDigest:digest,...(receipt.previousDeploymentId?{previousDeploymentId:receipt.previousDeploymentId}:{}),...(receipt.previousImageDigest?{previousImageDigest:receipt.previousImageDigest}:{}),checkedAt:updatedAt}}
        });
        const previousAt=new Date(Date.now()-60_000).toISOString(),currentAt=new Date().toISOString();
        const previousRun=verifiedDeployment(merged,previousId,previousDigest,previousAt,{deploymentId:'deploy_previous'});
        const currentRun=verifiedDeployment(sourceB,currentId,currentDigest,currentAt,{deploymentId:'deploy_current',previousDeploymentId:'deploy_previous',previousImageDigest:previousDigest});
        await sql`INSERT INTO wb_records(id,kind,project_id,data) VALUES (${previousRun.id},'run',${p.id},${sql.json(previousRun as never)}),(${currentRun.id},'run',${p.id},${sql.json(currentRun as never)})`;
        // Restore mutation capabilities via normal discovery after the read-only reconciliation proof.
        expect((await app.inject({method:'POST',url:'/api/workbench/connector/claim',headers:{authorization:`Bearer ${enrolled.token}`},payload:{capabilities:{...fixtureCapabilities,...caps,runKinds:[]}}})).statusCode).toBe(204);
        const otherProjectWork=checkedJson(await user('POST',`/projects/${otherProject.id}/works`,{title:'Foreign staging Work'})) as Work;
        const otherProjectReceipt={...previousRun,id:randomUUID(),projectId:otherProject.id,workId:otherProjectWork.id,operation:{...previousRun.operation!,stagingReceipt:{...previousRun.operation!.stagingReceipt!,deploymentId:'deploy_other_project'}}};
        const otherTargetReceipt={...previousRun,id:randomUUID(),operation:{...previousRun.operation!,targetId:'other-stage',stagingReceipt:{...previousRun.operation!.stagingReceipt!,targetId:'other-stage',deploymentId:'deploy_other_target'}}};
        const foreignProjectCurrent={...currentRun,id:randomUUID(),operation:{...currentRun.operation!,stagingReceipt:{...currentRun.operation!.stagingReceipt!,deploymentId:'deploy_current_foreign_project',previousDeploymentId:'deploy_other_project'}}};
        const foreignTargetCurrent={...currentRun,id:randomUUID(),operation:{...currentRun.operation!,stagingReceipt:{...currentRun.operation!.stagingReceipt!,deploymentId:'deploy_current_foreign_target',previousDeploymentId:'deploy_other_target'}}};
        await sql`INSERT INTO wb_records(id,kind,project_id,data) VALUES (${otherProjectReceipt.id},'run',${otherProject.id},${sql.json(otherProjectReceipt as never)}),(${otherTargetReceipt.id},'run',${p.id},${sql.json(otherTargetReceipt as never)}),(${foreignProjectCurrent.id},'run',${p.id},${sql.json(foreignProjectCurrent as never)}),(${foreignTargetCurrent.id},'run',${p.id},${sql.json(foreignTargetCurrent as never)})`;
        const rollbackRequest=(requestId:string,deploymentRunId=currentRun.id)=>user('POST',`/works/${rollbackWork.id}/staging/rollback`,{deploymentRunId,targetId:'staging',requestId});
        expect((await rollbackRequest('reject-other-project',foreignProjectCurrent.id)).statusCode).toBe(409);
        expect((await rollbackRequest('reject-other-target',foreignTargetCurrent.id)).statusCode).toBe(409);
        await sql`DELETE FROM wb_records WHERE id IN (${foreignProjectCurrent.id},${foreignTargetCurrent.id})`;
        const rollbackQueued=checkedJson(await rollbackRequest('rollback-first')) as {run:Run};
        expect(rollbackQueued.run).toMatchObject({workId:rollbackWork.id,operation:{candidateRunId:merged.operation!.candidateRunId,candidateFingerprint:merged.operation!.candidateFingerprint,sourceMergeRunId:merged.id,expectedCurrentDeploymentId:'deploy_current',buildReceipt:previousRun.operation!.buildReceipt}});
        expect(rollbackQueued.run.operation).toMatchObject({action:'rollback_staging',phase:'queued',previousDeploymentRunId:previousRun.id,previousDeploymentId:'deploy_previous',rollbackToImageDigest:previousDigest});
        const rollbackClaim=checkedJson(await app.inject({method:'POST',url:'/api/workbench/connector/claim',headers:{authorization:`Bearer ${enrolled.token}`},payload:{capabilities:{...fixtureCapabilities,...caps,runKinds:['delivery']}}})).run as Run;
        expect(rollbackClaim.id).toBe(rollbackQueued.run.id);
        await expect(client.authorizeStagingEffect(rollbackClaim.id,rollbackClaim.generation,'provenance')).resolves.toMatchObject({authorized:true,action:'rollback'});
        await expect(client.authorizeStagingEffect(rollbackClaim.id,rollbackClaim.generation,'transport')).resolves.toMatchObject({authorized:true,action:'rollback'});
        const rollbackUnknown={operationId:rollbackClaim.id,targetId:'staging',phase:'unknown',commitSha:mergedSha,imageDigest:previousDigest,checkedAt:new Date().toISOString()};
        expect((await client.stagingProgress(rollbackClaim.id,rollbackClaim.generation,rollbackUnknown as never)).run.operation?.phase).toBe('deploy_unknown');
        expect((await conn(`/runs/${rollbackClaim.id}/complete`,{generation:rollbackClaim.generation,error:'rollback result unknown'})).statusCode).toBe(200);
        const disabledPolicy=checkedJson(await user('PATCH',`/settings/${policy.id}`,{expectedUpdatedAt:enabledPolicy.updatedAt,data:{...enabledPolicy.data,enabled:false}}));
        const rollbackRetry=checkedJson(await rollbackRequest('rollback-status-retry')) as {run:Run};
        expect(rollbackRetry.run).toMatchObject({id:rollbackClaim.id,generation:rollbackClaim.generation+1,status:'queued',operation:{action:'rollback_staging',phase:'deploy_unknown',previousDeploymentRunId:previousRun.id}});
        const rollbackStatusClaim=checkedJson(await app.inject({method:'POST',url:'/api/workbench/connector/claim',headers:{authorization:`Bearer ${enrolled.token}`},payload:{capabilities:{...fixtureCapabilities,runKinds:['delivery'],deploymentTargets:['staging']}}})).run as Run;
        expect(rollbackStatusClaim.id).toBe(rollbackClaim.id);
        await expect(client.renew(rollbackStatusClaim.id,rollbackStatusClaim.generation)).resolves.toMatchObject({status:'running',generation:rollbackStatusClaim.generation});
        await expect(client.authorizeStagingEffect(rollbackStatusClaim.id,rollbackStatusClaim.generation,'transport')).resolves.toMatchObject({authorized:true,action:'status'});
        expect((await sql`SELECT result FROM wb_requests WHERE scope=${reservationScope} AND request_id='reservation'`)[0]?.result).toMatchObject({runId:rollbackClaim.id,action:'rollback_staging'});
        expect(disabledPolicy.data.enabled).toBe(false);
        expect((await conn(`/runs/${rollbackStatusClaim.id}/complete`,{generation:rollbackStatusClaim.generation,error:'rollback still unknown'})).statusCode).toBe(200);
        expect(changed.data.enabled).toBe(false);
        await sql`DELETE FROM wb_records WHERE project_id=${p.id}`;
        await sql`DELETE FROM wb_requests WHERE scope LIKE ${`%${p.id}%`} OR result->>'runId'=${claimed.id}`;
        await sql`DELETE FROM wb_records WHERE project_id=${otherProject.id}`;
        await sql`DELETE FROM wb_requests WHERE scope LIKE ${`%${otherProject.id}%`}`;
    });
    it('reviewer bridge reads exact candidate evidence and denies wider reads or mutations',async()=>{
        const p=(await user('POST','/projects',{name:'Scoped review proof'})).json();
        const credential=(await enrollProvider('review-bridge-connector',[p.id])).token;
        const work=(await user('POST',`/projects/${p.id}/works`,{title:'Review candidate'})).json();
        const other=(await user('POST',`/projects/${p.id}/works`,{title:'Private other Work'})).json();
        const send=(path:string,payload:unknown,bearer=credential)=>app.inject({method:'POST',url:'/api/workbench/connector'+path,headers:{authorization:`Bearer ${bearer}`},payload:connectorFixturePayload(path,payload) as never});
        await user('POST',`/projects/${p.id}/messages`,{workId:work.id,text:'Implement candidate',requestId:'review-bridge-implementation'});
        const candidate=(await send('/claim',{})).json().run;
        const diff=await send(`/runs/${candidate.id}/artifacts`,{generation:candidate.generation,kind:'diff',revision:'exact-candidate-revision',data:{files:[{path:'src/example.ts',added:1,removed:0,lines:['+ actual evidence']}],candidateFingerprint:'candidate-bytes',candidateRevision:'a'.repeat(40)},requestId:'candidate-diff'});
        expect(diff.statusCode).toBe(200);
        await send(`/runs/${candidate.id}/artifacts`,{generation:candidate.generation,kind:'qa',revision:'exact-candidate-revision',data:{candidateFingerprint:'c'.repeat(64),checks:[],stale:false},requestId:'review-bridge-qa'});
        await send(`/runs/${candidate.id}/complete`,{generation:candidate.generation,threadId:'candidate-thread'});
        const master=(await send('/claim',{})).json().run;
        const invalid=await send(`/runs/${master.id}/tools`,{generation:master.generation,action:'dispatch',input:{workId:work.id,kind:'review',model:'gpt-6.1-sol',prompt:'x'.repeat(12001)},requestId:'oversized-review'});
        expect(invalid.statusCode).toBe(400);
        expect(invalid.json().issues).toEqual([{path:['prompt'],code:'too_big'}]);
        expect(invalid.body).not.toContain('x'.repeat(100));
        const masterWork=await send(`/runs/${master.id}/tools`,{generation:master.generation,action:'read_work',input:{workId:work.id},requestId:'master-read-work'});
        expect(masterWork.statusCode).toBe(200);
        expect(masterWork.json().reviewAssignment).toBeUndefined();
        const review=(await send(`/runs/${master.id}/tools`,{generation:master.generation,action:'dispatch',input:{workId:work.id,kind:'review',model:'gpt-6.1-sol',prompt:'Review exact evidence'},requestId:'dispatch-review'})).json();
        await send(`/runs/${master.id}/complete`,{generation:master.generation,threadId:'master-thread'});
        const claimed=(await send('/claim',{capabilities:{runKinds:['review']}})).json().run;
        expect(claimed.id).toBe(review.id);
        const bridge=(await send(`/runs/${claimed.id}/bridge-token`,{generation:claimed.generation})).json().token;
        const tool=(action:string,input:unknown)=>send(`/runs/${claimed.id}/tools`,{generation:claimed.generation,action,input,requestId:crypto.randomUUID()},bridge);
        const assignment=(await tool('read_work',{workId:work.id})).json();
        expect(assignment.reviewAssignment).toMatchObject({reviewerRunId:claimed.id,reviewBinding:review.reviewBinding,currentRequiredQaValidation:{requiredQaValid:false,validity:'at-observation-only'}});
        expect((await tool('read_work',{workId:other.id})).statusCode).toBe(403);
        const evidence=await tool('read_run',{runId:candidate.id});
        expect(evidence.statusCode).toBe(200);
        expect(evidence.json().artifacts[0].data.files[0].lines).toEqual(['+ actual evidence']);
        expect((await tool('read_run',{runId:master.id})).statusCode).toBe(403);
        expect((await tool('read_context',{})).statusCode).toBe(403);
        expect((await tool('create_skill',{name:'Escalate',data:{content:'No'}})).statusCode).toBe(403);
        expect((await send('/claim',{},bridge)).statusCode).toBe(401);
    });
    it('returns fresh assigned current-policy QA validation without exposing settings or weakening reviewer grants',async()=>{
        const request=async(method:string,route:string,body?:unknown)=>app.inject({method:method as any,url:`/api/workbench${route}`,headers:{cookie,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{payload:body})});
        const p=(await request('POST','/projects',{name:'Reviewer QA projection',repositoryUrl:'https://github.com/example/reviewer-qa'})).json();
        const enrolled=(await request('POST','/connectors',{id:`review-qa-${randomUUID()}`,projectIds:[p.id]})).json();
        const send=(route:string,body:unknown,auth=enrolled.token)=>app.inject({method:'POST',url:`/api/workbench/connector${route}`,headers:{authorization:`Bearer ${auth}`},payload:body});
        expect((await send('/claim',{capabilities:{models:['gpt-6-luna','gpt-6.1-sol'],runKinds:[],codexAppServer:true,localWorktrees:true}})).statusCode).toBe(204);
        const connection=(await request('POST','/settings',{kind:'provider',name:'Reviewer QA host',data:{provider:'openai',method:'codex-host',connectorId:enrolled.id,enabled:true}})).json();
        const reference=qaPolicyFixture(p.id,p.repositoryUrl);reference.coverage='project/v1';reference.resource=undefined;reference.requirements=[{id:'generic-tests',category:'tests',commands:[{executable:'node',args:['test.cjs','{reportFile}'],timeoutMs:10_000}],report:'vitest-json'}];
        const policyResponse=await request('POST','/settings',{projectId:p.id,kind:'connection',name:'Assigned QA',data:{provider:'qa',purpose:'qa',url:p.repositoryUrl,coverage:reference.coverage,requirements:reference.requirements}});expect(policyResponse.statusCode).toBe(200);const policy=policyResponse.json();
        const work=(await request('POST',`/projects/${p.id}/works`,{title:'Current QA receipt',connectionId:connection.id})).json();
        const invite=(await request('POST','/invites',{email:`review-qa-${randomUUID()}@test.example`,projectId:p.id,role:'member'})).json();
        const member=(await app.inject({method:'POST',url:'/api/workbench/invites/accept',payload:{token:invite.token,name:'Reviewer actor',password:'review-qa-test-password'}})).json();
        const login=await app.inject({method:'POST',url:'/api/workbench/session',payload:{email:member.email,password:'review-qa-test-password'}});expect(login.statusCode).toBe(200);
        const memberCookie=String(login.headers['set-cookie']).split(';')[0]!;
        const actor=(await app.inject({method:'GET',url:'/api/workbench/me',headers:{cookie:memberCookie}})).json();
        // Establish the project Master through normal APIs before completion can wake it.
        const seed=checkedJson(await app.inject({method:'POST',url:`/api/workbench/projects/${p.id}/messages`,headers:{cookie:memberCookie},payload:{text:'Prepare candidate review',connectionId:connection.id,requestId:randomUUID()}})).run;
        expect(seed.kind).toBe('master');
        const seedClaim=checkedJson(await send('/claim',{capabilities:{models:['gpt-6-luna','gpt-6.1-sol'],runKinds:['master'],codexAppServer:true,localWorktrees:true}})).run;
        expect(seedClaim.id).toBe(seed.id);
        checkedJson(await send(`/runs/${seed.id}/complete`,{generation:seedClaim.generation,threadId:'review-master-thread'}));
        const queued=(await app.inject({method:'POST',url:`/api/workbench/projects/${p.id}/messages`,headers:{cookie:memberCookie},payload:{workId:work.id,text:'Implementation',requestId:randomUUID()}})).json().run;
        const candidate=(await send('/claim',{capabilities:{models:['gpt-6-luna','gpt-6.1-sol'],runKinds:['implementation'],codexAppServer:true,localWorktrees:true}})).json().run;
        expect(candidate.id).toBe(queued.id);
        const fingerprint='d'.repeat(64),revision='bound-diff',commit='a'.repeat(40);
        const diff=checkedJson(await send(`/runs/${candidate.id}/artifacts`,{generation:candidate.generation,kind:'diff',revision,data:{baseRevision:'b'.repeat(40),candidateRevision:commit,files:[]},requestId:'projection-diff'}));
        const required=checkedJson(await send(`/runs/${candidate.id}/artifacts`,{generation:candidate.generation,kind:'qa',revision,data:{...requiredQaFixture(fingerprint,qaPolicySnapshot.parse(candidate.qaPolicySnapshot)),revision},requestId:`required-qa:${candidate.id}:${candidate.generation}`}));
        checkedJson(await send(`/runs/${candidate.id}/artifacts`,{generation:candidate.generation,kind:'qa',revision,data:{candidateFingerprint:fingerprint,checks:[],verification:'stale',stale:true},requestId:'projection-supplemental'}));
        expect((await send(`/runs/${candidate.id}/complete`,{generation:candidate.generation,threadId:'candidate-thread'})).statusCode).toBe(200);
        const wakes=checkedJson(await request('GET','/snapshot')).runs.filter((run:Run)=>run.projectId===p.id&&run.kind==='master'&&run.status==='queued');
        expect(wakes).toHaveLength(1);
        const master=checkedJson(await send('/claim',{capabilities:{models:['gpt-6-luna','gpt-6.1-sol'],runKinds:['master'],codexAppServer:true,localWorktrees:true}})).run;
        expect(master.id).toBe(wakes[0].id);expect(master.execution.connectionId).toBe(connection.id);expect(master.requestedBy).toBe(actor.id);
        const masterRead=await send(`/runs/${master.id}/tools`,{generation:master.generation,action:'read_work',input:{workId:work.id},requestId:'master-no-validation'});
        expect(masterRead.json().reviewAssignment).toBeUndefined();
        const review=(await send(`/runs/${master.id}/tools`,{generation:master.generation,action:'dispatch',input:{workId:work.id,kind:'review',prompt:'Review current QA',model:'gpt-6.1-sol',reasoning:'medium'},requestId:'dispatch-review-projection'})).json();
        expect(review.kind).toBe('review');
        expect((await send(`/runs/${master.id}/complete`,{generation:master.generation,threadId:'review-master-thread'})).statusCode).toBe(200);
        const claimed=(await send('/claim',{capabilities:{models:['gpt-6-luna','gpt-6.1-sol'],runKinds:['review'],codexAppServer:true,localWorktrees:true}})).json().run;
        expect(claimed.id).toBe(review.id);expect(claimed.requestedBy).toBe(actor.id);
        const bridge=(await send(`/runs/${claimed.id}/bridge-token`,{generation:claimed.generation})).json().token;
        const read=(input={workId:work.id},generation=claimed.generation)=>send(`/runs/${claimed.id}/tools`,{generation,action:'read_work',input,requestId:'reused-fresh-observation'},bridge);
        const first=await read();expect(first.statusCode).toBe(200);
        const validation=first.json().reviewAssignment.currentRequiredQaValidation;
        expect(validation).toMatchObject({validity:'at-observation-only',candidateRunId:candidate.id,commitSha:commit,candidateFingerprint:fingerprint,diffArtifactId:diff.id,diffRevision:revision,candidateCurrent:true,policyMatchesSnapshot:true,requiredQaValid:true,qaArtifactIds:[required.id],currentPolicy:{id:policy.id,version:policy.updatedAt,coverage:'project/v1'},reason:'valid'});
        expect(Object.keys(validation.currentPolicy).sort()).toEqual(['coverage','id','version']);
        expect(first.json().settings).toBeUndefined();expect(JSON.stringify(validation)).not.toContain(p.repositoryUrl);
        expect((await read({workId:'another-work'})).statusCode).toBe(403);
        const staleGeneration=await read(undefined,claimed.generation-1);expect(staleGeneration.statusCode).toBe(409);
        expect(staleGeneration.json()).toMatchObject({error:'REQUEST_FAILED',message:'Lease lost; stop and reconcile execution'});expect(staleGeneration.json().reviewAssignment).toBeUndefined();
        expect((await send(`/runs/${claimed.id}/tools`,{generation:claimed.generation,action:'read_context',input:{},requestId:'forbidden-context'},bridge)).statusCode).toBe(403);
        expect((await send(`/runs/${claimed.id}/tools`,{generation:claimed.generation,action:'read_run',input:{runId:master.id},requestId:'forbidden-run'},bridge)).statusCode).toBe(403);
        const store=new WorkbenchStore(sql);
        await store.put('artifact',{...required,data:{...required.data,stale:true}});
        expect(checkedJson(await read()).reviewAssignment.currentRequiredQaValidation).toMatchObject({candidateCurrent:true,policyMatchesSnapshot:true,requiredQaValid:false,qaArtifactIds:[],reason:'required_qa_unavailable'});
        await store.put('artifact',required);
        const changed=(await request('PATCH',`/settings/${policy.id}`,{expectedUpdatedAt:policy.updatedAt,name:'Policy updated'})).json();
        const updated=await read();expect(updated.statusCode).toBe(200);expect(updated.json().reviewAssignment.currentRequiredQaValidation).toMatchObject({requiredQaValid:false,policyMatchesSnapshot:false,currentPolicy:{version:changed.updatedAt},reason:'policy_changed'});
        expect((await request('PATCH',`/settings/${policy.id}`,{expectedUpdatedAt:changed.updatedAt,data:{enabled:false}})).statusCode).toBe(200);
        const disabled=await read();expect(checkedJson(disabled).reviewAssignment.currentRequiredQaValidation).toMatchObject({requiredQaValid:false,currentPolicy:null,qaArtifactIds:[],reason:'policy_unavailable'});
        // A newer server-recorded diff invalidates this assignment even on a retried read request.
        const latest={...diff,id:'newer-projection-diff',revision:'new-revision',data:{...diff.data,candidateRevision:'c'.repeat(40)}};
        await new WorkbenchStore(sql).put('artifact',latest);
        expect(checkedJson(await read()).reviewAssignment.currentRequiredQaValidation).toMatchObject({candidateCurrent:false,requiredQaValid:false,reason:'candidate_changed'});
        expect((await request('DELETE',`/projects/${p.id}/members/${actor.id}`)).statusCode).toBe(200);
        expect((await read()).statusCode).toBe(403);
    });
    it('real HTTP client -> Fastify -> PostgreSQL freezes explicit generic QA policy and denies changed, forged and revoked captures',async()=>{
        const serverUrl=await app.listen({port:0,host:'127.0.0.1'});
        const browser=async(method:string,path:string,body?:unknown,status=200)=>{const response=await fetch(`${serverUrl}/api/workbench${path}`,{method,headers:{cookie,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const value=await response.json();expect(response.status).toBe(status);return value as any;};
        const p=await browser('POST','/projects',{name:'Explicit generic QA contract',repositoryUrl:'https://github.com/example/generic'});
        const owner=await browser('GET','/me'),enrolled=await browser('POST','/connectors',{id:`qa-http-${randomUUID()}`,projectIds:[p.id]});
        const client=new WorkbenchConnectorClient({serverUrl,token:enrolled.token},fetch,['gpt-6-luna','gpt-6.1-sol']);
        expect(await client.claim([])).toBeUndefined();
        const connection=await browser('POST','/settings',{kind:'provider',name:'Generic QA host',data:{provider:'openai',method:'codex-host',connectorId:enrolled.id,enabled:true}});
        const w=await browser('POST',`/projects/${p.id}/works`,{title:'Capture authorized project QA',connectionId:connection.id});
        const reference=qaPolicyFixture(p.id,p.repositoryUrl);reference.coverage='project/v1';reference.resource=undefined;reference.requirements=[{id:'generic-tests',category:'tests',commands:[{executable:'node',args:['test.cjs','{reportFile}'],timeoutMs:10_000}],report:'vitest-json'}];
        const policy=await browser('POST','/settings',{projectId:p.id,kind:'connection',name:'Generic QA',data:{provider:'qa',purpose:'qa',url:p.repositoryUrl,coverage:reference.coverage,requirements:reference.requirements}});
        const requested=await browser('POST',`/projects/${p.id}/messages`,{workId:w.id,text:'Bounded implementation',requestId:randomUUID()});
        const claim=(await client.claim(['implementation']))!,r=claim.run;
        expect(r.id).toBe(requested.run.id);expect(r.qaPolicySnapshot).toMatchObject({id:policy.id,version:policy.updatedAt,configuredBy:owner.id,requirements:reference.requirements});
        await expect(client.authorizeQaEffect(r.id,r.generation)).resolves.toEqual({authorized:true});
        const qa={...requiredQaFixture('d'.repeat(64),r.qaPolicySnapshot!),revision:'generic-diff'};
        const upload={kind:'qa' as const,revision:'generic-diff',data:qa,requestId:`required-qa:${r.id}:${r.generation}`};
        await expect(client.addArtifact(r.id,r.generation,{...upload,data:{...qa,policy:{...qa.policy,id:'forged'}}})).rejects.toMatchObject({status:403});
        const accepted=await client.addArtifact(r.id,r.generation,upload);expect(accepted.data).toMatchObject({policy:{id:policy.id}});
        expect((await client.addArtifact(r.id,r.generation,upload)).id).toBe(accepted.id);
        await expect(client.addArtifact(r.id,r.generation,{...upload,data:{...qa,capturedAt:new Date(Date.now()+1000).toISOString()}})).rejects.toMatchObject({status:409});
        await browser('PATCH',`/settings/${policy.id}`,{expectedUpdatedAt:policy.updatedAt,data:{enabled:false}});
        await expect(client.authorizeQaEffect(r.id,r.generation)).rejects.toMatchObject({status:409});
        await browser('POST',`/runs/${r.id}/cancel`,{});await expect(client.authorizeQaEffect(r.id,r.generation)).rejects.toMatchObject({status:409});await client.stopped(r.id,r.generation);
        const seededMaster=await browser('POST',`/projects/${p.id}/messages`,{text:'Verify QA policy authorization',connectionId:connection.id,requestId:randomUUID()});
        expect(seededMaster.run.kind).toBe('master');
        const masterClaim=await client.claim(['master']);
        expect(masterClaim).toBeDefined();
        expect(masterClaim!.run.id).toBe(seededMaster.run.id);
        const master=masterClaim!.run;
        await expect(client.tool(master.id,master.generation,'update_settings',{settingId:policy.id,expectedUpdatedAt:policy.updatedAt,data:{enabled:true}},randomUUID())).rejects.toMatchObject({status:403});
        await client.complete(master.id,master.generation,{});
    });
    it('real HTTP client -> Fastify -> PostgreSQL binds review, merge, immutable receipt and response-loss recovery',async()=>{
        const serverUrl=await app.listen({port:0,host:'127.0.0.1'});
        const browser=async(method:string,path:string,body?:unknown,status=200)=>{const response=await fetch(`${serverUrl}/api/workbench${path}`,{method,headers:{cookie,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const value=await response.json();expect(response.status,JSON.stringify(value)).toBe(status);return value as any;};
        const p=await browser('POST','/projects',{name:'Real HTTP merge proof',repositoryUrl:'https://github.com/org/repo'});
        const owner=await browser('GET','/me');
        const enrolled=await browser('POST','/connectors',{id:`merge-http-${randomUUID()}`,projectIds:[p.id]});
        const client=new WorkbenchConnectorClient({serverUrl,token:enrolled.token},fetch,['gpt-6-luna','gpt-6.1-sol']);
        expect(await client.claim([])).toBeUndefined();
        const connection=await browser('POST','/settings',{kind:'provider',name:'Merge proof host',data:{provider:'openai',method:'codex-host',connectorId:enrolled.id,enabled:true}});
        const w=await browser('POST',`/projects/${p.id}/works`,{title:'HTTP typed review merge',connectionId:connection.id});
        const template=mergeClaim(),op=template.run.operation!,stamp=new Date().toISOString();
        const candidate:Run={...template.run,id:randomUUID(),projectId:p.id,workId:w.id,requestedBy:owner.id,kind:'implementation',operation:undefined,status:'completed',connectorId:enrolled.id,createdAt:stamp,updatedAt:stamp};
        const diff:Artifact={id:randomUUID(),projectId:p.id,workId:w.id,runId:candidate.id,kind:'diff',revision:op.artifactRevision,data:{candidateRevision:op.commitSha,baseRevision:op.baseRevision},createdAt:stamp};
        const savedQa=qaPolicyFixture(p.id,p.repositoryUrl);
        const qaSetting=await browser('POST','/settings',{projectId:p.id,kind:'connection',name:'Explicit project QA policy',data:{provider:'qa',purpose:'qa',url:p.repositoryUrl,coverage:savedQa.coverage,requirements:savedQa.requirements,resource:savedQa.resource}});
        savedQa.id=qaSetting.id;savedQa.version=qaSetting.updatedAt;savedQa.configuredBy=owner.id;candidate.qaPolicySnapshot=savedQa;
        const qa:Artifact={...diff,id:randomUUID(),kind:'qa',data:requiredQaFixture(op.candidateFingerprint,savedQa)};
        const prior:Run={...template.run,id:randomUUID(),projectId:p.id,workId:w.id,requestedBy:owner.id,status:'completed',targetConnectorId:enrolled.id,connectorId:enrolled.id,createdAt:stamp,updatedAt:stamp,operation:{...op,action:'create_draft_pr',actorId:owner.id,candidateRunId:candidate.id,phase:'pr_created',integrationBaseSha:undefined,policySnapshot:undefined,mergeMethod:undefined,external:{...op.external}}};
        for(const [kind,item] of [['run',candidate],['artifact',diff],['artifact',qa],['run',prior]] as const)await sql`INSERT INTO wb_records(id,kind,project_id,data) VALUES (${item.id},${kind},${p.id},${sql.json(item as never)})`;
        const policy=await browser('POST','/settings',{projectId:p.id,kind:'connection',name:'Fixed merge policy',data:{provider:'github',url:p.repositoryUrl,purpose:'delivery',enabled:true,allowDraftPr:true,allowMergePr:true,baseBranch:'main',mergeMethod:'merge',requiredChecks:['Menoteam CI']}});
        await browser('POST',`/projects/${p.id}/messages`,{text:'Assign typed review',connectionId:connection.id,requestId:randomUUID()});
        const master=(await client.claim(['master']))!.run;
        const review=await client.tool(master.id,master.generation,'dispatch',{workId:w.id,prompt:'Review frozen candidate',kind:'review',model:'gpt-6.1-sol'},randomUUID()) as Run;
        expect(review.reviewBinding).toMatchObject({candidateRunId:candidate.id,diffArtifactId:diff.id,qaArtifactIds:[qa.id]});
        await expect(client.tool(master.id,master.generation,'submit_review_result',{disposition:'approved',findings:[],evidenceArtifactIds:[qa.id]},randomUUID())).rejects.toMatchObject({status:403,message:'Assigned review run required'});
        await client.complete(master.id,master.generation,{});
        const assigned=(await client.claim(['review']))!.run;
        const reviewToken=await client.createBridgeToken(assigned.id,assigned.generation);
        const reviewer=new WorkbenchConnectorClient({serverUrl,token:reviewToken.token});
        const result={disposition:'approved',findings:[],evidenceArtifactIds:[qa.id]};
        await expect(reviewer.tool(assigned.id,assigned.generation,'submit_review_result',{...result,evidenceArtifactIds:['forged']},randomUUID())).rejects.toMatchObject({status:403,message:'Review evidence is outside the assigned candidate'});
        expect((await reviewer.tool(assigned.id,assigned.generation,'submit_review_result',result,randomUUID()) as Artifact).kind).toBe('qa');
        await expect(reviewer.tool(assigned.id,assigned.generation,'submit_review_result',{...result,disposition:'changes_requested'},randomUUID())).rejects.toMatchObject({status:409});
        await client.complete(assigned.id,assigned.generation,{});
        const request={priorDeliveryRunId:prior.id,reviewRunId:assigned.id,requestId:randomUUID()};
        await browser('POST',`/works/${w.id}/merge`,{...request,headSha:op.commitSha},400);
        await sql`UPDATE wb_records SET data=jsonb_set(data,'{data,stale}','true') WHERE id=${qa.id}`;
        await browser('POST',`/works/${w.id}/merge`,request,409);
        await sql`UPDATE wb_records SET data=jsonb_set(data,'{data,stale}','false') WHERE id=${qa.id}`;
        const originalQa=qa.data as ReturnType<typeof requiredQaFixture>;
        const invalidQa=[...originalQa.checks.map(check=>({...originalQa,checks:originalQa.checks.filter(c=>c.category!==check.category)})),
          {...originalQa,checks:[{name:'cat passing.log',command:'cat passing.log',exitCode:0,testedRevision:op.candidateFingerprint}]},
          {...originalQa,verification:'unknown'}, {...originalQa,stale:true}, {...originalQa,capturedAt:'invalid'}, {...originalQa,checks:originalQa.checks.map((c,index)=>index===0?{...c,exitCode:1}:c)}, {...originalQa,candidateFingerprint:'f'.repeat(64)}, {...originalQa,checks:originalQa.checks.map(c=>c.category==='postgres'?{...c,metrics:{total:2,passed:1,failed:0,skipped:1}}:c)}];
        for(const invalid of invalidQa){await sql`UPDATE wb_records SET data=jsonb_set(data,'{data}',${sql.json(invalid as never)}) WHERE id=${qa.id}`;await browser('POST',`/works/${w.id}/merge`,request,409);}
        await sql`UPDATE wb_records SET data=jsonb_set(data,'{data}',${sql.json(originalQa as never)}) WHERE id=${qa.id}`;
        await sql`UPDATE wb_records SET data=jsonb_set(data,'{updatedAt}','"2099-01-01T00:00:00.000Z"') WHERE id=${qaSetting.id}`;
        await browser('POST',`/works/${w.id}/merge`,request,409);
        await sql`UPDATE wb_records SET data=jsonb_set(data,'{updatedAt}',${sql.json(savedQa.version)}) WHERE id=${qaSetting.id}`;
        const queued=await browser('POST',`/works/${w.id}/merge`,request);
        expect((await browser('POST',`/works/${w.id}/merge`,{...request,requestId:randomUUID()})).run.id).toBe(queued.run.id);
        const oldToken=process.env.MENOTEAM_GITHUB_TOKEN;process.env.MENOTEAM_GITHUB_TOKEN='fixture-only';
        try {
            let claimed=(await client.claim(['delivery']))!;
            expect(claimed.run.operation).toMatchObject({baseRevision:localBase,integrationBaseSha:base,policySnapshot:{id:policy.id,version:policy.updatedAt,requiredChecks:['Menoteam CI']}});
            await sql`UPDATE wb_records SET data=jsonb_set(data,'{data,resource,database}','"changed_test"') WHERE id=${qaSetting.id}`;
            await expect(client.authorizeDeliveryEffect(claimed.run.id,claimed.run.generation)).rejects.toMatchObject({status:409});
            await sql`UPDATE wb_records SET data=jsonb_set(data,'{data,resource,database}',${sql.json(savedQa.resource!.database)}) WHERE id=${qaSetting.id}`;
            for(const invalid of invalidQa){await sql`UPDATE wb_records SET data=jsonb_set(data,'{data}',${sql.json(invalid as never)}) WHERE id=${qa.id}`;await expect(client.authorizeDeliveryEffect(claimed.run.id,claimed.run.generation)).rejects.toMatchObject({status:409});}
            await sql`UPDATE wb_records SET data=jsonb_set(data,'{data}',${sql.json(originalQa as never)}) WHERE id=${qa.id}`;
            await expect(client.deliveryProgress(claimed.run.id,claimed.run.generation,{phase:'ready_intent',pullRequestNumber:99,pullRequestUrl:'https://github.com/org/repo/pull/99'})).rejects.toMatchObject({status:400});
            await expect(client.deliveryProgress(claimed.run.id,claimed.run.generation,{phase:'merge_intent',baseSha:'f'.repeat(40)})).rejects.toMatchObject({status:400});
            // Persist ready intent then simulate a stopped parent and fresh generation; no repeated ready mutation.
            await client.deliveryProgress(claimed.run.id,claimed.run.generation,{phase:'ready_intent'});
            await sql`UPDATE wb_records SET data=jsonb_set(data,'{status}','"interrupted"') WHERE id=${claimed.run.id}`;
            await client.stopped(claimed.run.id,claimed.run.generation);
            await browser('POST',`/works/${w.id}/merge`,{...request,requestId:randomUUID()});
            claimed=(await client.claim(['delivery']))!;
            const github=mergeFixture({draft:false,loseMergeResponse:true});
            const proof=await mergePullRequest(claimed,async()=>{await client.authorizeDeliveryEffect(claimed.run.id,claimed.run.generation);},github.fetcher,async phase=>{await client.deliveryProgress(claimed.run.id,claimed.run.generation,{phase});});
            expect(github.readyCalls).toBe(0);expect(github.mergeCalls).toBe(1);
            await expect(client.deliveryProgress(claimed.run.id,claimed.run.generation,{phase:'merged',...proof,pullRequestNumber:99})).rejects.toMatchObject({status:409});
            // Authorization revoked after HTTP completed: recording is narrowly allowed for saved intent,
            // same original connector/generation even when lease expired. A fresh effect is forbidden.
            await sql`UPDATE wb_users SET role='member' WHERE id=${owner.id}`;
            await sql`UPDATE wb_records SET data=jsonb_set(jsonb_set(data,'{status}','"interrupted"'),'{leaseUntil}','"2000-01-01T00:00:00Z"') WHERE id=${claimed.run.id}`;
            await expect(client.authorizeDeliveryEffect(claimed.run.id,claimed.run.generation)).rejects.toMatchObject({status:409});
            let lost=false;const lossyClient=new WorkbenchConnectorClient({serverUrl,token:enrolled.token},async(...args)=>{const response=await fetch(...args);if(!lost&&String(args[0]).endsWith('/delivery-progress')&&response.ok){lost=true;throw Error('Fixture response loss after PostgreSQL receipt commit');}return response;});
            await expect(lossyClient.deliveryProgress(claimed.run.id,claimed.run.generation,{phase:'merged',...proof})).rejects.toThrow('response loss');
            const recorded=await client.deliveryProgress(claimed.run.id,claimed.run.generation,{phase:'merged',...proof});
            expect(recorded.artifact.kind).toBe('delivery');expect(recorded.run.operation?.external?.mergeSha).toBe(mergeSha);
            await expect(client.deliveryProgress(claimed.run.id,claimed.run.generation,{phase:'merged',...proof,mergeSha:'f'.repeat(40)})).rejects.toMatchObject({status:409});
            expect((await client.deliveryProgress(claimed.run.id,claimed.run.generation,{phase:'merged',...proof})).run.operation?.external?.mergeSha).toBe(mergeSha);
            await client.complete(claimed.run.id,claimed.run.generation,{});
            expect((await client.readRun(claimed.run.id)).status).toBe('completed');
            await sql`UPDATE wb_users SET role='owner' WHERE id=${owner.id}`;
            // Legitimate refresh is a new candidate + QA + assigned review + immutable receipt;
            // changing only a review or the old saved remote base cannot repair the old operation.
            const identity={head:'7'.repeat(40),base:'8'.repeat(40),number:5,mergeSha:'6'.repeat(40)},freshFingerprint='9'.repeat(64),freshStamp=new Date().toISOString();
            const freshCandidate:Run={...candidate,id:randomUUID(),createdAt:freshStamp,updatedAt:freshStamp};
            const freshDiff:Artifact={...diff,id:randomUUID(),runId:freshCandidate.id,revision:'fresh-diff',data:{candidateRevision:identity.head,baseRevision:localBase},createdAt:freshStamp};
            const freshQa:Artifact={...freshDiff,id:randomUUID(),kind:'qa',data:requiredQaFixture(freshFingerprint,savedQa)};
            const freshPrior:Run={...prior,id:randomUUID(),createdAt:freshStamp,updatedAt:freshStamp,operation:{...prior.operation!,candidateRunId:freshCandidate.id,commitSha:identity.head,candidateFingerprint:freshFingerprint,candidateRevision:'fresh-diff',artifactRevision:'fresh-diff',external:{pullRequestNumber:5,pullRequestUrl:'https://github.com/org/repo/pull/5',pullRequestNodeId:'PR_fixture5',headSha:identity.head,baseSha:identity.base}}};
            for(const [kind,item] of [['run',freshCandidate],['artifact',freshDiff],['artifact',freshQa],['run',freshPrior]] as const)await sql`INSERT INTO wb_records(id,kind,project_id,data) VALUES (${item.id},${kind},${p.id},${sql.json(item as never)})`;
            await browser('POST',`/works/${w.id}/merge`,{...request,requestId:randomUUID()},409);
            const nextMaster=(await client.claim(['master']))!.run;
            const newReview=await client.tool(nextMaster.id,nextMaster.generation,'dispatch',{workId:w.id,prompt:'Review refreshed exact candidate',kind:'review',model:'gpt-6.1-sol'},randomUUID()) as Run;
            expect(newReview.reviewBinding).toMatchObject({candidateRunId:freshCandidate.id,commitSha:identity.head,candidateFingerprint:freshFingerprint,diffArtifactId:freshDiff.id,qaArtifactIds:[freshQa.id]});
            await client.complete(nextMaster.id,nextMaster.generation,{});
            const nextReview=(await client.claim(['review']))!.run;
            await client.tool(nextReview.id,nextReview.generation,'submit_review_result',{disposition:'approved',findings:[],evidenceArtifactIds:[freshQa.id]},randomUUID());
            await client.complete(nextReview.id,nextReview.generation,{});
            const refreshed=await browser('POST',`/works/${w.id}/merge`,{priorDeliveryRunId:freshPrior.id,reviewRunId:nextReview.id,requestId:randomUUID()});
            expect(refreshed.run.id).not.toBe(claimed.run.id);
            const nextClaim=(await client.claim(['delivery']))!,remote=mergeFixture({identity});
            const nextProof=await mergePullRequest(nextClaim,async()=>{await client.authorizeDeliveryEffect(nextClaim.run.id,nextClaim.run.generation);},remote.fetcher,async phase=>{await client.deliveryProgress(nextClaim.run.id,nextClaim.run.generation,{phase});});
            await client.deliveryProgress(nextClaim.run.id,nextClaim.run.generation,{phase:'merged',...nextProof});await client.complete(nextClaim.run.id,nextClaim.run.generation,{});
            expect((await client.readRun(claimed.run.id)).operation?.external).toMatchObject({headSha:op.commitSha,baseSha:base,mergeSha});
            expect(nextProof).toMatchObject({headSha:identity.head,baseSha:identity.base,mergeSha:identity.mergeSha});

        } finally { await sql`UPDATE wb_users SET role='owner' WHERE id=${owner.id}`;if(oldToken===undefined)delete process.env.MENOTEAM_GITHUB_TOKEN;else process.env.MENOTEAM_GITHUB_TOKEN=oldToken; }
    });
 it('freezes a candidate review binding and accepts only one typed review over scoped grants and PostgreSQL',async()=>{
  const p=checkedJson(await user('POST','/projects',{name:'Typed review PG proof',repositoryUrl:'https://github.com/example/typed-review'})) as Project;
  const owner=checkedJson(await user('GET','/me'));
  const enrolled=await enrollProvider(`typed-review-${randomUUID()}`,[p.id]);
  const w=checkedJson(await user('POST',`/projects/${p.id}/works`,{title:'Review exact candidate',connectionId:fixtureConnections.get(enrolled.id)})) as Work;
  const connectorAuth={authorization:`Bearer ${enrolled.token}`};
  const connectorRequest=(path:string,payload:unknown)=>app.inject({method:'POST',url:`/api/workbench/connector${path}`,headers:connectorAuth,payload:connectorFixturePayload(path,payload) as never});
  const candidateId=randomUUID(),commit='a'.repeat(40),base='b'.repeat(40),revision='diff-typed-review',fingerprint='c'.repeat(64);
  const candidate:Run={id:candidateId,projectId:p.id,workId:w.id,prompt:'candidate',requestedBy:owner.id,kind:'implementation',model:'gpt-6-luna',reasoning:'medium',status:'completed',connectorId:enrolled.id,generation:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  const diff:Artifact={id:'typed-diff',projectId:p.id,workId:w.id,runId:candidateId,kind:'diff',revision,data:{candidateRevision:commit,baseRevision:base},createdAt:new Date().toISOString()};
  const qa:Artifact={id:'typed-qa',projectId:p.id,workId:w.id,runId:candidateId,kind:'qa',revision,data:{candidateFingerprint:fingerprint,checks:[{name:'unit',exitCode:0,testedRevision:fingerprint}],stale:false},createdAt:new Date().toISOString()};
  await sql`INSERT INTO wb_records(id,kind,project_id,data) VALUES (${candidate.id},'run',${p.id},${sql.json(candidate as never)}),(${diff.id},'artifact',${p.id},${sql.json(diff as never)}),(${qa.id},'artifact',${p.id},${sql.json(qa as never)})`;
  await user('POST',`/projects/${p.id}/messages`,{text:'Assign exact review',requestId:'typed-review-pg-master'});
  const master=checkedJson(await connectorRequest('/claim',{capabilities:{runKinds:['master']}})).run as Run;
  const masterGrant=checkedJson(await connectorRequest(`/runs/${master.id}/bridge-token`,{generation:master.generation})).token;
  const masterTool=(action:string,input:unknown,requestId:string)=>app.inject({method:'POST',url:`/api/workbench/connector/runs/${master.id}/tools`,headers:{authorization:`Bearer ${masterGrant}`},payload:{generation:master.generation,action,input,requestId} as never});
  expect((await masterTool('request_merge',{priorDeliveryRunId:'delivery-placeholder',reviewRunId:'review-placeholder',requestId:'merge-forged-scope',workId:w.id},'merge-forged-scope-tool')).statusCode).toBe(400);
  const dispatched=checkedJson(await masterTool('dispatch',{workId:w.id,prompt:'Review candidate',kind:'review',model:'gpt-6.1-sol'},'dispatch-typed-review')) as Run;
  expect(dispatched.reviewBinding).toMatchObject({candidateRunId:candidateId,commitSha:commit,candidateFingerprint:fingerprint,diffRevision:revision,qaArtifactIds:['typed-qa']});
  expect((await masterTool('submit_review_result',{disposition:'approved',findings:[],evidenceArtifactIds:['typed-qa']},'master-forged-review')).statusCode).toBe(403);
  const review=checkedJson(await connectorRequest('/claim',{capabilities:{runKinds:['review']}})).run as Run;
  const reviewGrant=checkedJson(await connectorRequest(`/runs/${review.id}/bridge-token`,{generation:review.generation})).token;
  const reviewTool=(input:unknown,requestId:string)=>app.inject({method:'POST',url:`/api/workbench/connector/runs/${review.id}/tools`,headers:{authorization:`Bearer ${reviewGrant}`},payload:{generation:review.generation,action:'submit_review_result',input,requestId} as never});
  const submission={disposition:'approved',findings:[],evidenceArtifactIds:['typed-qa']};
  expect(checkedJson(await reviewTool(submission,'review-first')).kind).toBe('qa');
  expect(checkedJson(await reviewTool(submission,'review-retry')).kind).toBe('qa');
  expect((await reviewTool({...submission,disposition:'changes_requested'},'review-conflict')).statusCode).toBe(409);
  expect((await reviewTool({...submission,evidenceArtifactIds:['forged-other-project-artifact']},'review-evidence-mismatch')).statusCode).toBe(403);
  expect((await connectorRequest(`/runs/${review.id}/artifacts`,{generation:review.generation,kind:'qa',revision,data:{reviewDisposition:'approved'},requestId:'forged-generic'})).statusCode).toBe(403);
  expect((await connectorRequest(`/runs/${review.id}/artifacts`,{generation:review.generation,kind:'qa',revision,data:{typedReview:{disposition:'approved',reviewerRunId:review.id}},requestId:'forged-nested-review'})).statusCode).toBe(403);
  expect((await connectorRequest(`/runs/${review.id}/complete`,{generation:review.generation})).statusCode).toBe(200);
  const saved=await sql`SELECT count(*)::int AS count FROM wb_records WHERE kind='artifact' AND data->>'runId'=${review.id} AND data->'data' ? 'typedReview'`;
  expect(saved[0]!.count).toBe(1);
 });
    it('Master partial Work updates preserve omitted overview/status and allow explicit clearing',async()=>{
        const p=checkedJson((await user('POST','/projects',{name:'Partial Work update proof'})));
        const credential=(await enrollProvider('partial-work-connector',[p.id])).token;
        const work=checkedJson((await user('POST',`/projects/${p.id}/works`,{title:'Preserve definition',overview:'Original task definition',sources:['source:original']})));
        await user('POST',`/projects/${p.id}/messages`,{text:'Update only current progress',requestId:'partial-work-master'});
        const send=(path:string,payload:unknown)=>app.inject({method:'POST',url:'/api/workbench/connector'+path,headers:{authorization:`Bearer ${credential}`},payload:connectorFixturePayload(path,payload) as never});
        const run=checkedJson((await send('/claim',{}))).run;
        const tool=(input:unknown)=>send(`/runs/${run.id}/tools`,{generation:run.generation,action:'update_work',input,requestId:crypto.randomUUID()});
        const progress=await tool({workId:work.id,revision:work.revision,status:'in_progress'});
        expect(progress.statusCode).toBe(200);
        expect(checkedJson(progress).overview).toBe('Original task definition');
        expect(checkedJson(progress).sources).toEqual(['source:original']);
        expect(checkedJson((await user('GET',`/works/${work.id}`))).work.overview).toBe('Original task definition');
        const definition=await tool({workId:work.id,revision:checkedJson(progress).revision,overview:'Updated task definition'});
        expect(definition.statusCode).toBe(200);
        expect(checkedJson(definition).status).toBe('in_progress');
        const browser=await user('PATCH',`/works/${work.id}`,{revision:checkedJson(definition).revision,status:'paused'});
        expect(checkedJson(browser).overview).toBe('Updated task definition');
        const cleared=await tool({workId:work.id,revision:checkedJson(browser).revision,overview:''});
        expect(checkedJson(cleared).overview).toBe('');
        expect(checkedJson(cleared).status).toBe('paused');
        const persisted=checkedJson((await user('GET',`/works/${work.id}`))).work;
        expect(persisted.overview).toBe('');
        expect(persisted.status).toBe('paused');
        expect(persisted.sources).toEqual(['source:original']);
    });
    it('rejects credential-bearing source and settings URLs before any external fetch',async()=>{
        for(const url of ['https://secret@github.com/blossomsai/menoteam','https://github.com/blossomsai/menoteam?token=secret','http://github.com/blossomsai/menoteam']) {
            const result=await user('POST','/settings',{kind:'connection',name:'Unsafe metadata',projectId,data:{provider:'github',url}});
            expect(result.statusCode).toBe(400);
        }
        expect((await user('POST','/settings',{kind:'skill',name:'Unsafe skill source',projectId,data:{content:'Instructions',sourceUrl:'https://secret@github.com/o/r/blob/main/SKILL.md'}})).statusCode).toBe(400);
        expect((await user('POST',`/projects/${projectId}/sources/github`,{url:'https://secret@github.com/blossomsai/menoteam/issues/1'})).statusCode).toBe(400);
        expect((await user('POST',`/projects/${projectId}/skills/import`,{url:'https://secret@github.com/o/r/blob/main/SKILL.md'})).statusCode).toBe(400);
    });
    it('workspace profiles reject project skill references on create/update and work across projects',async()=>{
        const a=(await user('POST','/projects',{name:'Profile scope A'})).json();
        const b=(await user('POST','/projects',{name:'Profile scope B'})).json();
        const scoped=(await user('POST','/settings',{kind:'skill',projectId:a.id,name:'Private project instructions',data:{content:'Only project A'}})).json();
        const global=(await user('POST','/settings',{kind:'skill',name:'Reusable instructions',data:{content:'All authorized Projects'}})).json();
        const rejected=await user('POST','/settings',{kind:'profile',name:'Unsafe shared profile',data:{skillIds:[scoped.id]}});
        expect(rejected.statusCode).toBe(400);
        expect(rejected.json().message).toContain(scoped.id);
        expect((await user('POST','/settings',{kind:'profile',name:'Missing skill',data:{skillIds:['missing-skill']}})).statusCode).toBe(400);
        const profile=(await user('POST','/settings',{kind:'profile',name:'Reusable profile',data:{model:'gpt-6-luna',reasoning:'medium',skillIds:[global.id]}})).json();
        const badPatch=await user('PATCH',`/settings/${profile.id}`,{expectedUpdatedAt:profile.updatedAt,data:{skillIds:[scoped.id]}});
        expect(badPatch.statusCode).toBe(400);
        const persisted=(await user('GET','/snapshot')).json().settings.find((setting:any)=>setting.id===profile.id);
        expect(persisted.data.skillIds).toEqual([global.id]);
        for(const project of [a,b]) {
            await enrollProvider(`shared-profile-${project.id}`,[project.id]);
            const work=(await user('POST',`/projects/${project.id}/works`,{title:'Use the shared profile',profileId:profile.id})).json();
            const dispatched=await user('POST',`/projects/${project.id}/messages`,{workId:work.id,text:'Use reusable instructions',requestId:`shared-profile-${project.id}`});
            expect(dispatched.statusCode).toBe(200);
            expect(dispatched.json().run.execution.skills).toEqual([
                {id:global.id,name:'Reusable instructions',content:'All authorized Projects',contentSha256:createHash('sha256').update('All authorized Projects').digest('hex')},
                ...(project.id===a.id?[{id:scoped.id,name:scoped.name,content:'Only project A',contentSha256:createHash('sha256').update('Only project A').digest('hex')}]:[])
            ]);
        }
    });
    it("survives service restart", async () => {
        const before=(await user("GET","/snapshot")).json();
        await app.close();
        app = await createWorkbenchApp({
            sql
        });
        const snap = await user("GET", "/snapshot");
        expect(snap.json().projects.map((p:any)=>p.id).sort()).toEqual(before.projects.map((p:any)=>p.id).sort());
        expect(snap.json().messages.length).toBeGreaterThan(1);
    });
    it('isolated PostgreSQL persists >1 MiB cross-generation chunks and verifies member/reviewer pages without fencing renewal',async(context)=>{
        let phase='setup';
        context.onTestFailed(()=>{console.error(`[large persisted diff fixture] last phase: ${phase}`);});
        const p=checkedJson(await user('POST','/projects',{name:'Large persisted diff fixture'}));
        const enrolled=await enrollProvider(`large-diff-${randomUUID()}`,[p.id]);
        const work=checkedJson(await user('POST',`/projects/${p.id}/works`,{title:'Large file upload'}));
        const queued=checkedJson(await user('POST',`/projects/${p.id}/messages`,{workId:work.id,text:'Capture this fixture',requestId:randomUUID()}));
        const serverUrl=await app.listen({port:0,host:'127.0.0.1'});let dropAck=true;const postBytes:number[]=[];
        const client=new WorkbenchConnectorClient({serverUrl,token:enrolled.token},async(input,init)=>{
            const artifact=String(input).endsWith('/artifacts')?JSON.parse(String(init?.body)):undefined;
            if(artifact){const length=Buffer.byteLength(String(init?.body));postBytes.push(length);expect(length).toBeLessThan(1048576);}
            const response=await fetch(input,init);
            if(dropAck&&artifact?.kind==='diff_file_chunk'&&artifact.data.chunkIndex===0&&response.ok){dropAck=false;return discardPersistedChunkAck(response);}
            return response;
        },['gpt-6-luna','gpt-6.1-sol']);
        const claim=await client.claim(['implementation']);expect(claim?.run.id).toBe(queued.run.id);let run=claim!.run;
        const baseRevision='a'.repeat(40),candidateRevision='b'.repeat(40),revision=createHash('sha256').update(baseRevision).update('\0').update(candidateRevision).digest('hex'),filePath='src/雪 space\tline\n.ts';
        const unit='+quote " slash \\ tab\t 雪🙂\n',parts=Array.from({length:7},(_,index)=>Buffer.from((index===0?'@@ -0,0 +1,56000 @@\n':'')+unit.repeat(8000)));
        const fileBytes=parts.reduce((total,part)=>total+part.length,0),manifestHash=createHash('sha256');for(const part of parts){expect(part.length).toBeLessThanOrEqual(256*1024);manifestHash.update(part);}const fileSha256=manifestHash.digest('hex');expect(fileBytes).toBeGreaterThan(1048576);
        let parent=await client.addArtifact(run.id,run.generation,{kind:'diff',revision,requestId:`diff:${run.id}:${run.generation}`,data:{baseRevision,candidateRevision,diffFileChunksVersion:1,totalFiles:1,additions:56000,deletions:0,truncated:true,patch:'bounded preview',files:[{path:filePath,status:'added',binary:false,additions:56000,deletions:0,chunkCount:parts.length,textBytes:fileBytes,fileSha256}]}});
        let legacyIds=true;const payload=(index:number)=>({kind:'diff_file_chunk' as const,revision,requestId:`diff-file:${legacyIds?candidateRevision:createHash('sha256').update(parent.id).digest('hex')}:${createHash('sha256').update(filePath).digest('hex')}:${index}`,data:{parentArtifactId:parent.id,projectId:p.id,workId:work.id,runId:run.id,baseRevision,candidateRevision,diffRevision:revision,path:filePath,chunkIndex:index,chunkCount:parts.length,fileByteLength:fileBytes,fileSha256,chunkSha256:createHash('sha256').update(parts[index]!).digest('hex'),contentBase64:parts[index]!.toString('base64')}});
        const count=async()=>Number((await sql`SELECT count(*)::int AS count FROM wb_records WHERE kind='artifact' AND project_id=${p.id} AND data->>'kind'='diff_file_chunk' AND data->'data'->>'parentArtifactId'=${parent.id}`)[0]!.count);
        phase='persisted chunk ACK loss and replay';
        await expect(client.addArtifact(run.id,run.generation,payload(0))).rejects.toThrow('Fixture ACK loss');expect(await count()).toBe(1);
        const retry=await client.addArtifact(run.id,run.generation,payload(0));expect(retry.id).toBe(`artifact:${run.id}:${payload(0).requestId}`);expect(await count()).toBe(1);
        expect((await client.addArtifact(run.id,run.generation,payload(0))).id).toBe(retry.id);expect(await count()).toBe(1);
        const changed=Buffer.from('different bytes\n');await expect(client.addArtifact(run.id,run.generation,{...payload(0),data:{...payload(0).data,contentBase64:changed.toString('base64'),chunkSha256:createHash('sha256').update(changed).digest('hex')}})).rejects.toMatchObject({status:409});expect(await count()).toBe(1);
        const query=new URLSearchParams({path:filePath,revision});const partial=await fetch(`${serverUrl}/api/workbench/artifacts/${encodeURIComponent(parent.id)}/diff-file?${query}`,{headers:{cookie}});expect(partial.status).toBe(200);expect(await partial.json()).toMatchObject({complete:false,incomplete:true});
        phase='cross-generation resume and upload';
        const oldParent=parent,oldRequest=payload(0),oldGeneration=run.generation;
        expect((await user('POST',`/runs/${run.id}/pause`,{})).statusCode).toBe(200);
        await client.stopped(run.id,run.generation,'cross-generation-thread');
        expect((await user('POST',`/runs/${run.id}/resume`,{})).statusCode).toBe(200);
        run=(await client.claim(['implementation']))!.run;expect(run.generation).toBe(oldGeneration+1);
        parent=await client.addArtifact(run.id,run.generation,{kind:'diff',revision,requestId:`diff:${run.id}:${run.generation}`,data:oldParent.data});
        legacyIds=false;expect(parent.id).not.toBe(oldParent.id);expect(payload(0).requestId).not.toBe(oldRequest.requestId);
        await client.addArtifact(run.id,run.generation,payload(0));expect(await count()).toBe(1);
        expect((await client.addArtifact(run.id,run.generation,payload(0))).id).toBe(`artifact:${run.id}:${payload(0).requestId}`);expect(await count()).toBe(1);
        expect((await sql`SELECT data FROM wb_records WHERE id=${retry.id}`)[0]!.data.data).toEqual(oldRequest.data);
        for(let index=1;index<parts.length;index++)await client.addArtifact(run.id,run.generation,payload(index));expect(await count()).toBe(parts.length);
        phase='latest diff indexed lookup and persisted metadata';
        const artifactStore=new WorkbenchStore(sql);
        // Actual latestWorkDiff SQL, with enough project-local payload rows to expose a project scan.
        await sql`INSERT INTO wb_records(id,kind,project_id,data)
            SELECT ${p.id}||':unrelated-chunk:'||n,'artifact',${p.id},jsonb_build_object('id',${p.id}||':unrelated-chunk:'||n,'projectId',${p.id}::text,'workId',${work.id}::text,'kind','diff_file_chunk','data',jsonb_build_object('contentBase64',repeat('eA==',1024))) FROM generate_series(1,10000) n`;
        await sql`ANALYZE wb_records`;
        let explained=false;
        const explainSql=new Proxy(sql,{apply(target,thisArg,args){
            const query=(args[0] as TemplateStringsArray).map((text,index)=>text+(index<args.length-1?`$${index+1}`:'')).join('');
            return (async()=>{
                const plans=await sql.unsafe('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+query,args.slice(1));
                const nodes:any[]=[];const visit=(node:any)=>{nodes.push(node);for(const child of node.Plans??[])visit(child);};visit(plans[0]!['QUERY PLAN'][0].Plan);
                expect(nodes.some(node=>node['Index Name']==='wb_records_latest_work_diff_idx')).toBe(true);
                expect(nodes.some(node=>node['Node Type']==='Sort'||node['Relation Name']==='wb_records'&&node['Node Type']==='Seq Scan')).toBe(false);
                const index=nodes.find(node=>node['Index Name']==='wb_records_latest_work_diff_idx');expect(index['Actual Rows']).toBeLessThanOrEqual(1);expect(index['Index Cond']).toContain('project_id');expect(index['Index Cond']).toContain('workId');
                explained=true;return Reflect.apply(target,thisArg,args);
            })();
        }});
        expect((await artifactStore.latestWorkDiff(p.id,work.id,explainSql))!.id).toBe(parent.id);expect(explained).toBe(true);
        for(const artifacts of [await artifactStore.list<Artifact>('artifact',p.id),await artifactStore.list<Artifact>('artifact'),await artifactStore.transaction(p.id,tx=>artifactStore.list<Artifact>('artifact',p.id,tx))]){
            expect(artifacts.some(item=>item.id===parent.id)).toBe(true);
            expect(artifacts.some(item=>item.kind==='diff_file_chunk')).toBe(false);
        }
        expect(await count()).toBe(parts.length);
        const saved=(await sql`SELECT data FROM wb_records WHERE id=${parent.id} AND kind='artifact'`)[0]!.data;expect(saved.data.files[0]).toMatchObject({path:filePath,textBytes:fileBytes,fileSha256,chunkCount:parts.length});
        // Restart the reader with the same PostgreSQL store; no Connector is used for the offline reads.
        phase='restart offline reader';
        await app.close();app=await createWorkbenchApp({sql,sourceFetcher:(...args)=>sourceFetch(...args)});const readerUrl=await app.listen({port:0,host:'127.0.0.1'});
        const owner=await fetch(`${readerUrl}/api/workbench/me`,{headers:{cookie}});expect(owner.status).toBe(200);expect(await owner.json()).toMatchObject({role:'owner'});
        let cursor:string|undefined,total=0;const seen=new Set<string>(),reconstructed=createHash('sha256');
        phase='offline member page reconstruction';
        for(let index=0;index<parts.length;index++){
            const parameters=new URLSearchParams({path:filePath,revision,...(cursor?{cursor}:{})});const response=await fetch(`${readerUrl}/api/workbench/artifacts/${encodeURIComponent(parent.id)}/diff-file?${parameters}`,{headers:{cookie}});expect(response.status).toBe(200);const page=await response.json() as any;
            const bytes=Buffer.from(page.contentBase64,'base64');expect(bytes.equals(parts[index]!)).toBe(true);reconstructed.update(bytes);total+=bytes.length;expect(page.fileSha256).toBe(fileSha256);expect(page.chunkIndex).toBe(index);expect(page.complete).toBe(index===parts.length-1);expect(page.integrity).toBe(index===parts.length-1?'verified':'pending');
            if(index<parts.length-1){expect(typeof page.nextCursor).toBe('string');expect(seen.has(page.nextCursor)).toBe(false);seen.add(page.nextCursor);cursor=page.nextCursor;}else expect(page.nextCursor).toBeNull();
        }
        expect(total).toBe(fileBytes);expect(reconstructed.digest('hex')).toBe(fileSha256);expect(postBytes.every(length=>length<1048576)).toBe(true);
        // Gate a real PostgreSQL verification batch outside the mutation transaction.
        // Renewal must finish before the gate is released, for both HTTP readers.
        phase='restart renewal-gated reader';
        await app.close();let reached:()=>void=()=>{},release:()=>void=()=>{},barrier:Promise<void>|undefined;
        let gate=false,batchQueries=0;const sqlProxy=new Proxy(sql,{apply(target,thisArg,args){
            const query=(args[0] as TemplateStringsArray).join('?');
            if(query.startsWith('SELECT id,project_id,data FROM wb_records WHERE id=ANY')&&(args[1] as string[]).length>2){
                expect((args[1] as string[]).length).toBeLessThanOrEqual(8);
                batchQueries++;expect(query).not.toContain('decode(');
                if(gate){gate=false;reached();return (async()=>{await barrier;return Reflect.apply(target,thisArg,args);})();}
            }
            expect(query.includes('sum(octet_length(decode(')).toBe(false);
            return Reflect.apply(target,thisArg,args);
        }});
        app=await createWorkbenchApp({sql:sqlProxy,sourceFetcher:(...args)=>sourceFetch(...args)});
        const send=(path:string,payload:unknown)=>app.inject({method:'POST',url:'/api/workbench/connector'+path,headers:{authorization:`Bearer ${enrolled.token}`},payload:connectorFixturePayload(path,payload) as never});
        const otherWork=checkedJson(await user('POST',`/projects/${p.id}/works`,{title:'Unrelated lease renewal'}));
        checkedJson(await user('POST',`/projects/${p.id}/messages`,{workId:otherWork.id,text:'Unrelated control',requestId:randomUUID()}));
        const otherRun=checkedJson(await send('/claim',{capabilities:{runKinds:['implementation']}})).run;
        const finalCursor=Buffer.from(JSON.stringify([parent.id,revision,filePath,parts.length-1])).toString('base64url');
        const memberRead=()=>app.inject({method:'GET',url:`/api/workbench/artifacts/${encodeURIComponent(parent.id)}/diff-file`,headers:{cookie},query:{path:filePath,revision,cursor:finalCursor}});
        const whileReading=async(read:()=>ReturnType<typeof app.inject>,renewRun:Run,mutate?:()=>Promise<unknown>)=>{
            const started=new Promise<void>(resolve=>{reached=resolve;});barrier=new Promise<void>(resolve=>{release=resolve;});gate=true;
            const before=batchQueries;const response=read();
            try{
                await Promise.race([started,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Verification batch was not reached')),2000))]);
                const renewed=await Promise.race([send(`/runs/${renewRun.id}/renew`,{generation:renewRun.generation}),new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('Renewal fenced by diff verification')),2000))]);
                expect(renewed.statusCode,renewed.body).toBe(200);if(mutate)await mutate();
            }finally{release();}
            const result=await response;expect(batchQueries-before).toBe(Math.ceil(parts.length/4));return result;
        };
        phase='member verification with concurrent renewal';
        const memberPage=await whileReading(memberRead,otherRun);expect(memberPage.statusCode,memberPage.body).toBe(200);expect(memberPage.json().integrity).toBe('verified');
        const staleParent={...parent,id:parent.id+':newer',createdAt:new Date().toISOString()};
        const staleMember=await whileReading(memberRead,otherRun,()=>new WorkbenchStore(sql).put('artifact',staleParent));expect(staleMember.statusCode).toBe(409);
        await sql`DELETE FROM wb_records WHERE id=${staleParent.id}`;
        phase='dispatch and claim reviewer';
        checkedJson(await send(`/runs/${run.id}/artifacts`,{generation:run.generation,kind:'qa',revision,requestId:'fixture-review-evidence',data:{candidateFingerprint:'c'.repeat(64),checks:[],stale:false}}));
        checkedJson(await send(`/runs/${run.id}/complete`,{generation:run.generation,threadId:'cross-generation-thread'}));
        const master=checkedJson(await send('/claim',{})).run;
        const review=checkedJson(await send(`/runs/${master.id}/tools`,{generation:master.generation,action:'dispatch',input:{workId:work.id,kind:'review',model:'gpt-6.1-sol',prompt:'Review immutable diff'},requestId:randomUUID()}));
        checkedJson(await send(`/runs/${master.id}/complete`,{generation:master.generation,threadId:'master-thread'}));
        const reviewer=checkedJson(await send('/claim',{capabilities:{runKinds:['review']}})).run;expect(reviewer.id).toBe(review.id);
        const reviewerRead=()=>send(`/runs/${reviewer.id}/tools`,{generation:reviewer.generation,action:'read_diff_file',input:{diffArtifactId:parent.id,revision,path:filePath,cursor:finalCursor},requestId:randomUUID()});
        phase='reviewer verification with concurrent renewal';
        const reviewPage=await whileReading(reviewerRead,otherRun);expect(reviewPage.statusCode,reviewPage.body).toBe(200);expect(reviewPage.json().integrity).toBe('verified');
        phase='reviewer replay journal and request collisions';
        const collisionId=randomUUID(),scope=`tools:${reviewer.id}`,priorAction={id:'immutable-prior-action'};
        await sql`INSERT INTO wb_requests(scope,request_id,result) VALUES (${scope},${collisionId},${sql.json(priorAction)})`;
        const readWithId=(requestId:string,path=filePath)=>send(`/runs/${reviewer.id}/tools`,{generation:reviewer.generation,action:'read_diff_file',input:{diffArtifactId:parent.id,revision,path,cursor:finalCursor},requestId});
        expect((await readWithId(collisionId)).statusCode).toBe(409);expect((await sql`SELECT result FROM wb_requests WHERE scope=${scope} AND request_id=${collisionId}`)[0]!.result).toEqual(priorAction);
        const retryId=randomUUID();expect((await readWithId(retryId)).statusCode).toBe(200);expect((await readWithId(retryId)).statusCode).toBe(200);expect((await readWithId(retryId,'wrong/path')).statusCode).toBe(409);
        expect(Number((await sql`SELECT count(*) AS count FROM wb_requests WHERE scope=${scope} AND request_id=${retryId}`)[0]!.count)).toBe(1);
        const journalBytes=async()=>(await sql`SELECT result::text AS bytes FROM wb_requests WHERE scope=${scope} AND request_id=${retryId}`)[0]!.bytes;
        const savedJournal=await journalBytes();
        const genericRead=(action:string,input:Record<string,unknown>,requestId=retryId)=>send(`/runs/${reviewer.id}/tools`,{generation:reviewer.generation,action,input,requestId});
        const reverseCollision=async(action:string,input:Record<string,unknown>)=>{
            const response=await genericRead(action,input);expect(response.statusCode,response.body).toBe(409);
            expect(response.body).not.toContain('contentBase64');expect(response.body).not.toContain('__diffFileReadRequest');expect(await journalBytes()).toBe(savedJournal);
        };
        await reverseCollision('read_run',{runId:run.id});await reverseCollision('read_work',{workId:work.id});
        const plainRetry=await readWithId(retryId);expect(plainRetry.statusCode,plainRetry.body).toBe(200);expect(plainRetry.json().integrity).toBe('verified');expect(plainRetry.json()).not.toHaveProperty('__diffFileReadRequest');expect(await journalBytes()).toBe(savedJournal);
        const plainRun=await genericRead('read_run',{runId:run.id},randomUUID());expect(plainRun.statusCode,plainRun.body).toBe(200);expect(plainRun.json().run.id).toBe(run.id);expect(plainRun.json().artifacts.some((artifact:any)=>artifact.kind==='qa'&&artifact.revision===revision)).toBe(true);expect(plainRun.body).not.toContain('contentBase64');
        await new WorkbenchStore(sql).put('artifact',staleParent);
        await reverseCollision('read_run',{runId:run.id});await reverseCollision('read_work',{workId:work.id});
        expect((await readWithId(retryId)).statusCode).toBe(409);expect(await journalBytes()).toBe(savedJournal);
        const newerRun=await genericRead('read_run',{runId:run.id},randomUUID());expect(newerRun.statusCode,newerRun.body).toBe(200);expect(newerRun.json().run).toEqual(plainRun.json().run);expect(newerRun.json().artifacts.some((artifact:any)=>artifact.kind==='qa'&&artifact.revision===revision)).toBe(true);expect(newerRun.body).not.toContain('contentBase64');
        await sql`DELETE FROM wb_records WHERE id=${staleParent.id}`;
        phase='reviewer binding and generation invalidation';
        const stale=await whileReading(reviewerRead,otherRun,async()=>{await sql`UPDATE wb_records SET data=jsonb_set(data,'{reviewBinding,commitSha}',${sql.json('e'.repeat(40))}) WHERE id=${reviewer.id}`;});expect(stale.statusCode).toBe(409);
        await sql`UPDATE wb_records SET data=jsonb_set(data,'{reviewBinding,commitSha}',${sql.json(candidateRevision)}) WHERE id=${reviewer.id}`;
        const revoked=await whileReading(reviewerRead,otherRun,async()=>{await sql`UPDATE wb_records SET data=jsonb_set(data,'{generation}',${sql.json(reviewer.generation+1)}) WHERE id=${reviewer.id}`;});expect(revoked.statusCode).toBe(409);
        phase='missing and corrupt persisted chunk evidence';
        // Legacy IDs remain readable, but missing storage/metadata or hash corruption cannot verify.
        await sql`DELETE FROM wb_records WHERE kind='artifact' AND data->'data'->>'parentArtifactId'=${parent.id} AND data->'data'->>'chunkIndex'='1'`;
        const incomplete=await memberRead();expect(incomplete.statusCode).toBe(200);expect(incomplete.json().integrity).toBe('incomplete');
        await sql`UPDATE wb_records SET data=jsonb_set(data,'{data,chunkSha256}',${sql.json('0'.repeat(64))}) WHERE kind='artifact' AND data->'data'->>'parentArtifactId'=${parent.id}`;
        expect((await memberRead()).json()).toMatchObject({complete:false,incomplete:true});
        await sql`UPDATE wb_records SET data=data #- '{data,files,0,fileSha256}' WHERE id=${parent.id}`;expect((await memberRead()).json()).toMatchObject({complete:false,incomplete:true});
    },20000);

});

describe.skipIf(!url)('Real PostgreSQL authenticated rate budgets',()=>{
 let sql:ReturnType<typeof postgres>;
 let app:Awaited<ReturnType<typeof createWorkbenchApp>>;
 const suffix=randomUUID(), owner=`rate-${suffix}@example.invalid`;
 const connectorIds=[`rate-a-${suffix}`,`rate-b-${suffix}`];
 const tokens=[randomUUID(),randomUUID()];
 let cookie='';
 beforeAll(async()=>{
  const location=new URL(url!);
  if(!['localhost','127.0.0.1'].includes(location.hostname)||!location.pathname.endsWith('_test'))throw Error('Loopback *_test database required');
  sql=postgres(url!);
  app=await createWorkbenchApp({sql,bootstrapEmail:owner,bootstrapPassword:'rate-limit-test-password'});
  const login=await app.inject({method:'POST',url:'/api/workbench/session',payload:{email:owner,password:'rate-limit-test-password'}});
  expect(login.statusCode).toBe(200);cookie=String(login.headers['set-cookie']).split(';')[0]!;
  for(let i=0;i<2;i++)await sql`INSERT INTO wb_connectors(id,digest,project_ids) VALUES (${connectorIds[i]!},${digest(tokens[i]!)},'[]'::jsonb)`;
 });
 afterAll(async()=>{
  await app?.close();
  if(sql){await sql`DELETE FROM wb_connectors WHERE id=ANY(${connectorIds})`;await sql`DELETE FROM wb_sessions WHERE user_id IN (SELECT id FROM wb_users WHERE email=${owner})`;await sql`DELETE FROM wb_users WHERE email=${owner}`;await sql.end();}
 });
 it('two connectors and a member share an egress without sharing their 180-request budgets',async()=>{
  for(let n=0;n<100;n++){
   for(const token of tokens){const r=await app.inject({method:'POST',url:'/api/workbench/connector/claim',headers:{authorization:`Bearer ${token}`},payload:{}});expect(r.statusCode).toBe(204);}
   expect((await app.inject({url:'/api/workbench/me',headers:{cookie}})).statusCode).toBe(200);
  }
  for(let n=100;n<180;n++)expect((await app.inject({method:'POST',url:'/api/workbench/connector/claim',headers:{authorization:`Bearer ${tokens[0]}`},payload:{}})).statusCode).toBe(204);
  expect((await app.inject({method:'POST',url:'/api/workbench/connector/claim',headers:{authorization:`Bearer ${tokens[0]}`},payload:{}})).statusCode).toBe(429);
  expect((await app.inject({url:'/api/workbench/me',headers:{cookie}})).statusCode).toBe(200);
 });
 it('login remains IP-limited despite valid cookies and rotating supplied bearer credentials',async()=>{
  for(let n=0;n<10;n++)expect((await app.inject({method:'POST',url:'/api/workbench/session',remoteAddress:'127.0.0.21',headers:{cookie,authorization:`Bearer ${randomUUID()}`},payload:{email:owner,password:'wrong'}})).statusCode).toBe(401);
  expect((await app.inject({method:'POST',url:'/api/workbench/session',remoteAddress:'127.0.0.21',headers:{cookie},payload:{email:owner,password:'rate-limit-test-password'}})).statusCode).toBe(429);
 });
 it('invalid and revoked credentials cannot partition the anonymous IP budget',async()=>{
  await sql`DELETE FROM wb_connectors WHERE id=${connectorIds[1]!}`;
  for(let n=0;n<180;n++)expect((await app.inject({method:'POST',url:'/api/workbench/connector/claim',remoteAddress:'127.0.0.22',headers:{cookie,authorization:`Bearer ${n%2?tokens[1]:randomUUID()}`},payload:{}})).statusCode).toBe(401);
  expect((await app.inject({method:'POST',url:'/api/workbench/connector/claim',remoteAddress:'127.0.0.22',headers:{authorization:`Bearer ${randomUUID()}`},payload:{}})).statusCode).toBe(429);
 });
 it('rotating bridge grants share the connector identity and revoked actors lose that identity',async()=>{
  const actor=(await sql`SELECT id FROM wb_users WHERE email=${owner}`)[0]!.id;
  const projectId=`rate-project-${suffix}`, runId=`rate-run-${suffix}`;
  const grants=[randomUUID(),randomUUID()];
  const bridgeConnector=`rate-bridge-${suffix}`, bridgeEnrollment=randomUUID();
  connectorIds.push(bridgeConnector);
  await sql`INSERT INTO wb_connectors(id,digest,project_ids) VALUES (${bridgeConnector},${digest(bridgeEnrollment)},${sql.json([projectId])})`;
  const run={id:runId,projectId,connectorId:bridgeConnector,requestedBy:actor,generation:1,status:'running',leaseUntil:new Date(Date.now()+60000).toISOString()};
  await sql`INSERT INTO wb_records(id,kind,project_id,data) VALUES (${runId},'run',${projectId},${sql.json(run)})`;
  for(const raw of grants)await sql`INSERT INTO wb_bridge_tokens(digest,run_id,generation,expires_at) VALUES (${digest(raw)},${runId},1,now()+interval '1 minute')`;
  const key=rateLimitKey(sql);
  const req=(raw:string)=>({ip:'127.0.0.24',routeOptions:{url:'/api/workbench/connector/runs/:id/tools'},params:{id:runId},headers:{authorization:`Bearer ${raw}`}} as FastifyRequest);
  try{
   for(let n=0;n<180;n++)expect((await app.inject({method:'POST',url:'/api/workbench/connector/claim',headers:{authorization:`Bearer ${bridgeEnrollment}`},payload:{}})).statusCode).toBe(204);
   for(const raw of grants){expect(await key(req(raw))).toBe(`connector:${bridgeConnector}`);expect((await app.inject({method:'POST',url:`/api/workbench/connector/runs/${runId}/tools`,headers:{authorization:`Bearer ${raw}`},payload:{generation:1}})).statusCode).toBe(429);}
   await sql`UPDATE wb_users SET role='member' WHERE id=${actor}`;
   expect(await key(req(grants[0]!))).toBe('ip:127.0.0.24');
   await sql`UPDATE wb_users SET role='owner' WHERE id=${actor}`;
   await sql`UPDATE wb_records SET data=jsonb_set(data,'{generation}','2') WHERE id=${runId}`;
   expect(await key(req(grants[1]!))).toBe('ip:127.0.0.24');
  }finally{
   await sql`UPDATE wb_users SET role='owner' WHERE id=${actor}`;
   await sql`DELETE FROM wb_bridge_tokens WHERE run_id=${runId}`;
   await sql`DELETE FROM wb_records WHERE id=${runId}`;
  }
 });
 it('keeps finite read and renewal control available after ordinary Connector traffic exhausts its budget',async()=>{
  const actor=(await sql`SELECT id FROM wb_users WHERE email=${owner}`)[0]!.id;
  const project=(await app.inject({method:'POST',url:'/api/workbench/projects',headers:{cookie},payload:{name:'Lease control fixture'}})).json();
  const connectorId=`rate-control-${suffix}`,raw=randomUUID(),runId=`control-run-${suffix}`,otherRunId=`control-other-${suffix}`;
  connectorIds.push(connectorId);await sql`INSERT INTO wb_connectors(id,digest,project_ids) VALUES (${connectorId},${digest(raw)},${sql.json([project.id])})`;
  const stamp=new Date().toISOString(),before=new Date(Date.now()+30000).toISOString();
  const run:Run={id:runId,projectId:project.id,connectorId,requestedBy:actor,kind:'master',model:'gpt-6.1-sol',reasoning:'medium',prompt:'Fixture',status:'running',generation:1,leaseUntil:before,createdAt:stamp,updatedAt:stamp};
  const store=new WorkbenchStore(sql);await store.put('run',run);await store.put('run',{...run,id:otherRunId});
  const headers={authorization:`Bearer ${raw}`};
  try{
   for(let n=0;n<180;n++)expect((await app.inject({method:'POST',url:'/api/workbench/connector/claim',headers,payload:{capabilities:{codexAppServer:true,localWorktrees:true,models:['gpt-6.1-sol']}}})).statusCode).toBe(204);
   expect((await app.inject({method:'POST',url:'/api/workbench/connector/claim',headers,payload:{capabilities:{codexAppServer:true,localWorktrees:true,models:['gpt-6.1-sol']}}})).statusCode).toBe(429);
   expect((await app.inject({url:`/api/workbench/connector/runs/${runId}`,headers})).statusCode).toBe(200);
   const renewed=await app.inject({method:'POST',url:`/api/workbench/connector/runs/${runId}/renew`,headers,payload:{generation:1}});expect(renewed.statusCode).toBe(200);expect(Date.parse(renewed.json().leaseUntil)).toBeGreaterThan(Date.parse(before));
   expect((await app.inject({method:'POST',url:`/api/workbench/connector/runs/${runId}/renew`,headers,payload:{generation:2}})).statusCode).toBe(409);
   await sql`UPDATE wb_users SET role='member' WHERE id=${actor}`;await sql`DELETE FROM wb_memberships WHERE project_id=${project.id} AND user_id=${actor}`;
   expect((await app.inject({method:'POST',url:`/api/workbench/connector/runs/${runId}/renew`,headers,payload:{generation:1}})).statusCode).toBe(403);await sql`UPDATE wb_users SET role='owner' WHERE id=${actor}`;
   // The same Connector changing run IDs still shares one finite control budget.
   for(let n=4;n<180;n++)expect((await app.inject({url:`/api/workbench/connector/runs/${n%2?runId:otherRunId}`,headers})).statusCode).toBe(200);
   expect((await app.inject({method:'POST',url:`/api/workbench/connector/runs/${otherRunId}/renew`,headers,payload:{generation:1}})).statusCode).toBe(429);
  }finally{await sql`UPDATE wb_users SET role='owner' WHERE id=${actor}`;await sql`DELETE FROM wb_memberships WHERE project_id=${project.id}`;await sql`DELETE FROM wb_records WHERE id=ANY(${[runId,otherRunId,project.id]})`;}
 });
 it('unknown routes remain anonymous even with a valid session',async()=>{
  const key=rateLimitKey(sql);
  expect(await key({ip:'127.0.0.23',routeOptions:{url:'/*'},headers:{cookie}} as FastifyRequest)).toBe('ip:127.0.0.23');
 });
});

describe.skipIf(!url)('Slack signed intake through HTTP and PostgreSQL', () => {
    const databaseUrl = url;
    const schema = `slack_intake_${randomUUID().replaceAll('-', '')}`;
    const secret = 'fake-slack-ingest-signing-secret';
    const connectorToken = 'fake-slack-connector-token';
    const capabilities = {codexAppServer:true,localWorktrees:true,models:['gpt-6-luna','gpt-6.1-sol'],modelReasoningEfforts:{'gpt-6-luna':['medium'],'gpt-6.1-sol':['medium']}};
    let admin: ReturnType<typeof postgres>, sql: ReturnType<typeof postgres>, store: WorkbenchStore;
    let app: Awaited<ReturnType<typeof createWorkbenchApp>>, address: string;
    let ownsSchema = false;
    const previousSecret = process.env.WORKBENCH_SLACK_SIGNING_SECRET;
    const project: Project = { id:'slack-project', name:'Slack', instructions:'', repositoryUrl:'https://github.com/example/fixture', deliveryAuthorization:'', createdAt:new Date().toISOString(), feedbackIntake:{enabled:true,allowExecution:false,actorId:'source-actor'} };
    const mapping: Setting = { id:'slack-mapping', kind:'connection', projectId:project.id, name:'Slack', data:{provider:'slack',enabled:true,appId:'A123',teamId:'T123',channelId:'C123'},updatedAt:new Date().toISOString() };
    beforeAll(async () => {
        const location = new URL(databaseUrl!);
        if (!['localhost','127.0.0.1','::1'].includes(location.hostname) || !location.pathname.endsWith('_test')) throw new Error('Slack tests require loopback *_test database');
        admin = postgres(databaseUrl!, {max:1});
        await admin`CREATE SCHEMA ${admin(schema)}`; ownsSchema = true;
        location.searchParams.set('search_path',schema);
        await migrate(location.toString());
        sql = postgres(location.toString(), {max:4}); store = new WorkbenchStore(sql);
        await sql`INSERT INTO wb_users(id,email,name,password_hash,role) VALUES ('source-actor','slack@fixture.example','Source','unused','member')`;
        await sql`INSERT INTO wb_memberships(user_id,project_id,role) VALUES ('source-actor',${project.id},'admin')`;
        await store.put('project',project); await store.put('setting',mapping);
        await sql`INSERT INTO wb_connectors(id,digest,project_ids,capabilities,last_seen) VALUES ('slack-connector',${digest(connectorToken)},${sql.json([project.id])},${sql.json(capabilities)},now())`;
        await store.put('setting',{id:'slack-provider',kind:'provider',name:'Fake provider',data:{provider:'openai',method:'codex-host',connectorId:'slack-connector',enabled:true,default:true},updatedAt:new Date().toISOString()} as Setting);
        process.env.WORKBENCH_SLACK_SIGNING_SECRET = secret;
        app = await createWorkbenchApp({sql});
        address = await app.listen({host:'127.0.0.1',port:0});
    });
    afterAll(async () => {
        await app?.close(); await sql?.end();
        if (ownsSchema) await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
        await admin?.end();
        if (previousSecret === undefined) delete process.env.WORKBENCH_SLACK_SIGNING_SECRET;
        else process.env.WORKBENCH_SLACK_SIGNING_SECRET = previousSecret;
    });
    const event = (id:string) => ({type:'event_callback',api_app_id:'A123',team_id:'T123',event_id:id,event:{type:'app_mention',channel:'C123',user:'U123',text:'Please clarify this feedback',ts:'1760000000.000001',thread_ts:'1759999999.000001'}});
    async function send(body:unknown, valid=true) {
        const raw=JSON.stringify(body), timestamp=String(Math.floor(Date.now()/1000));
        const signature='v0='+createHmac('sha256',secret).update(`v0:${timestamp}:${raw}`).digest('hex');
        return fetch(address+'/api/workbench/sources/slack/events',{method:'POST',headers:{'content-type':'application/json','x-slack-request-timestamp':timestamp,'x-slack-signature':valid?signature:'v0=bad'},body:raw});
    }
    it('deduplicates signed mentions into one source and one server-origin Master Run', async () => {
        expect((await send(event('Ev123'))).status).toBe(200);
        expect((await send(event('Ev123'))).status).toBe(200);
        const messages=await store.list('message',project.id), runs=await store.list<Run>('run',project.id);
        expect(messages).toHaveLength(1); expect(runs).toHaveLength(1);
        expect(runs[0]?.kind).toBe('master');
        expect(runs[0]?.origin).toEqual({provider:'slack',connectionId:mapping.id,appId:'A123',teamId:'T123',channelId:'C123',threadTs:'1759999999.000001',eventId:'Ev123',sourceId:'slack:Ev123'});
    });
    it('rejects invalid signature, event shape, identity and revoked or missing actor without effects', async () => {
        expect((await send(event('bad-signature'),false)).status).toBe(401);
        const variants=[{...event('wrong-app'),api_app_id:'A999'}, {...event('wrong-team'),team_id:'T999'}, {...event('wrong-channel'),event:{...event('x').event,channel:'C999'}}, {...event('message'),event:{...event('x').event,type:'message'}}, {...event('bot'),event:{...event('x').event,bot_id:'B123'}}, {...event('subtype'),event:{...event('x').event,subtype:'changed'}}, {...event('bad-ts'),event:{...event('x').event,ts:'123'}}, {...event('missing-user'),event:{...event('x').event,user:undefined}}];
        for (const value of variants) expect((await send(value)).status).toBe(200);
        await sql`DELETE FROM wb_memberships WHERE user_id='source-actor'`;
        expect((await send(event('revoked'))).status).toBe(200);
        await store.put('project',{...project,feedbackIntake:{...project.feedbackIntake!,actorId:'missing-actor'}});
        expect((await send(event('missing-actor'))).status).toBe(200);
        await store.put('project',{...project,feedbackIntake:{...project.feedbackIntake!,enabled:false}});
        expect((await send(event('disabled-intake'))).status).toBe(200);
        expect(await store.list('message',project.id)).toHaveLength(1); expect(await store.list('run',project.id)).toHaveLength(1);
    });
    it('enforces a global active triple, while allowing disabled mappings', async () => {
        await expect(store.put('setting',{...mapping,id:'duplicate-mapping'})).rejects.toMatchObject({code:'23505'});
        await store.put('setting',{...mapping,id:'delivery-mapping',data:{...mapping.data,purpose:'delivery'}});
        await store.put('project',project);
        await sql`INSERT INTO wb_memberships(user_id,project_id,role) VALUES ('source-actor',${project.id},'admin')`;
        const index=(await sql`SELECT indexdef FROM pg_indexes WHERE schemaname=${schema} AND indexname='wb_slack_active_source_identity'`)[0]!.indexdef as string;
        await sql`DROP INDEX wb_slack_active_source_identity`;
        await store.put('setting',{...mapping,id:'ambiguous-mapping'});
        expect((await send(event('ambiguous-mapping'))).status).toBe(200);
        expect(await store.list('message',project.id)).toHaveLength(1);
        await sql`DELETE FROM wb_records WHERE id='ambiguous-mapping'`;
        await sql.unsafe(index);
        await store.put('setting',{...mapping,id:'disabled-mapping',data:{...mapping.data,enabled:false}});
        await store.put('setting',{...mapping,data:{...mapping.data,enabled:false}});
        expect((await send(event('disabled-mapping'))).status).toBe(200);
        expect(await store.list('message',project.id)).toHaveLength(1);
    });
    it('carries origin through dispatch, completion wake and continuation; fences final outbox and failed wake', async () => {
        await store.put('project',{...project,feedbackIntake:{...project.feedbackIntake!,enabled:false}});
        const chainProject:Project={...project,id:'slack-chain-project',feedbackIntake:{enabled:true,allowExecution:true,actorId:'source-actor'}};
        await store.put('project',chainProject);
        await sql`INSERT INTO wb_memberships(user_id,project_id,role) VALUES ('source-actor',${chainProject.id},'admin')`;
        await sql`UPDATE wb_connectors SET project_ids=${sql.json([project.id,chainProject.id])},capabilities=${sql.json(capabilities)},last_seen=now() WHERE id='slack-connector'`;
        await store.put('setting',{...mapping,id:'chain-mapping',projectId:chainProject.id,data:{...mapping.data,channelId:'C456'}});
        expect((await send({...event('chain-event'),event:{...event('x').event,channel:'C456'}})).status).toBe(200);
        async function connector(path:string,payload:unknown) {
            return fetch(address+'/api/workbench/connector'+path,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${connectorToken}`},body:JSON.stringify(payload)});
        }
        async function claim(kind:string):Promise<Run> {
            const response=await connector('/claim',{capabilities:{...capabilities,runKinds:[kind]}});
            expect(response.status).toBe(200); return (await response.json() as {run:Run}).run;
        }
        async function tool(run:Run,action:string,input:unknown,requestId:string) {
            const response=await connector(`/runs/${run.id}/tools`,{generation:run.generation,action,input,requestId});
            expect(response.status).toBe(200); return response.json();
        }
        async function complete(run:Run,body:Record<string,unknown>={}) {
            const response=await connector(`/runs/${run.id}/complete`,{generation:run.generation,...body});
            expect(response.status).toBe(200); return response.json() as Promise<Run>;
        }
        const master=await claim('master'); expect(master.projectId).toBe(chainProject.id);
        const work=await tool(master,'create_work',{title:'Scoped feedback'},'create-work') as {id:string};
        const implementation=await tool(master,'dispatch',{workId:work.id,prompt:'Inspect feedback',kind:'implementation',model:'gpt-6-luna',reasoning:'medium'},'dispatch') as Run;
        expect(implementation.origin).toEqual(master.origin); expect(implementation.causedByRunId).toBe(master.id);
        await tool(master,'post_message',{text:'Commentary persisted in conversation'},'commentary');
        expect(await sql`SELECT request_id FROM wb_requests WHERE scope=${`slack-reply:${chainProject.id}`}`).toHaveLength(0);
        const finalBody={threadId:'source-thread',canonicalFinal:{threadId:'source-thread',turnId:'source-turn',itemId:'source-final',text:'I will inspect this feedback.'}};
        await complete(master,finalBody); await complete(master,finalBody);
        expect((await connector(`/runs/${master.id}/complete`,{generation:master.generation-1,...finalBody})).status).toBe(403);
        expect(await sql`SELECT request_id FROM wb_requests WHERE scope=${`slack-reply:${chainProject.id}`}`).toHaveLength(1);
        const runningImplementation=await claim('implementation'); expect(runningImplementation.id).toBe(implementation.id);
        await complete(runningImplementation,{threadId:'implementation-thread'});
        const wake=await claim('master'); expect(wake.origin).toEqual(master.origin); expect(wake.causedByRunId).toBe(implementation.id);
        const continuation=await tool(wake,'dispatch',{workId:work.id,prompt:'Continue inspection',kind:'implementation',model:'gpt-6-luna',reasoning:'medium'},'continue') as Run;
        expect(continuation.origin).toEqual(master.origin); expect(continuation.causedByRunId).toBe(wake.id);
        await complete(wake,{threadId:'source-thread',canonicalFinal:{threadId:'source-thread',turnId:'wake-turn',itemId:'wake-final',text:'Inspection is continuing.'}});
        expect(await sql`SELECT request_id FROM wb_requests WHERE scope=${`slack-reply:${chainProject.id}`}`).toHaveLength(2);
        const runningContinuation=await claim('implementation'); expect(runningContinuation.id).toBe(continuation.id);
        const provider=await store.get<Setting>('setting','slack-provider');
        await store.put('setting',{...provider!,data:{...provider!.data,enabled:false}});
        await complete(runningContinuation,{error:'Inspection failed'});
        const wakes=(await store.list<Run>('run',chainProject.id)).filter(run=>run.causedByRunId===continuation.id);
        expect(wakes).toHaveLength(1); expect(wakes[0]?.status).toBe('failed'); expect(wakes[0]?.origin).toEqual(master.origin);
        expect(wakes[0]?.error).toContain('Master wake was not dispatched');
        expect(await sql`SELECT request_id FROM wb_requests WHERE scope=${`slack-reply:${chainProject.id}`}`).toHaveLength(2);
        await store.put('setting',provider!);
        expect((await send({...event('clarification-event'),event:{...event('x').event,channel:'C456'}})).status).toBe(200);
        const clarification=await claim('master');
        await tool(clarification,'post_message',{text:'Only commentary; no provider final'},'commentary-only');
        const blocked=await complete(clarification,{threadId:'source-thread'});
        expect(blocked.slackReply?.state).toBe('blocked'); expect(blocked.slackReply?.cause).toContain('provider final');
        expect(await sql`SELECT request_id FROM wb_requests WHERE scope=${`slack-reply:${chainProject.id}`}`).toHaveLength(2);
    });


    it('revokes Slack-origin authority after admin downgrade while ordinary member Work remains available', async () => {
        const authProject:Project={...project,id:'slack-auth-project',feedbackIntake:{enabled:true,allowExecution:true,actorId:'source-actor'}};
        await store.put('project',authProject);
        await sql`INSERT INTO wb_memberships(user_id,project_id,role) VALUES ('source-actor',${authProject.id},'admin')`;
        await sql`UPDATE wb_connectors SET project_ids=${sql.json([authProject.id])},capabilities=${sql.json(capabilities)},last_seen=now() WHERE id='slack-connector'`;
        await store.put('setting',{...mapping,id:'auth-mapping',projectId:authProject.id,data:{...mapping.data,channelId:'C789'}});
        expect((await send({...event('auth-event'),event:{...event('x').event,channel:'C789'}})).status).toBe(200);
        const connector=(path:string,payload?:unknown,method='POST')=>fetch(address+'/api/workbench/connector'+path,{method,headers:{'content-type':'application/json',authorization:`Bearer ${connectorToken}`},...(payload===undefined?{}:{body:JSON.stringify(payload)})});
        const claimed=await connector('/claim',{capabilities:{...capabilities,runKinds:['master']}});
        expect(claimed.status).toBe(200);
        const master=(await claimed.json() as {run:Run}).run;
        expect(master.projectId).toBe(authProject.id);
        const tool=(action:string,input:unknown,requestId:string)=>connector(`/runs/${master.id}/tools`,{generation:master.generation,action,input,requestId});
        const created=await tool('create_work',{title:'Created while actor was admin'},'auth-create');
        expect(created.status).toBe(200); const work=await created.json() as Work;
        const queuedWorkResponse=await tool('create_work',{title:'Queued before revoke'},'auth-queued-work');
        expect(queuedWorkResponse.status).toBe(200); const queuedWork=await queuedWorkResponse.json() as Work;
        const dispatch={prompt:'Bounded source work',kind:'implementation',model:'gpt-6-luna',reasoning:'medium'};
        const queuedResponse=await tool('dispatch',{...dispatch,workId:queuedWork.id},'auth-before-revoke');
        expect(queuedResponse.status).toBe(200); const queued=await queuedResponse.json() as Run;
        expect(queued.origin).toEqual(master.origin);
        await sql`UPDATE wb_memberships SET role='member' WHERE user_id='source-actor' AND project_id=${authProject.id}`;
        expect((await tool('dispatch',{...dispatch,workId:work.id},'auth-after-revoke')).status).toBe(403);
        expect((await store.list<Run>('run',authProject.id)).filter(run=>run.workId===work.id)).toHaveLength(0);
        expect((await connector(`/runs/${master.id}`,undefined,'GET')).status).toBe(403);
        expect((await connector(`/runs/${master.id}/renew`,{generation:master.generation})).status).toBe(403);
        expect((await tool('read_context',{},'auth-read-after-revoke')).status).toBe(403);
        expect((await connector('/claim',{capabilities:{...capabilities,runKinds:['implementation']}})).status).toBe(204);
        const revoked=await store.get<Run>('run',queued.id);
        expect(revoked?.status).toBe('cancelled'); expect(revoked?.generation).toBe(0); expect(revoked?.connectorId).toBeUndefined();
        expect(revoked?.error).toContain('authorization revoked');
        const memberSession='synthetic-slack-downgraded-member-session';
        await sql`INSERT INTO wb_sessions(digest,user_id,expires_at) VALUES (${digest(memberSession)},'source-actor',now()+interval '1 day')`;
        const memberPost=(path:string,payload:unknown)=>fetch(address+'/api/workbench'+path,{method:'POST',headers:{'content-type':'application/json',cookie:`menoteam_session=${memberSession}`},body:JSON.stringify(payload)});
        const ordinaryWorkResponse=await memberPost(`/projects/${authProject.id}/works`,{title:'Ordinary member request'});
        expect(ordinaryWorkResponse.status).toBe(200); const ordinaryWork=await ordinaryWorkResponse.json() as Work;
        const ordinaryResponse=await memberPost(`/projects/${authProject.id}/messages`,{workId:ordinaryWork.id,text:'Ordinary member task',requestId:'ordinary-member-task'});
        expect(ordinaryResponse.status).toBe(200); const ordinary=(await ordinaryResponse.json() as {run:Run}).run;
        expect(ordinary.origin).toBeUndefined(); expect(ordinary.sourceIds).toBeUndefined();
        const ordinaryClaimResponse=await connector('/claim',{capabilities:{...capabilities,runKinds:['implementation']}});
        expect(ordinaryClaimResponse.status).toBe(200); const ordinaryClaim=(await ordinaryClaimResponse.json() as {run:Run}).run;
        expect(ordinaryClaim.id).toBe(ordinary.id);
        expect((await connector(`/runs/${ordinary.id}`,undefined,'GET')).status).toBe(200);
        expect((await connector(`/runs/${ordinary.id}/renew`,{generation:ordinaryClaim.generation})).status).toBe(200);
    });
    it('keeps a concurrent signed event bound to P1 after its disabled Slack triple moves to P2', async () => {
        const p1:Project={...project,id:'slack-retry-p1'};
        const p2:Project={...project,id:'slack-retry-p2'};
        await store.put('project',p1); await store.put('project',p2);
        for(const p of [p1,p2])await sql`INSERT INTO wb_memberships(user_id,project_id,role) VALUES ('source-actor',${p.id},'admin')`;
        await sql`UPDATE wb_connectors SET project_ids=${sql.json([p1.id,p2.id])},capabilities=${sql.json(capabilities)},last_seen=now() WHERE id='slack-connector'`;
        const firstMapping:Setting={...mapping,id:'retry-p1-mapping',projectId:p1.id,data:{...mapping.data,channelId:'C999'}};
        await store.put('setting',firstMapping);
        const signedEvent={...event('stable-event'),event:{...event('x').event,channel:'C999'}};
        const responses=await Promise.all([send(signedEvent),send(signedEvent)]);
        expect(responses.map(response=>response.status)).toEqual([200,200]);
        const originalRuns=await store.list<Run>('run',p1.id);
        expect(await store.list('message',p1.id)).toHaveLength(1); expect(originalRuns).toHaveLength(1);
        expect(originalRuns[0]?.origin).toMatchObject({connectionId:firstMapping.id,eventId:'stable-event',sourceId:'slack:stable-event'});
        await store.put('setting',{...firstMapping,data:{...firstMapping.data,enabled:false}});
        await store.put('setting',{...firstMapping,id:'retry-p2-mapping',projectId:p2.id});
        expect((await send(signedEvent)).status).toBe(200);
        expect(await store.list('message',p1.id)).toHaveLength(1);
        expect((await store.list<Run>('run',p1.id)).map(run=>run.id)).toEqual(originalRuns.map(run=>run.id));
        expect(await store.list('message',p2.id)).toHaveLength(0); expect(await store.list('run',p2.id)).toHaveLength(0);
        expect(await sql`SELECT request_id FROM wb_requests WHERE scope=${`source:${p2.id}`} AND request_id='slack:stable-event'`).toHaveLength(0);
        // Older accepted events have authoritative Run.origin but no global receipt.
        // Their first retry must recover the original binding before consulting P2.
        await sql`DELETE FROM wb_requests WHERE scope='slack-source:A123:T123' AND request_id='stable-event'`;
        expect((await send(signedEvent)).status).toBe(200);
        expect(await store.list('message',p1.id)).toHaveLength(1);
        expect((await store.list<Run>('run',p1.id)).map(run=>run.id)).toEqual(originalRuns.map(run=>run.id));
        expect(await store.list('message',p2.id)).toHaveLength(0); expect(await store.list('run',p2.id)).toHaveLength(0);
        const recovered=await sql`SELECT result FROM wb_requests WHERE scope='slack-source:A123:T123' AND request_id='stable-event'`;
        expect(recovered).toHaveLength(1); expect(recovered[0]?.result).toMatchObject({projectId:p1.id,origin:originalRuns[0]!.origin});
    });

    it('lets project admins issue only project scoped invitations and keeps workspace invites owner only', async () => {
        const suffix = randomUUID();
        const email = (name: string) => `${name}-${suffix}@test.example`;
        const ownerEmail = email('workspace-owner');
        await app.close();
        app = await createWorkbenchApp({ sql, bootstrapEmail: ownerEmail, bootstrapPassword: 'invite-owner-password-123' });
        const ownerLogin = await app.inject({ method: 'POST', url: '/api/workbench/session', payload: { email: ownerEmail, password: 'invite-owner-password-123' } });
        expect(ownerLogin.statusCode).toBe(200);
        const ownerSession = String(ownerLogin.headers['set-cookie']).split(';')[0]!;
        const ownerPost = (path: string, payload: unknown) => app.inject({ method: 'POST', url: `/api/workbench${path}`, headers: { cookie: ownerSession }, payload });
        const checkedJson = (response: { statusCode: number; body: string; json(): any }, status = 200) => {
            expect(response.statusCode, response.statusCode === status ? undefined : 'Unexpected PostgreSQL fixture response').toBe(status);
            return response.json();
        };
        const adminEmail = email('project-admin');
        const memberInviteEmail = email('invited-member');
        const scopedAdminEmail = email('invited-admin');
        const ordinaryEmail = email('ordinary-member');
        const workspaceEmail = email('workspace-admin');
        const project = checkedJson(await ownerPost('/projects', { name: `Invite scope ${suffix}` })) as Project;
        const otherProject = checkedJson(await ownerPost('/projects', { name: `Invite other ${suffix}` })) as Project;
        const cleanupEmails = [ownerEmail, adminEmail, memberInviteEmail, scopedAdminEmail, ordinaryEmail, workspaceEmail];
        const inviteAndAccept = async (inviteEmail: string, projectId: string | undefined, role: 'admin' | 'member') => {
            const payload = { email: inviteEmail, ...(projectId ? { projectId } : {}), role };
            const invite = checkedJson(await ownerPost('/invites', payload));
            const accepted = await app.inject({
                method: 'POST', url: '/api/workbench/invites/accept',
                payload: { token: invite.token, name: 'Invite fixture', password: 'invite-fixture-password-123' }
            });
            expect(accepted.statusCode).toBe(200);
            const login = await app.inject({
                method: 'POST', url: '/api/workbench/session',
                payload: { email: inviteEmail, password: 'invite-fixture-password-123' }
            });
            expect(login.statusCode).toBe(200);
            return { invite, session: String(login.headers['set-cookie']).split(';')[0]! };
        };
        const sessionPost = (session: string, payload: unknown) => app.inject({
            method: 'POST', url: '/api/workbench/invites', headers: { cookie: session }, payload
        });
        const account = async (accountEmail: string, projectId: string, scopedRole: string) => {
            const rows = await sql`SELECT u.role AS global_role,m.role AS project_role FROM wb_users u LEFT JOIN wb_memberships m ON m.user_id=u.id AND m.project_id=${projectId} WHERE u.email=${accountEmail}`;
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ global_role: 'member', project_role: scopedRole });
            const memberships = await sql`SELECT project_id FROM wb_memberships WHERE user_id=(SELECT id FROM wb_users WHERE email=${accountEmail})`;
            expect(memberships).toHaveLength(1);
            expect(memberships[0]!.project_id).toBe(projectId);
        };
        try {
            const projectAdmin = await inviteAndAccept(adminEmail, project.id, 'admin');
            await account(adminEmail, project.id, 'admin');
            const actor = await sql`SELECT u.role AS global_role,m.role AS project_role FROM wb_users u JOIN wb_memberships m ON m.user_id=u.id AND m.project_id=${project.id} WHERE u.email=${adminEmail}`;
            expect(actor).toMatchObject([{ global_role: 'member', project_role: 'admin' }]);
            expect(await sql`SELECT role FROM wb_memberships WHERE user_id=(SELECT id FROM wb_users WHERE email=${adminEmail}) AND project_id=${otherProject.id}`).toHaveLength(0);

            const memberInvite = checkedJson(await sessionPost(projectAdmin.session, { email: memberInviteEmail, projectId: project.id, role: 'member' }));
            const memberAcceptance = await app.inject({ method: 'POST', url: '/api/workbench/invites/accept', payload: { token: memberInvite.token, name: 'Invited member', password: 'invite-fixture-password-123' } });
            expect(memberAcceptance.statusCode).toBe(200);
            await account(memberInviteEmail, project.id, 'member');
            const memberLogin = await app.inject({ method: 'POST', url: '/api/workbench/session', payload: { email: memberInviteEmail, password: 'invite-fixture-password-123' } });
            expect(memberLogin.statusCode).toBe(200);

            const scopedAdminInvite = checkedJson(await sessionPost(projectAdmin.session, { email: scopedAdminEmail, projectId: project.id, role: 'admin' }));
            const scopedAdminAcceptance = await app.inject({ method: 'POST', url: '/api/workbench/invites/accept', payload: { token: scopedAdminInvite.token, name: 'Invited admin', password: 'invite-fixture-password-123' } });
            expect(scopedAdminAcceptance.statusCode).toBe(200);
            await account(scopedAdminEmail, project.id, 'admin');
            const scopedAdminLogin = await app.inject({ method: 'POST', url: '/api/workbench/session', payload: { email: scopedAdminEmail, password: 'invite-fixture-password-123' } });
            expect(scopedAdminLogin.statusCode).toBe(200);
            await account(adminEmail, project.id, 'admin');

            const outsiderInvite = checkedJson(await ownerPost('/invites', { email: ordinaryEmail, projectId: project.id, role: 'member' }));
            const outsiderAcceptance = await app.inject({ method: 'POST', url: '/api/workbench/invites/accept', payload: { token: outsiderInvite.token, name: 'Ordinary member', password: 'invite-fixture-password-123' } });
            expect(outsiderAcceptance.statusCode).toBe(200);
            const ordinaryLogin = await app.inject({ method: 'POST', url: '/api/workbench/session', payload: { email: ordinaryEmail, password: 'invite-fixture-password-123' } });
            expect(ordinaryLogin.statusCode).toBe(200);
            const ordinarySession = String(ordinaryLogin.headers['set-cookie']).split(';')[0]!;
            expect((await sql`SELECT role FROM wb_memberships WHERE user_id=(SELECT id FROM wb_users WHERE email=${ordinaryEmail}) AND project_id=${project.id}`).map(row => row.role)).toEqual(['member']);

            const denied = async (response: { statusCode: number }) => expect(response.statusCode).toBe(403);
            const inviteCount = async (inviteEmail: string) => Number((await sql`SELECT count(*) AS count FROM wb_invites WHERE email=${inviteEmail}`)[0]!.count);
            const beforeUnscoped = await inviteCount(email('denied-unscoped'));
            await denied(await sessionPost(projectAdmin.session, { email: email('denied-unscoped'), role: 'member' }));
            await denied(await sessionPost(projectAdmin.session, { email: email('denied-unscoped'), role: 'admin' }));
            expect(await inviteCount(email('denied-unscoped'))).toBe(beforeUnscoped);
            await denied(await sessionPost(projectAdmin.session, { email: email('denied-other-project'), projectId: otherProject.id, role: 'admin' }));
            expect(await inviteCount(email('denied-other-project'))).toBe(0);
            await denied(await sessionPost(ordinarySession, { email: email('denied-ordinary-member'), projectId: project.id, role: 'admin' }));
            expect(await inviteCount(email('denied-ordinary-member'))).toBe(0);

            const deniedWorkspaceEmail = email('denied-workspace');
            await denied(await sessionPost(projectAdmin.session, { email: deniedWorkspaceEmail, role: 'member' }));
            expect(await inviteCount(deniedWorkspaceEmail)).toBe(0);
            await denied(await sessionPost(projectAdmin.session, { email: deniedWorkspaceEmail, role: 'admin' }));
            expect(await inviteCount(deniedWorkspaceEmail)).toBe(0);

            await inviteAndAccept(workspaceEmail, undefined, 'admin');
            const workspaceUser = await sql`SELECT role FROM wb_users WHERE email=${workspaceEmail}`;
            expect(workspaceUser).toMatchObject([{ role: 'admin' }]);
            expect(await sql`SELECT project_id FROM wb_memberships WHERE user_id=(SELECT id FROM wb_users WHERE email=${workspaceEmail})`).toHaveLength(0);
        } finally {
            await sql`DELETE FROM wb_invites WHERE email=ANY(${cleanupEmails}) OR email LIKE ${`%-${suffix}@test.example`}`;
            await sql`DELETE FROM wb_sessions WHERE user_id IN (SELECT id FROM wb_users WHERE email=ANY(${cleanupEmails}) OR email LIKE ${`%-${suffix}@test.example`})`;
            await sql`DELETE FROM wb_memberships WHERE user_id IN (SELECT id FROM wb_users WHERE email=ANY(${cleanupEmails}) OR email LIKE ${`%-${suffix}@test.example`})`;
            await sql`DELETE FROM wb_users WHERE email=ANY(${cleanupEmails}) OR email LIKE ${`%-${suffix}@test.example`}`;
            await sql`DELETE FROM wb_records WHERE id=ANY(${[project.id, otherProject.id]}) AND kind='project'`;
        }
    });
});

describe.skipIf(!url)('Slack durable reply PostgreSQL',()=>{
    let sql:ReturnType<typeof postgres>,admin:ReturnType<typeof postgres>,store:WorkbenchStore,schema:string;
    let run:Run;
    let ownsSchema=false;
    beforeAll(async()=>{
        const location=new URL(url!);
        if(!['127.0.0.1','localhost'].includes(location.hostname)||!location.pathname.endsWith('_test'))throw new Error('Slack tests require loopback *_test database');
        schema=`slack_reply_${randomUUID().replaceAll('-','')}`;admin=postgres(url!,{max:1});await admin`CREATE SCHEMA ${admin(schema)}`;ownsSchema=true;
        location.searchParams.set('search_path',schema);await migrate(location.toString());sql=postgres(location.toString(),{max:4});store=new WorkbenchStore(sql);
    });
    afterAll(async()=>{await sql?.end();if(ownsSchema)await admin`DROP SCHEMA ${admin(schema)} CASCADE`;await admin?.end();});
    beforeEach(async()=>{
        await sql`TRUNCATE wb_records,wb_requests,wb_users CASCADE`;
        await sql`INSERT INTO wb_users(id,email,name,password_hash,role) VALUES ('actor','slack@test.example','Actor','unused','owner')`;
        await store.put('project',{id:'project',name:'Slack',instructions:'',repositoryUrl:'',deliveryAuthorization:'',createdAt:new Date().toISOString(),feedbackIntake:{enabled:true,allowExecution:true,actorId:'actor'}} satisfies Project);
        await store.put('setting',{id:'slack',kind:'connection',projectId:'project',name:'Slack',updatedAt:new Date().toISOString(),data:{provider:'slack',enabled:true,appId:'A123',teamId:'T123',channelId:'C123'}} satisfies Setting);
        run={id:'run',projectId:'project',kind:'master',prompt:'source',requestedBy:'actor',sourceIds:['slack:event'],origin:{provider:'slack',connectionId:'slack',appId:'A123',teamId:'T123',channelId:'C123',threadTs:'1234567890.123456',eventId:'event',sourceId:'slack:event'},model:'gpt-6.1-sol',reasoning:'medium',status:'completed',generation:1,threadId:'thread',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
        await store.put('run',run);await sql`INSERT INTO wb_requests(scope,request_id,result) VALUES ('source:project','slack:event','{}'::jsonb)`;
        await store.transaction('enqueue',tx=>enqueueSlackReply(tx,run,{threadId:'thread',turnId:'turn',itemId:'item',text:'Canonical final'}));
    });
    const state=async()=>String((await sql`SELECT result->>'state' AS state FROM wb_requests WHERE scope='slack-reply:project'`)[0]?.state);
    it('serializes two workers before HTTP and freezes immutable body on completion replay',async()=>{
        await store.transaction('replay',tx=>enqueueSlackReply(tx,run,{threadId:'thread',turnId:'turn',itemId:'different',text:'Replacement'}));
        let calls=0;
        const transport:SlackTransport=async request=>{calls++;expect(request).toMatchObject({channel:'C123',thread_ts:run.origin!.threadTs,text:'Canonical final'});expect(await state()).toBe('ambiguous');return {status:200,body:{ok:true,channel:'C123',ts:'1234567891.123456'}};};
        await Promise.all([processSlackReplies(store,{token:'fake',transport}),processSlackReplies(store,{token:'fake',transport})]);
        expect(calls).toBe(1);expect(await state()).toBe('sent');
    });
    it('retains lost ACK across worker restart with no retry',async()=>{
        let calls=0;const transport:SlackTransport=async()=>{calls++;throw new Error('lost ack');};
        await processSlackReplies(store,{token:'fake',transport});
        await processSlackReplies(new WorkbenchStore(sql),{token:'fake',transport});
        expect(calls).toBe(1);expect(await state()).toBe('ambiguous');
    });
    it.each([{status:503,body:{ok:false}},{status:200,body:{ok:true,channel:'WRONG',ts:'1234567891.123456'}},{status:200,body:'invalid'}])('keeps uncertain acknowledgment ambiguous: %j',async response=>{
        await processSlackReplies(store,{token:'fake',transport:async()=>response});expect(await state()).toBe('ambiguous');
    });
    it('records definite rejection without replay',async()=>{
        await processSlackReplies(store,{token:'fake',transport:async()=>({status:200,body:{ok:false,error:'not_in_channel'}})});expect(await state()).toBe('failed');
    });
    it.each(['mapping','actor','generation','membership','source'])('rechecks revoked %s before any HTTP',async revoked=>{
        if(revoked==='mapping')await sql`UPDATE wb_records SET data=jsonb_set(data,'{data,enabled}','false') WHERE id='slack'`;
        if(revoked==='actor')await sql`DELETE FROM wb_users WHERE id='actor'`;
        if(revoked==='membership'){
            await sql`UPDATE wb_users SET role='member' WHERE id='actor'`;
            await sql`INSERT INTO wb_memberships(user_id,project_id,role) VALUES ('actor','project','admin')`;
            await sql`UPDATE wb_memberships SET role='member' WHERE user_id='actor' AND project_id='project'`;
        }
        if(revoked==='source')await sql`DELETE FROM wb_requests WHERE scope='source:project' AND request_id='slack:event'`;
        if(revoked==='generation'){run.generation++;await store.put('run',run);}
        let calls=0;await processSlackReplies(store,{token:'fake',transport:async()=>{calls++;return {status:200,body:{ok:true}};}});expect(calls).toBe(0);expect(await state()).toBe('blocked');
    });
});
