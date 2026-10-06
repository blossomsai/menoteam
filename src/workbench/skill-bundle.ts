import { createHash } from 'node:crypto';

export const SKILL_BOUNDS = { files: 256, fileBytes: 1_048_576, totalBytes: 4_194_304, runBytes: 16_777_216 } as const;
import type { SkillFile, SkillBundle, SkillTreeEntry } from './skill-bundle-types.js';
export type { SkillFile, SkillBundle, SkillTreeEntry } from './skill-bundle-types.js';
function fail(message: string): never { throw Object.assign(new Error(message), { statusCode: 400 }); }
export const bytesHash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export const gitBlobHash = (bytes: Uint8Array) => createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
export function bundlePath(value: string): string {
    if (typeof value !== 'string' || value.length > 1000 || value !== value.normalize('NFC') || !value
        || value.split('/').some(part => !part || part === '.' || part === '..' || /[\\:\x00-\x1f\x7f]/u.test(part) || /[. ]$/u.test(part))) fail('Unsafe or ambiguous skill bundle path');
    return value;
}
function fileOrder(files: SkillFile[]) { return [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0); }
function digest(bundle: Omit<SkillBundle, 'sha256'>) {
    return bytesHash(JSON.stringify([bundle.version, bundle.root, bundle.commit, bundle.bytes,
        fileOrder(bundle.files).map(f => [f.path, f.mode, f.bytes, f.sha256, f.sourceBlobSha])]));
}
export function sealBundle(root: string, commit: string, files: SkillFile[]): SkillBundle {
    const value = { version: 1 as const, root, commit, files: fileOrder(files), bytes: files.reduce((n, f) => n + f.bytes, 0) };
    const bundle = { ...value, sha256: digest(value) };
    verifyBundle(bundle);
    return bundle;
}
export function verifyBundle(input: unknown): asserts input is SkillBundle {
    if (!input || typeof input !== 'object') fail('Invalid skill bundle');
    const b = input as SkillBundle;
    if (b.version !== 1 || !/^[a-f0-9]{40}$/u.test(b.commit) || !Array.isArray(b.files) || !b.files.length || b.files.length > SKILL_BOUNDS.files) fail('Invalid skill bundle or file count');
    if (b.root !== '') bundlePath(b.root);
    const seen = new Set<string>(); let total = 0;
    for (const f of b.files) {
        bundlePath(f.path);
        const key = f.path.toLowerCase();
        if (seen.has(key) || [...seen].some(p => p.startsWith(`${key}/`) || key.startsWith(`${p}/`))) fail('Duplicate or colliding skill bundle paths');
        seen.add(key);
        if (!['100644', '100755'].includes(f.mode) || f.encoding !== 'base64' || typeof f.data !== 'string'
            || f.data.length > Math.ceil(SKILL_BOUNDS.fileBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(f.data)
            || !Number.isSafeInteger(f.bytes) || f.bytes < 0 || f.bytes > SKILL_BOUNDS.fileBytes || !/^[a-f0-9]{40}$/u.test(f.sourceBlobSha)) fail('Invalid skill bundle file');
        const bytes = Buffer.from(f.data, 'base64');
        if (bytes.toString('base64') !== f.data || bytes.length !== f.bytes || bytesHash(bytes) !== f.sha256) fail('Skill file integrity mismatch');
        total += bytes.length;
        if (total > SKILL_BOUNDS.totalBytes) fail('Skill bundle exceeds decoded byte limit');
    }
    if (!seen.has('skill.md') || !b.files.some(f => f.path === 'SKILL.md')) fail('Skill bundle requires exact SKILL.md');
    if (b.bytes !== total || b.sha256 !== digest(b)) fail('Skill bundle integrity mismatch');
    skillMarkdown(b);
}
export function skillMarkdown(bundle: SkillBundle): string {
    const f = bundle.files.find(f => f.path === 'SKILL.md');
    if (!f || !f.bytes || f.bytes > 64_000) fail('SKILL.md missing, empty or too large');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(f.data, 'base64')); }
    catch { return fail('SKILL.md must be complete UTF-8'); }
}
export async function collectSkillBundle(tree: SkillTreeEntry[], root: string, commit: string, read: (entry: SkillTreeEntry) => Promise<Uint8Array>): Promise<SkillBundle> {
    if (root !== '') bundlePath(root);
    const names = new Set<string>();
    for (const entry of tree) {
        bundlePath(entry.path);
        if (names.has(entry.path.toLowerCase())) fail('Duplicate or ambiguous Git tree paths');
        names.add(entry.path.toLowerCase());
        if (root === entry.path || root.startsWith(`${entry.path}/`)) {
            if (entry.type !== 'tree' || entry.mode !== '040000') fail('Skill root ancestor is not a regular directory');
        }
    }
    const prefix = root ? `${root}/` : '';
    for (const e of tree.filter(e => e.path.startsWith(prefix))) if (e.type === 'tree' && e.mode !== '040000') fail('Skill bundle directory has an unsupported mode');
    const entries = tree.filter(e => e.path.startsWith(prefix) && e.type !== 'tree');
    if (!entries.length || entries.length > SKILL_BOUNDS.files) fail('Skill bundle file count exceeds limit or SKILL.md missing');
    let total = 0;
    for (const e of entries) {
        if (e.type !== 'blob' || !['100644', '100755'].includes(e.mode ?? '') || !Number.isSafeInteger(e.size) || e.size! < 0 || e.size! > SKILL_BOUNDS.fileBytes || !/^[a-f0-9]{40}$/u.test(e.sha)) fail('Skill bundle contains a symlink, submodule, unsupported mode or oversized file');
        total += e.size!;
    }
    if (total > SKILL_BOUNDS.totalBytes || !entries.some(e => e.path === `${prefix}SKILL.md`)) fail('Skill bundle is oversized or SKILL.md missing');
    const files: SkillFile[] = [];
    for (const e of entries) {
        const bytes = await read(e);
        if (bytes.length !== e.size || gitBlobHash(bytes) !== e.sha) fail('Git blob is incomplete or does not match immutable tree');
        files.push({ path: e.path.slice(prefix.length), mode: e.mode as SkillFile['mode'], encoding: 'base64', data: Buffer.from(bytes).toString('base64'), bytes: bytes.length, sha256: bytesHash(bytes), sourceBlobSha: e.sha });
    }
    return sealBundle(root, commit, files);
}
export function editBundleMarkdown(input: unknown, content: string): SkillBundle {
    verifyBundle(input);
    const bytes = Buffer.from(content, 'utf8');
    return sealBundle(input.root, input.commit, input.files.map(f => f.path === 'SKILL.md'
        ? { ...f, data: bytes.toString('base64'), bytes: bytes.length, sha256: bytesHash(bytes) } : { ...f }));
}
export function freezeSkillBundle(input: unknown, content: string): SkillBundle {
    verifyBundle(input);
    if (skillMarkdown(input) !== content) fail('Saved SKILL.md differs from bundle bytes');
    return structuredClone(input);
}
export function verifyExecutionSkills(skills: Array<{ id: string; content: string; contentSha256?: string; bundle?: SkillBundle }>): void {
    if (!Array.isArray(skills) || skills.length > 40) fail('Invalid execution skills');
    const ids = new Set<string>(); let total = 0;
    for (const skill of skills) {
        if (typeof skill.id !== 'string' || !skill.id || ids.has(skill.id) || typeof skill.content !== 'string' || Buffer.byteLength(skill.content) > 64_000) fail('Invalid or duplicate execution skill');
        ids.add(skill.id);
        if (skill.contentSha256 !== undefined && bytesHash(skill.content) !== skill.contentSha256) fail('Execution skill content hash mismatch');
        if (skill.bundle !== undefined) { freezeSkillBundle(skill.bundle, skill.content); total += skill.bundle.bytes; }
        else total += Buffer.byteLength(skill.content);
    }
    if (total > SKILL_BOUNDS.runBytes) fail('Selected skill bundles exceed run byte limit');
}
