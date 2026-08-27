import type {
  CreateWorkInput,
  Entity,
  ListPage,
  RevisionSnapshot,
  SearchResult,
  Teammate,
  TeammateChanges,
  TeammateSummary,
  Work,
  WorkChanges,
  WorkFilters,
  WorkSummary,
} from './model.js';

export interface WorkMapRepository {
  list(kind: 'work', filters: WorkFilters, cursor: string | undefined, limit: number): Promise<ListPage<WorkSummary>>;
  list(kind: 'teammate', filters: Record<string, never>, cursor: string | undefined, limit: number): Promise<ListPage<TeammateSummary>>;
  search(query: string, cursor: string | undefined, limit: number): Promise<ListPage<SearchResult>>;
  read(ref: string): Promise<Entity>;
  createWork(input: CreateWorkInput): Promise<Work>;
  updateWork(ref: string, expectedRevision: number, changes: WorkChanges): Promise<Work>;
  updateTeammate(ref: string, expectedRevision: number, changes: TeammateChanges): Promise<Teammate>;
  revisions(ref: string): Promise<RevisionSnapshot[]>;
  health(): Promise<boolean>;
  close(): Promise<void>;
}
