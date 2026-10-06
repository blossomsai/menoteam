# Effective provider connections

This implementation extends the existing workspace Settings and enrolled
Workbench Connector contracts. It supports only OpenAI / `codex-host`; it does
not authenticate accounts, store credentials, enroll hosts, or grant projects.

## Management and selection

`POST /api/workbench/settings` with `kind: "provider"` binds a connection name
to a real enrolled, accessible Connector with discovered Codex/model capabilities.
Its data is `{provider, method, connectorId, enabled, default}`. Workspace owners
and admins manage these connections. `PATCH /api/workbench/settings/:id` supports
rename, enable/disable and default selection; Connector identity cannot be edited.
Use `expectedUpdatedAt` to reject stale edits. Disabling clears the default flag.
The existing transaction lock and PostgreSQL partial unique indexes prevent
concurrent duplicate defaults and duplicate Connector bindings.

Snapshot `providerConnections` reports available, offline, disabled,
disconnected, unbound, or capability-unavailable states separately. Enrollment
and reported capabilities are not completed-turn verification. No arbitrary
credential records, OAuth forms, additional vendors, or fallback routes exist.

New Work selects an explicit `connectionId` or the current workspace default.
The same choice is supported by the strict MCP `create_work` schema and the
mounted New Work UI. A Project Master's first message can explicitly select a
connection granted to that project, even when the workspace default belongs to
another project. Its scoped `read_context` includes granted connection discovery.
Once historical affinity exists, a different explicit selection is rejected;
changing the workspace default cannot rebind it.
All projects cards and focused Project Master use the same scoped bootstrap
selection. Each project's draft and explicit choice stay together across refresh
and navigation; a revoked choice blocks sending instead of using the default.
That Work identity cannot subsequently change. The default does not migrate an
existing Work or Project Master's historical affinity. Each new run records its
effective connection, Connector, provider/method, model, profile data, skills and
tools. A native continuation retains the original thread, model, reasoning and
execution snapshot. Editing a profile does not rewrite a queued/running/paused
run or an existing native thread's selection.

Request creation, claim, resume/reconcile, lease renewal, scoped tools and native
turn start validate project authorization, Connector grant, connection enabled
state, discovered models and execution capabilities. Connector-local identity
must match the selected host. The Connector checks a fresh authorized run just
before starting the native turn; Codex also validates the requested model against
its fresh model discovery. `runKinds` reflects temporary scheduling capacity and
does not revoke a running native turn. Failures never select another connection.

Fenced messages/artifacts/completion remain recordable after a connection becomes
disabled, so existing work can close without routing elsewhere. These operations
still require actor/project authorization and the correct Connector lease.
An unavailable follow-up Master wake is recorded as failed rather than rolling
back a valid completion. Paused and terminal recovery reads remain possible.

## Preconnection runs

Old run records are not backfilled with invented connection identities. A proven
historical Connector/thread remains the affinity for continuation and resume.
New legacy continuations record that historical Connector and `legacy: true`
without inventing a workspace connection record. Model availability and project
grants are still enforced. A queued run without any proven historical Connector
remains queued and unclaimable; snapshot explains the unresolved identity.
Requests requiring that identity fail explicitly. Adding a default does not
dispatch or migrate those old tasks.
Before deriving a continuation, the server validates the original historical
Connector, model, provider/method, profile and connection fields. Contradictory
records fail without copying their thread into a normalized new selection.

The UI distinguishes an unrecorded connection from an unproven Connector. It
uses the recorded run/target Connector for old executions that predate the
execution snapshot's Connector field. Capability fields absent in legacy
records remain compatible; an explicit `false` still denies use. Both
implementation and review require local Worktrees. New connections and default
selection require that capability, and status includes its incompatibility reason.

## Validation boundary and operator PG checks

A rejected completion wake records `causedByRunId` as a causal diagnostic,
without assigning the completing worker's Connector to Master. These failed,
generation-zero, threadless diagnostics are excluded from affinity selection;
the exact legacy diagnostic format receives the same treatment. Genuine failed
Master executions still retain their responsible identity. A queued Master with
no native thread continues to use its frozen Connector, including when it is
offline; the worker's completion remains committed and cannot authorize rebinding.

The native sandbox cannot bind/connect loopback sockets. PG contract tests must
be run by an operator after checkpoints, serialized with every other database
suite. Do not run them against a live workspace or while another Work owns the
shared `_test` database. Skipped PG tests are not successful validation.

The provider suite uses real PostgreSQL and Fastify HTTP request/response
contracts. It requires both `MENOTEAM_PROVIDER_TEST_DATABASE_URL` (a dedicated
loopback database ending in `_test`) and
`MENOTEAM_PROVIDER_TEST_SERIAL_AUTHORIZED=1`. The existing full Workbench PG
suite uses `WORK_MAP_TEST_DATABASE_URL` and destructive fixtures; run it
separately and serially. Run commands from this candidate checkout:

```sh
node node_modules/vitest/vitest.mjs run tests/workbench-provider-postgres.test.ts
node node_modules/vitest/vitest.mjs run tests/workbench-postgres.test.ts
```

Normal Connector completion owns the Git checkpoint and resulting diff revision.
A working-tree fingerprint or test pass does not prove that checkpoint, independent
review, merge, deployment, live pairing, or real model execution succeeded.

## Integrated QA policy

The integrated Menoteam adapter uses `menoteam-full/v3`: full tests, all three
PostgreSQL suites, three typechecks and isolated builds. It requires two distinct,
explicitly authorized loopback `_test` databases. The ordinary Workbench/V1
suites share `resource`; the Provider suite uses `providerResource`. The host
operator maps both resource IDs to private URLs in the Connector's existing
`qaResources` configuration. No URL is inferred from ambient environment.
The fixed QA child receives the second URL and its serial grant only after both
resources are bound; Vitest file parallelism is disabled. CI provisions the
Provider database separately and requires nonempty passing results from all
three PostgreSQL suites, with zero skipped/todo tests.

Both resource locks are canonicalized and acquired in one sorted order across
Connector processes. A known contention rolls back previously acquired locks;
an unknown owner write, executor or child stop retains durable intents. Recovery
uses the same original-parent/child stop proofs before releasing either lock.
This does not change generic `project/v1` single-resource policy behavior.
Legacy `menoteam-full/v2` remains readable history but is unusable for new QA or
delivery effects. An administrator must explicitly save a v3 policy and authorize
the second host resource; its new version makes old evidence stale. Integration
does not grant this authorization or modify any live policy automatically.
