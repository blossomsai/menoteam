import postgres from "postgres";
import { readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { migrate } from "../db/migrate.js";
import { createWorkbenchApp } from "./app.js";
import { processSlackReplies } from './slack-replies.js';
import { WorkbenchStore } from './store.js';
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl)
    throw new Error("DATABASE_URL required");
await migrate(databaseUrl);
const sql = postgres(databaseUrl, {
    max: 5
});
const app = await createWorkbenchApp({
    sql,
    bootstrapEmail: process.env.WORKBENCH_BOOTSTRAP_EMAIL,
    bootstrapPassword: process.env.WORKBENCH_BOOTSTRAP_PASSWORD,
    secureCookies: process.env.WORKBENCH_SECURE_COOKIES === "true" || process.env.WORKBENCH_ORIGIN?.startsWith("https://"),
    allowedOrigin: process.env.WORKBENCH_ORIGIN,
    registerAssets: async (app) => {
        const root = resolve("dist/workbench/web");
        app.get("/workbench/", async (_req, reply) => reply.type("text/html").send(await readFile(resolve(root, "index.html"))));
        app.get("/workbench/assets/*", async (req, reply) => {
            const name = (req.params as {
                "*": string;
            })["*"];
            const path = resolve(root, "assets", name);
            if (relative(root, path).startsWith("..") || !/[.](js|css|svg|png|woff2)$/.test(path))
                return reply.code(404).send();
            try {
                return reply.type(path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "application/octet-stream").send(await readFile(path));
            }
            catch {
                return reply.code(404).send();
            }
        });
    }
});
const slackToken=process.env.WORKBENCH_SLACK_BOT_TOKEN;
let slackBusy=false;
const slackTimer=slackToken?setInterval(()=>{
    if(slackBusy)return;
    slackBusy=true;
    void processSlackReplies(new WorkbenchStore(sql),{token:slackToken}).catch(()=>{app.log.error('Slack reply worker failed');}).finally(()=>{slackBusy=false;});
},1000):undefined;
slackTimer?.unref();
app.addHook('onClose',async()=>{if(slackTimer)clearInterval(slackTimer);});
await app.listen({
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 3200)
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
        void app.close().then(() => sql.end()).then(() => process.exit(0));
    });
