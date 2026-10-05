import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ConnectorConfig } from './types.js';

const configSchema = z.object({
  serverUrl: z.string().url(), token: z.string().min(32), connectorId: z.string().min(1),
  dataDir: z.string().min(1), projects: z.record(z.string(), z.string()),
  codexBinary: z.string().optional(), pollIntervalMs: z.number().int().min(1000).max(30_000).optional(),
  leaseRenewIntervalMs: z.number().int().min(5_000).max(60_000).optional(),
}).strict();

export async function loadConnectorConfig(file: string): Promise<ConnectorConfig> {
  const metadata = await stat(file);
  if ((metadata.mode & 0o077) !== 0) throw new Error('Connector configuration must be readable only by its owner (chmod 600)');
  return configSchema.parse(JSON.parse(await readFile(file, 'utf8')));
}

export async function prepareDataDir(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  return path.resolve(directory);
}

export function stateKey(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}

export async function writeSecureJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
  await chmod(temp, 0o600);
  await rename(temp, file);
  await chmod(file, 0o600);
}

export async function readJson<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
