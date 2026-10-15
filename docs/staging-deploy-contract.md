# Fixed staging delivery contract

This is a single-target staging adapter, not a general deployment platform. It
does not change the A15 production-export boundary: no staging target may be
provisioned until the separately required backup and isolated-restore proof is
authorized and complete. This implementation must never read, copy, or export
production records.

## Configuration and authorization

Keep the staging target in the existing owner-only Connector configuration.
The configured entry binds one stable `targetId` to an SSH host/user, pinned
`known_hosts` file/host-key fingerprint, identity-file path and fixed image
repository. Deployment paths and the health URL are constants in the
operator-installed Menoteam helper; target settings do not accept arbitrary
paths or URLs. Version identity is the actual running immutable image digest
and OCI source label checked by that helper, not an app `/version` endpoint. The Workbench delivery
connection may allow a list of target IDs; only project owners/admins may set
that policy. A delivery request is unavailable unless the project policy and
the claiming Connector both advertise the same configured ID. Do not add a
second target-settings subsystem.

Deploy requests carry only the source merge Run ID, target ID, and stable
request ID. The server derives the exact merged commit SHA from that completed
merge receipt and queues the existing delivery Run at `build_discovery`; a
caller cannot supply an image digest. The fixed Connector looks up only the
newest matching `workflow_dispatch` run for that exact SHA on `main` and
requires that attempt to have completed successfully. A newer running or
failed attempt remains visible. The Connector reads its one attempt-scoped
receipt artifact and verifies the signed GHCR digest
with the existing `gh attestation verify` policy. It does not dispatch builds
or fall back to an earlier run. The authenticated Connector submits the
validated receipt; the server durably binds its run/attempt/artifact IDs,
archive digest, source SHA, and OCI digest before granting mutation intent.
The server authorizes and freezes this evidence but does not independently
claim to perform cryptographic attestation verification.
On retry, discovery re-reads the frozen run attempt and artifact IDs instead
of selecting a newer build. Archive reads are bounded, require one regular
receipt file, and stream its bytes without extracting filesystem paths.

Runs never carry a hostname, SSH key, path,
command, environment, Compose file, or arbitrary URL. The server rechecks the
original actor's current project authority, target policy version, verified
merge receipt, frozen build receipt and Connector grant before each remote
effect. Missing configuration, credentials, merge receipt, build, receipt, or
provenance remains visible as unavailable/failed and can be retried through
read-only discovery; it never creates a queued success.

The only remote command is a fixed helper invocation with validated IDs,
40-character commit SHA, and OCI digest. Pass local SSH arguments as an argv
array, require strict host-key checking against the pinned known-hosts entry,
disable interactive prompts/agent forwarding, and never interpolate Work or
model text into a command. The helper performs only the documented isolated
staging operations; it does not accept arbitrary shell, path, service, or
Compose overrides.

## Durable operation and receipts

Use the existing delivery Run, canonical request key, lease/generation fence,
Connector spool, and immutable delivery Artifact. Snapshot target ID/policy
version, merge receipt ID/SHA, image digest/provenance, and actor when the
operation is created. A deploy's canonical key is target plus immutable merge
Run; legacy digest-bound operations retain their existing reconciliation key.
Persist the verified `buildReceipt` before creating deploy intent, including
the workflow run/attempt, artifact ID and archive digest, OCI digest, and
verification time. Before each effect, persist its intent. A retry first
queries the helper by operation ID and reconciles the recorded result; it does
not blindly replay an ambiguous remote effect.

The fixed operation phases are `deploy_intent`, `deploy_unknown`,
`deployed`, `health_passed`, `rollback_intent`, `rolled_back`, and
`target_offline`. Receipts bind the operation ID, target ID, commit SHA,
image digest, prior verified deployment receipt (for rollback), remote
deployment ID, timestamps, and bounded result. A lost response remains
`deploy_unknown` until a read-only status query resolves it.

`deployed` requires the target helper to report the exact commit and digest.
`health_passed` additionally requires the helper to verify the running image
and OCI source identity, healthy container and fixed health endpoint. This is deployment health only; it is not proof
that a user flow works and must not set Work to Verified. User-flow verification
is separate QA evidence bound to the same target, commit, and digest.

Rollback may target only an earlier immutable receipt for this target whose
health check passed. It records both the currently deployed digest and the
previous verified digest before the effect, and reads back the exact result.
On the first bootstrap there is no verified previous version: failure may
remove only the newly added staging route and stop the staging app, recording
`target_offline`; preserve the staging volume and do not call this a version
rollback. No V1 route, service, database, or volume is addressed by this
adapter.

## Minimal implementation and verification

Implementation touches the existing delivery contract, not a new engine:

- `src/workbench/types.ts`, `src/workbench/app.ts`, and `src/workbench/web/App.tsx`
  add the fixed action, strict target policy/request validation, unavailable
  state, and receipt display.
- `src/connector/types.ts`, `src/connector/client.ts`, `src/connector/runner.ts`,
  and one `src/connector/staging-deploy.ts` own configured targets and the
  fixed remote/status adapter. GitHub and SSH credentials stay in the parent
  Connector process, never the model child.
- Existing delivery/PostgreSQL and Connector tests cover missing target,
  wrong project/actor, changed policy, non-merged candidate, missing or
  mismatched image provenance, duplicate request, lost-response reconciliation,
  stale/unknown health, arbitrary command/path rejection, revoked actor,
  rollback to an unverified digest, and bootstrap failure retaining data.

Adapter tests use a recording transport and prove the exact argv, host-key
policy, request identity, and receipt transitions. They are contract tests,
not remote deployment proof. Real staging acceptance additionally requires
the A15 prerequisite, an immutable build/provenance source, a separately
authorized isolated target, and operator verification of the exact deployed
digest, version endpoint, health, V1 non-interference, bootstrap behavior, and
a second-version-to-first-verified-digest rollback drill.

A terminal pre-effect deploy at `build_discovery` may be explicitly retired by
its workspace owner, or a workspace administrator who is also a project owner
or administrator. The same-generation Connector must confirm local cleanup;
failed status or an expired lease alone is not stop proof. An unclaimed queue
cancelled before execution already has that proof. Retirement does not require
re-enabling a revoked delivery policy. It releases only this Run's reservation,
records `stagingRetired`, advances generation, and preserves the original Run,
receipt and canonical source identity. Old retries cannot revive it. Mutation
intent, transport intent and any staging receipt must use status reconciliation
and can never be released through retirement.

The fixed read-only discovery subprocesses wait for child `close`, including
abort/error paths, before the Connector records discovery cleanup as stopped.
That proof and the subsequent stopped acknowledgement remain in the outbox
until acknowledged by the server.
