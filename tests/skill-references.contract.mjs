import assert from 'node:assert/strict';
import { test } from 'node:test';
import { referencedPaths } from '../src/workbench/skill-references.ts';

test('recognizes the three required script/asset repros without an extension allowlist', () => {
    assert.deepEqual(referencedPaths('Run scripts/check.mjs'), ['scripts/check.mjs']);
    assert.deepEqual(referencedPaths('Run "scripts/check.ps1"'), ['scripts/check.ps1']);
    assert.deepEqual(referencedPaths('Use assets/template.xlsx.'), ['assets/template.xlsx']);
    assert.deepEqual(referencedPaths('Read docs/input.123 and "scripts/extensionless".'), ['docs/input.123', 'scripts/extensionless']);
    assert.deepEqual(referencedPaths('Run scripts/runner; read sources/demo.c++.'), ['scripts/runner', 'sources/demo.c++']);
});

test('recognizes quoted, punctuated, inline and reference-style Markdown paths', () => {
    assert.deepEqual(referencedPaths('Read nested.md.\nUse [guide](./references/guide.md), [asset][file].\n[file]: assets/template.xlsx'),
        ['./references/guide.md', 'assets/template.xlsx', 'nested.md']);
    assert.deepEqual(referencedPaths('Run `scripts/check.mjs`; use \'assets/template.xlsx\'.'), ['scripts/check.mjs', 'assets/template.xlsx']);
});

test('uses the same detector for dependencies inside referenced Markdown', () => {
    assert.deepEqual(referencedPaths('# Nested guide\nRead docs/missing.md. Run "scripts/check.ps1".'), ['docs/missing.md', 'scripts/check.ps1']);
});

test('recognizes extensionless command operands without an interpreter allowlist', () => {
    for (const command of ['Run bash scripts/check', 'Run sh scripts/check', 'Execute custom-launcher --check scripts/check.', 'Run python3.11 -u scripts/check']) {
        assert.deepEqual(referencedPaths(command), ['scripts/check']);
        assert.deepEqual(referencedPaths(`# Nested guide\n${command}`), ['scripts/check']);
    }
});

test('quotation alone is not file evidence for code properties, but explicit files remain references', () => {
    assert.deepEqual(referencedPaths('Use `response.status` to determine success. Use "request.id" and \'object.value\'.'), []);
    assert.deepEqual(referencedPaths('Run tests. Use JSON/YAML and/or prose.'), []);
    assert.deepEqual(referencedPaths('Read `nested.md`. [property file](response.status) [root](/check) [outside](../check)'),
        ['response.status', '/check', '../check', 'nested.md']);
});

test('slash prose within command instructions is not a terminal file operand', () => {
    for (const prose of ['Run tests and/or lint.', 'Run tests with JSON/YAML input.', 'Execute checks with text/binary output.']) {
        assert.deepEqual(referencedPaths(prose), []);
        assert.deepEqual(referencedPaths(`# Nested guide\n${prose}`), []);
    }
    assert.deepEqual(referencedPaths('Run bash scripts/check; run sh scripts/verify.'), ['scripts/check', 'scripts/verify']);
    assert.deepEqual(referencedPaths('Run bash "scripts/check" before continuing.'), ['scripts/check']);
});

test('leaves unsafe paths visible to the importer root/traversal checks', () => {
    assert.deepEqual(referencedPaths('Read ../outside.md and [root](/private/file.md) and [guide](./references/guide.md)'),
        ['/private/file.md', './references/guide.md', '../outside.md']);
});

test('does not interpret ordinary prose, versions, properties or external URLs as dependencies', () => {
    assert.deepEqual(referencedPaths('Version 1.2.3; e.g. compare response.status and request.id. Use JSON/YAML and/or prose.\nhttps://example.com/scripts/check.mjs\n[remote](https://example.com/assets/template.xlsx)\n[remote-ref]: https://example.com/guide.md'), []);
});

test('rejects malformed escaping in an explicit local Markdown path', () => {
    assert.throws(() => referencedPaths('[guide](docs/%ZZ.md)'), { statusCode: 400 });
});
