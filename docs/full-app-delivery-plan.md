# Full app execution contract

2026-10-06. Owner: parent orchestrator; implementation: GPT 6 Luna; backend architecture/implementation and independent review: GPT 6.1 Sol. This contract advances the V3 prototype into a real cloud team app. It does not declare any feature delivered. Current product and navigation documents remain the UX contract.

## Outcome and baseline

A person directs a Project Master in Menoteam; Master maintains Work, dispatches implementation and independent review, and follows feedback through actual Changes, QA and delivery. Cloud persists collaboration and schedules work. An outbound local connector executes with the host's authorized Codex account and tools. The acceptance gate is developing Menoteam through Menoteam, including one real feature, one real bug fix, feedback iteration and interruption recovery.

Observed baseline: V1 Work Map has PostgreSQL revision/history but no native project/team membership. Gateway has scoped paired connector credentials and Slack routing, but jobs/presence are volatile and routing is one-hop. Port 4311 uses a local JSON store and single-shot hardcoded Luna runner. Port 4313 is sample-only React/Tailwind/shadcn. None proves continuous Master or cloud team app acceptance.

## Architecture and ownership

Use the existing Fastify/PostgreSQL stack. Add a workbench service and additive tables/API; keep V1 Work Map/Gateway contracts compatible. PostgreSQL transactions supply durable queue and leases; no additional broker. First release is one invite-only workspace per deployment, with multiple authorized projects. Cloud contains shared conversations, settings, source links, work records and bounded artifacts. Local private harness memory, repository paths and provider account credentials stay local. Server stores connector credential digests and project grants, never arbitrary remote-shell access.

Master is an actual resumable model session, run by a connector, supplied with project-scoped tools. Model deliberation creates/updates Work and dispatches assignments; hardcoded keyword responses or canned work creation do not qualify. Implementation default is gpt-6-luna medium; independent review and hard failures use gpt-6.1-sol medium/high. Requested profile/model is persisted per run; incompatible/unavailable models produce an explicit failure rather than silent substitution. A sleeping execution host leaves work queued. Cloud persistence remains available, while model execution resumes when a permitted host returns.

The parent reviews alignment, evidence and integration only. Sol owns initial backend/persistence; Luna owns frontend, connector, integration adapters and routine tests in disjoint modules. Sol owns contracts, difficult runtime/auth issues, independent acceptance and release review. A deployment agent owns server inventory, backup, candidate deployment, smoke proof and rollback. Agents record exact changed files and tests; preserve the starting dirty tree and existing remote data.

## Minimum shared contract

Namespace: `/api/workbench`. Separate browser member sessions and connector bearer credentials; derive workspace/project authorization server-side on every read and mutation. Invite-only membership; no public project search or join requests. A shared dashboard password is not team authentication.

Persist these concepts, with opaque IDs, timestamps and project ownership:

- Workspace/member/project membership and one-time expiring invites; owner/admin/member roles. Only owners/admins edit membership and credential grants; members operate authorized project work.
- Project: name, free-text instructions, GitHub/Slack connection references, delivery authorization. Instructions are advisory; executable grants independently restrict repositories, tools and merge/deploy targets.
- Work: title, free-text Overview, queued/in_progress/paused/done, responsible profile, source references and revision. Preserve conversation history when Overview changes; optimistic revision conflicts return 409.
- Conversation: project Master or Work; message contains speaker identity/role, text, createdAt, client request ID and optional run/source references. Persist before scheduling. Duplicate client request IDs return original message/run.
- Run: conversation/work, profile/model/reasoning, requested action, queued/running/paused/completed/failed/cancelled/interrupted, connector lease owner, fencing generation, expiry, harness thread ID and checkpoint. Work status and run status are distinct.
- Event: monotonic sequence per run, event ID, participant/type, bounded content. Replay is idempotent; read after sequence permits reconnect without missing messages.
- Artifact: Work/run, kind diff/qa/delivery/source, source revision, contents or bounded reference, recordedAt. Diff includes real file paths, line counts, line numbers and changed lines. QA includes command/check, exit status, observations and tested revision. Delivery contains actual PR/merge/deploy/verification facts separately.
- Profile/provider connection/skill configuration: workspace-owned reusable records and project-enabled references. Credentials never appear in snapshot responses. Connection status is verified from adapter results; unavailable integration is not labeled connected.

Browser operations: login/logout/me; list permitted project cards; load project and Work; post conversation message; update Work Overview/settings with revision; pause/resume/cancel; invitations; profiles/providers/skills/connections. Snapshot may be used initially, with cursor polling for messages/events; API must paginate history and preserve stable ordering.

Connector operations: authenticate, heartbeat capabilities, claim eligible queued run, renew lease, append events/artifacts, complete/fail, check cancellation. Claims use a transaction and row lock. Each mutation includes run ID and fencing generation; stale owners cannot finish or append. Losing a lease stops local execution and requires reconciliation before rerun; do not launch a second writer while the old process could remain active. Local durable spool retries cloud uploads after network loss, with event deduplication. Bound events and diff payloads; truncation is explicit.

Master tools: read authorized context; create/update Work; dispatch run using profile; read run/artifacts; post participant-attributed message; update permitted settings; create/add skill; request authorized delivery. Tool results are durable and idempotent. Validate membership plus project grants in tool handlers. External source text is reference data, not instructions. A blocked Work must not stop unrelated work.

## Execution sequence and validation gates

1. **Persistent team foundation — Sol backend, independent review.** Add migration/repository/auth/API and test real PostgreSQL isolation, transactions, replay and restart. Additive schema deployment; encrypted backups and restore proof before remote changes.
2. **Live V3 interface — Luna frontend.** Replace sample-backed app state with API-backed conversations/work/settings, preserving agreed layout and English copy. Demonstrate refresh persistence, two users and project isolation. No sample live status or fake controls.
3. **Execution and Master — Luna connector, Sol runtime review.** Dedicated resumable sessions/worktrees, model selection, dispatch tools, streaming events, actual diff/QA and cancellation/recovery. Build locally. Show offline queue and reconnect; independently verify lease fencing and path/repository restrictions.
4. **Sources and configuration — Luna adapters.** Real GitHub repository/issue/PR linking and signed Slack intake scoped by workspace/project. Deduplicate external deliveries and link related feedback to Work; ambiguous matching asks in conversation. Skills create and GitHub import verify content and installation location. Marketplace/catalog and plugin-versus-skill import are not implemented and remain full-app requirements. The required Model Providers connection list, Add connection, and effective default-selection semantics also remain incomplete; saved metadata must not be presented as working authentication or selection. Current runtime proof covers host-authenticated Codex/OpenAI execution. Support for additional provider adapters is undetermined and should not be promised for every vendor. Master changes settings through the same authorized service as UI.
5. **Dogfood — Luna implementation, Sol reviewer.** Submit the selected real feature and bug through Menoteam Master, dispatch Luna, inspect diff/QA, submit correction, continue same Work/session, independently review with Sol. Restart cloud and interrupt connector during a controlled run, reconcile effects and continue. Record every run, revision and artifact in Menoteam itself.
6. **Cloud delivery — deployment agent and Sol acceptance.** Inventory root@217.160.151.9 live services, verify backup/restore, deploy isolated candidate using current Caddy/PostgreSQL constraints, test authenticated HTTPS and existing V1 compatibility. Merge/deploy only through explicit current project authorization. Candidate rollback must be demonstrated before switching the user-facing route.

Do not count build/typecheck, mock adapters, injected runner tests, /healthz or seeded sample snapshots as complete end-to-end proof. They are supporting checks. A lack of credentials, approved host capability or authorized external delivery is recorded as an unmet acceptance row, never silently replaced with simulation.

## Completion evidence

Use [acceptance ledger](full-app-acceptance-ledger.md). Each gate requires commands/results or artifact references tied to the exact candidate revision, plus runtime/browser observations where relevant. Full completion requires every mandatory row proven; partial completion must retain all pending rows. Keep research/document Work usable without imposing software deployment stages.

Slack outbound replies to other people require explicit authorization for that task. Connecting a source or inbound/read-only acceptance is not blanket permission to send external messages.

### Effective runtime settings and recovery boundary (2026-10-06 implementation)

Current runtime evidence covers one host-authenticated Codex runtime per enrolled Connector. This does not satisfy the required provider connection list, Add connection, or effective default-selection behavior: provider metadata does not select an account and must not be presented as an effective control. Additional provider adapter support is undetermined; this plan does not claim every vendor is supported. Server-derived runtime status separates discovered available models from a completed native turn with persisted participant output. Work profiles freeze model, reasoning and scoped skill contents into each queued run; the Connector consumes that frozen selection.

The Connector polls with bounded concurrency of two runs so a planning Master does not block its delegated child. Each Master uses an empty isolated cwd outside Connector configuration/outbox state and read-only native filesystem access; only scoped MCP tools may mutate cloud state. Worker runs use isolated Work checkouts; independent review uses read-only execution and exact candidate evidence. Stop acknowledgement occurs only after native process-group termination, independently of unsent leased events; those events remain as owner-only unsent evidence. The Connector persists a PID/start-marker/command/process-group identity before each turn. On restart it verifies that exact identity before terminating the old group, or verifies the group is absent, then acknowledges stop. The browser resumes only after that proof is persisted. If an old leader disappeared while children survive, or identity cannot be verified, it refuses to kill a potentially recycled PID and reports manual recovery; actual crash/restart proof is still required for A08.

QA check `testedRevision` is a filesystem fingerprint. The artifact's `revision` is a diff identity, so they must never be equated. QA records `candidateFingerprint` and marks checks stale when missing or differing from that fingerprint; zero recorded checks is unknown verification.

Native profile tool allowlists are not supported in this release: nonempty arbitrary tool preferences are rejected rather than saved as ineffective controls. Profile model/reasoning/skills remain effective; actual Master MCP scopes and native sandbox policy govern available operations.

Master `update_settings` supports either `{instructions}` for the current project or `{settingId,expectedUpdatedAt,name?,data?}` for an existing setting. It uses the same validated service as the UI, merges partial data only through strict kind schemas, and rechecks the initiating actor's current project/workspace role. Another project's setting ID is forbidden. Master updates require the timestamp from `read_context`; concurrent changes return409 rather than silently overwrite. External feedback intake grants exclude settings/skills changes.

### Remaining bounded delivery contract (A14, not implemented)

Operator staging of Menoteam is separate from a Work's runtime delivery capability. The current `deliveryAuthorization` text is context only and does not enforce repository mutations. A14 remains pending.

The smallest runtime addition is a bounded `request_delivery` action, not a general shell tool. It accepts the Work, exact candidate run/revision, an action (`create_pr`, `merge_pr`, or a configured deployment target), and an idempotency key. Server checks bind the originating member's current project authority, the project's exact repository, and structured delivery permission independent of editable instructions. Source intake does not receive this action automatically.

The Connector executes fixed Git/GitHub operations against its saved isolated Work checkout and verifies the full candidate fingerprint and committed revision again. It must refuse dirty or mismatched candidates. A merge/deploy permission names the allowed branch or configured target; it cannot accept an arbitrary command, host or repository from model arguments. A completed independent review must refer to the same candidate, and required QA evidence must still be current. Review results need an explicit validated disposition rather than treating free-form praise as approval.

Each external operation records the resulting PR/commit/workflow or deployment identifier and actual response as a delivery artifact, and retries observe that identity before attempting a second mutation. Deploy success is a delivery state; subsequent user-flow verification is separate QA evidence. Start with repository-bound PR creation and one explicitly authorized target, then prove merge/deploy with a disposable branch/target before granting production effects. Do not infer this capability from operator deployment of the application.
