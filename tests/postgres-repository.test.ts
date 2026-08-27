import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { PostgresWorkMapRepository } from '../src/db/postgres-repository.js';

const databaseUrl = process.env.WORK_MAP_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('PostgreSQL repository integration', () => {
  const teammateRef = `teammate_test_${randomUUID()}`;
  let sql: ReturnType<typeof postgres>;
  let repository: PostgresWorkMapRepository;
  const workRefs: string[] = [];

  beforeAll(async () => {
    await migrate(databaseUrl as string);
    sql = postgres(databaseUrl as string);
    repository = new PostgresWorkMapRepository(sql);
  });

  afterAll(async () => {
    if (!sql) return;
    for (const ref of workRefs) {
      await sql`DELETE FROM entity_revisions WHERE entity_ref = ${ref}`;
      await sql`DELETE FROM work_dependencies WHERE work_ref = ${ref} OR dependency_ref = ${ref}`;
    }
    for (const ref of [...workRefs].reverse()) {
      await sql`DELETE FROM works WHERE ref = ${ref}`;
    }
    await sql`DELETE FROM entity_revisions WHERE entity_ref = ${teammateRef}`;
    await sql`DELETE FROM teammates WHERE ref = ${teammateRef}`;
    await repository.close();
  });

  it('persists complete entities, revisions, search, and optimistic conflicts', async () => {
    const teammate = await repository.updateTeammate(teammateRef, 0, { display_name: `Integration ${teammateRef.slice(-8)}`, default_agent_addresses: { slack: `@${teammateRef.slice(-8)}` }, memory: 'PostgreSQL integration owner.' });
    await expect(repository.updateTeammate(`teammate_duplicate_${randomUUID()}`, 0, { display_name: `Other ${teammateRef.slice(-8)}`, default_agent_addresses: teammate.default_agent_addresses, memory: '' })).rejects.toMatchObject({ code: 'DUPLICATE_IDENTITY' });
    const work = await repository.createWork({ title: 'PostgreSQL integration', owner: teammate.ref, state: 'current', current_summary: 'Validate durable storage.', living_doc_markdown: '# Durable storage\n' });
    workRefs.push(work.ref);
    expect(work.revision).toBe(1);
    const updated = await repository.updateWork(work.ref, 1, { current_summary: 'Validated durable storage.' });
    expect(updated.revision).toBe(2);
    await expect(repository.updateWork(work.ref, 1, { current_summary: 'Stale write.' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(repository.read(work.ref)).resolves.toMatchObject({ revision: 2, living_doc_markdown: '# Durable storage\n' });
    await expect(repository.search('durable storage', undefined, 10)).resolves.toMatchObject({ items: [expect.objectContaining({ ref: work.ref, kind: 'work' })] });
    await expect(repository.revisions(work.ref)).resolves.toHaveLength(2);
  }, 15_000);

  it('returns the full filtered count and recursively scopes Work descendants', async () => {
    const root = await repository.createWork({ title: 'List root', owner: teammateRef, state: 'current', current_summary: 'Root', living_doc_markdown: '# Root' });
    workRefs.push(root.ref);
    const child = await repository.createWork({ title: 'List child', owner: teammateRef, state: 'current', parent: root.ref, current_summary: 'Child', living_doc_markdown: '# Child' });
    workRefs.push(child.ref);
    const grandchild = await repository.createWork({ title: 'List grandchild', owner: teammateRef, state: 'completed', parent: child.ref, current_summary: 'Grandchild', living_doc_markdown: '# Grandchild' });
    workRefs.push(grandchild.ref);
    const outside = await repository.createWork({ title: 'List outside', owner: teammateRef, state: 'current', current_summary: 'Outside', living_doc_markdown: '# Outside' });
    workRefs.push(outside.ref);

    const first = await repository.list('work', { ancestor: root.ref }, undefined, 2);
    expect(first.total_count).toBe(3);
    expect(first.next_cursor).toEqual(expect.any(String));
    const second = await repository.list('work', { ancestor: root.ref }, first.next_cursor ?? undefined, 2);
    expect(second.total_count).toBe(3);
    expect(second.next_cursor).toBeNull();
    expect([...first.items, ...second.items].find((item) => item.ref === root.ref)?.subtree_count).toBe(3);
    expect([...first.items, ...second.items].map((item) => item.ref).sort()).toEqual([root.ref, child.ref, grandchild.ref].sort());
    await expect(repository.list('work', { title: root.title }, undefined, 10)).resolves.toMatchObject({ total_count: 1, items: [expect.objectContaining({ ref: root.ref, subtree_count: 3 })] });

    const outOfRangeCursor = Buffer.from(JSON.stringify({ offset: 100 }), 'utf8').toString('base64url');
    await expect(repository.list('work', { ancestor: root.ref }, outOfRangeCursor, 2)).resolves.toMatchObject({ items: [], total_count: 3, next_cursor: null });
    await expect(repository.list('teammate', {}, outOfRangeCursor, 2)).resolves.toMatchObject({ items: [], total_count: 1, next_cursor: null });
    await expect(repository.search('List', outOfRangeCursor, 2)).resolves.toMatchObject({ items: [], total_count: 4, next_cursor: null });
  });
});
