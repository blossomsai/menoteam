import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const databaseUrl = required('DATABASE_URL');
const input = process.argv[2];
if (!input) throw new Error('Usage: pnpm restore <dump-file>');
await promisify(execFile)('pg_restore', ['--clean', '--if-exists', '--no-owner', '--no-privileges', '--exit-on-error', '--dbname', databaseUrl, input]);

function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }
