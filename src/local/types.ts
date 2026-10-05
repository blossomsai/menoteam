import type { Work } from '../domain/model.js';

export interface LocalProject { id: string; name: string; path: string; repositoryUrl: string; goal: string; instructions: string; workRef: string; createdAt: string; updatedAt: string }
export type LocalJobStatus = 'queued' | 'running' | 'needs_review' | 'accepted' | 'failed' | 'cancelled' | 'interrupted';
export interface LocalJob { id: string; projectId: string; prompt: string; mode: 'read-only' | 'workspace-write'; status: LocalJobStatus; createdAt: string; updatedAt: string; startedAt?: string; finishedAt?: string; threadId?: string; output: string; error?: string; recoveryConfirmed?: boolean; events: Array<{ at: string; type: string; text: string }> }
export interface LocalState { projects: LocalProject[]; jobs: LocalJob[]; submissions?: Record<string, string>; workMap: { works: Work[]; teammates: import('../domain/model.js').Teammate[]; history: import('../domain/model.js').RevisionSnapshot[] } }
export interface RunnerInput { project: LocalProject; job: LocalJob; codexBinary?: string; onEvent(event: { type: string; text: string; threadId?: string }): void }
export interface RunnerHandle { result: Promise<{ output: string; threadId?: string }>; cancel(): void }
export type LocalRunner = (input: RunnerInput) => RunnerHandle;
