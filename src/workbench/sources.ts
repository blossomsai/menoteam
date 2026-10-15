import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import type { Sql } from 'postgres';
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { WorkbenchStore } from "./store.js";
import { collectSkillBundle, skillMarkdown, bytesHash, gitBlobHash, SKILL_BOUNDS } from "./skill-bundle.js";
import type { SkillTreeEntry } from "./skill-bundle-types.js";
import type { Project, Message, Setting, RunOrigin } from "./types.js";
import { verifySlackRequest } from "../gateway/slack-events.js";
interface SourceOptions {
    githubToken?: string;
    githubWebhookSecret?: string;
    slackSigningSecret?: string;
    authorize(req: FastifyRequest, projectId?: string, edit?:boolean): Promise<void>;
    fetcher?: typeof fetch;
    authorizeIntake?(projectId:string,actorId:string,tx:Sql):Promise<boolean>;
    onIntake?(projectId:string,sourceId:string,tx:Sql,origin?:RunOrigin):Promise<void>;
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
    async function githubJson<T>(url: string, maxBytes = MAX_SOURCE_BYTES, signal?: AbortSignal): Promise<T> {
        let response: Response;
        try { response = await fetcher(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'menoteam-workbench', ...(options.githubToken ? { authorization: `Bearer ${options.githubToken}` } : {}) }, redirect: 'error', signal: signal ?? AbortSignal.timeout(15000) }); }
        catch (error) { fail(502, error instanceof Error && error.name === 'TimeoutError' ? 'GitHub source request timed out' : 'GitHub source request failed'); }
        if (!response.ok) fail(502, `GitHub source unavailable (${response.status})`);
        const reader = response.body?.getReader();
        if (!reader) fail(502, 'GitHub response has no readable body');
        const chunks: Uint8Array[] = []; let size = 0;
        try {
            if (Number(response.headers.get('content-length')) > maxBytes) { await reader.cancel('GitHub response exceeds the supported size').catch(() => undefined); fail(400, 'GitHub response exceeds the supported size'); }
            try { while (true) {
                const next = await reader.read(); if (next.done) break;
                size += next.value.byteLength;
                if (size > maxBytes) { await reader.cancel('GitHub response exceeds the supported size').catch(() => undefined); fail(400, 'GitHub response exceeds the supported size'); }
                chunks.push(next.value);
            } } catch (error) { if ((error as { statusCode?: number }).statusCode) throw error; fail(502, signal?.aborted ? 'GitHub source request timed out' : 'GitHub source response failed'); }
        } finally { reader.releaseLock(); }
        let raw: string;
        try { raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); } catch { fail(400, 'GitHub response is not valid UTF-8'); }
        try { return JSON.parse(raw) as T; } catch { return fail(400, 'GitHub response is not valid JSON'); }
    }
    async function resolveCommit(owner: string, repo: string, ref: string, signal?: AbortSignal) {
        if (!ref || ref.length > 255 || /[\0\r\n]/u.test(ref)) fail(400, 'Invalid GitHub ref');
        const result = await githubJson<{ sha?: string }>(`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`, MAX_SOURCE_BYTES, signal);
        if (!/^[a-f0-9]{40}$/u.test(result.sha ?? '') || (/^[a-f0-9]{40}$/u.test(ref) && result.sha !== ref)) fail(502, 'GitHub did not return the requested immutable commit SHA');
        return result.sha!;
    }
    async function gitTree(owner: string, repo: string, commit: string, signal?: AbortSignal) {
        const tree = await githubJson<{ truncated?: boolean; tree?: Array<{ path: string; type: string; mode?: string; sha: string; size?: number }> }>(`https://api.github.com/repos/${owner}/${repo}/git/trees/${commit}?recursive=1`, 8_000_000, signal);
        if (tree.truncated !== false || !Array.isArray(tree.tree) || tree.tree.length > 100_000) fail(400, 'GitHub tree is truncated or too large');
        const entries = z.array(z.object({ path: z.string().min(1).max(1000), type: z.enum(['blob', 'tree', 'commit']), mode: z.string().regex(/^(040000|100644|100755|120000|160000)$/u), sha: z.string().regex(/^[a-f0-9]{40}$/u), size: z.number().int().nonnegative().optional() }).passthrough()).parse(tree.tree);
        const names = new Set<string>();
        for (const item of entries) { if (safeRepoPath(item.path) !== item.path || names.has(item.path.toLowerCase())) fail(400, 'Duplicate or ambiguous repository path'); names.add(item.path.toLowerCase()); }
        return entries;
    }
    async function gitBytes(owner: string, repo: string, blob: string, limit = MAX_SOURCE_BYTES, signal?: AbortSignal) {
        if (!/^[a-f0-9]{40}$/u.test(blob)) fail(400, 'GitHub returned an invalid blob identifier');
        const result = await githubJson<{ encoding?: string; content?: string; size?: number }>(`https://api.github.com/repos/${owner}/${repo}/git/blobs/${blob}`, limit * 2, signal);
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
    async function publicGitBytes(owner: string, repo: string, commit: string, entry: { path: string; sha: string; size?: number }, limit: number, signal: AbortSignal) {
        if (!Number.isSafeInteger(entry.size) || entry.size! > limit) fail(400, 'Repository file exceeds the supported size');
        const path = entry.path.split('/').map(encodeURIComponent).join('/');
        let response: Response;
        try { response = await fetcher(`https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${commit}/${path}`, { redirect: 'error', signal }); }
        catch (error) { fail(502, error instanceof Error && error.name === 'TimeoutError' ? 'GitHub raw source request timed out' : 'GitHub raw source request failed'); }
        if (!response.ok) fail(502, `GitHub raw source unavailable (${response.status})`);
        const reader = response.body?.getReader(); if (!reader) fail(502, 'GitHub raw response has no readable body');
        const chunks: Uint8Array[] = []; let size = 0;
        try { try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > Math.min(entry.size!, limit)) { await reader.cancel().catch(() => undefined); fail(400, 'Repository file exceeds its immutable tree size'); } chunks.push(next.value); } } catch (error) { if ((error as { statusCode?: number }).statusCode) throw error; fail(502, signal.aborted ? 'GitHub raw source request timed out' : 'GitHub raw source response failed'); } } finally { reader.releaseLock(); }
        const bytes = Buffer.concat(chunks);
        if (bytes.length !== entry.size || gitBlobHash(bytes) !== entry.sha) fail(400, 'Git blob is incomplete or does not match immutable tree');
        return bytes;
    }
    async function repoInfo(owner: string, repo: string, signal: AbortSignal, visibility: Map<string, { private: boolean; default_branch?: string }>) {
        const key = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
        if (visibility.has(key)) return visibility.get(key)!;
        const result = await githubJson<{ private?: boolean; default_branch?: string }>(`https://api.github.com/repos/${owner}/${repo}`, MAX_SOURCE_BYTES, signal);
        if (typeof result.private !== 'boolean') fail(502, 'GitHub did not confirm repository visibility');
        const info = { private: result.private, default_branch: result.default_branch };
        visibility.set(key, info);
        return info;
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
    async function marketplacePreview(catalogUrl: string, deadline = AbortSignal.timeout(45_000), visibility = new Map<string, { private: boolean; default_branch?: string }>()) {
        const catalog = parseCatalogUrl(catalogUrl);
        const privateRepo = (await repoInfo(catalog.owner, catalog.repo, deadline, visibility)).private;
        const commit = await resolveCommit(catalog.owner, catalog.repo, catalog.ref, deadline); const tree = await gitTree(catalog.owner, catalog.repo, commit, deadline);
        const catalogFile = tree.find(item => item.path === catalog.path && item.type === 'blob' && item.mode !== '120000');
        if (!catalogFile || (catalogFile.size ?? MAX_CATALOG_BYTES + 1) > MAX_CATALOG_BYTES) fail(400, 'Marketplace file is missing or too large');
        let data: { name?: unknown; plugins?: unknown };
        try { const bytes = !privateRepo ? await publicGitBytes(catalog.owner, catalog.repo, commit, catalogFile, MAX_CATALOG_BYTES, deadline) : await gitBytes(catalog.owner, catalog.repo, catalogFile.sha, MAX_CATALOG_BYTES, deadline); data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as typeof data; } catch (error) { if ((error as { statusCode?: number }).statusCode) throw error; return fail(400, 'Marketplace JSON is invalid'); }
        if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 120 || !Array.isArray(data.plugins) || data.plugins.length > 300) fail(400, 'Marketplace metadata is invalid');
        const plugins = data.plugins.map((raw, index) => {
            const itemResult = z.object({ name: z.string().min(1).max(120), category: z.string().min(1).max(80), policy: z.unknown(), source: z.unknown() }).passthrough().safeParse(raw);
            if (!itemResult.success) fail(400, `Marketplace entry ${index + 1} metadata is invalid`);
            const item = itemResult.data;
            const policyResult = z.object({ installation: z.enum(['AVAILABLE', 'INSTALLED_BY_DEFAULT', 'NOT_AVAILABLE']), authentication: z.enum(['ON_INSTALL', 'ON_FIRST_USE', 'ON_USE']), products: z.array(z.literal('CODEX')).optional() }).strict().safeParse(item.policy);
            if (!policyResult.success) {
                const issue = policyResult.error.issues[0]!;
                const field = issue.path.length ? `policy.${issue.path.join('.')}` : 'policy';
                if (issue.code === 'unrecognized_keys') fail(400, `Marketplace entry "${item.name}" policy contains unknown field${issue.keys.length === 1 ? '' : 's'}: ${issue.keys.map(key => `policy.${key}`).join(', ')}`);
                if (issue.path[0] === 'products') fail(400, `Marketplace entry "${item.name}" policy.products must be an array containing only CODEX values`);
                fail(400, `Marketplace entry "${item.name}" has invalid ${field}`);
            }
            const policy = policyResult.data;
            const description = typeof (raw as Record<string, unknown>).description === 'string' ? String((raw as Record<string, unknown>).description).slice(0, 1024) : '';
            const unsupported = (sourceKind: string, reason = `Source type ${sourceKind} is catalog metadata only and is not installable here`) => ({ name: item.name, description, category: item.category, owner: '', repo: '', pluginPath: '', requestedRef: '', sourceKind, unsupportedReason: reason });
            if (typeof item.source === 'string') { safeRepoPath(item.source); return unsupported('local'); }
            if (!item.source || typeof item.source !== 'object' || Array.isArray(item.source)) fail(400, `Marketplace source is invalid for ${item.name}`);
            const sourceKind = (item.source as Record<string, unknown>).source;
            if (sourceKind === 'local') {
                const source = z.object({ source: z.literal('local'), path: z.string().min(1).max(1000) }).strict().parse(item.source);
                if (!source.path.startsWith('./')) fail(400, `Local plugin ${item.name} must use a repository-relative ./ path`);
                const pluginPath = safeRepoPath(source.path);
                if (policy.installation === 'NOT_AVAILABLE') return unsupported('local', 'Marketplace policy marks this plugin NOT_AVAILABLE');
                return { name: item.name, description, category: item.category, owner: catalog.owner, repo: catalog.repo, pluginPath, requestedRef: commit, sourceSha: commit, sourceKind: 'local', unsupportedReason: undefined };
            }
            if (sourceKind === 'npm') { z.object({ source: z.literal('npm'), package: z.string().min(1).max(255), version: z.string().max(255).optional(), registry: publicHttpsUrl.optional() }).strict().parse(item.source); return unsupported('npm'); }
            const source = z.object({ source: z.enum(['url', 'git-subdir']), url: githubRepo, path: z.string().optional(), ref: z.string().min(1).max(255).optional(), sha: z.string().regex(/^[a-f0-9]{40}$/u).optional() }).strict().parse(item.source);
            const sourceUrl = new URL(source.url); const [owner, rawRepo] = sourceUrl.pathname.split('/').filter(Boolean); const repo = rawRepo?.replace(/\.git$/u, '');
            if (source.source === 'url' && source.path !== undefined) fail(400, 'source:url resolves only the repository root');
            if (source.ref && source.sha) fail(400, 'Specify either ref or sha for a GitHub plugin source');
            const pluginPath = source.source === 'url' ? '' : safeRepoPath(source.path ?? '');
            if (!owner || !repo) fail(400, 'Invalid plugin repository URL');
            if (policy.installation === 'NOT_AVAILABLE') return unsupported(source.source, 'Marketplace policy marks this plugin NOT_AVAILABLE');
            return { name: item.name, description, category: item.category, owner, repo, pluginPath, requestedRef: source.sha ?? source.ref ?? '', sourceSha: source.sha, sourceKind: source.source, unsupportedReason: undefined };
        });
        if (new Set(plugins.map(plugin => plugin.name)).size !== plugins.length) fail(400, 'Marketplace plugin names must be unique');
        return { name: data.name, catalogUrl, catalogCommit: commit, plugins };
    }
    async function inspectPlugin(plugin: Awaited<ReturnType<typeof marketplacePreview>>['plugins'][number], selectedPaths: string[] = [], deadline = AbortSignal.timeout(45_000), visibility = new Map<string, { private: boolean; default_branch?: string }>(), expectedCommit?: string) {
        if (plugin.unsupportedReason) fail(400, plugin.unsupportedReason);
        const repository = await repoInfo(plugin.owner!, plugin.repo!, deadline, visibility);
        const privateRepo = repository.private;
        const requestedRef = plugin.requestedRef || repository.default_branch;
        if (!requestedRef) fail(502, 'GitHub did not return a default branch');
        const commit = await resolveCommit(plugin.owner!, plugin.repo!, requestedRef, deadline);
        if (expectedCommit && expectedCommit !== commit) fail(409, 'Catalog or plugin source changed after preview; preview again before importing');
        const tree = await gitTree(plugin.owner!, plugin.repo!, commit, deadline); const prefix = plugin.pluginPath ? `${plugin.pluginPath}/` : '';
        const entries = tree.filter(item => item.path.startsWith(prefix));
        const paths = entries.filter(item => item.type === 'blob' && item.mode !== '120000');
        const manifestPath = `${prefix}plugin.json`; const manifestFile = paths.find(item => item.path === manifestPath);
        const codexManifestPath = `${prefix}.codex-plugin/plugin.json`; const codexManifestFile = paths.find(item => item.path === codexManifestPath);
        if (!manifestFile && !codexManifestFile) fail(400, `Plugin ${plugin.name} has no supported plugin manifest`);
        if ([manifestFile, codexManifestFile].some(file => file && (file.size ?? MAX_SOURCE_BYTES + 1) > MAX_SOURCE_BYTES)) fail(400, `Plugin ${plugin.name} manifest is too large`);
        const readManifest = async (file: typeof manifestFile) => {
            if (!file) return undefined;
            try { const bytes = !privateRepo ? await publicGitBytes(plugin.owner!, plugin.repo!, commit, file, MAX_SOURCE_BYTES, deadline) : await gitBytes(plugin.owner!, plugin.repo!, file.sha, MAX_SOURCE_BYTES, deadline); return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Record<string, unknown>; } catch (error) { if ((error as { statusCode?: number }).statusCode) throw error; return fail(400, `Plugin ${plugin.name} manifest JSON is invalid`); }
        };
        const manifests = await Promise.allSettled([readManifest(manifestFile), readManifest(codexManifestFile)]);
        const manifestFailure = manifests.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (manifestFailure) throw manifestFailure.reason;
        const [portable, codex] = manifests.map(result => (result as PromiseFulfilledResult<Record<string, unknown> | undefined>).value);
        const pluginManifest = z.object({ $schema: z.literal('https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'), name: z.string().min(1).max(64).regex(/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u), version: z.string().optional(), description: z.string().optional(), author: z.object({ name: z.string().optional(), email: z.string().optional(), url: z.string().optional() }).strict().optional(), homepage: z.string().optional(), repository: z.string().optional(), license: z.string().optional(), keywords: z.array(z.string()).optional(), extensions: z.record(z.string(), z.record(z.string(), z.unknown())).optional() }).strict();
        const codexPluginManifest = z.object({ name: z.string().min(1).max(64).regex(/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u), version: z.string().optional(), description: z.string().optional(), apps: z.union([z.string(), z.array(z.string())]).optional(), skills: z.union([z.string(), z.array(z.string())]).optional(), hooks: z.unknown().optional(), mcpServers: z.unknown().optional(), agents: z.unknown().optional(), commands: z.unknown().optional(), interface: z.record(z.string(), z.unknown()).optional() }).passthrough();
        if (portable && !pluginManifest.safeParse(portable).success) fail(400, `Plugin ${plugin.name} portable manifest is invalid`);
        if (codex && !codexPluginManifest.safeParse(codex).success) fail(400, `Plugin ${plugin.name} Codex compatibility manifest is invalid`);
        if (portable && codex && portable.name !== codex.name) fail(400, `Plugin ${plugin.name} manifests have conflicting identities`);
        const manifest = portable ?? codex!;
        if (manifest.name !== plugin.name) fail(400, `Plugin ${plugin.name} manifest identity does not match the catalog`);
        const extensions = portable?.extensions as Record<string, unknown> | undefined;
        const inlineOpenAi = extensions?.['com.openai'];
        if (inlineOpenAi !== undefined && (!inlineOpenAi || typeof inlineOpenAi !== 'object' || Array.isArray(inlineOpenAi))) fail(400, `Plugin ${plugin.name} OpenAI extension must be an object`);
        const overlay = (inlineOpenAi ?? codex ?? {}) as Record<string, unknown>;
        const overlayPath = inlineOpenAi !== undefined ? 'plugin.json:extensions.com.openai' : '.codex-plugin/plugin.json';
        // Official precedence: inline OpenAI settings replace, never merge with, the Codex fallback.
        const declaredSkills = overlay.skills;
        if (declaredSkills !== undefined && declaredSkills !== './skills/' && declaredSkills !== './skills') fail(400, `Plugin ${plugin.name} declares an unsupported skill path`);
        const unsupported: string[] = [];
        if (portable && codex && inlineOpenAi !== undefined) unsupported.push('.codex-plugin/plugin.json ignored: replaced by plugin.json extensions.com.openai');
        for (const component of ['mcpServers', 'apps', 'hooks', 'agents', 'commands']) if (overlay[component] !== undefined) unsupported.push(`${overlayPath}:${component}`);
        for (const component of ['agents', 'commands']) if (entries.some(item => item.path.startsWith(`${prefix}${component}/`))) unsupported.push(`${component}/`);
        for (const [namespace, values] of Object.entries(extensions ?? {})) if (namespace !== 'com.openai' && values && typeof values === 'object' && !Array.isArray(values)) for (const component of ['mcpServers', 'apps', 'hooks', 'agents', 'commands']) if ((values as Record<string, unknown>)[component] !== undefined) unsupported.push(`plugin.json:extensions.${namespace}.${component}`);
        const skillFiles = entries.filter(item => item.path.startsWith(`${prefix}skills/`) && item.path.endsWith('/SKILL.md'));
        if (skillFiles.length > MAX_SKILLS) fail(400, 'Plugin exceeds supported skill count');
        const skills: Array<{ name: string; description: string; license?: string; sourcePath: string; content: string; bundle?: Awaited<ReturnType<typeof collectSkillBundle>>; dependencyError?: string; contentSha256: string; sourceContentSha256?: string }> = [];
        const selectedSet = new Set(selectedPaths);
        if (selectedSet.size !== selectedPaths.length) fail(400, 'Duplicate selected skills are not allowed');
        const availablePaths = new Set(skillFiles.map(file => file.path));
        if (selectedPaths.some(path => !availablePaths.has(path))) fail(400, 'One or more selected skills are unavailable or invalid');
        const readResource = async (entry: SkillTreeEntry, readSignal: AbortSignal) => {
            const signal = AbortSignal.any([deadline, readSignal]);
            return !privateRepo
                ? publicGitBytes(plugin.owner!, plugin.repo!, commit, entry, SKILL_BOUNDS.fileBytes, signal)
                : gitBytes(plugin.owner!, plugin.repo!, entry.sha, SKILL_BOUNDS.fileBytes, signal);
        };
        for (const file of skillFiles) {
            const sourcePath = file.path;
            const root = sourcePath.slice(0, -'/SKILL.md'.length);
            const name = root.split('/').at(-1)!;
            if (!selectedSet.has(sourcePath)) { skills.push({ name, description: '', sourcePath, content: '', contentSha256: bytesHash('') }); continue; }
            let bundle: Awaited<ReturnType<typeof collectSkillBundle>> | undefined;
            let content = ''; let metadata = { name, description: '', license: undefined as string | undefined };
            try {
                bundle = await collectSkillBundle(tree, root, commit, readResource);
                content = skillMarkdown(bundle);
                const parsed = parseSkillMarkdown(content, name);
                metadata = { name: parsed.name, description: parsed.description, license: parsed.license };
            } catch (error) { if ((error as { statusCode?: number }).statusCode === 502) throw error; if (deadline.aborted) fail(502, 'GitHub source request timed out'); fail(400, error instanceof Error ? error.message : 'Skill bundle is invalid'); }
            skills.push({ ...metadata, sourcePath, content, bundle, contentSha256: bytesHash(content), sourceContentSha256: bundle?.sha256 });
        }
        // Skill regular files are supported bytes; plugin-level components remain uninstalled.
        unsupported.push(...entries.filter(item => item.type !== 'tree' && !skills.some(skill => item.path.startsWith(`${skill.sourcePath.slice(0, -'/SKILL.md'.length)}/`)) && item.path !== manifestPath && item.path !== codexManifestPath && !item.path.endsWith('/README.md') && !item.path.endsWith('/LICENSE')).map(item => item.path));
        return { plugin: { ...plugin, description: plugin.description || String(manifest.description ?? '') , requestedRef }, commit, manifest, skills, unsupported: [...new Set(unsupported)] };
    }
    const catalogRequest = z.object({ scope: z.enum(['project', 'workspace']), projectId: z.string().min(1).optional(), catalogUrl: z.string().url().max(2000) }).superRefine((value, context) => {
        if (value.scope === 'project' && !value.projectId) context.addIssue({ code: 'custom', message: 'Project scope requires a project ID' });
        if (value.scope === 'workspace' && value.projectId) context.addIssue({ code: 'custom', message: 'Workspace scope cannot include a project ID' });
    });
    async function getPluginPreview(catalogUrl: string, pluginName: string, selectedPaths: string[] = [], expected?: { pluginCommit: string; catalogCommit: string }) {
        const deadline = AbortSignal.timeout(45_000);
        const visibility = new Map<string, { private: boolean; default_branch?: string }>();
        const catalog = await marketplacePreview(catalogUrl, deadline, visibility);
        if (expected && expected.catalogCommit !== catalog.catalogCommit) fail(409, 'Catalog or plugin source changed after preview; preview again before importing');
        const plugin = catalog.plugins.find(item => item.name === pluginName);
        if (!plugin) fail(400, 'Plugin is not present in this marketplace');
        const inspected = await inspectPlugin(plugin, selectedPaths, deadline, visibility, expected?.pluginCommit);
        return { catalog, ...inspected };
    }
    app.post('/api/workbench/skills/catalog', async req => {
        const input = catalogRequest.parse(req.body); await options.authorize(req, input.projectId, input.scope === 'project');
        const catalog = await marketplacePreview(input.catalogUrl); await options.authorize(req, input.projectId, input.scope === 'project');
        return { name: catalog.name, url: catalog.catalogUrl, commit: catalog.catalogCommit, plugins: catalog.plugins.map(plugin => ({ name: plugin.name, description: plugin.description, category: plugin.category, ...(plugin.unsupportedReason ? { unsupportedReason: plugin.unsupportedReason } : {}) })) };
    });
    app.post('/api/workbench/skills/catalog/preview', async req => {
        const input = catalogRequest.parse(req.body); await options.authorize(req, input.projectId, input.scope === 'project');
        const body = z.object({ scope: z.enum(['project', 'workspace']), projectId: z.string().min(1).optional(), catalogUrl: z.string().url().max(2000), pluginName: z.string().min(1).max(120), selectedPaths: z.array(z.string().min(1).max(500)).max(MAX_SKILLS).default([]) }).strict().parse(req.body);
        const result = await getPluginPreview(body.catalogUrl, body.pluginName, body.selectedPaths); await options.authorize(req, input.projectId, input.scope === 'project');
        return { catalog: { name: result.catalog.name, url: result.catalog.catalogUrl, commit: result.catalog.catalogCommit }, plugin: { name: result.plugin.name, description: result.plugin.description, commit: result.commit, version: result.manifest.version ?? null }, unsupported: result.unsupported, skills: result.skills.map(skill => ({ name: skill.name, description: skill.description, license: skill.license ?? null, path: skill.sourcePath, ...(skill.bundle ? { content: skill.content, includedReferences: [], bundleFiles: skill.bundle.files.map(({ path, mode, bytes, sha256 }) => ({ path, mode, bytes, sha256 })), bundleSha256: skill.bundle.sha256, contentSha256: skill.contentSha256 } : skill.dependencyError ? { unsupportedDependency: skill.dependencyError } : {}) })) };
    });
    app.post('/api/workbench/skills/catalog/import', async req => {
        const base = catalogRequest.parse(req.body); await options.authorize(req, base.projectId, true);
        const input = z.object({ scope: z.enum(['project', 'workspace']), projectId: z.string().min(1).optional(), catalogUrl: z.string().url().max(2000), pluginName: z.string().min(1).max(120), selectedPaths: z.array(z.string().min(1).max(500)).min(1).max(MAX_SKILLS), previewCommit: z.string().regex(/^[a-f0-9]{40}$/u), previewCatalogCommit: z.string().regex(/^[a-f0-9]{40}$/u) }).strict().parse(req.body);
        if (new Set(input.selectedPaths).size !== input.selectedPaths.length) fail(400, 'Duplicate selected skills are not allowed');
        const result = await getPluginPreview(input.catalogUrl, input.pluginName, input.selectedPaths, { pluginCommit: input.previewCommit, catalogCommit: input.previewCatalogCommit });
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
    async function ingest(projectId: string, sourceId: string, speaker: string, body: string, url: string, reauthorize?: () => Promise<void>, transaction?:Sql, origin?:RunOrigin) {
        const persist = async (tx:Sql) => {
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
            await options.onIntake?.(projectId,sourceId,tx,origin);
            return message;
        };
        return transaction ? persist(transaction) : store.transaction("source", persist);
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
        const deadline = AbortSignal.timeout(45_000);
        const commit = await resolveCommit(owner!, repo!, requestedRef, deadline);
        const tree = await gitTree(owner!, repo!, commit, deadline);
        const sourcePath = safeRepoPath(path.join('/'));
        const root = sourcePath === 'SKILL.md' ? '' : sourcePath.slice(0, -'/SKILL.md'.length);
        const bundle = await collectSkillBundle(tree, root, commit, (entry, readSignal) => gitBytes(owner!, repo!, entry.sha, SKILL_BOUNDS.fileBytes, AbortSignal.any([deadline, readSignal])));
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
            let payload: unknown;
            try { payload = JSON.parse(raw.toString()); } catch { fail(400, "Invalid Slack JSON"); }
            const envelope = z.object({ type:z.literal('url_verification'), challenge:z.string().min(1).max(4000) }).safeParse(payload);
            if (envelope.success) return { challenge:envelope.data.challenge };
            const identifier = (prefix:string) => z.string().regex(new RegExp(`^[${prefix}][A-Z0-9]{1,100}$`, 'u'));
            const timestamp = z.string().regex(/^[0-9]{10}\.[0-9]{6}$/u);
            const parsed = z.object({
                type:z.literal('event_callback'), api_app_id:identifier('A'), team_id:identifier('T'),
                event_id:z.string().min(1).max(200),
                event:z.object({ type:z.literal('app_mention'), channel:identifier('C'), user:identifier('UW'),
                    text:z.string().trim().min(1).max(16000), ts:timestamp, thread_ts:timestamp.optional(),
                    bot_id:z.never().optional(), subtype:z.never().optional() })
            }).safeParse(payload);
            if (!parsed.success) return { ok:true };
            const { api_app_id:appId, team_id:teamId, event_id:eventId, event } = parsed.data;
            // Resolve and authorize inside the same serialized transaction as dedupe and Run creation.
            await store.transaction('source', async tx => {
                const receiptScope = `slack-source:${appId}:${teamId}`;
                const accepted = await tx`SELECT result FROM wb_requests WHERE scope=${receiptScope} AND request_id=${eventId}`;
                if (accepted[0]) return;
                // Old accepted events may predate the global receipt. Only server-owned Run origin
                // can identify their original route; never resolve a historical event using today's mapping.
                const historical = await tx`SELECT DISTINCT project_id, data->'origin' AS origin FROM wb_records
                    WHERE kind='run' AND data->'origin'->>'provider'='slack'
                    AND data->'origin'->>'appId'=${appId} AND data->'origin'->>'teamId'=${teamId}
                    AND data->'origin'->>'eventId'=${eventId} LIMIT 2`;
                if (historical.length) {
                    if (historical.length === 1) await tx`INSERT INTO wb_requests(scope,request_id,result)
                        VALUES (${receiptScope},${eventId},${tx.json({projectId:historical[0]!.project_id,origin:historical[0]!.origin} as never)})`;
                    return;
                }
                const sourceId = `slack:${eventId}`;
                const legacy = await tx`SELECT 1 FROM wb_requests WHERE scope LIKE 'source:%' AND request_id=${sourceId} LIMIT 1`;
                if (legacy[0]) return; // A legacy receipt without authoritative origin fails closed.
                const settings = await store.list<Setting>('setting', undefined, tx);
                const connections = settings.filter(c => c.kind === 'connection' && c.projectId &&
                    c.data.provider === 'slack' && c.data.enabled !== false && (c.data.purpose === undefined || c.data.purpose === 'source') &&
                    c.data.appId === appId && c.data.teamId === teamId && c.data.channelId === event.channel);
                if (connections.length !== 1) return;
                const connection = connections[0]!;
                const projectId = connection.projectId!;
                const project = await store.get<Project>('project', projectId, tx);
                const policy = project?.feedbackIntake;
                if (!policy?.enabled || !policy.actorId || !await options.authorizeIntake?.(projectId, policy.actorId, tx)) return;
                const threadTs = event.thread_ts ?? event.ts;
                const origin:RunOrigin = { provider:'slack', connectionId:connection.id, appId, teamId,
                    channelId:event.channel, threadTs, eventId, sourceId };
                await tx`INSERT INTO wb_requests(scope,request_id,result) VALUES (${receiptScope},${eventId},${tx.json({projectId,origin} as never)})`;
                await ingest(projectId, sourceId, `Slack source · ${event.user}`, event.text,
                    `https://app.slack.com/client/${teamId}/${event.channel}/thread/${threadTs}`, undefined, tx, origin);
            });
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
