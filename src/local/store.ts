import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { InMemoryWorkMapRepository } from '../db/in-memory-repository.js';
import type { LocalState } from './types.js';

export const EMPTY_STATE: LocalState = { projects: [], jobs: [], workMap: { works: [], teammates: [], history: [] } };

export async function loadState(file: string, repo: InMemoryWorkMapRepository): Promise<LocalState> {
  let state: LocalState;
  try { state = JSON.parse(await readFile(file, 'utf8')) as LocalState; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; state = structuredClone(EMPTY_STATE); }
  if (!Array.isArray(state.projects) || !Array.isArray(state.jobs) || !state.workMap || !Array.isArray(state.workMap.works) || !Array.isArray(state.workMap.teammates) || !Array.isArray(state.workMap.history)) throw new Error('Local state file is malformed; refusing to overwrite it');
  repo.restoreSnapshot(state.workMap);
  return state;
}

export async function saveState(file: string, state: LocalState, repo: InMemoryWorkMapRepository): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const next = `${file}.${process.pid}.tmp`;
  await writeFile(next, JSON.stringify({ ...state, workMap: repo.exportSnapshot() }), { mode: 0o600 });
  await rename(next, file);
}
