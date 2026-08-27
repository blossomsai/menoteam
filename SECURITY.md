# Security model and reporting

Menoteam Work Map V1 is a self-hosted, one-team service. Its security boundary
is intentionally narrow and explicit:

- `MCP_API_KEY` is one instance-level bearer capability for all MCP reads and
  writes. V1 does not provide per-agent authorization, user accounts, RBAC, or
  authenticated actor attribution.
- `DASHBOARD_PASSWORD` is a separate credential for read-only dashboard API
  routes. Anyone who has it can read the full team map.
- PostgreSQL credentials stay server-side. The database is the durable store;
  backups include current entities and revision history.
- Team-visible Work Map content is not a place for personal data, private
  project context, credentials, tokens, or repository/document secrets.

## Required deployment controls

1. Generate high-entropy, separate values for `POSTGRES_PASSWORD`,
   `MCP_API_KEY`, and `DASHBOARD_PASSWORD`. Store them in a secret manager or a
   protected process environment; never commit `.env` or paste a real key into
   a prompt, MCP config, issue, log, or screenshot.
2. Use HTTPS outside a genuinely private network. The application container
   serves plain HTTP; terminate TLS at a trusted reverse proxy/load balancer and
   keep the raw port private or loopback-bound.
3. Set `ALLOWED_HOSTS` and `ALLOWED_ORIGINS` to exact production values. An
   empty allowlist is only appropriate when network exposure is already private;
   it is not a safe public default.
4. Keep the PostgreSQL service off the public network. Restrict host access to
   the proxy and approved operators, and use encrypted managed-PostgreSQL
   connections when applicable.
5. Back up on a schedule, encrypt backup files, restrict their access, and
   verify restoration on a staging database. `pnpm export`/`export-cli` is for
   review and portability, not disaster recovery.
6. Rotate the MCP and dashboard credentials when an agent host, operator, or
   configuration file is no longer trusted. Re-test all clients after rotation.

The service validates tool inputs, limits request bodies, rate-limits HTTP
requests, and checks configured hosts/origins. These controls do not turn the
V1 shared bearer key into tenant isolation or actor-level authorization.

## Dashboard and browser boundary

Dashboard data routes are read-only but still sensitive: they expose all Work,
Living Docs, teammate addresses, and Teammate Memory to a holder of
`DASHBOARD_PASSWORD`.

Unlocking uses `POST /api/dashboard/session`. The request must be same-origin:
the service checks `Origin` against `ALLOWED_ORIGINS` (or the request host when
no allowlist is configured) and rejects `Sec-Fetch-Site: cross-site`. A
successful request returns an eight-hour, signed
`HttpOnly; SameSite=Strict` cookie containing only a versioned expiry, random
nonce, and HMAC signature derived from `DASHBOARD_PASSWORD`. The password is
never placed in client-side JavaScript, URLs, browser storage, or a cookie.
Dashboard data requests require that cookie; the old password-header and
Bearer fallbacks are not accepted.

Sessions are stateless: replicas can verify the cookie without Redis or shared
session storage, and restarting the service does not invalidate a correctly
signed cookie. `POST /api/dashboard/session/logout` expires only the current
browser's cookie; it is not global revocation. If a dashboard cookie is stolen,
rotate `DASHBOARD_PASSWORD` to invalidate all issued cookies, then unlock again.
Outside a genuinely private network, serve the complete flow through HTTPS at
a trusted TLS proxy and keep the plain HTTP app port private or loopback-bound;
the cookie is marked `Secure` for HTTPS deployments.

Do not remove the `/api/*` authentication guard or substitute `MCP_API_KEY` just
to make a browser page load. The dashboard is not a public read endpoint.

## Discord/native harness boundary

Discord is not part of the Work Map server. A native harness owns Discord bot
login, tokens, Gateway intents, guild/channel allowlists, permissions, thread
delivery, and agent execution. Work Map must never receive or persist those
credentials. The `docs/connect-agents.md` guide describes the two independent
proofs required for a Discord setup: authenticated MCP access and an explicit
native mention/reply in the original Discord thread. Do not claim Discord
support from an MCP health check or a bot login alone.

## Reporting a vulnerability

Do not include live credentials, private Work Map content, or exploit details in
a public issue. Use GitHub's private Security Advisory flow when it is enabled
for the repository; otherwise contact the project maintainers through an
already-established private channel. Rotate any exposed key immediately and
preserve only the minimum non-sensitive evidence needed to reproduce the issue.
