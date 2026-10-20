import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';

const assetPattern = /\.(js|css|svg|png|woff2)$/u;

async function readContainedFile(root: string, path: string): Promise<Buffer> {
    const [realRoot, realFile] = await Promise.all([realpath(root), realpath(path)]);
    const fromRoot = relative(realRoot, realFile);
    if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot) || !(await stat(realFile)).isFile())
        throw new Error('File is outside the static root');
    return readFile(realFile);
}

async function manifestAssets(webRoot: string): Promise<Set<string> | undefined> {
    try {
        const parsed: unknown = JSON.parse((await readContainedFile(webRoot, resolve(webRoot, '.vite/manifest.json'))).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
        const files = new Set<string>();
        for (const entry of Object.values(parsed)) {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.file !== 'string') return undefined;
            const references: unknown[] = [entry.file];
            for (const field of ['css', 'assets']) {
                const value = entry[field];
                if (value !== undefined && (!Array.isArray(value) || value.some(path => typeof path !== 'string'))) return undefined;
                if (Array.isArray(value)) references.push(...value);
            }
            for (const file of references as string[]) {
                if (file.includes('\\') || file.startsWith('/') || !file.startsWith('assets/')) return undefined;
                const contained = resolve(webRoot, file);
                const fromRoot = relative(webRoot, contained);
                if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) return undefined;
                if (assetPattern.test(file)) files.add(file);
            }
        }
        return files;
    } catch {
        return undefined;
    }
}

function mimeType(path: string): string {
    if (path.endsWith('.js')) return 'text/javascript';
    if (path.endsWith('.css')) return 'text/css';
    return 'application/octet-stream';
}

function matchesEtag(header: string | undefined, etag: string): boolean {
    return header?.split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//u, '') === etag) ?? false;
}

export async function registerWorkbenchAssets(app: FastifyInstance, root: string): Promise<void> {
    const webRoot = resolve(root);
    const assetsRoot = resolve(webRoot, 'assets');
    const assets = new Map<string, Buffer>();

    app.get('/workbench/', async (req, reply) => {
        const html = await readFile(resolve(webRoot, 'index.html'));
        const htmlEtag = `"${createHash('sha256').update(html).digest('hex')}"`;
        reply.header('Cache-Control', 'no-cache').header('ETag', htmlEtag);
        if (matchesEtag(req.headers['if-none-match'], htmlEtag)) return reply.code(304).send();
        return reply.type('text/html').send(html);
    });
    app.get('/workbench/assets/*', async (req, reply) => {
        const name = (req.params as { '*': string })['*'];
        const path = resolve(assetsRoot, name);
        const fromAssets = relative(assetsRoot, path);
        if (!name || fromAssets === '..' || fromAssets.startsWith(`..${sep}`) || fromAssets.startsWith(sep) || !assetPattern.test(path))
            return reply.code(404).send();
        const cached = assets.get(name);
        const hashed = cached !== undefined || (await manifestAssets(webRoot))?.has(`assets/${name}`) === true;
        let body = cached;
        if (!body) {
            try {
                body = await readContainedFile(assetsRoot, path);
                if (hashed) assets.set(name, body);
            }
            catch { return reply.code(404).send(); }
        }
        reply.header('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
        if (hashed) reply.header('ETag', `"${createHash('sha256').update(body).digest('hex')}"`);
        return reply.type(mimeType(path)).send(body);
    });
}
