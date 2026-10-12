import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { checkpoint, createDiff, diffRevision, ensureWorktree, fingerprint, git, spoolDiffFile } from '../src/connector/git.js';
import type { ConnectorConfig } from '../src/connector/types.js';

let temp = '';
afterEach(async () => { if (temp) await rm(temp, { recursive: true, force: true }); temp = ''; });

it('isolates dirty checkout state and records committed diff, rename, binary, and symlink safely', async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), 'menoteam-connector-git-'));
  const repo = path.join(temp, 'repo'); const dataDir = path.join(temp, 'connector-data');
  await mkdir(repo); await mkdir(dataDir);
  await git(repo, 'init', '-q'); await git(repo, 'config', 'user.name', 'Test'); await git(repo, 'config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(repo, 'old.txt'), 'before\n'); await writeFile(path.join(repo, 'tracked.txt'), 'base\n');
  await git(repo, 'add', '-A'); await git(repo, 'commit', '-qm', 'base');
  await writeFile(path.join(repo, 'root-dirty.txt'), 'must stay outside the worker');
  const config: ConnectorConfig = { serverUrl: 'https://workbench.example.invalid', token: 'x'.repeat(48), connectorId: 'test', dataDir, projects: { project: repo } };
  const worktree = await ensureWorktree(config, 'project', 'work-1');
  await expect(readFile(path.join(worktree.path, 'root-dirty.txt'))).rejects.toThrow();

  await writeFile(path.join(worktree.path, 'tracked.txt'), 'changed\n');
  await rm(path.join(worktree.path, 'old.txt')); await writeFile(path.join(worktree.path, 'new.txt'), 'before\n');
  await writeFile(path.join(worktree.path, 'new-file.txt'), 'added\n');
  const outside = path.join(temp, 'outside-secret.txt'); await writeFile(outside, 'one');
  await symlink(outside, path.join(worktree.path, 'outside-link'));
  await writeFile(path.join(worktree.path, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
  const before = await fingerprint(worktree.path);
  await writeFile(outside, 'two');
  expect(await fingerprint(worktree.path)).toBe(before);

  await checkpoint(worktree.path, 'connector candidate');
  expect(await fingerprint(worktree.path)).toBe(before);
  const diff = await createDiff(worktree.path, worktree.baseRevision);
  expect(diff.files.find(file => file.path === 'new.txt')?.status).toBe('renamed');
  expect(diff.files.some(file => file.path === 'new-file.txt' && file.status === 'added')).toBe(true);
  expect(diff.files.find(file => file.path === 'binary.bin')?.binary).toBe(true);
  expect(diff.files.find(file => file.path === 'outside-link')?.binary).toBe(false);
  expect(diff.patch).toContain('new-file.txt');
  expect(diff.baseRevision).toBe(worktree.baseRevision);
  expect(diff.additions).toBe(3);
  expect(diff.deletions).toBe(1);
});

it('keeps candidate revisions distinct when visible diff prefixes match', async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), 'menoteam-connector-large-diff-'));
  await git(temp, 'init', '-q'); await git(temp, 'config', 'user.name', 'Test'); await git(temp, 'config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(temp, 'base.txt'), 'base\n'); await git(temp, 'add', '-A'); await git(temp, 'commit', '-qm', 'base');
  const base = (await git(temp, 'rev-parse', 'HEAD')).trim();
  const shared = 'same prefix line\n'.repeat(25_000);
  await writeFile(path.join(temp, 'a-large.txt'), `${shared}tail\n`); await git(temp, 'add', '-A'); await git(temp, 'commit', '-qm', 'candidate A');
  const a = await createDiff(temp, base);
  const prefixEnd = a.patch.indexOf('@@');
  await writeFile(path.join(temp, 'a-large.txt'), `${shared}tail different\n`); await git(temp, 'add', '-A'); await git(temp, 'commit', '-qm', 'candidate B');
  const b = await createDiff(temp, base);
  expect(a.truncated).toBe(true); expect(b.truncated).toBe(true);
  expect(a.patch.slice(prefixEnd)).toBe(b.patch.slice(b.patch.indexOf('@@')));
  expect(diffRevision(a)).not.toBe(diffRevision(b));
});

it('keeps a complete 217-file manifest beyond the aggregate preview and spools a >1 MiB text diff losslessly',async()=>{
  temp=await mkdtemp(path.join(os.tmpdir(),'menoteam-complete-diff-'));
  await git(temp,'init','-q');await git(temp,'config','user.name','Test');await git(temp,'config','user.email','test@example.invalid');
  await mkdir(path.join(temp,'source'));
  await writeFile(path.join(temp,'source','large Ω file.txt'),'base\n');
  for(let index=0;index<216;index++)await writeFile(path.join(temp,'source',`ordinary ${index}.txt`),'base\n');
  await git(temp,'add','-A');await git(temp,'commit','-qm','base');const base=(await git(temp,'rev-parse','HEAD')).trim();
  const largeText=('quote " slash \\ tab\t line\n雪🙂\n').repeat(55_000);
  await writeFile(path.join(temp,'source','large Ω file.txt'),largeText);
  for(let index=0;index<216;index++)await writeFile(path.join(temp,'source',`ordinary ${index}.txt`),`changed ${index} ${'x'.repeat(1500)}\n`);
  await git(temp,'add','-A');await git(temp,'commit','-qm','candidate');
  const diff=await createDiff(temp,base);
  expect(diff.files).toHaveLength(217);expect(diff.totalFiles).toBe(217);expect(Buffer.byteLength(diff.patch)).toBe(280_000);expect(diff.truncated).toBe(true);
  expect(diff.files.some(file=>file.path==='source/large Ω file.txt'&&file.status==='modified'&&!file.binary)).toBe(true);
  const directory=path.join(temp,'spool');await mkdir(directory);const file=diff.files.find(item=>item.path==='source/large Ω file.txt')!;
  const index=await spoolDiffFile(temp,base,diff.candidateRevision,file,directory);
  expect(index.byteLength).toBeGreaterThan(1_000_000);expect(index.chunks).toBeGreaterThan(4);
  const joined=Buffer.concat(await Promise.all(Array.from({length:index.chunks},(_,part)=>readFile(path.join(directory,createHash('sha256').update(file.path).digest('hex'),String(part))))));
  expect(createHash('sha256').update(joined).digest('hex')).toBe(index.sha256);
  const expected=Buffer.from(await git(temp,'diff','--find-renames','--no-ext-diff','-U0',`${base}..${diff.candidateRevision}`,'--',file.path));
  expect(joined.equals(expected)).toBe(true);
  for(let part=0;part<index.chunks;part++){
    const chunk=await readFile(path.join(directory,createHash('sha256').update(file.path).digest('hex'),String(part)));
    const serialized=JSON.stringify({kind:'diff_file_chunk',revision:'r'.repeat(64),requestId:`diff-file:${diff.candidateRevision}:${createHash('sha256').update(file.path).digest('hex')}:${part}`,data:{path:file.path,contentBase64:chunk.toString('base64'),escaped:'\\\"\n\t'}});
    expect(Buffer.byteLength(serialized)).toBeLessThan(1_000_000);
  }
});

it('marks invalid UTF-8 text diffs unsupported while retaining exact raw spool bytes',async()=>{
  temp=await mkdtemp(path.join(os.tmpdir(),'menoteam-invalid-utf8-'));await git(temp,'init','-q');await git(temp,'config','user.name','Test');await git(temp,'config','user.email','test@example.invalid');await writeFile(path.join(temp,'encoding.bin'),Buffer.from([0x61,0x0a]));await git(temp,'add','-A');await git(temp,'commit','-qm','base');const base=(await git(temp,'rev-parse','HEAD')).trim();await writeFile(path.join(temp,'encoding.bin'),Buffer.from([0xff,0x0a,0x62,0x0a]));await git(temp,'add','-A');await git(temp,'commit','-qm','invalid utf8 candidate');const diff=await createDiff(temp,base),file=diff.files.find(item=>item.path==='encoding.bin')!;expect(file.binary).toBe(false);const directory=path.join(temp,'spool');await mkdir(directory);const index=await spoolDiffFile(temp,base,diff.candidateRevision,file,directory);expect(index.encodingUnsupported).toBe(true);const reconstructed=Buffer.concat(await Promise.all(Array.from({length:index.chunks},(_,part)=>readFile(path.join(directory,createHash('sha256').update(file.path).digest('hex'),String(part))))));expect(createHash('sha256').update(reconstructed).digest('hex')).toBe(index.sha256);expect(reconstructed.includes(Buffer.from([0xff]))).toBe(true);
});
