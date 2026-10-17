# Workbench staging runbook

This runbook describes an additive, isolated staging deployment beside V1. It
does not itself authorize a server change, a V1 change, or a user-facing cutover.
The sole current status is in the [acceptance ledger authority](full-app-acceptance-ledger.md#current-delivery-and-staging-authority-2026-10-17).
This document records
future operator instructions; this documentation update executed no operation.

## Completed backup prerequisite — verified 2026-10-14

The user granted specific production-data encrypted off-host backup and isolated
restore authorization. One authorized operation completed: consistent custom
pg_dump, standard CMS AES-256-GCM authenticated encryption, owner-only retained
ciphertext and separately retained recipient key, fully authenticated tmpfs-only
isolated PostgreSQL16.15 restore, migrations001/002/schema and count observations
verified, owned restore resources removed. Production service/container/volume/
route identities and source metadata remained unchanged. No backup/private-key
paths or data belong in Git. Safe evidence is indexed in the
[acceptance ledger](full-app-acceptance-ledger.md).

This completes the backup/restore prerequisite; it does not create a staging
target, authorize policy bypass, prove HTTPS/user flows, or verify version
rollback. The old rejection paragraph below is historical and does not require
another production dump. Use the retained authenticated backup and proof rather
than automatically repeating the export.

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

At the historical pre-authorization checkpoint, the requested encrypted production dump to a local destination was rejected
by automatic approval review because it would export private production data.
No export, restore, or backup artifact was created. No alternate path may be
used to work around that rejection. A15 remained pending at that checkpoint
until specific export/destination authorization; the later authorized operation
and verified prerequisite are recorded above. The existing V1 services and
named volumes were not changed.

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

For a new isolated target, use a dedicated staging PostgreSQL service and
Compose key
`stage_pgdata`, whose exact physical volume is
`menoteam-workbench-stage_stage_pgdata`. The current target is already
provisioned; do not apply initial-create steps to it blindly.
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

## Current fixed-target deployment and rollback

The isolated target is already provisioned and has completed normal A deploy,
B deploy, and cross-Work rollback to A. The current remote is rolled-back A,
not B or latest main. See the ledger for exact run, digest, source, retained
state, and proof boundaries. These are Owner-attributed observations.

For any separately authorized future candidate, use the normal Workbench
deployment API/Work flow against the fixed target. Require the immutable A
source/build provenance and current B actor, policy, target authorization and
compare-and-swap check; do not substitute a helper or manual host command.
Verify terminal run state, exact immutable image/source, health, migration
compatibility and post-deployment authenticated user flow. Health alone is not
acceptance. On rollback, invoke the normal target rollback flow: it must derive
the prior image's immutable provenance while preserving current authorization
and target CAS. Preserve the physical staging volume and data; never reverse
migrations automatically or use `down -v`/prune. Confirm V1 services and routes
remain intact after the terminal result.

The initial bootstrap and manual Caddy/Compose procedures below are historical
contingency guidance only. They are not the current deployment or rollback
path and are not evidence that those manual steps were performed. The actual
rollback left Caddy unchanged. Keep the physical volume
`menoteam-workbench-stage_stage_pgdata` (Compose key `stage_pgdata`) and
migrations 001–008; do not recreate the target or database.

The older bootstrap-failure and manual Caddy removal/Compose rollback
instructions are retained below as historical contingency context. They apply
only to a genuinely new target or a separately authorized emergency procedure,
not this provisioned target's normal API-controlled release flow.

Schema changes must remain additive and backward-compatible while V1 remains
live. A candidate migration incompatible with its previous app revision blocks
deployment until an isolated rollback drill demonstrates safe recovery. A
user-facing cutover requires separate explicit authorization.

## Historical first isolated deployment: bootstrap failure handling

The following procedure describes the earlier first-deployment contingency; it
does not describe the current provisioned target, which has an active App and a
verified prior image. For a genuinely new isolated target only, no prior image
exists: record `previousVersion: null`, and do not call cleanup a version
rollback. If such a first deployment fails verification, remove only its added
Caddy route, validate and reload Caddy, preserve the staging database volume and
failure evidence, and record `deploy failed / target offline`. The current
target state and actual A/B/rollback evidence are in the ledger.

## Historical manual rollback contingency

The following host-level steps are retained as contingency documentation and
were not the current rollback execution. Normal rollback uses the Workbench
target rollback flow described above. If a separately authorized emergency
requires manual host recovery, restore only the saved staging Caddy route
configuration, validate/reload Caddy, then recreate the app from the previously
verified immutable digest using the dedicated Compose project. Preserve the
staging volume, do not reverse migrations, and verify V1 routes. Never use
`latest`, `down -v`, or volume pruning.

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


For an interrupted local Work with a verified stopped proof, a later same-Work
continuation remains blocked by the existing reservation rule even while its
Connector heartbeats normally. Use the existing owner/admin UI reconciliation
flow; if an unwanted queued continuation exists, cancel it first, then resume
the original run. Current Master MCP has no cancel/reconciliation tool. Do not
release the reservation by editing the database or restarting the Connector.
