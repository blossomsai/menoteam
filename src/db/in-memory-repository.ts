import { randomUUID } from 'node:crypto';
import { DomainError, validateRef } from '../domain/errors.js';
import type { WorkMapRepository } from '../domain/repository.js';
import { validateCreateWork, validateTeammateChanges, validateWorkChanges } from '../domain/validation.js';
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
} from '../domain/model.js';

export class InMemoryWorkMapRepository implements WorkMapRepository {
  private readonly works = new Map<string, Work>();
  private readonly teammates = new Map<string, Teammate>();
  private readonly history = new Map<string, RevisionSnapshot[]>();

  async list(kind: 'work', filters: WorkFilters, cursor: string | undefined, limit: number): Promise<ListPage<WorkSummary>>;
  async list(kind: 'teammate', filters: Record<string, never>, cursor: string | undefined, limit: number): Promise<ListPage<TeammateSummary>>;
  async list(kind: 'work' | 'teammate', filters: WorkFilters | Record<string, never>, cursor: string | undefined, limit: number): Promise<ListPage<WorkSummary | TeammateSummary>> {
    const offset = decodeCursor(cursor);
    if (kind === 'work') {
      const workFilters = filters as WorkFilters;
      const ancestorRefs = workFilters.ancestor === undefined ? null : this.descendantRefs(workFilters.ancestor);
      const matching = [...this.works.values()]
        .filter((work) => {
          return (ancestorRefs === null || ancestorRefs.has(work.ref))
            && (workFilters.title === undefined || work.title === workFilters.title)
            && (workFilters.owner === undefined || work.owner === workFilters.owner)
            && (workFilters.state === undefined || work.state === workFilters.state)
            && (workFilters.parent === undefined || work.parent === workFilters.parent);
        })
        .sort(compareByTitle);
      const items = matching.slice(offset, offset + limit)
        .map((work) => toWorkSummary(work, this.descendantRefs(work.ref).size));
      return { items, next_cursor: offset + items.length < matching.length ? encodeCursor(offset + items.length) : null, total_count: matching.length };
    }
    const matching = [...this.teammates.values()].sort(compareByName);
    const items = matching.slice(offset, offset + limit).map(toTeammateSummary);
    return { items, next_cursor: offset + items.length < matching.length ? encodeCursor(offset + items.length) : null, total_count: matching.length };
  }

  async search(query: string, cursor: string | undefined, limit: number): Promise<ListPage<SearchResult>> {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return { items: [], next_cursor: null, total_count: 0 };
    const terms = needle.split(/\s+/u);
    const results: Array<{ result: SearchResult; score: number }> = [];
    for (const work of this.works.values()) {
      const haystack = `${work.title} ${work.current_summary} ${work.living_doc_markdown}`.toLocaleLowerCase();
      const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
      if (score) results.push({ result: { ...toWorkSummary(work, this.descendantRefs(work.ref).size), kind: 'work' }, score });
    }
    for (const teammate of this.teammates.values()) {
      const haystack = `${teammate.display_name} ${teammate.memory}`.toLocaleLowerCase();
      const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
      if (score) results.push({ result: { ...toTeammateSummary(teammate), kind: 'teammate' }, score });
    }
    results.sort((a, b) => {
      const aLabel = a.result.kind === 'work' ? a.result.title : a.result.display_name;
      const bLabel = b.result.kind === 'work' ? b.result.title : b.result.display_name;
      return b.score - a.score || a.result.kind.localeCompare(b.result.kind) || aLabel.localeCompare(bLabel) || a.result.ref.localeCompare(b.result.ref);
    });
    const offset = decodeCursor(cursor);
    const items = results.slice(offset, offset + limit).map(({ result }) => result);
    return { items, next_cursor: offset + items.length < results.length ? encodeCursor(offset + items.length) : null, total_count: results.length };
  }

  async read(ref: string): Promise<Entity> {
    const entity = this.works.get(ref) ?? this.teammates.get(ref);
    if (!entity) throw new DomainError('NOT_FOUND', `Entity ${ref} was not found`);
    return clone(entity);
  }

  async createWork(input: CreateWorkInput): Promise<Work> {
    validateCreateWork(input);
    if (!this.teammates.has(input.owner)) throw new DomainError('NOT_FOUND', `Owner ${input.owner} was not found`);
    if (input.parent && !this.works.has(input.parent)) throw new DomainError('NOT_FOUND', `Parent ${input.parent} was not found`);
    for (const dependency of input.dependencies ?? []) {
      if (!this.works.has(dependency)) throw new DomainError('NOT_FOUND', `Dependency ${dependency} was not found`);
    }
    const now = new Date().toISOString();
    const work: Work = {
      ref: `work_${randomUUID()}`,
      title: input.title,
      owner: input.owner,
      owner_source: input.owner_source ?? 'confirmed',
      owner_evidence: [...(input.owner_evidence ?? [])],
      state: input.state,
      parent: input.parent ?? null,
      dependencies: [...(input.dependencies ?? [])],
      current_summary: input.current_summary,
      living_doc_markdown: input.living_doc_markdown,
      revision: 1,
      created_at: now,
      updated_at: now,
    };
    this.works.set(work.ref, work);
    this.saveRevision(work);
    return clone(work);
  }

  async updateWork(ref: string, expectedRevision: number, changes: WorkChanges): Promise<Work> {
    validateRef(ref, 'work');
    validateWorkChanges(changes);
    const current = this.works.get(ref);
    if (!current) throw new DomainError('NOT_FOUND', `Work ${ref} was not found`);
    if (current.revision !== expectedRevision) throw new DomainError('CONFLICT', 'Work was changed by another agent', { current_revision: current.revision });
    if (changes.owner && !this.teammates.has(changes.owner)) throw new DomainError('NOT_FOUND', `Owner ${changes.owner} was not found`);
    if (changes.parent && !this.works.has(changes.parent)) throw new DomainError('NOT_FOUND', `Parent ${changes.parent} was not found`);
    if (changes.parent) this.assertNoParentCycle(ref, changes.parent);
    for (const dependency of changes.dependencies ?? []) {
      if (dependency === ref) throw new DomainError('VALIDATION', 'A Work cannot depend on itself');
      if (!this.works.has(dependency)) throw new DomainError('NOT_FOUND', `Dependency ${dependency} was not found`);
    }
    const next: Work = {
      ...current,
      ...changes,
      owner: changes.owner ?? current.owner,
      owner_source: changes.owner_source ?? (changes.owner !== undefined && changes.owner !== current.owner ? 'confirmed' : current.owner_source),
      owner_evidence: changes.owner_evidence === undefined
        ? changes.owner !== undefined && changes.owner !== current.owner ? [] : current.owner_evidence
        : [...changes.owner_evidence],
      state: changes.state ?? current.state,
      parent: changes.parent === undefined ? current.parent : changes.parent,
      dependencies: changes.dependencies === undefined ? current.dependencies : [...changes.dependencies],
      current_summary: changes.current_summary ?? current.current_summary,
      living_doc_markdown: changes.living_doc_markdown ?? current.living_doc_markdown,
      revision: current.revision + 1,
      updated_at: new Date().toISOString(),
    };
    this.works.set(ref, next);
    this.saveRevision(next);
    return clone(next);
  }

  async updateTeammate(ref: string, expectedRevision: number, changes: TeammateChanges): Promise<Teammate> {
    validateRef(ref, 'teammate');
    validateTeammateChanges(changes);
    const current = this.teammates.get(ref);
    if (expectedRevision === 0 && current) throw new DomainError('CONFLICT', 'Teammate already exists', { current_revision: current.revision });
    if (current && current.revision !== expectedRevision) throw new DomainError('CONFLICT', 'Teammate was changed by another agent', { current_revision: current.revision });
    if (!current && expectedRevision !== 0) throw new DomainError('NOT_FOUND', `Teammate ${ref} was not found`);
    const displayName = changes.display_name ?? current?.display_name;
    if (!displayName) throw new DomainError('VALIDATION', 'display_name is required when creating a teammate');
    this.assertUniqueIdentity(ref, displayName, changes.default_agent_addresses ?? current?.default_agent_addresses ?? {});
    const now = new Date().toISOString();
    const next: Teammate = current
      ? { ...current, ...changes, display_name: displayName, default_agent_addresses: changes.default_agent_addresses ?? current.default_agent_addresses, memory: changes.memory ?? current.memory, revision: current.revision + 1, updated_at: now }
      : { ref, display_name: displayName, default_agent_addresses: changes.default_agent_addresses ?? {}, memory: changes.memory ?? '', revision: 1, created_at: now, updated_at: now };
    this.teammates.set(ref, next);
    this.saveRevision(next);
    return clone(next);
  }

  async revisions(ref: string): Promise<RevisionSnapshot[]> {
    return clone(this.history.get(ref) ?? []);
  }

  async health(): Promise<boolean> { return true; }
  async close(): Promise<void> { /* in-memory test store */ }

  private assertUniqueIdentity(ref: string, displayName: string, addresses: Record<string, string>): void {
    for (const teammate of this.teammates.values()) {
      if (teammate.ref !== ref && teammate.display_name.toLocaleLowerCase() === displayName.toLocaleLowerCase()) {
        throw new DomainError('DUPLICATE_IDENTITY', 'A teammate with that display name already exists');
      }
      if (teammate.ref !== ref && Object.values(teammate.default_agent_addresses).some((address) => Object.values(addresses).includes(address))) {
        throw new DomainError('DUPLICATE_IDENTITY', 'A teammate agent address is already registered');
      }
    }
  }

  private assertNoParentCycle(ref: string, parent: string): void {
    let next: string | null = parent;
    for (let count = 0; next && count < 1000; count += 1) {
      if (next === ref) throw new DomainError('VALIDATION', 'Parent relationship would create a cycle');
      next = this.works.get(next)?.parent ?? null;
    }
    if (next) throw new DomainError('VALIDATION', 'Parent hierarchy is too deep');
  }

  private descendantRefs(ancestor: string): Set<string> {
    const descendants = new Set<string>([ancestor]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const work of this.works.values()) {
        if (work.parent && descendants.has(work.parent) && !descendants.has(work.ref)) {
          descendants.add(work.ref);
          changed = true;
        }
      }
    }
    return descendants;
  }

  private saveRevision(entity: Work | Teammate): void {
    const kind = 'title' in entity ? 'work' : 'teammate';
    const snapshot: RevisionSnapshot = {
      entity_kind: kind,
      entity_ref: entity.ref,
      revision: entity.revision,
      full_snapshot: clone(entity),
      created_at: entity.updated_at,
    };
    const snapshots = this.history.get(entity.ref) ?? [];
    snapshots.push(snapshot);
    this.history.set(entity.ref, snapshots);
  }
}

function toWorkSummary(work: Work, subtreeCount: number): WorkSummary { return { ref: work.ref, title: work.title, owner: work.owner, owner_source: work.owner_source, state: work.state, parent: work.parent, dependencies: [...work.dependencies], current_summary: work.current_summary, subtree_count: subtreeCount, revision: work.revision, updated_at: work.updated_at }; }
function toTeammateSummary(teammate: Teammate): TeammateSummary { return { ref: teammate.ref, display_name: teammate.display_name, default_agent_addresses: { ...teammate.default_agent_addresses }, revision: teammate.revision, updated_at: teammate.updated_at }; }
function compareByTitle(a: Work, b: Work): number { return a.title.localeCompare(b.title) || a.ref.localeCompare(b.ref); }
function compareByName(a: Teammate, b: Teammate): number { return a.display_name.localeCompare(b.display_name) || a.ref.localeCompare(b.ref); }
function encodeCursor(offset: number): string { return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url'); }
function decodeCursor(cursor: string | undefined): number { if (!cursor) return 0; try { const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { offset?: unknown }; return typeof parsed.offset === 'number' && Number.isInteger(parsed.offset) && parsed.offset >= 0 ? parsed.offset : 0; } catch { return 0; } }
function clone<T>(value: T): T { return structuredClone(value); }
