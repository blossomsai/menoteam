import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import type { Sql } from 'postgres';
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { WorkbenchStore } from "./store.js";
import { collectSkillBundle, skillMarkdown, bytesHash, SKILL_BOUNDS } from "./skill-bundle.js";
import type { Project, Message, Setting } from "./types.js";
import { verifySlackRequest } from "../gateway/slack-events.js";
interface SourceOptions {
    githubToken?: string;
    githubWebhookSecret?: string;
    slackSigningSecret?: string;
    authorize(req: FastifyRequest, projectId?: string, edit?:boolean): Promise<void>;
    fetcher?: typeof fetch;
    onIntake?(projectId:string,sourceId:string,tx:Sql):Promise<void>;
}
function fail(statusCode: number, message: string): never {
    throw Object.assign(new Error(message), {
        statusCode
    });
}

const MAX_SOURCE_BYTES = 64_000;
const MAX_CATALOG_BYTES = 256_000;
const MAX_SKILLS = 40;
const yaml = createRequire(import.meta.url)("js-yaml") as { load(value: string, options: { schema: unknown, json: boolean }): unknown; JSON_SCHEMA: unknown };
const publicHttpsUrl = z.string().url().refine(value => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash; }, 'Use an HTTPS URL without credentials or query parameters');
const githubRepo = z.string().url().max(2000).refine(value => {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password && !url.search && !url.hash && /^\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/?$/.test(url.pathname) && !url.pathname.includes('..');
}, 'Use a public GitHub repository URL');

function safeRepoPath(value: string): string {
    const path = value.replace(/^\.\//, '').replace(/\/$/, '');
    if (!path || path.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\\')) || path.startsWith('/')) fail(400, 'Invalid repository path');
    return path;
}

function parseSkillMarkdown(content: string, directoryName: string | undefined) {
    if (Buffer.byteLength(content) > MAX_SOURCE_BYTES || !content.trim()) fail(400, 'Skill content must be nonempty and at most 64 KB');
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(content);
    if (!match) fail(400, 'SKILL.md requires YAML frontmatter');
    let fields: unknown;
    try { fields = yaml.load(match[1]!, { schema: yaml.JSON_SCHEMA, json: false }); } catch { return fail(400, 'SKILL.md YAML frontmatter is invalid'); }
    const parsed = z.object({ name: z.string().min(1).max(64), description: z.string().min(1).max(1024), license: z.string().max(1024).optional(), compatibility: z.string().max(500).optional(), metadata: z.record(z.string(), z.string()).optional(), 'allowed-tools': z.string().max(500).optional() }).strict().safeParse(fields);
    if (!parsed.success || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(parsed.data.name) || parsed.data.name.includes('--') || (directoryName !== undefined && parsed.data.name !== directoryName) || !parsed.data.description.trim()) fail(400, 'SKILL.md frontmatter does not match the Agent Skills schema');
    return { ...parsed.data, body: match[2]! };
}

function sha256(value: string) { return createHash('sha256').update(value).digest('hex'); }
export async function registerSourceRoutes(app: FastifyInstance, store: WorkbenchStore, options: SourceOptions) {
    const fetcher = options.fetcher ?? fetch;
    async function githubJson<T>(url: string, maxBytes = MAX_SOURCE_BYTES): Promise<T> {
        const response = await fetcher(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'menoteam-workbench', ...(options.githubToken ? { authorization: `Bearer ${options.githubToken}` } : {}) }, redirect: 'error', signal: AbortSignal.timeout(15000) });
        if (!response.ok) fail(502, `GitHub catalog source unavailable (${response.status})`);
        const reader = response.body?.getReader();
        if (!reader) fail(502, 'GitHub response has no readable body');
        const chunks: Uint8Array[] = []; let size = 0;
        try {
            if (Number(response.headers.get('content-length')) > maxBytes) { await reader.cancel('GitHub response exceeds the supported size').catch(() => undefined); fail(400, 'GitHub response exceeds the supported size'); }
            while (true) {
                const next = await reader.read(); if (next.done) break;
                size += next.value.byteLength;
                if (size > maxBytes) { await reader.cancel('GitHub response exceeds the supported size').catch(() => undefined); fail(400, 'GitHub response exceeds the supported size'); }
                chunks.push(next.value);
            }
        } finally { reader.releaseLock(); }
        let raw: string;
        try { raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); } catch { fail(400, 'GitHub response is not valid UTF-8'); }
        try { return JSON.parse(raw) as T; } catch { return fail(400, 'GitHub response is not valid JSON'); }
    }
    async function resolveCommit(owner: string, repo: string, ref: string) {
        if (!ref || ref.length > 255 || /[\0\r\n]/u.test(ref)) fail(400, 'Invalid GitHub ref');
        const result = await githubJson<{ sha?: string }>(`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`);
        if (!/^[a-f0-9]{40}$/u.test(result.sha ?? '') || (/^[a-f0-9]{40}$/u.test(ref) && result.sha !== ref)) fail(502, 'GitHub did not return the requested immutable commit SHA');
        return result.sha!;
    }
    async function gitTree(owner: string, repo: string, commit: string) {
        const tree = await githubJson<{ truncated?: boolean; tree?: Array<{ path: string; type: string; mode?: string; sha: string; size?: number }> }>(`https://api.github.com/repos/${owner}/${repo}/git/trees/${commit}?recursive=1`, 8_000_000);
        if (tree.truncated !== false || !Array.isArray(tree.tree) || tree.tree.length > 100_000) fail(400, 'GitHub tree is truncated or too large');
        const entries = z.array(z.object({ path: z.string().min(1).max(1000), type: z.enum(['blob', 'tree', 'commit']), mode: z.string().regex(/^(040000|100644|100755|120000|160000)$/u), sha: z.string().regex(/^[a-f0-9]{40}$/u), size: z.number().int().nonnegative().optional() }).passthrough()).parse(tree.tree);
        const names = new Set<string>();
        for (const item of entries) { if (safeRepoPath(item.path) !== item.path || names.has(item.path.toLowerCase())) fail(400, 'Duplicate or ambiguous repository path'); names.add(item.path.toLowerCase()); }
        return entries;
    }
    async function gitBytes(owner: string, repo: string, blob: string, limit = MAX_SOURCE_BYTES) {
        if (!/^[a-f0-9]{40}$/u.test(blob)) fail(400, 'GitHub returned an invalid blob identifier');
        const result = await githubJson<{ encoding?: string; content?: string; size?: number }>(`https://api.github.com/repos/${owner}/${repo}/git/blobs/${blob}`, limit * 2);
        if (result.encoding !== 'base64' || typeof result.content !== 'string' || typeof result.size !== 'number' || result.size > limit) fail(400, 'Repository file is invalid or exceeds the supported size');
        const base64 = result.content.replace(/\s/gu, '');
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(base64)) fail(400, 'GitHub returned invalid base64 content');
        const bytes = Buffer.from(base64, 'base64');
        if (bytes.length !== result.size || bytes.length > limit) fail(400, 'Repository file was incomplete or exceeds the supported size');
        return bytes;
    }
    async function gitText(owner: string, repo: string, blob: string, limit = MAX_SOURCE_BYTES) {
        const bytes = await gitBytes(owner, repo, blob, limit);
        try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return fail(400, 'Repository file must contain complete UTF-8 text'); }
    }
    function parseCatalogUrl(value: string) {
        const url = new URL(value); const parts = url.pathname.split('/').filter(Boolean);
        if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.search || url.hash || parts.length < 5 || parts[2] !== 'blob') fail(400, 'Use a GitHub URL to .agents/plugins/marketplace.json');
        const [owner, repo, , encodedRef, ...file] = parts;
        let ref: string;
        try { ref = decodeURIComponent(encodedRef ?? ''); } catch { return fail(400, 'Invalid GitHub ref encoding'); }
        if (!owner || !repo || !ref || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u.test(owner) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u.test(repo) || owner.includes('..') || repo.includes('..')) fail(400, 'Invalid GitHub catalog URL');
        const path = safeRepoPath(file.join('/'));
        if (path !== '.agents/plugins/marketplace.json' && path !== '.claude-plugin/marketplace.json' && path !== 'marketplace.json') fail(400, 'URL must point to a supported marketplace.json');
        return { owner, repo, ref, path };
    }
    async function marketplacePreview(catalogUrl: string) {
        const catalog = parseCatalogUrl(catalogUrl); const commit = await resolveCommit(catalog.owner, catalog.repo, catalog.ref); const tree = await gitTree(catalog.owner, catalog.repo, commit);
        const catalogFile = tree.find(item => item.path === catalog.path && item.type === 'blob' && item.mode !== '120000');
        if (!catalogFile || (catalogFile.size ?? MAX_CATALOG_BYTES + 1) > MAX_CATALOG_BYTES) fail(400, 'Marketplace file is missing or too large');
        let data: { name?: unknown; plugins?: unknown };
        try { data = JSON.parse(await gitText(catalog.owner, catalog.repo, catalogFile.sha, MAX_CATALOG_BYTES)) as typeof data; } catch { return fail(400, 'Marketplace JSON is invalid'); }
        if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 120 || !Array.isArray(data.plugins) || data.plugins.length > 300) fail(400, 'Marketplace metadata is invalid');
        const plugins = data.plugins.map(raw => {
            const item = z.object({ name: z.string().min(1).max(120), category: z.string().min(1).max(80), policy: z.object({ installation: z.enum(['AVAILABLE', 'INSTALLED_BY_DEFAULT', 'NOT_AVAILABLE']), authentication: z.enum(['ON_INSTALL', 'ON_FIRST_USE']) }).strict(), source: z.unknown() }).passthrough().parse(raw);
            const description = typeof (raw as Record<string, unknown>).description === 'string' ? String((raw as Record<string, unknown>).description).slice(0, 1024) : '';
            const unsupported = (sourceKind: string, reason = `Source type ${sourceKind} is catalog metadata only and is not installable here`) => ({ name: item.name, description, category: item.category, owner: '', repo: '', pluginPath: '', requestedRef: '', sourceKind, unsupportedReason: reason });
            if (typeof item.source === 'string') { safeRepoPath(item.source); return unsupported('local'); }
            if (!item.source || typeof item.source !== 'object' || Array.isArray(item.source)) fail(400, `Marketplace source is invalid for ${item.name}`);
            const sourceKind = (item.source as Record<string, unknown>).source;
            if (sourceKind === 'local') { z.object({ source: z.literal('local'), path: z.string().min(1).max(1000) }).strict().parse(item.source); return unsupported('local'); }
            if (sourceKind === 'npm') { z.object({ source: z.literal('npm'), package: z.string().min(1).max(255), version: z.string().max(255).optional(), registry: publicHttpsUrl.optional() }).strict().parse(item.source); return unsupported('npm'); }
            const source = z.object({ source: z.enum(['url', 'git-subdir']), url: githubRepo, path: z.string().optional(), ref: z.string().min(1).max(255).optional(), sha: z.string().regex(/^[a-f0-9]{40}$/u).optional() }).strict().parse(item.source);
            const sourceUrl = new URL(source.url); const [owner, rawRepo] = sourceUrl.pathname.split('/').filter(Boolean); const repo = rawRepo?.replace(/\.git$/u, '');
            if (source.source === 'url' && source.path !== undefined) fail(400, 'source:url resolves only the repository root');
            if (source.ref && source.sha) fail(400, 'Specify either ref or sha for a GitHub plugin source');
            const pluginPath = source.source === 'url' ? '' : safeRepoPath(source.path ?? '');
            if (!owner || !repo) fail(400, 'Invalid plugin repository URL');
            if (item.policy.installation === 'NOT_AVAILABLE') return unsupported(source.source, 'Marketplace policy marks this plugin NOT_AVAILABLE');
            return { name: item.name, description, category: item.category, owner, repo, pluginPath, requestedRef: source.sha ?? source.ref ?? '', sourceSha: source.sha, sourceKind: source.source, unsupportedReason: undefined };
        });
        if (new Set(plugins.map(plugin => plugin.name)).size !== plugins.length) fail(400, 'Marketplace plugin names must be unique');
        return { name: data.name, catalogUrl, catalogCommit: commit, plugins };
    }
    async function inspectPlugin(plugin: Awaited<ReturnType<typeof marketplacePreview>>['plugins'][number]) {
        if (plugin.unsupportedReason) fail(400, plugin.unsupportedReason);
        const repository = plugin.requestedRef ? undefined : await githubJson<{ default_branch?: string }>(`https://api.github.com/repos/${plugin.owner}/${plugin.repo}`);
        const requestedRef = plugin.requestedRef || repository?.default_branch;
        if (!requestedRef) fail(502, 'GitHub did not return a default branch');
        const commit = await resolveCommit(plugin.owner!, plugin.repo!, requestedRef);
        const tree = await gitTree(plugin.owner!, plugin.repo!, commit); const prefix = plugin.pluginPath ? `${plugin.pluginPath}/` : '';
        const entries = tree.filter(item => item.path.startsWith(prefix));
        const paths = entries.filter(item => item.type === 'blob' && item.mode !== '120000');
        const manifestPath = `${prefix}plugin.json`; const manifestFile = paths.find(item => item.path === manifestPath);
        if (!manifestFile || (manifestFile.size ?? MAX_SOURCE_BYTES + 1) > MAX_SOURCE_BYTES) fail(400, `Plugin ${plugin.name} has no supported root plugin.json`);
        let manifest: Record<string, unknown>;
        try { manifest = JSON.parse(await gitText(plugin.owner!, plugin.repo!, manifestFile.sha)) as Record<string, unknown>; } catch { return fail(400, `Plugin ${plugin.name} manifest JSON is invalid`); }
        const pluginManifest = z.object({ $schema: z.literal('https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'), name: z.string().min(1).max(64).regex(/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u), version: z.string().optional(), description: z.string().optional(), author: z.object({ name: z.string().optional(), email: z.string().optional(), url: z.string().optional() }).strict().optional(), homepage: z.string().optional(), repository: z.string().optional(), license: z.string().optional(), keywords: z.array(z.string()).optional(), extensions: z.record(z.string(), z.record(z.string(), z.unknown())).optional() }).strict();
        const parsedManifest = pluginManifest.safeParse(manifest);
        if (!parsedManifest.success || manifest.name !== plugin.name) fail(400, `Plugin ${plugin.name} manifest is invalid`);
        const unsupported: string[] = [];
        const extensions = manifest.extensions as Record<string, Record<string, unknown>> | undefined;
        for (const [namespace, values] of Object.entries(extensions ?? {})) for (const component of ['mcpServers', 'apps', 'hooks']) if (values[component] !== undefined) unsupported.push(`plugin.json:extensions.${namespace}.${component}`);
        const skillFiles = entries.filter(item => item.path.startsWith(`${prefix}skills/`) && item.path.endsWith('/SKILL.md'));
        if (skillFiles.length > MAX_SKILLS) fail(400, 'Plugin exceeds supported skill count');
        const skills: Array<{ name: string; description: string; license?: string; sourcePath: string; content: string; bundle?: Awaited<ReturnType<typeof collectSkillBundle>>; dependencyError?: string; contentSha256: string; sourceContentSha256?: string }> = [];
        for (const file of skillFiles) {
            const sourcePath = file.path;
            const root = sourcePath.slice(0, -'/SKILL.md'.length);
            let bundle: Awaited<ReturnType<typeof collectSkillBundle>> | undefined;
            let dependencyError: string | undefined;
            let content = ''; let metadata = { name: root.split('/').at(-1)!, description: '', license: undefined as string | undefined };
            try {
                bundle = await collectSkillBundle(tree, root, commit, entry => gitBytes(plugin.owner!, plugin.repo!, entry.sha, SKILL_BOUNDS.fileBytes));
                content = skillMarkdown(bundle);
                const parsed = parseSkillMarkdown(content, root.split('/').at(-1)!);
                metadata = { name: parsed.name, description: parsed.description, license: parsed.license };
            } catch (error) { dependencyError = error instanceof Error ? error.message : 'Skill bundle is invalid'; }
            skills.push({ ...metadata, sourcePath, content, bundle, dependencyError, contentSha256: bytesHash(content), sourceContentSha256: bundle?.sha256 });
        }
        // Skill regular files are supported bytes; plugin-level components remain uninstalled.
        unsupported.push(...entries.filter(item => item.type !== 'tree' && !skills.some(skill => item.path.startsWith(`${skill.sourcePath.slice(0, -'/SKILL.md'.length)}/`)) && item.path !== manifestPath && !item.path.endsWith('/README.md') && !item.path.endsWith('/LICENSE')).map(item => item.path));
        return { plugin: { ...plugin, description: plugin.description || String(manifest.description ?? '') , requestedRef }, commit, manifest, skills, unsupported: [...new Set(unsupported)] };
    }
    const catalogRequest = z.object({ scope: z.enum(['project', 'workspace']), projectId: z.string().min(1).optional(), catalogUrl: z.string().url().max(2000) }).superRefine((value, context) => {
        if (value.scope === 'project' && !value.projectId) context.addIssue({ code: 'custom', message: 'Project scope requires a project ID' });
        if (value.scope === 'workspace' && value.projectId) context.addIssue({ code: 'custom', message: 'Workspace scope cannot include a project ID' });
    });
    async function getPluginPreview(catalogUrl: string, pluginName: string) {
        const catalog = await marketplacePreview(catalogUrl); const plugin = catalog.plugins.find(item => item.name === pluginName);
        if (!plugin) fail(400, 'Plugin is not present in this marketplace');
        const inspected = await inspectPlugin(plugin);
        return { catalog, ...inspected };
    }
    app.post('/api/workbench/skills/catalog', async req => {
        const input = catalogRequest.parse(req.body); await options.authorize(req, input.projectId, input.scope === 'project');
        const catalog = await marketplacePreview(input.catalogUrl); await options.authorize(req, input.projectId, input.scope === 'project');
        return { name: catalog.name, url: catalog.catalogUrl, commit: catalog.catalogCommit, plugins: catalog.plugins.map(plugin => ({ name: plugin.name, description: plugin.description, category: plugin.category, ...(plugin.unsupportedReason ? { unsupportedReason: plugin.unsupportedReason } : {}) })) };
    });
    app.post('/api/workbench/skills/catalog/preview', async req => {
        const input = catalogRequest.parse(req.body); await options.authorize(req, input.projectId, input.scope === 'project');
        const body = z.object({ scope: z.enum(['project', 'workspace']), projectId: z.string().min(1).optional(), catalogUrl: z.string().url().max(2000), pluginName: z.string().min(1).max(120) }).strict().parse(req.body);
        const result = await getPluginPreview(body.catalogUrl, body.pluginName); await options.authorize(req, input.projectId, input.scope === 'project');
        return { catalog: { name: result.catalog.name, url: result.catalog.catalogUrl, commit: result.catalog.catalogCommit }, plugin: { name: result.plugin.name, description: result.plugin.description, commit: result.commit, version: result.manifest.version ?? null }, unsupported: result.unsupported, skills: result.skills.map(skill => ({ name: skill.name, description: skill.description, license: skill.license ?? null, path: skill.sourcePath, content: skill.content, includedReferences: [], bundleFiles: skill.bundle?.files.map(({ path, mode, bytes, sha256 }) => ({ path, mode, bytes, sha256 })) ?? [], bundleSha256: skill.bundle?.sha256, unsupportedDependency: skill.dependencyError, contentSha256: skill.contentSha256 })) };
    });
    app.post('/api/workbench/skills/catalog/import', async req => {
        const base = catalogRequest.parse(req.body); await options.authorize(req, base.projectId, true);
        const input = z.object({ scope: z.enum(['project', 'workspace']), projectId: z.string().min(1).optional(), catalogUrl: z.string().url().max(2000), pluginName: z.string().min(1).max(120), selectedPaths: z.array(z.string().min(1).max(500)).min(1).max(MAX_SKILLS), previewCommit: z.string().regex(/^[a-f0-9]{40}$/u), previewCatalogCommit: z.string().regex(/^[a-f0-9]{40}$/u) }).strict().parse(req.body);
        if (new Set(input.selectedPaths).size !== input.selectedPaths.length) fail(400, 'Duplicate selected skills are not allowed');
        const result = await getPluginPreview(input.catalogUrl, input.pluginName);
        if (input.previewCommit !== result.commit || input.previewCatalogCommit !== result.catalog.catalogCommit) fail(409, 'Catalog or plugin source changed after preview; preview again before importing');
        const selected = result.skills.filter(skill => input.selectedPaths.includes(skill.sourcePath));
        if (selected.length !== input.selectedPaths.length) fail(400, 'One or more selected skills are unavailable or invalid');
        const invalidDependency = selected.find(skill => skill.dependencyError);
        if (invalidDependency) fail(400, `${invalidDependency.name} cannot be installed completely: ${invalidDependency.dependencyError}`);
        if (selected.reduce((bytes, skill) => bytes + (skill.bundle?.bytes ?? 0), 0) > SKILL_BOUNDS.runBytes) fail(400, 'Selected bundles exceed byte limit');
        return store.transaction('catalog-skills-import', async tx => {
            await options.authorize(req, input.projectId, true);
            const existing = (await store.list<Setting>('setting', input.projectId, tx)).filter(item => item.projectId === input.projectId);
            const provenance = selected.map(skill => `${result.plugin.owner}/${result.plugin.repo}@${result.commit}:${skill.sourcePath}`);
            if (new Set(provenance).size !== provenance.length || existing.some(item => item.kind === 'skill' && provenance.includes(String(item.data.provenance)))) fail(409, 'One or more selected skills are already installed; no skills were imported');
            const installed = selected.map(skill => {
                const content = skill.content;
                const sourceUrl = `https://github.com/${result.plugin.owner}/${result.plugin.repo}/blob/${result.commit}/${skill.sourcePath}`;
                const record: Setting = { id: `setting_${crypto.randomUUID()}`, kind: 'skill', ...(input.projectId ? { projectId: input.projectId } : {}), name: skill.name, data: { content, bundle: skill.bundle, sourceUrl, enabled: true, installed: true, provenance: `${result.plugin.owner}/${result.plugin.repo}@${result.commit}:${skill.sourcePath}`, requestedRef: result.plugin.requestedRef, resolvedSha: result.commit, sourcePath: skill.sourcePath, contentSha256: skill.contentSha256, sourceContentSha256: skill.sourceContentSha256, catalogUrl: input.catalogUrl, catalogName: result.catalog.name, catalogResolvedSha: result.catalog.catalogCommit, pluginName: result.plugin.name, includedReferences: skill.bundle!.files.filter(f => f.path !== 'SKILL.md').map(f => f.path), unsupportedPluginComponents: result.unsupported }, updatedAt: new Date().toISOString() };
                return record;
            });
            for (const setting of installed) await store.put('setting', setting, tx);
            return { installed };
        });
    });
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
        const requestedRef = decodeURIComponent(ref!);
        const commit = await resolveCommit(owner!, repo!, requestedRef);
        const tree = await gitTree(owner!, repo!, commit);
        const sourcePath = safeRepoPath(path.join('/'));
        const root = sourcePath === 'SKILL.md' ? '' : sourcePath.slice(0, -'/SKILL.md'.length);
        const bundle = await collectSkillBundle(tree, root, commit, entry => gitBytes(owner!, repo!, entry.sha, SKILL_BOUNDS.fileBytes));
        const content = skillMarkdown(bundle);
        const metadata = parseSkillMarkdown(content, root ? root.split('/').at(-1)! : undefined);
        const skill:Setting={id:`setting_${crypto.randomUUID()}`,kind:'skill',projectId,name:input.name??metadata.name,data:{content,bundle,sourceUrl:input.url,enabled:true,installed:true,requestedRef,resolvedSha:commit,sourcePath,provenance:`${owner}/${repo}@${commit}:${sourcePath}`,contentSha256:bytesHash(content),sourceContentSha256:bundle.sha256},updatedAt:new Date().toISOString()};return store.transaction('skill-import',async tx=>{
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
