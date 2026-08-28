# Self-host Menoteam Work Map

This guide runs the current checkout as one Work Map service and one PostgreSQL
database. It is deliberately small: the service owns shared Work Map data and
MCP, while an existing agent harness owns agent execution and channel access.
The repository can publish versioned container images to GHCR from matching
release tags; source-checkout deployment remains supported. See the
[release guide](releasing.md) for the maintainer flow. There is no hosted
control plane, Discord bot, or per-user account system promised by this
repository.

## What you need

- Docker Engine with Docker Compose v2.
- A checkout of this repository and a host with port `3000` available.
- `openssl` for generating local secrets (or an equivalent secret manager).

Compose requires all four of these values before the app can start:

| Variable | Used by | Must be |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | PostgreSQL container | A unique database password |
| `DATABASE_URL` | App and migration runner | The same database password, URL-encoded if needed |
| `MCP_API_KEY` | Agent read/write access to `/mcp` | A separate, high-entropy bearer secret |
| `DASHBOARD_PASSWORD` | Read-only dashboard API access | A separate, high-entropy secret |

Do not use the placeholder values from `.env.example` outside a throwaway
local test. Do not commit `.env`; it is ignored by Git.

## Quickstart: local loopback only

This command creates a local `.env` with random hexadecimal secrets. The base
Compose file binds the app only to `127.0.0.1` unless `BIND_ADDRESS` is set
explicitly.

```bash
git clone https://github.com/E2023/menoteam.git menoteam
cd menoteam
db_password="$(openssl rand -hex 32)"
cat > .env <<EOF
POSTGRES_PASSWORD=$db_password
DATABASE_URL=postgres://menoteam:$db_password@db:5432/menoteam
MCP_API_KEY=$(openssl rand -hex 32)
DASHBOARD_PASSWORD=$(openssl rand -hex 32)
PORT=3000
HOST=0.0.0.0
APP_VERSION=0.1.1
APP_IMAGE=ghcr.io/e2023/menoteam-work-map:v0.1.1
ALLOWED_HOSTS=localhost,127.0.0.1
ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
EOF
chmod 600 .env
docker compose --env-file .env pull app
docker compose --env-file .env up -d --no-build
curl --fail --retry 20 --retry-delay 2 http://127.0.0.1:3000/healthz
docker compose --env-file .env ps
```

This runs the reviewed `v0.1.1` app image instead of building the current
checkout. Use the source-build upgrade flow below only when you deliberately
want to run locally reviewed source.

The app runs the versioned SQL migrations during startup. The migration runner
uses a PostgreSQL advisory lock, so starting more than one app replica does not
run the same migration concurrently. A healthy `/healthz` proves app/database
readiness only; it does not prove MCP authentication, dashboard access, or a
Discord route.

Use `http://localhost:3000` or `http://127.0.0.1:3000` only from the same host.
This HTTP loopback setup is not a production deployment and must not be made
internet-facing by opening the host port.

## Production boundary: HTTPS in front

The app listens for plain HTTP inside the container. Outside a private network,
put a TLS-terminating reverse proxy or load balancer in front of it and expose
only the proxy's HTTPS listener. Bind the app to loopback when the proxy runs on
the same host, or keep it on a private container/network interface. Do not
publish the raw app port to the public internet.

For a same-host proxy, use the loopback override above and set the production
allowlists to the exact public host and origin in `.env`:

```dotenv
ALLOWED_HOSTS=team.example.com
ALLOWED_ORIGINS=https://team.example.com
```

Do not leave `ALLOWED_HOSTS` or `ALLOWED_ORIGINS` empty on an internet-facing
deployment. Keep `DATABASE_URL`, all three passwords/keys, and proxy TLS
private-key material in a secret manager or protected process environment.
The database service has no published port in the supplied Compose file; keep
it that way unless a deliberate, separately secured administration path is
needed.

## Migrations and upgrades

Migrations are forward-only files in `migrations/` and run automatically before
the app listens. A manual, idempotent migration check inside the running image
is:

```bash
docker compose --env-file .env exec -T app node dist/db/migrate-cli.js
```

To upgrade a source checkout, review the target commit first, take a backup,
then rebuild and restart. The default remains loopback-only:

```bash
git pull --ff-only
docker compose --env-file .env config --quiet
docker compose --env-file .env up -d --build --pull always
curl --fail --retry 20 --retry-delay 2 http://127.0.0.1:3000/healthz
```

The app refuses to start when the database has a migration newer than the
application. Do not edit an applied migration or assume an arbitrary schema
change is reversible. Keep the pre-upgrade dump until the new version has
passed health, authenticated MCP read, and dashboard read-only checks. Never
run `docker compose down -v` as routine cleanup: `-v` deletes the PostgreSQL
volume and its data.

## Backup, export, restore, and verification

An export is portable JSON plus Markdown; it is not a database backup. A
PostgreSQL custom-format dump is the recovery artifact. The commands below
copy the dump out of the app container into a local `backups/` directory:

```bash
mkdir -p backups
backup_file="backups/work-map-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose --env-file .env exec -T app node dist/db/backup-cli.js /tmp/work-map.dump
docker cp "$(docker compose --env-file .env ps -q app):/tmp/work-map.dump" "$backup_file"
chmod 600 "$backup_file"
```

For a reviewable export, use a different pair of output paths and copy both
files out of the container:

```bash
docker compose --env-file .env exec -T app node dist/db/export-cli.js /tmp/work-map-export.json /tmp/work-map-export.md
docker cp "$(docker compose --env-file .env ps -q app):/tmp/work-map-export.json" backups/work-map-export.json
docker cp "$(docker compose --env-file .env ps -q app):/tmp/work-map-export.md" backups/work-map-export.md
```

Backups contain the team's complete Work Map and revision history. Encrypt them
at rest, restrict access, and test a restore before relying on a schedule. A
simple pre/post check records counts and the number of retained revisions:

```bash
docker compose --env-file .env exec -T db psql -U menoteam -d menoteam -Atc \
  "SELECT (SELECT count(*) FROM works),(SELECT count(*) FROM teammates),(SELECT count(*) FROM entity_revisions);"
```

Restore is destructive to the target database. Perform it during maintenance
on a staging copy first, stop the app, and use the same CLI against the dump;
do not test a restore against the only production volume:

```bash
docker compose --env-file .env stop app
docker compose --env-file .env run --rm -v "$PWD/backups:/restore:ro" app \
  node dist/db/restore-cli.js /restore/work-map-<timestamp>.dump
docker compose --env-file .env up -d app
curl --fail --retry 20 --retry-delay 2 http://127.0.0.1:3000/healthz
docker compose --env-file .env exec -T db psql -U menoteam -d menoteam -Atc \
  "SELECT (SELECT count(*) FROM works),(SELECT count(*) FROM teammates),(SELECT count(*) FROM entity_revisions);"
```

The post-restore counts must match the pre-restore record. Also perform an
authenticated MCP `list` or `search` and read one known Work and its revision
history. A successful restore is not established by a process becoming
healthy alone.

## Verify dashboard authentication

`DASHBOARD_PASSWORD` is separate from `MCP_API_KEY`. The read-only `/api/*`
dashboard routes reject requests without a short-lived stateless dashboard
session. Unlocking posts the password to the same-origin session endpoint; the
server returns an eight-hour `HttpOnly; SameSite=Strict` cookie containing a
versioned expiry, random nonce, and HMAC signature. Its signing key is derived
from `DASHBOARD_PASSWORD` with a domain-separated context, so replicas using
the same password can verify the cookie without Redis or database session
state. The password is not placed in browser JavaScript, URLs, storage,
cookies, or page source. `/healthz` is the only deliberately unauthenticated
readiness probe.

```bash
set -a
. ./.env
set +a
curl --fail-with-body -sS -o /dev/null -w '%{http_code}\n' \
  http://127.0.0.1:3000/api/teammates
umask 077
curl --fail-with-body -sS -c /tmp/menoteam-dashboard.cookies \
  -H 'content-type: application/json' \
  --data-binary @- http://127.0.0.1:3000/api/dashboard/session <<EOF
{"password":"$DASHBOARD_PASSWORD"}
EOF
curl --fail-with-body -sS -b /tmp/menoteam-dashboard.cookies \
  http://127.0.0.1:3000/api/teammates
```

The first request must be `401`; the session request and cookie-authenticated
read must succeed. The dashboard is read-only and has no V1 user accounts or
per-person permissions, so anyone who receives the dashboard password can read
the entire team map. For public deployments, place the entire flow behind
HTTPS (or a stronger trusted reverse-proxy session) and never weaken the
`/api/*` guard. Restarting the app does not invalidate a correctly signed
cookie. Logout clears only the current browser's cookie; if a cookie is stolen,
rotate `DASHBOARD_PASSWORD` to invalidate all existing dashboard cookies, then
unlock again. Remove the temporary cookie file after testing
(`rm -f /tmp/menoteam-dashboard.cookies`).

## Connect a remote MCP client

Use the HTTPS URL exposed by the reverse proxy, for example
`https://team.example.com/mcp`, and inject the same instance key into each
trusted agent host without committing it:

```bash
export WORK_MAP_MCP_API_KEY='read-this-from-your-secret-manager'
codex mcp add work-map \
  --url https://team.example.com/mcp \
  --bearer-token-env-var WORK_MAP_MCP_API_KEY
codex mcp list
```

The Codex command is a client configuration example, not a claim that Codex
awakens agents in Discord. Credential-free Hermes and OpenClaw templates are in
[`examples/mcp/`](../examples/mcp/), and the broader harness boundary is in
[`docs/connect-agents.md`](connect-agents.md). Validate the connection with a
read-only `list`, `search`, or `read` before allowing writes. V1 intentionally
uses one trusted-team MCP bearer capability; it is not actor-level
authorization.

## Discord is still operator-owned

Work Map does not log in to Discord, store bot tokens, read channel history,
awaken agents, or post messages. A Discord workflow requires a separate native
Hermes/OpenClaw (or another supported) gateway configured by the operator with
its own bot token, Gateway intents, guild/channel allowlists, permissions, and
explicit-mention policy. The operator must prove both the authenticated MCP
call and a native Discord mention/reply in the original thread. A healthy Work
Map, a successful MCP handshake, or a successful bot login alone is not proof
that the Discord route works.
