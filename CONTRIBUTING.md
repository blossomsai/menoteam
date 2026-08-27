# Contributing to Menoteam

Menoteam Work Map is an Apache-2.0 project. Contributions should preserve the
V1 boundary: a small self-hosted PostgreSQL service, authenticated Streamable
HTTP MCP, read-only dashboard, and existing native agent/channel harnesses.
The Work Map service is not an agent runner, Discord bot, hosted control plane,
or per-user authorization system.

## Local setup

Use Node.js 20 or newer and the repository-pinned pnpm version (`11.19.0`).
For a source checkout:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

`pnpm test` runs the in-memory and importer suites. The PostgreSQL integration
suite is skipped unless `WORK_MAP_TEST_DATABASE_URL` is set; when enabled, use
a disposable database, not a production database. Docker Compose is the
supported way to exercise the self-hosted app and migration path; see
[`docs/self-hosting.md`](docs/self-hosting.md).

Before changing deployment-related files, validate Compose interpolation without
starting services:

```bash
docker compose --env-file .env.example config --quiet
```

The example file contains placeholders only. Never use it as production
credentials.

## Change and review expectations

- Keep secrets, tokens, private channel content, and personal context out of
  source, tests, fixtures, docs, screenshots, and commit messages.
- Treat the instance MCP key as shared read/write authority. Do not describe it
  as RBAC or per-agent isolation.
- Keep dashboard data read-only and authenticated. Do not add a browser-side
  copy of `DASHBOARD_PASSWORD` or a public data fallback.
- Keep Discord credentials and native gateway behavior in the selected harness;
  do not move bot login or channel history into the Work Map service.
- Add forward-only, numerically ordered migration files for schema changes and
  document the required backup/upgrade verification. Do not rewrite an applied
  migration.
- Update the self-hosting/security docs when an environment variable, endpoint,
  authentication boundary, recovery command, or operator prerequisite changes.
- Prefer the smallest implementation that satisfies a demonstrated V1 use
  case. Do not add speculative queues, agents, adapters, hosted dependencies,
  or speculative public API surfaces.

## Before opening a pull request

Run the same checks used by CI and report them accurately:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

For documentation-only changes, also inspect every copied command for the
correct path, required secret, TLS assumption, and whether it is destructive.
If a check cannot run locally, say why; do not replace it with an aspirational
claim. Regular branch and pull-request CI only verifies changes. A separate
release workflow publishes the container image for a matching version tag; see
[`docs/releasing.md`](docs/releasing.md).
