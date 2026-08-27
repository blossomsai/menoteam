export type WorkState = 'current' | 'completed';
export type OwnerSource = 'confirmed' | 'inferred' | 'unresolved';
export type EntityKind = 'work' | 'teammate';
export type AgentAddresses = Record<string, string>;

export interface OwnerEvidence {
  kind: string;
  label: string;
  ref?: string;
  detail?: string;
  url?: string;
}

export interface Work {
  ref: string;
  title: string;
  owner: string;
  owner_source: OwnerSource;
  owner_evidence: OwnerEvidence[];
  state: WorkState;
  parent: string | null;
  dependencies: string[];
  current_summary: string;
  living_doc_markdown: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface Teammate {
  ref: string;
  display_name: string;
  default_agent_addresses: AgentAddresses;
  memory: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export type Entity = Work | Teammate;

export type WorkSummary = Pick<Work, 'ref' | 'title' | 'owner' | 'owner_source' | 'state' | 'parent' | 'dependencies' | 'current_summary' | 'revision' | 'updated_at'> & {
  /** This Work plus every descendant reachable through parent links. */
  subtree_count: number;
};
export type TeammateSummary = Pick<Teammate, 'ref' | 'display_name' | 'default_agent_addresses' | 'revision' | 'updated_at'>;
export type SearchResult = (WorkSummary & { kind: 'work' }) | (TeammateSummary & { kind: 'teammate' });

export interface WorkFilters {
  title?: string;
  parent?: string | null;
  ancestor?: string;
  owner?: string;
  state?: WorkState;
}

export interface ListPage<T> {
  items: T[];
  next_cursor: string | null;
  total_count: number;
}

export interface CreateWorkInput {
  title: string;
  owner: string;
  owner_source?: OwnerSource;
  owner_evidence?: OwnerEvidence[];
  state: WorkState;
  parent?: string | null;
  dependencies?: string[];
  current_summary: string;
  living_doc_markdown: string;
}

export interface WorkChanges {
  owner?: string;
  owner_source?: OwnerSource;
  owner_evidence?: OwnerEvidence[];
  state?: WorkState;
  parent?: string | null;
  dependencies?: string[];
  current_summary?: string;
  living_doc_markdown?: string;
}

export interface TeammateChanges {
  display_name?: string;
  default_agent_addresses?: AgentAddresses;
  memory?: string;
}

export interface RevisionSnapshot {
  entity_kind: EntityKind;
  entity_ref: string;
  revision: number;
  full_snapshot: Entity;
  created_at: string;
}
