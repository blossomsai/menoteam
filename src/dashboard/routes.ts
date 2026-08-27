import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { renderDashboardShell } from './dashboard.js';

/**
 * Register only dashboard assets. Data/auth routes stay with the server layer so
 * the dashboard cannot accidentally grow a second write or authorization path.
 */
export async function registerDashboardAssets(app: FastifyInstance): Promise<void> {
  app.get('/dashboard', async (_request, reply) => reply.type('text/html; charset=utf-8').send(renderDashboardShell()));
  app.get('/dashboard/dashboard.js', async (_request, reply) => reply.type('application/javascript; charset=utf-8').send(await readDashboardAsset('dashboard.js')));
  app.get('/dashboard/client.js', async (_request, reply) => reply.type('application/javascript; charset=utf-8').send(await readDashboardAsset('client.js')));
}

async function readDashboardAsset(filename: string): Promise<string> {
  // After `tsc`, routes.js and the browser modules live side by side in dist.
  return await readFile(new URL(`./${filename}`, import.meta.url), 'utf8');
}
