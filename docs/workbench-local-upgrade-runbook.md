# Local Workbench runtime upgrade

This procedure is for the existing dogfood service on loopback `127.0.0.1:3200`, using its existing protected environment and existing local PostgreSQL database. It covers the Workbench app/UI and, when code has changed, its separate local Connector. It is not the remote staging procedure in [the staging runbook](workbench-staging-runbook.md), does not authorize a production-data export, and does not replace or copy a database. It does not promise an automatic rollback.

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

Only after the build and preflight pass, perform the replacement in order. If Connector code changed, stop its single identified process first as described below. Then stop the identified Workbench app process cleanly, leaving PostgreSQL running. Start the candidate from its own checkout using the verified launcher and unchanged protected environment. Startup applies migrations transactionally under a PostgreSQL advisory lock. Do not manually run migrations in parallel with startup.

## Connector companion upgrade

Updating the server and Workbench UI alone does **not** install new Connector behavior such as native prompt changes, local QA policy, or skill materialization. If the approved candidate changes `src/connector/**`, build and upgrade the Connector from the same exact SHA as the server:

1. Keep the preconditions above. In particular, require no active native runs/leases, no in-flight QA or delivery child process, and no unreviewed files under the configured `dataDir/spool` or `dataDir/unsent-evidence`. Preserve the Connector's existing `connectorId`, owner-only config file and `dataDir` (which also holds worktree mappings and resumable state); never reset or copy them.
2. Identify the single current Connector PID/tree, launcher, config path and data directory. `src/connector/main.ts` reads `MENOTEAM_CONNECTOR_CONFIG`, requires that file to be owner-only, and handles `SIGINT`/`SIGTERM` by calling `runner.stop()`. That stop closes the claim loop, aborts QA and stops active native processes; it does not authorize stopping a busy Connector. Signal only after the idle checks pass. Use the verified existing process supervisor/launcher and wait for the parent and its verified child groups to exit. If identity or shutdown cannot be confirmed, stop and investigate; do not broad-kill or start a second Connector with the same identity.
3. The existing entry points are `pnpm connector:dev` and `pnpm connector:start` (`node dist/connector/main.js`). `pnpm workbench:build` compiles the TypeScript tree, including Connector code, and builds the Workbench UI. Use the actual verified launch method and the same protected config/environment; do not put tokens in command arguments or change the server URL, connector ID, project grants or data directory.
4. After starting the upgraded Workbench and confirming health/authenticated readback, start exactly one Connector from the same candidate checkout. Confirm the same connector ID appears, its configured project scope is unchanged, `last_seen` advances, and the advertised runtime capabilities/models match the expected host. The API reports capability/heartbeat, not the Connector's source version, so record the process working directory and candidate SHA as the version evidence.
5. Run one bounded, authorized native canary that exercises the changed Connector behavior without requesting PR, merge, deploy, Slack send or other external side effects. For local QA behavior, use only the candidate's authorized disposable `_test` resources; never point QA at the dogfood/runtime database. Read back the resulting run and evidence, and record its exact IDs and candidate SHA. Without this native proof, mark Connector changes as built but not verified; do not claim new native features are live.

Do not restart PostgreSQL as part of either app or Connector replacement. Never run old and new Connector processes concurrently against the same config/data directory: both could claim work or reconcile the same spool.

## Verify and record

- Confirm `/healthz` returns `200` and identifies `menoteam-workbench`.
- In the existing authenticated browser session, confirm `/api/workbench/me` still resolves to the same member; do not log out or replace the session merely to make the check pass.
- Read the same project, Work, conversation and setting recorded before the upgrade. Compare stable IDs, revisions and non-secret fields; do not copy full private records into logs or this runbook.
- Confirm the same Connector ID remains enrolled and its `last_seen` advances after the app is healthy. The Connector is a separate process: do not restart it as part of this procedure.
- Record exact before/after app PIDs, source SHA, migration ledger, HTTP status, same-session result, record-ID/revision comparisons, Connector identity/heartbeat, and any failure. Keep evidence private and redact cookies, credentials, message bodies and repository contents.
- If Connector code changed, also record its before/after PID/tree, launcher working directory/SHA, unchanged connector ID/data directory, child-process shutdown proof, heartbeat/capabilities, and bounded native canary result.

## Failure boundary

If build or preflight fails, do not stop the current app. If candidate startup or readback fails, stop only the identified candidate app and preserve the existing database, current checkout/build and diagnostic evidence. Do not delete records, reverse a migration, restore another database, or automatically restart an older binary.

The migration runner rejects a database whose schema version is newer than the app. Therefore, once migration 006 has committed, an older binary that only knows migrations through 005 is expected to refuse startup. The new indexes are additive at the SQL level, but that does not establish an application rollback path. If the candidate cannot be verified after applying 006, leave the local service stopped and escalate for a deliberate recovery decision; do not describe the outcome as rolled back.

This local procedure is not evidence for remote A15 backup/restore or deployment. The production export rejection and its authorization boundary remain as recorded in the remote staging runbook; this document provides no alternate route around them.
