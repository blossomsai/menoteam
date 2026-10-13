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

it('spools wildcard, pathspec-magic and renamed paths literally without selecting sibling files',async()=>{
  temp=await mkdtemp(path.join(os.tmpdir(),'menoteam-literal-diff-'));await git(temp,'init','-q');await git(temp,'config','user.name','Test');await git(temp,'config','user.email','test@example.invalid');
  const names=['wild*.txt','wild-one.txt','question?.txt','questionx.txt','bracket[ab].txt','bracketa.txt',':(glob)*.txt',':(exclude)hidden.txt','hidden.txt','old*.txt','olda.txt','newa.txt'];
  for(let index=0;index<names.length;index++)await writeFile(path.join(temp,names[index]!),`BASE_MARKER_${index}\n`);
  await git(temp,'add','-A');await git(temp,'commit','-qm','base');const base=(await git(temp,'rev-parse','HEAD')).trim();
  for(let index=0;index<names.length;index++)if(names[index]!=='old*.txt')await writeFile(path.join(temp,names[index]!),`CHANGED_MARKER_${index}\n`);
  await rm(path.join(temp,'old*.txt'));await writeFile(path.join(temp,'new[ab].txt'),'BASE_MARKER_9\n');await git(temp,'add','-A');await git(temp,'commit','-qm','candidate');
  const diff=await createDiff(temp,base),directory=path.join(temp,'spool');await mkdir(directory);expect(diff.files).toHaveLength(names.length);
  expect(diff.files.find(file=>file.path==='new[ab].txt')).toMatchObject({oldPath:'old*.txt',status:'renamed'});
  for(const file of diff.files){
    const index=await spoolDiffFile(temp,base,diff.candidateRevision,file,directory),chunks=await Promise.all(Array.from({length:index.chunks},(_,part)=>readFile(path.join(directory,createHash('sha256').update(file.path).digest('hex'),String(part))))),bytes=Buffer.concat(chunks);
    const selected=[...(file.oldPath?[file.oldPath]:[]),file.path],expected=await git(temp,'--literal-pathspecs','diff','--find-renames','--no-ext-diff','-U0',`${base}..${diff.candidateRevision}`,'--',...selected);
    expect(bytes.toString('utf8')).toBe(expected);expect(expected.match(/^diff --git /gmu)).toHaveLength(1);
    const paths=(await git(temp,'--literal-pathspecs','diff','--name-only','-z','--find-renames',`${base}..${diff.candidateRevision}`,'--',...selected)).split('\0').filter(Boolean);expect(paths).toEqual([file.path]);
  }
});

it.each([false,true])('isolates each file/directory conversion patch and hash, reverse=%s',async(reverse)=>{
  temp=await mkdtemp(path.join(os.tmpdir(),'menoteam-exact-conversion-'));await git(temp,'init','-q');await git(temp,'config','user.name','Test');await git(temp,'config','user.email','test@example.invalid');
  const root=':(glob)雪 space\tline\n[?]*',child=`${root}/new.txt`,other=`${root}/other.txt`;
  const putFile=async()=>{await rm(path.join(temp,root),{recursive:true,force:true});await writeFile(path.join(temp,root),'ONLY_ROOT_FILE\n');};
  const putDirectory=async()=>{await rm(path.join(temp,root),{recursive:true,force:true});await mkdir(path.join(temp,root));await writeFile(path.join(temp,child),'ONLY_NEW_CHILD\n');await writeFile(path.join(temp,other),'ONLY_OTHER_CHILD\n');};
  await (reverse?putDirectory():putFile());await git(temp,'add','-A');await git(temp,'commit','-qm','base');const base=(await git(temp,'rev-parse','HEAD')).trim();await (reverse?putFile():putDirectory());await git(temp,'add','-A');await git(temp,'commit','-qm','candidate');
  const diff=await createDiff(temp,base),directory=path.join(temp,'spool');await mkdir(directory);expect(diff.files).toHaveLength(3);
  const markers=new Map([[root,'ONLY_ROOT_FILE'],[child,'ONLY_NEW_CHILD'],[other,'ONLY_OTHER_CHILD']]);
  expect((await git(temp,'--literal-pathspecs','diff',`${base}..${diff.candidateRevision}`,'--',root)).match(/^diff --git /gmu)).toHaveLength(3);
  for(const file of diff.files){
    const index=await spoolDiffFile(temp,base,diff.candidateRevision,file,directory),bytes=Buffer.concat(await Promise.all(Array.from({length:index.chunks},(_,part)=>readFile(path.join(directory,createHash('sha256').update(file.path).digest('hex'),String(part))))));
    const patch=bytes.toString('utf8');expect(patch.match(/^diff --git /gmu)).toHaveLength(1);expect(patch).toContain(markers.get(file.path));for(const [name,marker] of markers)if(name!==file.path)expect(patch).not.toContain(marker);expect(createHash('sha256').update(bytes).digest('hex')).toBe(index.sha256);expect(bytes.length).toBe(index.byteLength);
    expect(file.status).toBe(file.path===root?(reverse?'added':'deleted'):(reverse?'deleted':'added'));
  }
});

it.each([false,true])('keeps an ancestor/descendant rename and unrelated children isolated, reverse=%s',async(reverse)=>{
  temp=await mkdtemp(path.join(os.tmpdir(),'menoteam-exact-rename-'));await git(temp,'init','-q');await git(temp,'config','user.name','Test');await git(temp,'config','user.email','test@example.invalid');
  const root='雪',child='雪/new.txt';const putFile=async()=>{await rm(path.join(temp,root),{recursive:true,force:true});await writeFile(path.join(temp,root),'SAME_RENAME_CONTENT\n'.repeat(20));};const putDirectory=async()=>{await rm(path.join(temp,root),{recursive:true,force:true});await mkdir(path.join(temp,root));await writeFile(path.join(temp,child),'SAME_RENAME_CONTENT\n'.repeat(20));await writeFile(path.join(temp,root,'other.txt'),'UNRELATED_CHILD\n');};
  await (reverse?putDirectory():putFile());await git(temp,'add','-A');await git(temp,'commit','-qm','base');const base=(await git(temp,'rev-parse','HEAD')).trim();await (reverse?putFile():putDirectory());await git(temp,'add','-A');await git(temp,'commit','-qm','candidate');const diff=await createDiff(temp,base),directory=path.join(temp,'spool');await mkdir(directory);
  const file=diff.files.find(item=>item.status==='renamed')!;expect(file).toMatchObject({path:reverse?root:child,oldPath:reverse?child:root});const index=await spoolDiffFile(temp,base,diff.candidateRevision,file,directory),bytes=Buffer.concat(await Promise.all(Array.from({length:index.chunks},(_,part)=>readFile(path.join(directory,createHash('sha256').update(file.path).digest('hex'),String(part))))));
  const patch=bytes.toString('utf8');expect(patch.match(/^diff --git /gmu)).toHaveLength(1);expect(patch).toContain('similarity index 100%');expect(patch).toContain('rename from');expect(patch).toContain('rename to');expect(patch).not.toContain('UNRELATED_CHILD');expect(createHash('sha256').update(bytes).digest('hex')).toBe(index.sha256);
});
