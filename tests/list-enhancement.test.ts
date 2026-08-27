import { describe, expect, it } from 'vitest';
import { InMemoryWorkMapRepository } from '../src/db/in-memory-repository.js';

describe('deterministic list enhancement', () => {
  it('reports the filtered total on every page and includes an ancestor root and descendants', async () => {
    const repository = new InMemoryWorkMapRepository();
    await repository.updateTeammate('teammate_alice', 0, { display_name: 'Alice' });
    const root = await repository.createWork({ title: 'Root', owner: 'teammate_alice', state: 'current', current_summary: 'Root', living_doc_markdown: '# Root' });
    const child = await repository.createWork({ title: 'Child', owner: 'teammate_alice', state: 'current', parent: root.ref, current_summary: 'Child', living_doc_markdown: '# Child' });
    const grandchild = await repository.createWork({ title: 'Grandchild', owner: 'teammate_alice', state: 'completed', parent: child.ref, current_summary: 'Grandchild', living_doc_markdown: '# Grandchild' });
    await repository.createWork({ title: 'Outside', owner: 'teammate_alice', state: 'current', current_summary: 'Outside', living_doc_markdown: '# Outside' });

    const first = await repository.list('work', { ancestor: root.ref }, undefined, 2);
    expect(first.total_count).toBe(3);
    expect(first.items).toHaveLength(2);
    expect(first.next_cursor).toEqual(expect.any(String));
    const second = await repository.list('work', { ancestor: root.ref }, first.next_cursor ?? undefined, 2);
    expect(second.total_count).toBe(3);
    expect(second.next_cursor).toBeNull();
    expect([...first.items, ...second.items].find((item) => item.ref === root.ref)?.subtree_count).toBe(3);
    expect([...first.items, ...second.items].map((item) => item.ref).sort()).toEqual([child.ref, grandchild.ref, root.ref].sort());

    const teammates = await repository.list('teammate', {}, undefined, 10);
    expect(teammates.total_count).toBe(1);
    const search = await repository.search('Child', undefined, 1);
    expect(search.total_count).toBe(2);
    const exactTitle = await repository.list('work', { title: root.title }, undefined, 10);
    expect(exactTitle).toMatchObject({ total_count: 1, items: [expect.objectContaining({ ref: root.ref, subtree_count: 3 })] });
    await repository.close();
  });
});
