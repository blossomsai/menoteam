import { createHash, randomUUID } from 'node:crypto';
import { digest } from '../src/workbench/auth.js';
import { rateLimitKey } from '../src/workbench/rate-limit.js';
import type { FastifyRequest } from 'fastify';
import postgres from "postgres";
import { createHmac } from "node:crypto";
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { createWorkbenchApp } from "../src/workbench/app.js";
import { WorkbenchConnectorClient } from "../src/connector/client.js";
import type { Artifact, Project, Run, Work } from "../src/workbench/types.js";
const url = process.env.WORK_MAP_TEST_DATABASE_URL;
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
    const user = (method: "GET" | "POST" | "PATCH", path: string, payload?: unknown) => app.inject({
        method,
        url: "/api/workbench" + path,
        remoteAddress: `127.0.0.${scenarioAddress}`,
        headers: {
            cookie
        },
        payload: payload as never
    });
    const conn = (method: "GET" | "POST", path: string, payload?: unknown) => app.inject({
        method,
        url: "/api/workbench/connector" + path,
        remoteAddress: `127.0.0.${scenarioAddress}`,
        headers: {
            authorization: `Bearer ${connectorToken}`
        },
        payload: payload as never
    });
    it("persists project and conversation, idempotent submission and scoped login", async () => {
        expect((await app.inject("/api/workbench/snapshot")).statusCode).toBe(401);
        const p = await user("POST", "/projects", {
            name: "Dogfood",
            instructions: "Build from evidence"
        });
        projectId = p.json().id;
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
        const c = await user("POST", "/connectors", {
            id: "test-connector",
            projectIds: [projectId]
        });
        connectorToken = c.json().token;
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
        const bridgeCall=(path:string,payload:unknown)=>app.inject({method:'POST',url:'/api/workbench/connector'+path,headers:{authorization:`Bearer ${bridge}`},payload:payload as never});
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
            payload: payload as never
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
        const raw = (await user("POST", "/connectors", {
            id: "concurrent",
            projectIds: [p.id]
        })).json().token;
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
            payload: payload as never
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
        const t = (await user("POST", "/connectors", {
            id: "cancel-connector",
            projectIds: [p.id]
        })).json().token;
        const send = (path: string, payload: unknown) => app.inject({
            method: "POST",
            url: "/api/workbench/connector" + path,
            headers: {
                authorization: `Bearer ${t}`
            },
            payload: payload as never
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
                url: "https://app.slack.com/client/TEAM/CHANNEL"
            }
        });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const body = JSON.stringify({
            type: "event_callback",
            event_id: "slack-e1",
            team_id: "TEAM",
            event: {
                type: "app_mention",
                channel: "CHANNEL",
                text: "Please inspect this feedback",
                user: "USER",
                ts: "123"
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
        }) => m.projectId === p.id)).toHaveLength(2);
        expect(snap.runs.filter((r: {
            projectId: string;
        }) => r.projectId === p.id)).toHaveLength(0);
        expect((await user('PATCH',`/projects/${p.id}`,{feedbackIntake:{enabled:true,allowExecution:false}})).statusCode).toBe(200);
        await app.inject({...gh,headers:{...gh.headers,'x-github-delivery':'delivery-triage'}});
        const sourceToken=(await user('POST','/connectors',{id:'source-triage',projectIds:[p.id]})).json().token;
        const scoped=(path:string,payload:unknown)=>app.inject({method:'POST',url:'/api/workbench/connector'+path,headers:{authorization:`Bearer ${sourceToken}`},payload:payload as never});
        const run=(await scoped('/claim',{})).json().run;expect(run.kind).toBe('master');expect(run.allowedActions).not.toContain('dispatch');
        expect((await scoped(`/runs/${run.id}/tools`,{generation:run.generation,action:'dispatch',input:{workId:'none',prompt:'Execute source',kind:'implementation',model:'gpt-6-luna'},requestId:'source-deny'})).statusCode).toBe(403);
        expect((await scoped(`/runs/${run.id}/tools`,{generation:run.generation,action:'update_settings',input:{instructions:'Escalate'},requestId:'source-settings-deny'})).statusCode).toBe(403);
        await user('PATCH',`/projects/${p.id}`,{feedbackIntake:{enabled:false,allowExecution:false}});
        expect((await scoped(`/runs/${run.id}/renew`,{generation:run.generation})).statusCode).toBe(403);
    });
    it("binds effective profile skills and derives runtime evidence independently of provider metadata", async () => {
        const skill = (await user('POST','/settings',{kind:'skill',name:'Evidence',data:{content:'Record proof before claiming success'}})).json();
        const profile = (await user('POST','/settings',{kind:'profile',name:'Sol reviewer',data:{model:'gpt-6.1-sol',reasoning:'high',skillIds:[skill.id],tools:[]}})).json();
        const work = (await user('POST',`/projects/${projectId}/works`,{title:'Effective settings',profileId:profile.id})).json();
        const submitted = (await user('POST',`/projects/${projectId}/messages`,{text:'Check effective profile',workId:work.id,requestId:'effective-profile'})).json();
        expect(submitted.run.model).toBe('gpt-6.1-sol');
        expect(submitted.run.reasoning).toBe('high');
        expect(submitted.run.execution.skills).toEqual([{id:skill.id,name:'Evidence',content:'Record proof before claiming success'}]);
        await user('PATCH',`/settings/${skill.id}`,{data:{content:'Updated later'}});
        const stored = await sql`SELECT data FROM wb_records WHERE id=${submitted.run.id}`;
        expect(stored[0]!.data.execution.skills[0].content).toBe('Record proof before claiming success');
        const provider = (await user('POST','/settings',{kind:'provider',name:'Saved only',data:{provider:'openai',method:'codex-host'}})).json();
        expect(provider.id).toBeTruthy();
        const runtime = (await user('GET','/snapshot')).json().runtimeProviders;
        expect(runtime.every((r:{connectorId:string}) => r.connectorId !== provider.id)).toBe(true);
        expect(runtime.some((r:{verifiedRunId?:string}) => !!r.verifiedRunId)).toBe(true);
    });
    it("imports GitHub SKILL.md over HTTP, persists the returned text, and rejects bad upstream content", async () => {
        const importProjectId = (await user("POST", "/projects", { name: "GitHub skill import fixture" })).json().id as string;
        const ref = "a".repeat(40);
        const sourceUrl = `https://github.com/example/skills/blob/${ref}/review/SKILL.md`;
        const skillText = "# Review skill\nCheck the changed behavior against its acceptance criteria.";
        const githubResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" }
        });
        const fetchMock = vi.fn<typeof fetch>();
        const originalFetch = sourceFetch;
        sourceFetch = fetchMock;
        try {
            fetchMock.mockResolvedValueOnce(githubResponse(200, {
                type: "file",
                encoding: "base64",
                content: Buffer.from(skillText).toString("base64"),
                size: Buffer.byteLength(skillText)
            }));
            const imported = await user("POST", `/projects/${importProjectId}/skills/import`, { url: sourceUrl });
            expect(imported.statusCode).toBe(200);
            expect(fetchMock.mock.calls[0]?.[0]).toBe(`https://api.github.com/repos/example/skills/contents/review/SKILL.md?ref=${ref}`);
            expect(imported.json()).toMatchObject({
                kind: "skill",
                projectId: importProjectId,
                name: "review",
                data: { content: skillText, sourceUrl, enabled: true }
            });
            expect((await user("GET", "/snapshot")).json().settings).toContainEqual(imported.json());

            fetchMock.mockResolvedValueOnce(githubResponse(404, { message: "Not Found" }));
            const missing = await user("POST", `/projects/${importProjectId}/skills/import`, { url: sourceUrl });
            expect(missing.statusCode).toBe(502);

            fetchMock.mockResolvedValueOnce(githubResponse(200, {
                type: "file",
                encoding: "base64",
                content: Buffer.from("x").toString("base64"),
                size: 64001
            }));
            const oversized = await user("POST", `/projects/${importProjectId}/skills/import`, { url: sourceUrl });
            expect(oversized.statusCode).toBe(400);
            expect(fetchMock).toHaveBeenCalledTimes(3);
        } finally {
            sourceFetch = originalFetch;
        }
    });
    it('requires connector stop proof before browser reconciliation',async()=>{
        const p=(await user('POST','/projects',{name:'Recovery proof'})).json();
        await user('POST',`/projects/${p.id}/messages`,{text:'Recover safely',requestId:'recovery-run'});
        const credential=(await user('POST','/connectors',{id:'recovery-connector',projectIds:[p.id]})).json().token;
        const send=(path:string,payload:unknown)=>app.inject({method:'POST',url:'/api/workbench/connector'+path,headers:{authorization:`Bearer ${credential}`},payload:payload as never});
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
        const p=(await user('POST','/projects',{name:'Settings operations'})).json();
        const skill=(await user('POST','/settings',{projectId:p.id,kind:'skill',name:'Original',data:{content:'Original instructions'}})).json();
        const outside=(await user('POST','/settings',{projectId,kind:'skill',name:'Outside project',data:{content:'Protected'}})).json();
        const profile=(await user('POST','/settings',{kind:'profile',name:'Workspace profile',data:{model:'gpt-6-luna',reasoning:'medium',skillIds:[]}})).json();
        await user('POST',`/projects/${p.id}/messages`,{text:'Update the project skill',requestId:'settings-owner-master'});
        const credential=(await user('POST','/connectors',{id:'settings-connector',projectIds:[p.id]})).json().token;
        const send=(path:string,payload:unknown)=>app.inject({method:'POST',url:'/api/workbench/connector'+path,headers:{authorization:`Bearer ${credential}`},payload:payload as never});
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
        await app.inject({method:'POST',url:`/api/workbench/projects/${p.id}/messages`,headers:{cookie:String(login.headers['set-cookie']).split(';')[0]!},payload:{text:'Change settings',requestId:'settings-member-master'}});
        const memberRun=(await send('/claim',{})).json().run;
        expect((await tool(memberRun,{settingId:profile.id,expectedUpdatedAt:profile.updatedAt,name:'Escalate'},'member-workspace')).statusCode).toBe(403);
        expect((await tool(memberRun,{settingId:skill.id,expectedUpdatedAt:updated.updatedAt,name:'Escalate'},'member-project')).statusCode).toBe(403);
    });
    it('reflects active Work progress and kind-filtered capacity without treating a turn as done',async()=>{
        const p=(await user('POST','/projects',{name:'Work activity proof'})).json();
        const work=(await user('POST',`/projects/${p.id}/works`,{title:'Current progress'})).json();
        await user('POST',`/projects/${p.id}/messages`,{workId:work.id,text:'Implement one step',requestId:'activity-implementation'});
        const credential=(await user('POST','/connectors',{id:'activity-connector',projectIds:[p.id]})).json().token;
        const send=(path:string,payload:unknown)=>app.inject({method:'POST',url:'/api/workbench/connector'+path,headers:{authorization:`Bearer ${credential}`},payload:payload as never});
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
        const work=checkedJson((await user('POST',`/projects/${p.id}/works`,{title:'Create a bounded draft'}))) as Work;
        const connector=checkedJson((await user('POST','/connectors',{id:'draft-pr-connector',projectIds:[p.id]})));
        const connRequest=(path:string,payload:unknown)=>app.inject({method:'POST',url:'/api/workbench/connector'+path,headers:{authorization:`Bearer ${connector.token}`},payload:payload as never});
        expect((await connRequest('/claim',{capabilities:{git:true,githubWrite:true,deliveryActions:['create_draft_pr']}})).statusCode).toBe(204);
        const connection=await user('POST','/settings',{projectId:p.id,kind:'connection',name:'Draft PR delivery',data:{provider:'github',url:p.repositoryUrl,purpose:'delivery',baseBranch:'main',allowDraftPr:true}});
        expect(connection.statusCode).toBe(200);
        const sourceConnection=await user('POST','/settings',{projectId:p.id,kind:'connection',name:'GitHub source',data:{provider:'github',url:p.repositoryUrl}});
        expect(sourceConnection.statusCode).toBe(200);
        const invite=checkedJson((await user('POST','/invites',{email:'draft-pr-member@test.example',projectId:p.id,role:'member'})));
        const accepted=await app.inject({method:'POST',url:'/api/workbench/invites/accept',payload:{token:invite.token,name:'Draft PR member',password:'draft-pr-password'}});
        checkedJson(accepted);const login=await app.inject({method:'POST',url:'/api/workbench/session',payload:{email:'draft-pr-member@test.example',password:'draft-pr-password'}});checkedJson(login);const memberCookie=String(login.headers['set-cookie']).split(';')[0]!;
        const memberReq=(method:'GET'|'POST'|'PATCH',path:string,payload?:unknown)=>app.inject({method,url:'/api/workbench'+path,headers:{cookie:memberCookie},payload:payload as never});
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
        const other=checkedJson((await user('POST','/projects',{name:'Other candidate scope'}))) as Project;const otherWork=checkedJson((await user('POST',`/projects/${other.id}/works`,{title:'Other project candidate'}))) as Work;
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
        const prCreated=await deliveryClient.deliveryProgress(memberDelivery.id,memberDelivery.generation,{phase:'pr_created',pullRequestNumber:42,pullRequestUrl:`${p.repositoryUrl}/pull/42`,headSha:secondSha});
        expect(prCreated).toMatchObject({run:{id:memberDelivery.id,generation:memberDelivery.generation,operation:{phase:'pr_created'}},artifact:{kind:'delivery',revision:secondRevision,data:{phase:'pr_created',pullRequestNumber:42}}});
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
    it('reviewer bridge reads exact candidate evidence and denies wider reads or mutations',async()=>{
        const p=(await user('POST','/projects',{name:'Scoped review proof'})).json();
        const work=(await user('POST',`/projects/${p.id}/works`,{title:'Review candidate'})).json();
        const other=(await user('POST',`/projects/${p.id}/works`,{title:'Private other Work'})).json();
        const credential=(await user('POST','/connectors',{id:'review-bridge-connector',projectIds:[p.id]})).json().token;
        const send=(path:string,payload:unknown,bearer=credential)=>app.inject({method:'POST',url:'/api/workbench/connector'+path,headers:{authorization:`Bearer ${bearer}`},payload:payload as never});
        await user('POST',`/projects/${p.id}/messages`,{workId:work.id,text:'Implement candidate',requestId:'review-bridge-implementation'});
        const candidate=(await send('/claim',{})).json().run;
        const diff=await send(`/runs/${candidate.id}/artifacts`,{generation:candidate.generation,kind:'diff',revision:'exact-candidate-revision',data:{files:[{path:'src/example.ts',added:1,removed:0,lines:['+ actual evidence']}],candidateFingerprint:'candidate-bytes'},requestId:'candidate-diff'});
        expect(diff.statusCode).toBe(200);
        await send(`/runs/${candidate.id}/complete`,{generation:candidate.generation,threadId:'candidate-thread'});
        const master=(await send('/claim',{})).json().run;
        const invalid=await send(`/runs/${master.id}/tools`,{generation:master.generation,action:'dispatch',input:{workId:work.id,kind:'review',model:'gpt-6.1-sol',prompt:'x'.repeat(12001)},requestId:'oversized-review'});
        expect(invalid.statusCode).toBe(400);
        expect(invalid.json().issues).toEqual([{path:['prompt'],code:'too_big'}]);
        expect(invalid.body).not.toContain('x'.repeat(100));
        const review=(await send(`/runs/${master.id}/tools`,{generation:master.generation,action:'dispatch',input:{workId:work.id,kind:'review',model:'gpt-6.1-sol',prompt:'Review exact evidence'},requestId:'dispatch-review'})).json();
        await send(`/runs/${master.id}/complete`,{generation:master.generation,threadId:'master-thread'});
        const claimed=(await send('/claim',{capabilities:{runKinds:['review']}})).json().run;
        expect(claimed.id).toBe(review.id);
        const bridge=(await send(`/runs/${claimed.id}/bridge-token`,{generation:claimed.generation})).json().token;
        const tool=(action:string,input:unknown)=>send(`/runs/${claimed.id}/tools`,{generation:claimed.generation,action,input,requestId:crypto.randomUUID()},bridge);
        const evidence=await tool('read_run',{runId:candidate.id});
        expect(evidence.statusCode).toBe(200);
        expect(evidence.json().artifacts[0].data.files[0].lines).toEqual(['+ actual evidence']);
        expect((await tool('read_work',{workId:work.id})).statusCode).toBe(200);
        expect((await tool('read_work',{workId:other.id})).statusCode).toBe(403);
        expect((await tool('read_run',{runId:master.id})).statusCode).toBe(403);
        expect((await tool('read_context',{})).statusCode).toBe(403);
        expect((await tool('create_skill',{name:'Escalate',data:{content:'No'}})).statusCode).toBe(403);
        expect((await send('/claim',{},bridge)).statusCode).toBe(401);
    });
    it('Master partial Work updates preserve omitted overview/status and allow explicit clearing',async()=>{
        const p=checkedJson((await user('POST','/projects',{name:'Partial Work update proof'})));
        const work=checkedJson((await user('POST',`/projects/${p.id}/works`,{title:'Preserve definition',overview:'Original task definition',sources:['source:original']})));
        await user('POST',`/projects/${p.id}/messages`,{text:'Update only current progress',requestId:'partial-work-master'});
        const credential=checkedJson((await user('POST','/connectors',{id:'partial-work-connector',projectIds:[p.id]}))).token;
        const send=(path:string,payload:unknown)=>app.inject({method:'POST',url:'/api/workbench/connector'+path,headers:{authorization:`Bearer ${credential}`},payload:payload as never});
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
            const work=(await user('POST',`/projects/${project.id}/works`,{title:'Use the shared profile',profileId:profile.id})).json();
            const dispatched=await user('POST',`/projects/${project.id}/messages`,{workId:work.id,text:'Use reusable instructions',requestId:`shared-profile-${project.id}`});
            expect(dispatched.statusCode).toBe(200);
            expect(dispatched.json().run.execution.skills).toEqual([{id:global.id,name:'Reusable instructions',content:'All authorized Projects'}]);
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
 it('unknown routes remain anonymous even with a valid session',async()=>{
  const key=rateLimitKey(sql);
  expect(await key({ip:'127.0.0.23',routeOptions:{url:'/*'},headers:{cookie}} as FastifyRequest)).toBe('ip:127.0.0.23');
 });
});
