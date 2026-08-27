import { writeFile } from 'node:fs/promises';
import postgres from 'postgres';
import { PostgresWorkMapRepository } from './postgres-repository.js';
import type { Entity, RevisionSnapshot } from '../domain/model.js';

const databaseUrl = required('DATABASE_URL');
const jsonPath = process.argv[2] ?? 'work-map-export.json';
const markdownPath = process.argv[3] ?? 'work-map-export.md';
const sql = postgres(databaseUrl);
const repository = new PostgresWorkMapRepository(sql);
try {
  const works = await collect('work');
  const teammates = await collect('teammate');
  const payload = { format_version: 1, exported_at: new Date().toISOString(), works, teammates };
  await writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  const markdown = [
    '# Work Map export',
    '',
    `Format version: ${payload.format_version}`,
    `Exported at: ${payload.exported_at}`,
    '',
    '## Work',
    '',
    ...works.map((item) => 'title' in item.entity ? `- **${item.entity.title}** (${item.entity.state}) — owner: ${item.entity.owner}; ref: ${item.entity.ref}\n\n${item.entity.living_doc_markdown}` : ''),
    '',
    '## Teammates',
    '',
    ...teammates.map((item) => 'display_name' in item.entity ? `- **${item.entity.display_name}** — ref: ${item.entity.ref}\n\n${item.entity.memory}` : ''),
    '',
  ].join('\n');
  await writeFile(markdownPath, markdown, 'utf8');
} finally {
  await repository.close();
}

async function collect(kind: 'work' | 'teammate'): Promise<ExportedEntity[]> {
  const items: ExportedEntity[] = [];
  let cursor: string | undefined;
  do {
    const page = kind === 'work' ? await repository.list('work', {}, cursor, 100) : await repository.list('teammate', {}, cursor, 100);
    for (const item of page.items) items.push({ entity: await repository.read(item.ref), revisions: await repository.revisions(item.ref) });
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return items;
}

interface ExportedEntity { entity: Entity; revisions: RevisionSnapshot[] }

function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }
