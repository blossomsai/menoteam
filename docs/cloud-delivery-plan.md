# Menoteam cloud delivery plan

This plan turns the V3 workbench prototype into a team application while
preserving the existing Work Map V1 and Agent Gateway until compatibility and
cutover are proven. It is a deployment plan, not evidence that the V3 app is
already hosted or production-ready.

## Current server baseline

Read-only SSH inspection on 2026-10-06 found a Debian 12 host with 1 vCPU,
1.8 GiB RAM, 2 GiB swap, and 52 GiB free disk. Three healthy containers are
running: the V1 Work Map app on `127.0.0.1:3000`, PostgreSQL, and the Agent
Gateway on `127.0.0.1:3100`. Caddy serves
`217-160-151-9.sslip.io` and `agents.217-160-151-9.sslip.io`. PostgreSQL data
is in `menoteam_menoteam-postgres`; Gateway pairing state is in
`menoteam_menoteam-gateway:/data`. Both apps return 200 from `/healthz`.

The deployed Work Map database has `001_initial.sql` and
`002_owner_provenance.sql` applied; those were the original V1 migrations at inspection. The additive workbench candidate now includes `003_workbench.sql`, `004_workbench_constraints.sql`, and `005_workbench_bridge_tokens.sql`; they are validated locally but are not yet claimed applied on the remote service. The self-hosting contract says
the dashboard is read-only with one shared password, and V1 MCP access uses one
trusted-team key; there are no user accounts or actor-level permissions. The
current host is therefore a useful additive deployment target, but it does not
yet satisfy the V3 team app's identity, invitation, or project-isolation needs.

The local Menoteam checkout currently contains uncommitted and untracked product
work. It must not be reset, stashed, or mapped as a project execution baseline.
The Connector creates isolated worktrees from explicit committed revisions, so
dogfooding waits until the intended baseline is preserved as a reviewable commit.
No dirty checkout files are copied into agent worktrees implicitly.

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
4. **Stage additively.** Build the image and test against an isolated database
   with production-shaped but non-sensitive fixtures. Reuse the existing
   PostgreSQL server for a separate staging database, and add one staging app
   bound only to loopback port 3200 after measuring resource headroom. The host
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
