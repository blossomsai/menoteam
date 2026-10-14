import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, stat, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
// Production TS modules, without application dependencies or bootstrap.
registerHooks({ resolve(specifier, context, next) {
    if (specifier.endsWith('.js') && specifier.startsWith('.') && context.parentURL) {
        const source = new URL(specifier.replace(/\.js$/u, '.ts'), context.parentURL);
        if (existsSync(fileURLToPath(source))) return next(source.href, context);
    }
    return next(specifier, context);
} });
const { collectSkillBundle, verifyBundle, sealBundle, gitBlobHash, bytesHash, editBundleMarkdown, freezeSkillBundle, verifyExecutionSkills, SKILL_BOUNDS } = await import('../src/workbench/skill-bundle.ts');
const { materializeRunSkills, selectedSkillPrompt } = await import('../src/connector/skill-files.ts');
const commit = 'a'.repeat(40), root = 'skills/fixture';
const contents = {
    'SKILL.md': Buffer.from('---\nname: fixture\ndescription: Read bundled resources.\n---\nRun bash scripts/check. Use `response.status`. Run tests and/or lint.\n'),
    'references/guide.md': Buffer.from('Exact reference bytes\r\n'),
    'scripts/check': Buffer.from('#!/bin/sh\nprintf "MENOTEAM_BUNDLE_NATIVE_MARKER\\n"\ncat references/guide.md\n'),
    'assets/icon.bin': Buffer.from([0, 255, 128, 13, 10, 0])
};
const tree = Object.entries(contents).map(([p, b]) => ({ path: `${root}/${p}`, type: 'blob', mode: p.startsWith('scripts/') ? '100755' : '100644', sha: gitBlobHash(b), size: b.length }));
const read = async e => contents[e.path.slice(root.length + 1)];
const make = () => collectSkillBundle(tree, root, commit, read);
const clone = v => structuredClone(v);

test('complete immutable tree bundle preserves exact binary/text bytes, modes and deterministic hashes', async () => {
    const b = await make(); verifyBundle(JSON.parse(JSON.stringify(b)));
    assert.equal(b.commit, commit); assert.equal(b.root, root);
    assert.equal(b.bytes, Object.values(contents).reduce((n, v) => n + v.length, 0));
    for (const f of b.files) {
        assert.deepEqual(Buffer.from(f.data, 'base64'), contents[f.path]);
        assert.equal(f.sourceBlobSha, gitBlobHash(contents[f.path]));
        assert.equal(f.sha256, bytesHash(contents[f.path]));
    }
    assert.equal((await collectSkillBundle([...tree].reverse(), root, commit, read)).sha256, b.sha256);
});

test('rejects traversal, absolute, ambiguous, duplicate and colliding file paths', async () => {
    const b = await make();
    for (const p of ['../escape', '/root', './file', 'a//b', 'a\\b', 'a:stream', 'bad.', 'bad ', 'a/../../b']) {
        const bad = clone(b); bad.files[0].path = p; assert.throws(() => verifyBundle(bad));
    }
    for (const p of [b.files[0].path, b.files[0].path.toUpperCase(), `${b.files[0].path}/child`]) assert.throws(() => sealBundle(root, commit, [...b.files, { ...b.files[0], path: p }]));
});

test('rejects symlink/submodule/root ancestors, missing SKILL.md and duplicate tree listings before blob reads', async () => {
    for (const unsafe of [
        [...tree, { path: `${root}/link`, type: 'blob', mode: '120000', sha: 'b'.repeat(40), size: 5 }],
        [...tree, { path: `${root}/module`, type: 'commit', mode: '160000', sha: 'b'.repeat(40) }],
        [...tree, { path: 'skills', type: 'blob', mode: '120000', sha: 'b'.repeat(40), size: 1 }],
        [...tree, tree[0]], tree.filter(e => !e.path.endsWith('/SKILL.md'))
    ]) {
        let reads = 0;
        await assert.rejects(collectSkillBundle(unsafe, root, commit, async () => { reads++; return Buffer.alloc(0); }));
        assert.equal(reads, 0);
    }
});

test('enforces count, per-file and decoded total bounds before fetching', async () => {
    const variants = [
        [...tree, { ...tree[0], path: `${root}/large`, size: SKILL_BOUNDS.fileBytes + 1 }],
        Array.from({ length: SKILL_BOUNDS.files + 1 }, (_, i) => ({ ...tree[0], path: `${root}/${i}` })),
        [...tree, ...Array.from({ length: 5 }, (_, i) => ({ ...tree[0], path: `${root}/large-${i}`, size: SKILL_BOUNDS.fileBytes }))]
    ];
    for (const entries of variants) await assert.rejects(collectSkillBundle(entries, root, commit, () => { throw new Error('Must reject before fetch'); }), /limit|oversized/u);
});

test('rejects incomplete immutable Git blobs and bundle tampering', async () => {
    await assert.rejects(collectSkillBundle(tree, root, commit, async e => Buffer.from((await read(e)).subarray(1))), /incomplete/u);
    for (const key of ['data', 'mode', 'sha256', 'bytes', 'sourceBlobSha']) {
        const b = await make(); b.files[0][key] = key === 'bytes' ? 1 : 'tampered'; assert.throws(() => verifyBundle(b));
    }
    const b = await make(); b.sha256 = 'b'.repeat(64); assert.throws(() => verifyBundle(b));
});

test('edit reseals current SKILL.md while queued snapshot/source provenance stays frozen', async () => {
    const b = await make(), content = contents['SKILL.md'].toString();
    const queued = freezeSkillBundle(b, content), old = JSON.stringify(queued);
    const changed = editBundleMarkdown(b, `${content}\nEdited.`);
    assert.notEqual(changed.sha256, b.sha256); assert.equal(changed.commit, b.commit);
    assert.equal(changed.files.find(f => f.path === 'SKILL.md').sourceBlobSha, b.files.find(f => f.path === 'SKILL.md').sourceBlobSha);
    assert.equal(JSON.stringify(queued), old);
    verifyExecutionSkills([{ id: 'skill', content: `${content}\nEdited.`, contentSha256: bytesHash(`${content}\nEdited.`), bundle: changed }]);
    assert.throws(() => verifyExecutionSkills([{ id: 'skill', content: 'wrong', bundle: queued }]));
});

test('claim JSON roundtrip and legacy content-only selection both materialize safely', async () => {
    const b = await make();
    const selection = JSON.parse(JSON.stringify([{ id: 's', name: 'Fixture', content: contents['SKILL.md'].toString(), contentSha256: bytesHash(contents['SKILL.md']), bundle: b }, { id: 'legacy', name: 'Legacy', content: 'Original legacy content' }]));
    const files = await materializeRunSkills(selection);
    try {
        assert.equal(await readFile(path.join(files.paths.legacy, 'SKILL.md'), 'utf8'), 'Original legacy content');
        assert.deepEqual(await readFile(path.join(files.paths.s, 'assets/icon.bin')), contents['assets/icon.bin']);
        const prompt = selectedSkillPrompt(selection, files.paths);
        assert.ok(prompt.includes(path.join(files.paths.s, 'SKILL.md'))); assert.ok(prompt.includes('scripts/check'));
        assert.ok(prompt.includes('does not authorize automatic scripts/hooks'));
        assert.equal((await stat(path.join(files.paths.s, 'scripts/check'))).mode & 0o777, 0o500);
    } finally { await files.cleanup(); }
    await assert.rejects(access(files.directory));
});

test('selection tamper and failed second write leave no published or partial resources', async () => {
    const b = await make(), s = { id: 's', name: 'Fixture', content: contents['SKILL.md'].toString(), bundle: b };
    const bad = clone(s); bad.id = 'bad'; bad.bundle.files[0].data = 'AA==';
    await assert.rejects(materializeRunSkills([s, bad]));
    let written = 0, owned;
    await assert.rejects(materializeRunSkills([s], async (...args) => {
        const target = String(args[0]); owned = target.slice(0, target.indexOf('/staging/'));
        assert.equal(existsSync(path.join(owned, 'ready')), false);
        if (++written === 2) throw new Error('Injected write failure');
        return writeFile(...args);
    }), /Injected/u);
    assert.equal(written, 2); await assert.rejects(access(owned));
});

test('real local harmless marker process reads materialized reference and binary outside repository', async () => {
    const s = { id: 'native', name: 'Fixture', content: contents['SKILL.md'].toString(), bundle: await make() };
    const files = await materializeRunSkills([s]);
    try {
        const cwd = files.paths.native;
        assert.equal(cwd.startsWith(process.cwd() + '/'), false);
        const { stdout } = await promisify(execFile)(path.join(cwd, 'scripts/check'), [], { cwd, timeout: 5000, env: { PATH: '/usr/bin:/bin' } });
        assert.equal(stdout, 'MENOTEAM_BUNDLE_NATIVE_MARKER\nExact reference bytes\r\n');
        const { stdout: binary } = await promisify(execFile)(process.execPath, ['-e', 'process.stdout.write(require("node:fs").readFileSync("assets/icon.bin").toString("base64"))'], { cwd, timeout: 5000, env: {} });
        assert.equal(binary, contents['assets/icon.bin'].toString('base64'));
    } finally { await files.cleanup(); }
});
