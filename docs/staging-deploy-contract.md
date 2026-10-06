# Fixed staging delivery contract

This is a single-target staging adapter, not a general deployment platform. It
does not change the A15 production-export boundary: no staging target may be
provisioned until the separately required backup and isolated-restore proof is
authorized and complete. This implementation must never read, copy, or export
production records.

## Configuration and authorization

Keep the staging target in the existing owner-only Connector configuration.
The configured entry binds one stable `targetId` to an SSH alias, pinned
`known_hosts` file/host-key fingerprint, identity-file path, fixed deployment
root, and fixed health/version URL. The configured deployment root contains
the operator-installed Menoteam deployment helper. The Workbench delivery
connection may allow a list of target IDs; only project owners/admins may set
that policy. A delivery request is unavailable unless the project policy and
the claiming Connector both advertise the same configured ID. Do not add a
second target-settings subsystem.

Runs carry only the target ID, exact merged commit SHA, immutable OCI image
digest, and stable request ID. They never carry a hostname, SSH key, path,
command, environment, Compose file, or arbitrary URL. The server rechecks the
original actor's current project authority, target policy version, verified
merge receipt, image provenance, and Connector grant before each remote
effect. Missing configuration, credentials, merge receipt, or build
provenance means `unavailable`, not a queued success.

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
operation is created. Before each effect, persist its intent. A retry first
queries the helper by operation ID and reconciles the recorded result; it does
not blindly replay an ambiguous remote effect.

The fixed operation phases are `deploy_intent`, `deploy_unknown`,
`deployed`, `health_passed`, `rollback_intent`, `rolled_back`, and
`target_offline`. Receipts bind the operation ID, target ID, commit SHA,
image digest, prior verified deployment receipt (for rollback), remote
deployment ID, timestamps, and bounded result. A lost response remains
`deploy_unknown` until a read-only status query resolves it.

`deployed` requires the target helper to report the exact commit and digest.
`health_passed` additionally requires the fixed health/version endpoint to
return that same identity. This is deployment health only; it is not proof
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
