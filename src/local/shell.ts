import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export function readLocalIndex(): Promise<string> {
  return readFile(join(process.cwd(), 'dist/local/web/index.html'), 'utf8');
}
