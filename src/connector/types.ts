import type { Artifact, Project, Run, Setting } from '../workbench/types.js';

export interface ConnectorConfig {
  serverUrl: string;
  token: string;
  connectorId: string;
  dataDir: string;
  projects: Record<string, string>;
  codexBinary?: string;
  models?: string[];
  pollIntervalMs?: number;
  leaseRenewIntervalMs?: number;
}

export interface ClaimedRun {
  run: Run;
  project: Project;
  messages: Array<{ id: string; role: string; speaker: string; text: string; createdAt: string }>;
  settings: Setting[];
}

export interface FencedRun extends Run {
  generation: number;
}

export interface ConnectorEvent {
  id: string;
  type: string;
  text: string;
  threadId?: string;
}

export interface DiffLine {
  type: 'context' | 'add' | 'remove';
  oldLine?: number;
  newLine?: number;
  text: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  binary: boolean;
  additions: number | null;
  deletions: number | null;
  hunks: DiffHunk[];
}

export interface DiffArtifactData {
  source: 'git';
  baseRevision: string;
  candidateRevision: string;
  files: DiffFile[];
  additions: number;
  deletions: number;
  totalFiles: number;
  patch: string;
  truncated: boolean;
}

export interface QaCheck {
  name: string;
  command: string;
  exitCode: number | null;
  output: string;
  outputChannel: 'combined';
  durationMs: number | null;
  startedAt: string | null;
  finishedAt: string;
  testedRevision: string | null;
  source: 'codex-command';
}

export interface QaArtifactData {
  checks: QaCheck[];
  capturedAt: string;
  revision: string;
  stale: boolean;
}

export interface UploadArtifact {
  kind: Artifact['kind'];
  revision: string;
  data: unknown;
  requestId: string;
}
