import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
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
  OwnerEvidence,
  OwnerSource,
} from '../domain/model.js';

type SqlClient = ReturnType<typeof postgres>;
type QueryClient = SqlClient | postgres.TransactionSql;

interface WorkRow {
  ref: string;
  title: string;
  owner_teammate_ref: string;
  owner_source: OwnerSource;
  owner_evidence: OwnerEvidence[];
  state: 'current' | 'completed';
  parent_ref: string | null;
  dependencies: string[];
  current_summary: string;
  living_doc_markdown: string;
  revision: number;
  created_at: Date | string;
  updated_at: Date | string;
}

interface WorkSummaryRow {
  ref: string;
  title: string;
  owner_teammate_ref: string;
  owner_source: OwnerSource;
  state: 'current' | 'completed';
  parent_ref: string | null;
  dependencies: string[];
  current_summary: string;
  subtree_count: number;
  revision: number;
  updated_at: Date | string;
}

interface PagedWorkRow extends WorkSummaryRow {
  total_count: number;
}

interface NullablePagedWorkRow extends Omit<PagedWorkRow, 'ref'> {
  // The totals row is deliberately retained when the requested page is empty.
  ref: string | null;
}

interface TeammateRow {
  ref: string;
  display_name: string;
  agent_addresses: Record<string, string>;
  memory: string;
  revision: number;
  created_at: Date | string;
  updated_at: Date | string;
}

interface PagedTeammateRow extends TeammateRow {
  total_count: number;
}

interface NullablePagedTeammateRow extends Omit<PagedTeammateRow, 'ref'> {
  // The totals row is deliberately retained when the requested page is empty.
  ref: string | null;
}

export class PostgresWorkMapRepository implements WorkMapRepository {
  constructor(private readonly sql: SqlClient) {}

  async list(kind: 'work', filters: WorkFilters, cursor: string | undefined, limit: number): Promise<ListPage<WorkSummary>>;
  async list(kind: 'teammate', filters: Record<string, never>, cursor: string | undefined, limit: number): Promise<ListPage<TeammateSummary>>;
  async list(kind: 'work' | 'teammate', filters: WorkFilters | Record<string, never>, cursor: string | undefined, limit: number): Promise<ListPage<WorkSummary | TeammateSummary>> {
    const offset = decodeCursor(cursor);
    if (kind === 'teammate') {
      const rows = await this.sql<NullablePagedTeammateRow[]>`
        WITH filtered AS (
          SELECT ref, display_name, agent_addresses, memory, revision, created_at, updated_at
          FROM teammates
        ), page AS (
          SELECT * FROM filtered
          ORDER BY display_name ASC, ref ASC
          LIMIT ${limit} OFFSET ${offset}
        ), totals AS (
          SELECT COUNT(*)::int AS total_count FROM filtered
        )
        SELECT page.ref, page.display_name, page.agent_addresses, page.memory,
               page.revision, page.created_at, page.updated_at, totals.total_count
        FROM totals
        LEFT JOIN page ON TRUE
        ORDER BY page.display_name ASC NULLS LAST, page.ref ASC NULLS LAST
      `;
      const pageRows = rows.filter((row): row is PagedTeammateRow => row.ref !== null);
      const items = pageRows.map(toTeammateSummary);
      const totalCount = rows[0]?.total_count ?? 0;
      return { items, next_cursor: offset + items.length < totalCount ? encodeCursor(offset + items.length) : null, total_count: totalCount };
    }
    const workFilters = filters as WorkFilters;
    const titleClause = workFilters.title === undefined ? this.sql`` : this.sql`AND w.title = ${workFilters.title}`;
    const parentClause = workFilters.parent === undefined
      ? this.sql``
      : workFilters.parent === null
        ? this.sql`AND w.parent_ref IS NULL`
        : this.sql`AND w.parent_ref = ${workFilters.parent}`;
    const ownerClause = workFilters.owner === undefined ? this.sql`` : this.sql`AND w.owner_teammate_ref = ${workFilters.owner}`;
    const stateClause = workFilters.state === undefined ? this.sql`` : this.sql`AND w.state = ${workFilters.state}`;
    const ancestorClause = workFilters.ancestor === undefined
      ? this.sql``
      : this.sql`AND w.ref IN (
          WITH RECURSIVE descendants(ref) AS (
            SELECT ref FROM works WHERE ref = ${workFilters.ancestor}
            UNION ALL
            SELECT child.ref FROM works child
            INNER JOIN descendants parent ON child.parent_ref = parent.ref
          )
          SELECT ref FROM descendants
        )`;
    const rows = await this.sql<NullablePagedWorkRow[]>`
      WITH RECURSIVE ancestry(ancestor_ref, descendant_ref) AS (
        SELECT ref, ref FROM works
        UNION ALL
        SELECT ancestry.ancestor_ref, child.ref
        FROM ancestry
        INNER JOIN works child ON child.parent_ref = ancestry.descendant_ref
      ), subtree_counts AS (
        SELECT ancestor_ref, COUNT(*)::int AS subtree_count
        FROM ancestry
        GROUP BY ancestor_ref
      ), filtered AS (
        SELECT w.ref, w.title, w.owner_teammate_ref, w.owner_source, w.state, w.parent_ref,
               COALESCE((SELECT array_agg(dependency_ref ORDER BY dependency_ref) FROM work_dependencies d WHERE d.work_ref = w.ref), '{}') AS dependencies,
               w.current_summary, subtree_counts.subtree_count, w.revision, w.updated_at
        FROM works w
        INNER JOIN subtree_counts ON subtree_counts.ancestor_ref = w.ref
        WHERE TRUE ${titleClause} ${parentClause} ${ancestorClause} ${ownerClause} ${stateClause}
      ), page AS (
        SELECT * FROM filtered
        ORDER BY title ASC, ref ASC
        LIMIT ${limit} OFFSET ${offset}
      ), totals AS (
        SELECT COUNT(*)::int AS total_count FROM filtered
      )
      SELECT page.ref, page.title, page.owner_teammate_ref, page.owner_source, page.state, page.parent_ref,
             page.dependencies, page.current_summary, page.subtree_count, page.revision, page.updated_at,
             totals.total_count
      FROM totals
      LEFT JOIN page ON TRUE
      ORDER BY page.title ASC NULLS LAST, page.ref ASC NULLS LAST
    `;
    const pageRows = rows.filter((row): row is PagedWorkRow => row.ref !== null);
    const items = pageRows.map(toWorkSummary);
    const totalCount = rows[0]?.total_count ?? 0;
    return { items, next_cursor: offset + items.length < totalCount ? encodeCursor(offset + items.length) : null, total_count: totalCount };
  }

  async search(query: string, cursor: string | undefined, limit: number): Promise<ListPage<SearchResult>> {
    const value = query.trim();
    if (!value) return { items: [], next_cursor: null, total_count: 0 };
    const offset = decodeCursor(cursor);
    const rows = await this.sql<NullableSearchRow[]>`
      WITH RECURSIVE ancestry(ancestor_ref, descendant_ref) AS (
        SELECT ref, ref FROM works
        UNION ALL
        SELECT ancestry.ancestor_ref, child.ref
        FROM ancestry
        INNER JOIN works child ON child.parent_ref = ancestry.descendant_ref
      ), subtree_counts AS (
        SELECT ancestor_ref, COUNT(*)::int AS subtree_count
        FROM ancestry
        GROUP BY ancestor_ref
      ), results AS (
        SELECT 'work'::text AS kind, w.ref, w.title, NULL::text AS display_name,
               w.owner_teammate_ref AS owner, w.owner_source, w.state, w.parent_ref AS parent,
               (SELECT COALESCE(array_agg(dependency_ref ORDER BY dependency_ref), '{}') FROM work_dependencies d WHERE d.work_ref = w.ref) AS dependencies,
               w.current_summary, subtree_counts.subtree_count, NULL::jsonb AS default_agent_addresses, w.revision, w.updated_at,
               ts_rank_cd(to_tsvector('simple', w.title || ' ' || w.current_summary || ' ' || w.living_doc_markdown), websearch_to_tsquery('simple', ${value})) + similarity(w.title, ${value}) AS score
        FROM works w
        INNER JOIN subtree_counts ON subtree_counts.ancestor_ref = w.ref
        WHERE to_tsvector('simple', w.title || ' ' || w.current_summary || ' ' || w.living_doc_markdown) @@ websearch_to_tsquery('simple', ${value})
           OR similarity(w.title, ${value}) > 0.2
        UNION ALL
        SELECT 'teammate'::text AS kind, t.ref, NULL::text AS title, t.display_name,
               NULL::text AS owner, NULL::text AS owner_source,
               NULL::text AS state, NULL::text AS parent,
               NULL::text[] AS dependencies, NULL::text AS current_summary, NULL::int AS subtree_count, t.agent_addresses AS default_agent_addresses,
               t.revision, t.updated_at,
               ts_rank_cd(to_tsvector('simple', t.display_name || ' ' || t.memory), websearch_to_tsquery('simple', ${value})) + similarity(t.display_name, ${value}) AS score
        FROM teammates t
        WHERE to_tsvector('simple', t.display_name || ' ' || t.memory) @@ websearch_to_tsquery('simple', ${value})
           OR similarity(t.display_name, ${value}) > 0.2
      ), page AS (
        SELECT * FROM results
        ORDER BY score DESC, kind ASC, COALESCE(title, display_name) ASC, ref ASC
        LIMIT ${limit} OFFSET ${offset}
      ), totals AS (
        SELECT COUNT(*)::int AS total_count FROM results
      )
      SELECT page.kind, page.ref, page.title, page.display_name, page.owner, page.state,
             page.parent, page.dependencies, page.current_summary, page.subtree_count,
             page.owner_source, page.default_agent_addresses, page.revision, page.updated_at,
             page.score, totals.total_count
      FROM totals
      LEFT JOIN page ON TRUE
      ORDER BY page.score DESC NULLS LAST, page.kind ASC NULLS LAST,
               COALESCE(page.title, page.display_name) ASC NULLS LAST, page.ref ASC NULLS LAST
    `;
    const pageRows = rows.filter((row): row is SearchRow => row.kind !== null && row.ref !== null);
    const items = pageRows.map(toSearchResult);
    const totalCount = rows[0]?.total_count ?? 0;
    return { items, next_cursor: offset + items.length < totalCount ? encodeCursor(offset + items.length) : null, total_count: totalCount };
  }

  async read(ref: string): Promise<Entity> {
    if (ref.startsWith('work_')) {
      validateRef(ref, 'work');
      const work = await queryWork(this.sql, ref);
      if (!work) throw new DomainError('NOT_FOUND', `Work ${ref} was not found`);
      return work;
    }
    if (ref.startsWith('teammate_')) {
      validateRef(ref, 'teammate');
      const teammate = await queryTeammate(this.sql, ref);
      if (!teammate) throw new DomainError('NOT_FOUND', `Teammate ${ref} was not found`);
      return teammate;
    }
    throw new DomainError('VALIDATION', 'Reference must identify a Work or teammate');
  }

  async createWork(input: CreateWorkInput): Promise<Work> {
    validateCreateWork(input);
    return this.sql.begin(async (tx) => {
      if (!await exists(tx, 'teammates', input.owner)) throw new DomainError('NOT_FOUND', `Owner ${input.owner} was not found`);
      if (input.parent && !await exists(tx, 'works', input.parent)) throw new DomainError('NOT_FOUND', `Parent ${input.parent} was not found`);
      for (const dependency of input.dependencies ?? []) {
        if (!await exists(tx, 'works', dependency)) throw new DomainError('NOT_FOUND', `Dependency ${dependency} was not found`);
      }
      const ref = `work_${randomUUID()}`;
      try {
        await tx`
          INSERT INTO works (ref, title, owner_teammate_ref, owner_source, owner_evidence, state, parent_ref, current_summary, living_doc_markdown, revision)
          VALUES (${ref}, ${input.title}, ${input.owner}, ${input.owner_source ?? 'confirmed'}, ${tx.json(JSON.parse(JSON.stringify(input.owner_evidence ?? [])))}, ${input.state}, ${input.parent ?? null}, ${input.current_summary}, ${input.living_doc_markdown}, 1)
        `;
        for (const dependency of input.dependencies ?? []) await tx`INSERT INTO work_dependencies (work_ref, dependency_ref) VALUES (${ref}, ${dependency})`;
      } catch (error) {
        throw mapPostgresError(error);
      }
      const work = await queryWork(tx, ref);
      if (!work) throw new DomainError('VALIDATION', 'Created Work could not be read');
      await saveRevision(tx, 'work', work);
      return work;
    });
  }

  async updateWork(ref: string, expectedRevision: number, changes: WorkChanges): Promise<Work> {
    validateRef(ref, 'work');
    validateWorkChanges(changes);
    return this.sql.begin(async (tx) => {
      const current = await queryWork(tx, ref, true);
      if (!current) throw new DomainError('NOT_FOUND', `Work ${ref} was not found`);
      if (current.revision !== expectedRevision) throw new DomainError('CONFLICT', 'Work was changed by another agent', { current_revision: current.revision });
      const owner = changes.owner ?? current.owner;
      const ownerChanged = changes.owner !== undefined && changes.owner !== current.owner;
      const ownerSource = changes.owner_source ?? (ownerChanged ? 'confirmed' : current.owner_source);
      const ownerEvidence = changes.owner_evidence ?? (ownerChanged ? [] : current.owner_evidence);
      const parent = changes.parent === undefined ? current.parent : changes.parent;
      const dependencies = changes.dependencies ?? current.dependencies;
      if (!await exists(tx, 'teammates', owner)) throw new DomainError('NOT_FOUND', `Owner ${owner} was not found`);
      if (parent && !await exists(tx, 'works', parent)) throw new DomainError('NOT_FOUND', `Parent ${parent} was not found`);
      if (parent) await assertNoParentCycle(tx, ref, parent);
      for (const dependency of dependencies) {
        if (dependency === ref) throw new DomainError('VALIDATION', 'A Work cannot depend on itself');
        if (!await exists(tx, 'works', dependency)) throw new DomainError('NOT_FOUND', `Dependency ${dependency} was not found`);
      }
      try {
        await tx`
          UPDATE works
          SET owner_teammate_ref = ${owner}, owner_source = ${ownerSource},
              owner_evidence = ${tx.json(JSON.parse(JSON.stringify(ownerEvidence)))}, state = ${changes.state ?? current.state}, parent_ref = ${parent},
              current_summary = ${changes.current_summary ?? current.current_summary},
              living_doc_markdown = ${changes.living_doc_markdown ?? current.living_doc_markdown},
              revision = revision + 1, updated_at = now()
          WHERE ref = ${ref} AND revision = ${expectedRevision}
        `;
        if (changes.dependencies !== undefined) {
          await tx`DELETE FROM work_dependencies WHERE work_ref = ${ref}`;
          for (const dependency of dependencies) await tx`INSERT INTO work_dependencies (work_ref, dependency_ref) VALUES (${ref}, ${dependency})`;
        }
      } catch (error) {
        throw mapPostgresError(error);
      }
      const work = await queryWork(tx, ref);
      if (!work) throw new DomainError('VALIDATION', 'Updated Work could not be read');
      await saveRevision(tx, 'work', work);
      return work;
    });
  }

  async updateTeammate(ref: string, expectedRevision: number, changes: TeammateChanges): Promise<Teammate> {
    validateRef(ref, 'teammate');
    validateTeammateChanges(changes);
    return this.sql.begin(async (tx) => {
      const current = await queryTeammate(tx, ref, true);
      if (expectedRevision === 0 && current) throw new DomainError('CONFLICT', 'Teammate already exists', { current_revision: current.revision });
      if (!current && expectedRevision !== 0) throw new DomainError('NOT_FOUND', `Teammate ${ref} was not found`);
      if (current && current.revision !== expectedRevision) throw new DomainError('CONFLICT', 'Teammate was changed by another agent', { current_revision: current.revision });
      const displayName = changes.display_name ?? current?.display_name;
      if (!displayName) throw new DomainError('VALIDATION', 'display_name is required when creating a teammate');
      const addresses = changes.default_agent_addresses ?? current?.default_agent_addresses ?? {};
      const duplicates = await tx<TeammateRow[]>`SELECT ref, display_name, agent_addresses, memory, revision, created_at, updated_at FROM teammates WHERE ref <> ${ref}`;
      const duplicate = duplicates.find((row) => Object.values(row.agent_addresses ?? {}).some((address) => Object.values(addresses).includes(address)));
      const duplicateName = duplicates.some((row) => row.display_name.toLocaleLowerCase() === displayName.toLocaleLowerCase());
      if (duplicateName) throw new DomainError('DUPLICATE_IDENTITY', 'A teammate with that display name already exists');
      if (duplicate) throw new DomainError('DUPLICATE_IDENTITY', 'A teammate agent address is already registered');
      const nowRevision = current ? current.revision + 1 : 1;
      try {
        if (current) {
          await tx`UPDATE teammates SET display_name = ${displayName}, agent_addresses = ${tx.json(addresses)}, memory = ${changes.memory ?? current.memory}, revision = ${nowRevision}, updated_at = now() WHERE ref = ${ref} AND revision = ${expectedRevision}`;
        } else {
          await tx`INSERT INTO teammates (ref, display_name, agent_addresses, memory, revision) VALUES (${ref}, ${displayName}, ${tx.json(addresses)}, ${changes.memory ?? ''}, 1)`;
        }
      } catch (error) {
        throw mapPostgresError(error);
      }
      const teammate = await queryTeammate(tx, ref);
      if (!teammate) throw new DomainError('VALIDATION', 'Updated teammate could not be read');
      await saveRevision(tx, 'teammate', teammate);
      return teammate;
    });
  }

  async revisions(ref: string): Promise<RevisionSnapshot[]> {
    const rows = await this.sql<RevisionSnapshot[]>`SELECT entity_kind, entity_ref, revision, full_snapshot, created_at FROM entity_revisions WHERE entity_ref = ${ref} ORDER BY revision ASC`;
    return rows.map((row) => ({ ...row, created_at: asIso(row.created_at) }));
  }

  async health(): Promise<boolean> {
    try { await this.sql`SELECT 1`; return true; } catch { return false; }
  }

  async close(): Promise<void> { await this.sql.end({ timeout: 5 }); }
}

interface SearchRow {
  kind: 'work' | 'teammate';
  ref: string;
  title: string | null;
  display_name: string | null;
  owner: string | null;
  state: 'current' | 'completed' | null;
  parent: string | null;
  dependencies: string[] | null;
  current_summary: string | null;
  subtree_count: number | null;
  owner_source: OwnerSource | null;
  default_agent_addresses: Record<string, string> | null;
  revision: number;
  updated_at: Date | string;
  score: number;
  total_count: number;
}

interface NullableSearchRow extends Omit<SearchRow, 'kind' | 'ref'> {
  // The totals row is deliberately retained when the requested page is empty.
  kind: SearchRow['kind'] | null;
  ref: string | null;
}

async function queryWork(sql: QueryClient, ref: string, forUpdate = false): Promise<Work | null> {
  const lock = forUpdate ? sql` FOR UPDATE` : sql``;
  const rows = await sql<WorkRow[]>`
    SELECT w.ref, w.title, w.owner_teammate_ref, w.owner_source, w.owner_evidence, w.state, w.parent_ref,
           COALESCE((SELECT array_agg(dependency_ref ORDER BY dependency_ref) FROM work_dependencies d WHERE d.work_ref = w.ref), '{}') AS dependencies,
           w.current_summary, w.living_doc_markdown, w.revision, w.created_at, w.updated_at
    FROM works w WHERE w.ref = ${ref} ${lock}
  `;
  return rows[0] ? toWork(rows[0]) : null;
}

async function queryTeammate(sql: QueryClient, ref: string, forUpdate = false): Promise<Teammate | null> {
  const lock = forUpdate ? sql` FOR UPDATE` : sql``;
  const rows = await sql<TeammateRow[]>`SELECT ref, display_name, agent_addresses, memory, revision, created_at, updated_at FROM teammates WHERE ref = ${ref} ${lock}`;
  return rows[0] ? toTeammate(rows[0]) : null;
}

async function exists(sql: QueryClient, table: 'works' | 'teammates', ref: string): Promise<boolean> {
  const rows = table === 'works' ? await sql`SELECT 1 FROM works WHERE ref = ${ref}` : await sql`SELECT 1 FROM teammates WHERE ref = ${ref}`;
  return rows.length > 0;
}

async function assertNoParentCycle(sql: QueryClient, ref: string, parent: string): Promise<void> {
  let next: string | null = parent;
  for (let count = 0; next && count < 1000; count += 1) {
    if (next === ref) throw new DomainError('VALIDATION', 'Parent relationship would create a cycle');
    const rows: Array<{ parent_ref: string | null }> = await sql`SELECT parent_ref FROM works WHERE ref = ${next}`;
    next = rows[0]?.parent_ref ?? null;
  }
  if (next) throw new DomainError('VALIDATION', 'Parent hierarchy is too deep');
}

async function saveRevision(sql: QueryClient, kind: 'work' | 'teammate', entity: Entity): Promise<void> {
  await sql`INSERT INTO entity_revisions (entity_kind, entity_ref, revision, full_snapshot) VALUES (${kind}, ${entity.ref}, ${entity.revision}, ${sql.json(JSON.parse(JSON.stringify(entity)))})`;
}

function toWork(row: WorkRow): Work { return { ref: row.ref, title: row.title, owner: row.owner_teammate_ref, owner_source: row.owner_source, owner_evidence: row.owner_evidence ?? [], state: row.state, parent: row.parent_ref, dependencies: row.dependencies ?? [], current_summary: row.current_summary, living_doc_markdown: row.living_doc_markdown, revision: row.revision, created_at: asIso(row.created_at), updated_at: asIso(row.updated_at) }; }
function toTeammate(row: TeammateRow): Teammate { return { ref: row.ref, display_name: row.display_name, default_agent_addresses: row.agent_addresses ?? {}, memory: row.memory, revision: row.revision, created_at: asIso(row.created_at), updated_at: asIso(row.updated_at) }; }
function toWorkSummary(row: WorkSummaryRow): WorkSummary { return { ref: row.ref, title: row.title, owner: row.owner_teammate_ref, owner_source: row.owner_source, state: row.state, parent: row.parent_ref, dependencies: row.dependencies ?? [], current_summary: row.current_summary, subtree_count: row.subtree_count, revision: row.revision, updated_at: asIso(row.updated_at) }; }
function toTeammateSummary(row: TeammateRow): TeammateSummary { const teammate = toTeammate(row); return { ref: teammate.ref, display_name: teammate.display_name, default_agent_addresses: teammate.default_agent_addresses, revision: teammate.revision, updated_at: teammate.updated_at }; }
function toSearchResult(row: SearchRow): SearchResult { return row.kind === 'work' ? { kind: 'work', ref: row.ref, title: row.title ?? '', owner: row.owner ?? '', owner_source: row.owner_source ?? 'confirmed', state: row.state ?? 'current', parent: row.parent, dependencies: row.dependencies ?? [], current_summary: row.current_summary ?? '', subtree_count: row.subtree_count ?? 1, revision: row.revision, updated_at: asIso(row.updated_at) } : { kind: 'teammate', ref: row.ref, display_name: row.display_name ?? '', default_agent_addresses: row.default_agent_addresses ?? {}, revision: row.revision, updated_at: asIso(row.updated_at) }; }
function asIso(value: Date | string): string { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
function encodeCursor(offset: number): string { return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url'); }
function decodeCursor(cursor: string | undefined): number { if (!cursor) return 0; try { const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { offset?: unknown }; return typeof parsed.offset === 'number' && Number.isInteger(parsed.offset) && parsed.offset >= 0 ? parsed.offset : 0; } catch { return 0; } }
function mapPostgresError(error: unknown): DomainError | unknown { const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : ''; if (code === '23505') return new DomainError('DUPLICATE_IDENTITY', 'A teammate or Work reference already exists'); if (code === '23503') return new DomainError('NOT_FOUND', 'A referenced entity was not found'); return error; }
