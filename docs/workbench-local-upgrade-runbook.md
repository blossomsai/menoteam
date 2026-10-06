# Local Workbench runtime upgrade

This procedure is for the existing dogfood service on loopback `127.0.0.1:3200`, using its existing protected environment and existing local PostgreSQL database. It is not the remote staging procedure in [the staging runbook](workbench-staging-runbook.md), does not authorize a production-data export, and does not replace or copy a database. It does not promise an automatic rollback.

The acceptance ledger records one earlier local backend-only upgrade using the existing environment/database. That event did not upgrade the current Workbench UI bundle or prove migration compatibility for a later candidate. Treat each new candidate as a separate change.

## Preconditions

1. Select the exact integrated source SHA and confirm its required operator tests, zero-skip gate, typechecks/builds and independent review status in the [acceptance ledger](full-app-acceptance-ledger.md). Do not upgrade from a native Work checkout or an unreviewed dirty tree.
2. Wait until all native tasks are terminal. Confirm there are no active or queued runs being executed, no live run leases, no pending Connector spool/outbox events, and no surviving native child process groups. Inspect process identity, parent/child relationship, working directory and Connector configuration path; do not stop an ambiguous or duplicate-looking process. Preserve the current Connector and its configuration.
3. Identify the actual `:3200` process, its launch method, working directory, and protected environment source. Do not print or copy environment values. If the launch method or database identity cannot be established, stop here; do not guess a command, change `DATABASE_URL`, or point at a test/remote database.
4. Record the current app PID/tree, source SHA if known, `/healthz` result, current migration ledger, and the IDs (not private contents) of one known project, Work, conversation and setting for readback. Record the current Connector identity and observed `last_seen` without exposing credentials.
5. Review migrations in the candidate against the currently applied ledger. In particular, migration `006_workbench_provider_connections.sql` adds two unique indexes. Before startup, use read-only database-side checks to confirm there are no duplicate workspace provider `connectorId` values and no more than one default bound provider. Record only the conflict counts; do not export rows or “fix” user data as part of preflight.

## Build and replace the app

Build from a clean, detached checkout of the approved SHA so the running checkout and its current build remain intact. The existing script is `pnpm workbench:build`; it writes the TypeScript output under `dist/` and empties/rebuilds `dist/workbench/web`. Do not run it in the active serving checkout. Run the established project typecheck and acceptance gate for that same SHA before replacement.

The server entry point is `src/workbench/main.ts`: it requires the existing `DATABASE_URL`, runs migrations before listening, serves assets from `<working-directory>/dist/workbench/web`, and defaults to `127.0.0.1:3200`. The supported package entry point is `pnpm workbench:start`. Use the actual, already-identified local process launcher and the same protected environment; do not create a new secret file, expose credentials in command arguments, change the port, or start a second app against the same database. If the current service is not launched this way, follow its verified launcher rather than substituting this script.

Only after the build and preflight pass, stop the identified Workbench app process cleanly, leaving PostgreSQL and the Connector running. Start the candidate from its own checkout using the verified launcher and unchanged protected environment. Startup applies migrations transactionally under a PostgreSQL advisory lock. Do not manually run migrations in parallel with startup.

## Verify and record

- Confirm `/healthz` returns `200` and identifies `menoteam-workbench`.
- In the existing authenticated browser session, confirm `/api/workbench/me` still resolves to the same member; do not log out or replace the session merely to make the check pass.
- Read the same project, Work, conversation and setting recorded before the upgrade. Compare stable IDs, revisions and non-secret fields; do not copy full private records into logs or this runbook.
- Confirm the same Connector ID remains enrolled and its `last_seen` advances after the app is healthy. The Connector is a separate process: do not restart it as part of this procedure.
- Record exact before/after app PIDs, source SHA, migration ledger, HTTP status, same-session result, record-ID/revision comparisons, Connector identity/heartbeat, and any failure. Keep evidence private and redact cookies, credentials, message bodies and repository contents.

## Failure boundary

If build or preflight fails, do not stop the current app. If candidate startup or readback fails, stop only the identified candidate app and preserve the existing database, current checkout/build and diagnostic evidence. Do not delete records, reverse a migration, restore another database, or automatically restart an older binary.

The migration runner rejects a database whose schema version is newer than the app. Therefore, once migration 006 has committed, an older binary that only knows migrations through 005 is expected to refuse startup. The new indexes are additive at the SQL level, but that does not establish an application rollback path. If the candidate cannot be verified after applying 006, leave the local service stopped and escalate for a deliberate recovery decision; do not describe the outcome as rolled back.

This local procedure is not evidence for remote A15 backup/restore or deployment. The production export rejection and its authorization boundary remain as recorded in the remote staging runbook; this document provides no alternate route around them.
