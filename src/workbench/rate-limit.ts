import type { FastifyRequest } from 'fastify';
import type { Sql } from 'postgres';
import { digest } from './auth.js';

/** Identity here partitions a budget; handlers still enforce authorization and leases. */
export function rateLimitKey(sql: Sql) {
  return async (req: FastifyRequest): Promise<string> => {
    const anonymous = `ip:${req.ip}`;
    const route = req.routeOptions.url ?? '';
    if (!route.startsWith('/api/workbench/') || route.includes('*')) return anonymous;
    // Authentication attempts must never escape the IP budget using supplied credentials.
    if (route === '/api/workbench/session') return anonymous;
    if (route.startsWith('/api/workbench/connector/')) {
      const raw = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
      if (!raw || raw.length > 200) return anonymous;
      const tokenDigest = digest(raw);
      const connectors = await sql`SELECT id FROM wb_connectors WHERE digest=${tokenDigest}`;
      if (connectors[0]) return `connector:${connectors[0].id}`;
      if (route === '/api/workbench/connector/runs/:id/tools') {
        const runId = (req.params as {id?: string}).id ?? '';
        const grants = await sql`
          SELECT c.id FROM wb_bridge_tokens b
          JOIN wb_records r ON r.id=b.run_id AND r.kind='run'
          JOIN wb_connectors c ON c.id=r.data->>'connectorId'
          JOIN wb_users u ON u.id=r.data->>'requestedBy'
          WHERE b.digest=${tokenDigest} AND b.expires_at>now() AND b.run_id=${runId}
            AND b.generation=(r.data->>'generation')::integer
            AND c.project_ids ? r.project_id
            AND r.data->>'status'='running' AND (r.data->>'leaseUntil')::timestamptz>now()
            AND (u.role='owner' OR EXISTS (
              SELECT 1 FROM wb_memberships m WHERE m.user_id=u.id AND m.project_id=r.project_id))
            AND (COALESCE(jsonb_array_length(r.data->'sourceIds'),0)=0 OR EXISTS (
              SELECT 1 FROM wb_records p WHERE p.kind='project' AND p.id=r.project_id
                AND p.data->'feedbackIntake'->>'enabled'='true'
                AND p.data->'feedbackIntake'->>'actorId'=u.id))`;
        if (grants[0]) return `connector:${grants[0].id}`;
      }
      return anonymous;
    }
    const raw = req.headers.cookie?.split(';').map(s => s.trim())
      .find(s => s.startsWith('menoteam_session='))?.slice(17);
    if (!raw || raw.length > 200) return anonymous;
    const sessions = await sql`
      SELECT u.id FROM wb_sessions s JOIN wb_users u ON u.id=s.user_id
      WHERE s.digest=${digest(raw)} AND s.expires_at>now()`;
    return sessions[0] ? `member:${sessions[0].id}` : anonymous;
  };
}
