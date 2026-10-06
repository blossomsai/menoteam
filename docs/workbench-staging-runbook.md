# Workbench staging runbook

This runbook describes an additive, isolated staging deployment beside V1. It
does not authorize a production-data export, a server change, a V1 change, or a
user-facing cutover. Do not execute a remote mutation until the required
authorization checks below are satisfied.

## Verified remote baseline — 2026-10-06

Read-only inspection of `root@217.160.151.9` found Debian 12, 1 vCPU, 1.8 GiB
RAM (about 1.1 GiB available at inspection), 2 GiB swap, and 52 GiB free disk.
The healthy containers were:

| Service | Listener / data |
| --- | --- |
| V1 app | `127.0.0.1:3000`; no persistent container volume |
| Agent Gateway | `127.0.0.1:3100`; named volume `menoteam_menoteam-gateway:/data` |
| PostgreSQL | internal container port 5432; named volume `menoteam_menoteam-postgres:/var/lib/postgresql/data` |

Caddy is a host `systemd` service. Its validated configuration has two sites:
`217-160-151-9.sslip.io` proxies to `127.0.0.1:3000`, and
`agents.217-160-151-9.sslip.io` proxies to `127.0.0.1:3100`. No staging
hostname or `:3200` listener existed during inspection. PostgreSQL listed only
`menoteam` and `postgres`; there was no staging database. The existing V1
database was about 8.9 MB with 24 Work records, one teammate, and 101 entity
revisions. Migrations `001_initial.sql` and `002_owner_provenance.sql` were
present. These are point-in-time observations, not a claim of current health.

The requested encrypted production dump to a local destination was rejected
by automatic approval review because it would export private production data.
No export, restore, or backup artifact was created. No alternate path may be
used to work around that rejection. A15 remains pending until the user grants
specific authorization for the data export and destination, after which a
separate backup/restore procedure can be reviewed and run. The existing V1
services and named volumes were not changed.

## Authorization and preflight gates

Before any staging mutation, record the operator, approved candidate digest,
and change window. Confirm that the authorization covers creating isolated
staging resources and a public HTTPS hostname. Do not infer permission to
export production records from permission to SSH to the host. If backup export
is still unauthorized, keep staging work that depends on it stopped.

Recheck current resource headroom and service inventory immediately before
deployment. The host is small; do not build images, run browser/agent workloads,
or start staging if measured memory/CPU headroom is inadequate. Confirm the V1
container names, ports, images, health, Caddy site blocks, database names,
volumes, and Caddy validation result have not changed since the baseline above.
If any have changed, update the plan before proceeding.

## Isolation contract

Keep staging files in a dedicated directory such as
`/opt/menoteam/workbench-stage/`, with a dedicated Compose file and project
name `menoteam-workbench-stage`. Never run staging commands from the V1 Compose
directory or omit `-p menoteam-workbench-stage`.

Use a dedicated staging PostgreSQL service and a Compose-managed volume named
`workbench_stage_pgdata` (Compose will namespace it under the staging project).
Do not attach or mount `menoteam_menoteam-postgres` or
`menoteam_menoteam-gateway`. The staging database name is
`menoteam_workbench_stage`; its user and password are staging-only. Publish no
database port. Do not point the candidate `DATABASE_URL` at the V1 database,
even if using a separate database name on the same server. This dedicated
database boundary avoids giving the candidate a network path and credentials
for V1 data.

The staging app binds only `127.0.0.1:3200` on the host and has no direct public
port. It uses only the staging database and staging-only auth/session keys.
The Caddy staging site is
`workbench.217-160-151-9.sslip.io` and proxies only to
`127.0.0.1:3200`. Leave the existing V1 and Gateway site blocks byte-for-byte
unchanged. Keep all environment files and secret material outside Git, owned
by the deployment operator, mode `0600`; never place secret values in the
Compose file, command line, logs, docs, or screenshots.

The candidate image must be selected by immutable registry digest
(`image@sha256:...`), not `latest`, a mutable branch tag, or an unreviewed local
build. Record the digest and matching source revision in the deployment record.

## Staging deployment sequence

1. Verify the explicit authorization and backup prerequisite; inspect disk,
   memory, CPU, current containers, named volumes, active Caddy file, and
   listener ports again. Confirm `:3200` is unused and that no staging
   resources already exist under the chosen Compose project.
2. Pull the approved candidate by exact digest. Review the dedicated Compose
   file and render its configuration with secrets redacted. Confirm its
   project name, staging-only database, unique named volume, loopback-only app
   bind, and absence of V1 mounts or ports.
3. Start the staging database first; verify its database name and migration
   state from inside that container. Start the app only after confirming its
   effective database host/name point to the staging service. Check that the
   app is reachable on loopback `:3200` and not on a public interface.
4. Before editing Caddy, make a root-readable, timestamped copy of
   `/etc/caddy/Caddyfile` outside the repository. Add only the staging site
   block. Validate the candidate config with
   `caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`; on any
   validation error, restore the saved file and stop. After validation,
   reload Caddy with `systemctl reload caddy` (do not restart it) and confirm
   both existing sites still route to their original upstreams.
5. Verify HTTPS and authentication on the staging hostname. Exercise the
   staging database from the app, invite flow, project isolation, Work and
   conversation persistence, connector enrollment/execution as authorized,
   and V1 dashboard/MCP/Gateway routes. Health alone is insufficient. Keep
   this candidate private to invited test identities; do not invite real team
   members without separate authorization.
6. Save the approved image digest, source revision, staging migration list,
   before/after Caddy config checksums, service health, test evidence, and
   rollback result without recording secret values or production record data.

## First isolated deployment: bootstrap failure handling

The first isolated staging deployment has no previously verified Workbench
image to roll back to. Record this explicitly as `previousVersion: null` before
starting; do not invent a rollback target or describe bootstrap cleanup as a
version rollback.

If the first deployment fails verification, remove only the newly added staging
Caddy route, validate the restored configuration, and reload Caddy. Confirm
that the V1 and Gateway routes still use their original upstreams, then stop
the staging app and leave the target offline. Preserve the staging database
volume, its data, and the failure evidence; do not run `down -v`, prune, or
delete volumes. Record the outcome as `deploy failed / target offline`, not
`rolled back` or `rollback verified`.

This bootstrap exception applies only to a new, isolated staging target. It
does not bypass the authorization or backup prerequisite in the preflight
section: A15 remains blocked until the user explicitly authorizes the
production-data export and destination and the required backup/restore proof
is completed. Do not create the staging target while that prerequisite is
unmet.

After the first version passes actual version, authentication, and user-flow
verification, record its immutable digest and source SHA as the first verified
version. A later candidate can then use that version as its rollback target.

## Subsequent version rollback sequence

Rollback is an app/config operation. Do not delete either database volume and
do not reverse applied migrations automatically.

1. Stop traffic to staging by restoring the pre-change Caddyfile copy (or
   removing only the staging site block), then validate it and run
   `systemctl reload caddy`. Confirm the V1 and Gateway sites still point to
   `127.0.0.1:3000` and `127.0.0.1:3100`.
2. For a deployment after bootstrap, recreate the staging app using the
   previously recorded, verified image
   digest with `docker compose -p menoteam-workbench-stage -f
   /opt/menoteam/workbench-stage/compose.yml up -d app`. Do not use `latest`.
   If the prior staging image is not available, leave staging offline rather
   than guessing a version.
3. Confirm the staging app/database health and migration compatibility, then
   verify V1 app, V1 database, Gateway, and both existing HTTPS routes. Do not
   point either app to the other's database as a rollback shortcut.
4. Keep the staging volume and database until evidence has been preserved and
   a separately authorized cleanup is approved. Never run `down -v`, prune
   volumes, or remove the V1 project/volumes as part of staging rollback.

Before enabling version rollback as a release capability, perform a second
isolated deployment and drill switching back to the first verified digest.
Verify the service reports that exact digest/source SHA and that persisted
staging data and a representative authenticated Work flow still work. This is
the first real version-rollback proof; first-deployment bootstrap cleanup does
not count.

Schema changes must remain additive and backward-compatible while V1 remains
live. If a candidate migration is not compatible with its previous app
revision, deployment is blocked until an isolated rollback drill demonstrates
a safe recovery. A future user-facing cutover requires a separate explicit
authorization and is outside this runbook.


## Local isolated Work dependency readiness

Creating a Connector Git worktree currently does not prepare its dependencies.
Before a future authorized native run, verify the assigned checkout's pinned
package-manager version, exact lockfile hash and required local tool links.
The demonstrated preparation is limited to a scratch checkout: pnpm 11.19.0,
frozen lockfile, offline cached packages and ignored install scripts, with
copies/links confined to that checkout. Missing cached packages must be reported
as blocked; do not substitute a mutable main `node_modules`, fetch unknown
dependencies or enable install scripts implicitly. Preparation does not permit
writing shared `dist`, changing runtime processes or inheriting QA database
credentials. A scratch typecheck success is not proof that an active native
checkout was prepared or that its source compiles.
