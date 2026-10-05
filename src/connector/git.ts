import { createHash } from 'node:crypto';
import { execFile as execFileCb, spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readlink, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ConnectorConfig, DiffArtifactData, DiffFile, DiffLine } from './types.js';

const execFile = promisify(execFileCb);
const DIFF_LIMIT = 280_000;
const MAX_BUFFER = 4 * 1024 * 1024;

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER });
  return stdout;
}

export interface Worktree { path: string; revision: string; baseRevision: string; artifactRevision?: string; }

/** Worktrees are based only on committed refs. Existing dirty checkout files are never copied implicitly. */
export async function ensureWorktree(config: ConnectorConfig, projectId: string, workId: string, baseRef = 'HEAD'): Promise<Worktree> {
  const configured = config.projects[projectId];
  if (!configured) throw new Error(`No local repository is configured for project ${projectId}`);
  const root = await realpath(configured);
  const dataDir = path.resolve(config.dataDir);
  if (dataDir === root || dataDir.startsWith(`${root}${path.sep}`)) throw new Error('Connector data directory must be outside project repositories');
  const commonDir = (await git(root, 'rev-parse', '--show-toplevel')).trim();
  if (await realpath(commonDir) !== root) throw new Error('Configured repository path must be its canonical worktree root');
  const target = path.join(dataDir, 'worktrees', projectId, workId);
  const stateFile = path.join(dataDir, 'worktree-map', `${encodeURIComponent(workId)}.json`);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    const existing = await realpath(target);
    const registered = (await git(root, 'worktree', 'list', '--porcelain')).split(/\n/u).some(line => line === `worktree ${existing}`);
    if (!registered || !existing.startsWith(`${path.join(dataDir, 'worktrees')}${path.sep}`)) throw new Error('Existing worktree mapping is not a registered connector worktree');
    const saved = JSON.parse(await readFile(stateFile, 'utf8')) as Worktree;
    if (saved.path !== existing || !/^[a-f0-9]{40,64}$/u.test(saved.baseRevision)) throw new Error('Saved Work mapping does not match the registered local worktree');
    return { ...saved, revision: (await git(existing, 'rev-parse', 'HEAD')).trim() };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const revision = (await git(root, 'rev-parse', '--verify', `${baseRef}^{commit}`)).trim();
  await git(root, 'worktree', 'add', '--detach', target, revision);
  const actual = await realpath(target);
  const result = { path: actual, revision, baseRevision: revision };
  await persistWorktreeMap(dataDir, workId, result);
  return result;
}

export async function fingerprint(cwd: string): Promise<string> {
  const root = path.resolve(cwd);
  const files = [...new Set((await git(cwd, 'ls-files', '-z', '--cached', '--others', '--exclude-standard')).split('\0').filter(Boolean))].sort();
  const hash = createHash('sha256');
  for (const file of files) {
    const absolute = path.resolve(cwd, file);
    if (!absolute.startsWith(`${root}${path.sep}`)) throw new Error('Indexed path escaped the worktree');
    let metadata;
    try { metadata = await lstat(absolute); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    let contentHash: string;
    if (metadata.isSymbolicLink()) contentHash = createHash('sha256').update(`symlink:${await readlink(absolute)}`).digest('hex');
    else if (metadata.isFile()) {
      const fileHash = createHash('sha256');
      for await (const chunk of createReadStream(absolute)) fileHash.update(chunk as Buffer);
      contentHash = fileHash.digest('hex');
    } else contentHash = 'unsupported-file-kind';
    hash.update(`${file}\0${metadata.mode & 0o111}\0${metadata.isSymbolicLink() ? 'link' : metadata.isFile() ? 'file' : 'other'}\0${contentHash}\0`);
  }
  return hash.digest('hex');
}

export async function checkpoint(cwd: string, message: string): Promise<string> {
  const before = await git(cwd, 'status', '--porcelain=v1', '--untracked-files=all');
  if (!before.trim()) return (await git(cwd, 'rev-parse', 'HEAD')).trim();
  await git(cwd, 'add', '-A', '--');
  await execFile('git', ['-c','user.name=Menoteam Connector','-c','user.email=connector@localhost','commit','-m',message.slice(0,160)], { cwd, encoding:'utf8', maxBuffer: MAX_BUFFER });
  return (await git(cwd, 'rev-parse', 'HEAD')).trim();
}

export async function createDiff(cwd: string, baseRevision: string): Promise<DiffArtifactData> {
  if (!/^[a-f0-9]{40,64}$/u.test(baseRevision)) throw new Error('Diff base revision is invalid');
  const candidateRevision = (await git(cwd, 'rev-parse', 'HEAD')).trim();
  const names = await git(cwd, 'diff', '--name-status', '-z', '--find-renames', `${baseRevision}..HEAD`, '--');
  const paths: Array<{ path: string; oldPath?: string; status: DiffFile['status'] }> = [];
  const nameParts = names.split('\0');
  for (let i = 0; i < nameParts.length;) {
    const code = nameParts[i++]; if (!code) continue;
    const first = nameParts[i++];
    const second = code.startsWith('R') || code.startsWith('C') ? nameParts[i++] : undefined;
    const state = code?.startsWith('R') ? 'renamed' : code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified';
    paths.push(state === 'renamed' ? { path: second!, oldPath: first!, status: state } : { path: first!, status: state });
  }
  const bounded = await boundedDiff(cwd, ['diff', '--find-renames', '--binary', '--no-ext-diff', '-U0', `${baseRevision}..${candidateRevision}`, '--']);
  const patch = bounded.patch;
  const patchStats = await git(cwd, 'diff', '--numstat', '-z', '--no-renames', `${baseRevision}..${candidateRevision}`, '--');
  let totalAdditions = 0; let totalDeletions = 0;
  for (const row of patchStats.split('\0')) {
    const first = row.indexOf('\t'); if (first < 0) continue;
    const second = row.indexOf('\t', first + 1); if (second < 0) continue;
    totalAdditions += Number(row.slice(0, first)) || 0; totalDeletions += Number(row.slice(first + 1, second)) || 0;
  }
  const files: DiffFile[] = [];
  const sections = patch.split(/(?=^diff --git )/mu).filter(section => section.startsWith('diff --git '));
  for (let index = 0; index < Math.min(sections.length, paths.length); index++) {
    const { path: displayPath, oldPath, status: state } = paths[index]!;
    const filePatch = sections[index]!;
    const binary = filePatch.includes('Binary files ') || filePatch.includes('GIT binary patch');
    const hunks: DiffFile['hunks'] = [];
    let current: DiffFile['hunks'][number] | undefined;
    let oldLine = 0; let newLine = 0;
    for (const line of filePatch.split('\n')) {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/u.exec(line);
      if (hunk) { current = { header: line, lines: [] }; hunks.push(current); oldLine = Number(hunk[1]); newLine = Number(hunk[2]); continue; }
      if (!current || line.startsWith('\\ No newline')) continue;
      const type = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'remove' : line.startsWith(' ') ? 'context' : undefined;
      if (!type) continue;
      const item: DiffLine = { type, text: line.slice(1) };
      if (type !== 'add') item.oldLine = oldLine++;
      if (type !== 'remove') item.newLine = newLine++;
      current.lines.push(item);
    }
    const add = filePatch.match(/^\+(?!\+).*$/gmu)?.length ?? 0;
    const del = filePatch.match(/^-(?!--).*$/gmu)?.length ?? 0;
    files.push({ path: displayPath, ...(oldPath ? { oldPath } : {}), status: state, binary, additions: binary ? null : add, deletions: binary ? null : del, hunks });
  }
  return { source: 'git', baseRevision, candidateRevision, files, additions: totalAdditions, deletions: totalDeletions, totalFiles: paths.length, patch, truncated: bounded.truncated || files.length < paths.length };
}

export async function persistWorktreeMap(dataDir: string, workId: string, worktree: Worktree): Promise<void> {
  const dir = path.join(dataDir, 'worktree-map'); await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${encodeURIComponent(workId)}.json`); const temp = `${file}.${process.pid}.tmp`;
  let prior: Partial<Worktree> = {};
  try { prior = JSON.parse(await readFile(file, 'utf8')) as Partial<Worktree>; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await writeFile(temp, JSON.stringify({ ...prior, ...worktree, baseRevision: prior.baseRevision ?? worktree.baseRevision }), { mode: 0o600 }); await rename(temp, file);
}

export async function readWorktreeMap(dataDir: string, workId: string): Promise<Worktree | undefined> {
  const file = path.join(dataDir, 'worktree-map', `${encodeURIComponent(workId)}.json`);
  try { return JSON.parse(await readFile(file, 'utf8')) as Worktree; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

export function diffRevision(diff: DiffArtifactData): string {
  return createHash('sha256').update(diff.baseRevision).update('\0').update(diff.candidateRevision).digest('hex');
}

async function boundedDiff(cwd: string, args: string[]): Promise<{ patch: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore','pipe','pipe'], shell: false });
    const chunks: Buffer[] = []; let captured = 0; let total = 0; let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (captured >= DIFF_LIMIT) return;
      const keep = chunk.subarray(0, DIFF_LIMIT - captured); chunks.push(keep); captured += keep.length;
    });
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 4096) stderr += chunk.toString('utf8').slice(0, 4096 - stderr.length); });
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) reject(new Error(`git diff failed (${code ?? 'signal'}): ${stderr.trim().slice(0, 500)}`));
      else resolve({ patch: Buffer.concat(chunks).toString('utf8'), truncated: total > DIFF_LIMIT });
    });
  });
}
