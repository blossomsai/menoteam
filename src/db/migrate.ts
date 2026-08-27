import { readFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';

export async function migrate(databaseUrl: string, migrationsDir = join(process.cwd(), 'migrations')): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('menoteam-work-map-migrations'))`;
      await tx`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
      const files = (await readdir(migrationsDir)).filter((file) => /^\d+_.+\.sql$/u.test(file)).sort();
      const applied = await tx<{ version: string }[]>`SELECT version FROM schema_migrations`;
      const appliedVersions = new Set(applied.map((row) => row.version));
      const latestLocal = files.reduce((latest, file) => Math.max(latest, migrationNumber(file)), 0);
      for (const row of applied) {
        if (migrationNumber(row.version) > latestLocal) throw new Error(`Database schema ${row.version} is newer than this application`);
      }
      for (const file of files) {
        if (appliedVersions.has(file)) continue;
        const sqlText = await readFile(join(migrationsDir, file), 'utf8');
        await tx.unsafe(sqlText, [], { prepare: false });
        await tx`INSERT INTO schema_migrations (version) VALUES (${file})`;
      }
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function migrationNumber(version: string): number {
  const match = /^(\d+)_/u.exec(version);
  return match ? Number(match[1]) : 0;
}
