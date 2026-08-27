import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const databaseUrl = required('DATABASE_URL');
const output = process.argv[2] ?? `work-map-${new Date().toISOString().replaceAll(':', '-')}.dump`;
await promisify(execFile)('pg_dump', [
  '--format=custom',
  '--no-owner',
  '--no-privileges',
  '--no-comments',
  '--file',
  output,
  databaseUrl,
]);

function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }
