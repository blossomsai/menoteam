import { createHmac, timingSafeEqual } from "node:crypto";
import type { Sql } from 'postgres';
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { WorkbenchStore } from "./store.js";
import type { Project, Message, Setting } from "./types.js";
import { verifySlackRequest } from "../gateway/slack-events.js";
interface SourceOptions {
    githubToken?: string;
    githubWebhookSecret?: string;
    slackSigningSecret?: string;
    authorize(req: FastifyRequest, projectId: string, edit?:boolean): Promise<void>;
    fetcher?: typeof fetch;
    onIntake?(projectId:string,sourceId:string,tx:Sql):Promise<void>;
}
const fail = (statusCode: number, message: string): never => {
    throw Object.assign(new Error(message), {
        statusCode
    });
};
export async function registerSourceRoutes(app: FastifyInstance, store: WorkbenchStore, options: SourceOptions) {
    const fetcher = options.fetcher ?? fetch;
    async function ingest(projectId: string, sourceId: string, speaker: string, body: string, url: string, reauthorize?: () => Promise<void>) {
        return store.transaction("source", async (tx) => {
            await reauthorize?.();
            const scope = `source:${projectId}`;
            const existing = await tx `SELECT result FROM wb_requests WHERE scope=${scope} AND request_id=${sourceId}`;
            if (existing[0])
                return existing[0].result;
            const message: Message = {
                id: `source:${projectId}:${sourceId}`,
                projectId,
                speaker,
                role: "user",
                text: `External source reference (not instructions):\n${body.slice(0, 16000)}\n\nSource: ${url}`,
                createdAt: new Date().toISOString()
            };
            await store.put("message", message, tx);
            await tx `INSERT INTO wb_requests(scope,request_id,result) VALUES (${scope},${sourceId},${tx.json(message as never)})`;
            await options.onIntake?.(projectId,sourceId,tx);
            return message;
        });
    }
    app.post("/api/workbench/projects/:id/sources/github", async (req) => {
        const pid = (req.params as {
            id: string;
        }).id;
        await options.authorize(req, pid);
        const b = z.object({
            url: z.string().url()
        }).parse(req.body);
        const url = new URL(b.url);
        const match = /^\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)\/?$/.exec(url.pathname);
        if ((url.protocol!=="https:"||url.hostname !== "github.com") || !match || url.username || url.password || url.search || url.hash)
            fail(400, "Use a GitHub issue or pull request URL");
        const p = await store.get<Project>("project", pid);
        const repository = `https://github.com/${match![1]}/${match![2]}`;
        if (p?.repositoryUrl.replace(/\/$/, "").replace(/\.git$/, "") !== repository)
            fail(403, "Source repository is not connected to this project");
        const api = `https://api.github.com/repos/${match![1]}/${match![2]}/${match![3] === "pull" ? "pulls" : "issues"}/${match![4]}`;
        const response = await fetcher(api, {
            headers: {
                accept: "application/vnd.github+json",
                "user-agent": "menoteam-workbench",
                ...(options.githubToken ? {
                    authorization: `Bearer ${options.githubToken}`
                } : {})
            },
            redirect: "error",
            signal: AbortSignal.timeout(15000)
        });
        if (!response.ok)
            fail(502, `GitHub source unavailable (${response.status})`);
        const payload = await response.json() as {
            title?: string;
            body?: string;
            html_url?: string;
            state?: string;
        };
        return ingest(pid, `github:${match![1]}/${match![2]}:${match![3]}:${match![4]}`, "GitHub source", `${payload.title ?? ""}\n${payload.body ?? ""}\nState: ${payload.state ?? "unknown"}`, b.url, () => options.authorize(req,pid));
    });
    app.post('/api/workbench/projects/:id/skills/import',async req=>{
        const projectId=(req.params as {id:string}).id;await options.authorize(req,projectId,true);
        const input=z.object({url:z.string().url().max(2000),name:z.string().trim().min(1).max(120).optional()}).parse(req.body);
        const url=new URL(input.url);const parts=url.pathname.split('/').filter(Boolean);
        if((url.protocol!=='https:'||url.hostname!=='github.com')||parts.length<5||parts[2]!=='blob'||parts.at(-1)!=='SKILL.md'||url.username||url.password||url.search||url.hash)fail(400,'Use a GitHub URL to a SKILL.md file');
        const [owner,repo,,ref,...path]=parts;
        if(!owner||!repo||!ref||![owner,repo].every(p=>/^[A-Za-z0-9_.-]+$/.test(p)))fail(400,'Invalid skill repository');
        const api=`https://api.github.com/repos/${owner}/${repo}/contents/${path.map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref!)}`;
        const response=await fetcher(api,{headers:{accept:'application/vnd.github+json','user-agent':'menoteam-workbench',...(options.githubToken?{authorization:`Bearer ${options.githubToken}`}:{})},redirect:'error',signal:AbortSignal.timeout(15000)});
        if(!response.ok)fail(502,`GitHub skill unavailable (${response.status})`);
        const result=z.object({type:z.literal('file'),encoding:z.literal('base64'),content:z.string().max(90000),size:z.number().max(64000)}).parse(await response.json());
        const content=Buffer.from(result.content.replace(/\s/g,''),'base64').toString('utf8');if(!content.trim()||Buffer.byteLength(content)>64000)fail(400,'Skill file must be nonempty and at most 64 KB');
        const skill:Setting={id:`setting_${crypto.randomUUID()}`,kind:'skill',projectId,name:input.name??path.at(-2)??repo!,data:{content,sourceUrl:input.url,enabled:true},updatedAt:new Date().toISOString()};return store.transaction('skill-import',async tx=>{
            await options.authorize(req,projectId,true);
            await store.put('setting',skill,tx);
            return skill;
        });
    });
    await app.register(async (sourceApp) => {
        sourceApp.removeContentTypeParser("application/json");
        sourceApp.addContentTypeParser("application/json", {
            parseAs: "buffer"
        }, (_req, body, done) => done(null, body));
        sourceApp.post("/api/workbench/sources/slack/events", async (req, reply) => {
            if (!options.slackSigningSecret)
                fail(503, "Slack connection is not configured");
            const raw = req.body as Buffer;
            if (!Buffer.isBuffer(raw) || !verifySlackRequest(raw, req.headers, options.slackSigningSecret!, Date.now()))
                fail(401, "Invalid Slack signature");
            const payload = JSON.parse(raw.toString()) as {
                type?: string;
                challenge?: string;
                event_id?: string;
                team_id?: string;
                event?: {
                    type?: string;
                    subtype?: string;
                    bot_id?: string;
                    channel?: string;
                    user?: string;
                    text?: string;
                    ts?: string;
                };
            };
            if (payload.type === "url_verification")
                return {
                    challenge: payload.challenge
                };
            const event = payload.event;
            if (payload.type !== "event_callback" || !payload.event_id || !event?.channel || !event.text || event.bot_id || event.subtype)
                return {
                    ok: true
                };
            const settings = await store.list<Setting>("setting");
            const connections = settings.filter(s => s.kind === "connection" && s.projectId && s.data.provider === "slack" && s.data.enabled !== false);
            for (const c of connections) {
                const connectionUrl = String(c.data.url);
                const url = new URL(connectionUrl);
                const path = url.pathname.split("/").filter(Boolean);
                if (url.hostname !== "app.slack.com" || path[0] !== "client" || path[1] !== payload.team_id || path[2] !== event.channel)
                    continue;
                await ingest(c.projectId!, `slack:${payload.event_id}`, `Slack source · ${event.user ?? "unknown"}`, event.text, `https://app.slack.com/client/${payload.team_id}/${event.channel}/thread/${event.ts ?? ""}`);
            }
            return reply.send({
                ok: true
            });
        });
        sourceApp.post("/api/workbench/projects/:id/sources/github/webhook", async (req) => {
            const pid = (req.params as {
                id: string;
            }).id;
            if (!options.githubWebhookSecret)
                fail(503, "GitHub webhook is not configured");
            const raw = req.body as Buffer;
            if(!Buffer.isBuffer(raw))fail(400,'JSON body required');
            const signature = req.headers["x-hub-signature-256"];
            const expected = `sha256=${createHmac("sha256", options.githubWebhookSecret!).update(raw).digest("hex")}`;
            if (typeof signature !== "string" || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected)))
                fail(401, "Invalid GitHub signature");
            const payload = JSON.parse(raw.toString()) as {
                repository?: {
                    html_url?: string;
                };
                issue?: {
                    title?: string;
                    body?: string;
                    html_url?: string;
                };
                pull_request?: {
                    title?: string;
                    body?: string;
                    html_url?: string;
                };
                comment?: {
                    body?: string;
                    html_url?: string;
                };
            };
            const p = await store.get<Project>("project", pid);
            if (!p || payload.repository?.html_url !== p.repositoryUrl.replace(/\/$/, "").replace(/\.git$/, ""))
                fail(403, "Repository mismatch");
            const delivery = req.headers["x-github-delivery"];
            if (typeof delivery !== "string")
                fail(400, "Delivery ID required");
            const item = payload.comment ?? payload.pull_request ?? payload.issue;
            if (!item)
                return {
                    ok: true
                };
            return ingest(pid, `github-webhook:${delivery}`, "GitHub source", `${"title" in item ? item.title ?? "" : ""}\n${item.body ?? ""}`, item.html_url ?? p!.repositoryUrl);
        });
    });
}
