# Menoteam cloud delivery plan

This plan turns the V3 workbench prototype into a team application while
preserving the existing Work Map V1 and Agent Gateway until compatibility and
cutover are proven. It is a deployment plan, not evidence that the V3 app is
already hosted or production-ready.

## Historical server baseline — inspected 2026-10-06

Read-only SSH inspection on 2026-10-06 found a Debian 12 host with 1 vCPU,
1.8 GiB RAM, 2 GiB swap, and 52 GiB free disk. Three healthy containers are
running: the V1 Work Map app on `127.0.0.1:3000`, PostgreSQL, and the Agent
Gateway on `127.0.0.1:3100`. Caddy serves
`217-160-151-9.sslip.io` and `agents.217-160-151-9.sslip.io`. PostgreSQL data
is in `menoteam_menoteam-postgres`; Gateway pairing state is in
`menoteam_menoteam-gateway:/data`. Both apps return 200 from `/healthz`.

At that inspection, the deployed Work Map database had `001_initial.sql` and
`002_owner_provenance.sql` applied; those were the original V1 migrations at
inspection. The then-current additive workbench candidate included
`003_workbench.sql`, `004_workbench_constraints.sql`, and
`005_workbench_bridge_tokens.sql`. These statements describe the 2026-10-06
checkpoint, not the current local source or a later remote database query. The
self-hosting contract says
the dashboard is read-only with one shared password, and V1 MCP access uses one
trusted-team key; there are no user accounts or actor-level permissions. The
current host was therefore a useful additive deployment target, but it did not
satisfy the V3 team app's identity, invitation, or project-isolation needs.

## Current delivery status — evidence through 2026-10-14

The latest read-only remote preflight found the existing V1 app, PostgreSQL and
Agent Gateway containers healthy, with the existing V1 volumes and Caddy routes
unchanged. It found no workbench staging container or volume, staging directory,
port-3200 listener or workbench hostname. The inspection did not query or export
the remote database. This is remote inventory evidence, not a deployment or
schema inspection: [2026-10-14 preflight](../.local/acceptance/a15-remote-preflight-20261014-safe.json).

Local source and runtime have advanced beyond the historical `003`–`005`
checkpoint. The local committed source includes migrations `006` and `007`; the
historical local full-app gate for source **`5251ca9b4abda4aaea04fd2512467ca3b93f79a4`**
passed **758/758 tests and 59/59 PostgreSQL tests**, with no skips. Its matched
local rollout is recorded in the [acceptance ledger](full-app-acceptance-ledger.md).
Migration `007_workbench_latest_diff.sql` was applied to the local runtime
database, and its partial latest-diff index was observed valid and ready. The
supporting local receipts are [rollout](../.local/acceptance/combined-5251ca9-20261014/rollout-safe.json),
[migration 007](../.local/acceptance/combined-5251ca9-20261014/migration007-runtime-safe.json),
and [fixed gate](../.local/acceptance/combined-5251ca9-20261014/summary-safe.json).
The latest local matched runtime source85ce has the same tracked tree as
reviewed native8e; both separately passed783/783 plus60/60 PostgreSQL, zero
skips, typechecks/builds exit0. Native typed approval and bounded real UI
Pause/End/reload proof are linked in the ledger. Subsequent documentation-only
commits are not another runtime or gate. The historical758/59 result above is
not a claim about the latest candidate. This local
evidence does not show migrations `006` or `007` applied remotely.

The repository baseline should be selected by an explicit committed revision
and recorded with its tree and required evidence at the time of each run. Never
use uncommitted checkout state as an implicit execution baseline or assume that
an isolated worktree contains uncommitted files. The earlier dirty-checkout
warning was a historical checkpoint, not a claim about the current checkout.

No V3 cloud deployment, remote schema change, authenticated staging user-flow
or route/image rollback has been proven. The earlier read-only preflight retained
the historical export restriction. Later on2026-10-14 the user gave specific
private-data export/destination/isolated-restore authorization: one encrypted
production backup and authenticated tmpfs-only PostgreSQL16.15 restore passed,
with matching migration/schema/count observations and unchanged V1 inventory.
Ciphertext and separate recipient key are retained outside Git; restore resources
were removed. This completes the backup prerequisite only; do not repeat the
backup automatically or infer a remote deployment from it. Actual safe evidence
is linked in the [acceptance ledger](full-app-acceptance-ledger.md).
These facts do not relax the identity, isolation, backup/restore, V1
compatibility, staging, acceptance or rollback gates below.

Local preparation now includes an exact8e synthetic staging-Compose image smoke:
dummy rendering, isolated app/DB health, Workbench/login/owner routes and real
migration001–007 passed without published ports or V1 resources. All owned
containers/network/volume/image tag were removed; existing container identities
remained unchanged. The local image has no OCI revision label or release
attestation, and no version endpoint was checked. This is not production restore,
remote HTTPS staging, cloud persistence or rollback proof. See the
[smoke receipt](../.local/acceptance/staging-compose-local-8e4409-20261014/smoke-safe.json).
Normal product [draft PR7](https://github.com/blossomsai/menoteam/pull/7) has exact8e
head and successful push/PR CI; it remains unmerged. Project merge policy remains
false. Registry publication from an actual authorized main merge and every remote
gate below are still pending; do not deploy this local smoke tag as a release.


## Delivery sequence

1. **Finish the local dogfood loop.** Build the full application locally,
   including persistent conversations and Work state, real changes/QA evidence,
   Master coordination, and a local Connector that executes Codex work in an
   isolated worktree. Verify create → assign → execute → inspect diff/QA → user
   feedback → resume, including interruption and restart recovery. The server
   remains a coordinator and durable shared-data service; it does not run agent
   builds, browsers, or repository commands.
2. **Add cloud identity and authorization.** Implement authenticated human
   sessions and invitation lifecycle before exposing the workbench to a team.
   Scope every read and write to the authenticated workspace and project;
   enforce membership/role checks on the server, not only in the UI. Invitations
   must be addressed, expiring, revocable, single-use, and accepted only by the
   invited identity. Connector enrollment uses its own revocable device token;
   never hand a shared database or MCP credential to a browser or local agent.
3. **Introduce a separate V3 persistence boundary.** Add forward-only,
   reviewed migrations for users, memberships, invitations (one workspace per deployment),
   projects, Work, conversation events, execution/QA evidence, and connector
   leases. Keep V1 tables and API behavior intact during the transition. Do not
   assume that V1's graph, ownership, or revision records can be mechanically
   translated into V3 Works; define and validate any import mapping separately.
4. **Stage additively.** After the production backup/export authorization and
   isolated restore proof required by the [staging runbook](workbench-staging-runbook.md),
   test an immutable candidate image against a dedicated staging PostgreSQL
   service with its own Compose project, volume, staging-only credentials and
   non-sensitive fixtures. Do not reuse the V1 PostgreSQL service, network or
   credentials, even under a separate database name. Add one staging app bound
   only to loopback port3200 after measuring resource headroom. The host
   has 1 vCPU and currently runs three services; do not launch competing build,
   browser, or agent workloads there. Add
   `workbench.217-160-151-9.sslip.io` as a separate Caddy site when the staging
   app is ready. Never point the staging app at the V1 database.
5. **Release alongside V1.** Publish a versioned workbench image and deploy it
   at `/workbench` or the staging hostname while preserving the existing root,
   `/mcp`, and Agent Gateway routes. Pin an immutable image digest or exact
   release tag; do not deploy `latest`. Run database migrations as an explicit
   release step with a single-writer lock, and require backward-compatible
   expand/contract migrations while old V1 services remain live.
6. **Prove operations before cutover.** Take an encrypted off-host PostgreSQL
   backup, restore it into an isolated database, and record row counts and
   migration state. Validate authentication, invitation acceptance/revocation,
   workspace/project isolation, conversation persistence, connector pairing
   and revocation, real execution callbacks, and V1 route compatibility. Test
   rollback against the isolated copy. A green `/healthz` alone is insufficient.
7. **Cut over only after acceptance.** Keep V1 routes and volumes intact. Switch
   only the workbench route after the new app passes the above gates and an
   acceptance checks. Keep the previous immutable app image and backup
   available. Roll back by reverting the workbench route/image; do
   not roll back by deleting volumes or automatically reversing applied schema
   migrations.

## Release and recovery gates

- CI passes typecheck, unit and integration tests, production build, migration
  checks, and image build; publish an immutable artifact with SBOM/provenance.
- Staging passes an end-to-end self-hosted development task including feedback
  iteration, durable resume after connector restart, real diff and QA evidence,
  and independent review.
- Security tests prove cross-project access is denied for
  both reads and mutations, including guessed IDs, replayed invitations, and
  expired/revoked connector tokens.
- The backup restore is successful and V1 API reads still work against the
  retained V1 service/data. Record exactly which migrations have been applied.
- Rollback is demonstrated without touching the V1 database or its named
  volumes. Deployment success, QA success, and user-flow verification remain
  distinct states in the Work record.

## Operational limits and references

Keep builds, Codex execution, and browser QA on local agent machines. The server
is currently a small single-host deployment with no demonstrated high
availability; monitor memory, CPU, disk, database growth, and backup age before
adding sustained team load. Do not promise uptime or scale from the current
health checks.

Existing operational details remain in [self-hosting](self-hosting.md),
[release procedure](releasing.md), and the [V1 Work Map contract](work-map-v1-spec.md).
Those documents describe the current V1 deployment and APIs; this plan defines
the additive path to the V3 workbench.
