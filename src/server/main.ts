import postgres from 'postgres';
import { migrate } from '../db/migrate.js';
import { PostgresWorkMapRepository } from '../db/postgres-repository.js';
import { registerDashboardAssets } from '../dashboard/routes.js';
import { createApp } from './app.js';

const databaseUrl = required('DATABASE_URL');
const apiKey = required('MCP_API_KEY');
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

await migrate(databaseUrl);
const sql = postgres(databaseUrl, { max: Number(process.env.DB_POOL_SIZE ?? 10) });
const repository = new PostgresWorkMapRepository(sql);
const app = await createApp({
  repository,
  apiKey,
  dashboardPassword: required('DASHBOARD_PASSWORD'),
  registerDashboardRoutes: registerDashboardAssets,
  version: process.env.APP_VERSION,
  allowedOrigins: splitEnv(process.env.ALLOWED_ORIGINS),
  allowedHosts: splitEnv(process.env.ALLOWED_HOSTS),
});

await app.listen({ port, host });

async function shutdown(): Promise<void> {
  await app.close();
  await repository.close();
  process.exit(0);
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function splitEnv(value: string | undefined): string[] | undefined {
  const values = value?.split(',').map((item) => item.trim()).filter(Boolean);
  return values?.length ? values : undefined;
}
