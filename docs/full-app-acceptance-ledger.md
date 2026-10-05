# Full app acceptance ledger

2026-10-06. Status at creation: **not delivered**. Record evidence here only after inspecting actual results. Supporting unit tests do not establish a real adapter/browser/dogfood result.

| ID | Required result | Authoritative proof | Status |
|---|---|---|---|
| A01 | Real member login and invite-only workspace/project authorization | Two authenticated users; unauthorized project reads/mutations/artifacts/connector claims rejected | Pending |
| A02 | Persistent cloud projects, Work, conversations and settings | Real PostgreSQL migration, save/read, process restart and browser refresh | Pending |
| A03 | V3 navigation/layout connected to real state | Desktop/mobile browser observations of project cards, focused Master, Work split, Overview/Changes/QA, settings | Pending |
| A04 | Real continuous Master and model-driven delegation | Saved Master harness thread + tool traces creating/updating Work and dispatching Luna/Sol, no canned routing | Pending |
| A05 | Outbound connector executes only authorized repository/work | Real Codex run, isolated worktree and denied out-of-grant claim/action | Pending |
| A06 | Real diff and revision-bound QA | Git diff matches displayed files/counts/lines; actual checks and failure evidence match recorded revision | Pending |
| A07 | Feedback continues same Work and responsible Agent | User correction, continued thread/checkpoint, updated diff/QA, preserved conversation | Pending |
| A08 | Pause/cancel/offline/restart cannot duplicate side effects | Controlled process/network interruption, lease fencing, local process cleanup/reconciliation and resumed run | Pending |
| A09 | Concurrent unrelated work progresses safely | Two projects/worktrees, distinct Luna/Sol runs, no cross-project state or writer collision | Pending |
| A10 | Real GitHub and Slack sources | Authorized repository/issue/PR fetch; verified signed Slack event; duplicate handling and project routing | Pending |
| A11 | Flexible instructions, profiles/providers and skills are effective | UI and Master mutate same authorized persistent settings; subsequent run observes selection/content; real Codex connection and create/GitHub skill import proof (marketplace and other providers deferred) | Pending |
| A12 | Master setting/skill changes obey permissions | Allowed change visible in UI; denied workspace/project/grant escalation proven | Pending |
| A13 | Menoteam builds Menoteam | Feature and bug Work initiated in app, Luna implementation, Sol independent review, feedback loop and recovery; exact run/artifact links | Pending |
| A14 | Authorized PR/merge/deploy tracked truthfully | Real PR URL + revision, independently checked merge/deploy and user-flow verification; project authorization record | Pending |
| A15 | Cloud delivery preserves existing services/data | Server inventory, backup + restore proof, isolated candidate HTTPS test, V1 regression and rollback proof | Pending |
| A16 | Required regression/security/quality pass for candidate | Actual PostgreSQL suite, backend/UI/runtime tests, typecheck/build, independent review tied to candidate revision | Pending |

## Evidence entry format

For each row append date, candidate revision, executor/reviewer, commands or browser observations, result, artifact/run/PR references and any limits. Change Pending to Proven only when the proof directly covers the required result. If external credentials/capabilities are unavailable, keep Pending with the precise dependency. Do not reduce the requirement.

## Supporting evidence — 2026-10-06

Initial backend integration passed 8 real PostgreSQL tests: member sessions, project/conversation persistence, idempotent submission and run-scoped event/artifact replay, Master tool authorization and membership revocation, concurrent claim exclusivity, stale-generation fencing, pause/stop/resume and connector revocation, raw password preservation, nested credential metadata rejection, active cancellation writer reservation and signed inbound source deduplication. V1 PostgreSQL repository 2 tests also passed on the same isolated test service. These checks re-create the Fastify app against existing PostgreSQL state; they do not prove host/database restart or real connector/browser recovery. All full acceptance rows remain Pending.

Disposable validation container: `menoteam-workbench-validation`, PostgreSQL16, loopback55439, database `menoteam_workbench_test`, no attached user volumes. Tests must not run against live/staging data because the workbench fixture clears its isolated tables.

### Codex continuation feasibility proof

A real Luna native thread `01a10d2d-e944-7581-bf22-9cad0e640175` called a temporary stdio MCP `probe_ping` successfully before and after `thread/resume`, returning `MENOTEAM_MCP_ALIVE` on both turns. `config.mcp_servers` was supplied on both start/resume, with an explicit `enabled_tools` allowlist and per-tool `approval_mode: approve`; shell approval remained `never`. This establishes MCP continuation feasibility, not yet actual Menoteam Master acceptance. A prior probe discovered the tool on both turns but `never` without per-tool configuration rejected MCP calls; discovery alone was not counted as successful proof.

The exact per-tool configuration is documented in [official OpenAI MCP docs](https://learn.chatgpt.com/docs/extend/mcp?surface=cli). The production bridge must expose only bounded Menoteam tools, enforce current run/member grants in the server, and keep connector credentials out of native prompts and persisted configuration values.

Independent parent regression run: 111/111 tests across 20 files passed against the disposable PostgreSQL service, zero skipped. A later focused workbench run passed 9/9, adding frozen profile/model/skill selection and server-derived runtime evidence checks. These fixtures establish contract behavior; fixture thread IDs are not real native execution proof. Runtime-provider UI must distinguish discovered availability from a completed native turn. This first release uses host-authenticated Codex; saved provider metadata and additional account/default selection are deferred and are not claimed effective.

Focused recovery checks: workbench PostgreSQL 10/10 passed (browser cannot bypass connector stop proof; unexpected physical stop remains interrupted), integrated Connector lifecycle 3/3 passed (native thread continuity parameter, bounded bridge token, process-stop ordering, pending-event preservation). These mocked lifecycle checks are supporting evidence, not actual native crash/restart or dogfood completion.

Connector lifecycle suite now 5/5 passed. One test uses a real loopback HTTP server that accepts an event then drops the TCP response and accepts completion then drops its response: stable event IDs deduplicate, the terminal result is reconciled, and the native adapter is invoked once. The native adapter itself is mocked in this test. Latest full typecheck and build passed; real Codex Master/dogfood and native process crash/restart evidence remain pending.

Baseline snapshot: `9dbe7e0aaa2761258319b631af6c6660d669ee63` (`Build real Menoteam workbench baseline`). After the final Master read-only sandbox correction, local `pnpm test` passed 111 tests and skipped 12 PostgreSQL-only tests because `WORK_MAP_TEST_DATABASE_URL` was not configured in this shell; `pnpm typecheck` and `pnpm build` passed. The root separately reported 123/123 tests with the disposable PostgreSQL service configured before that one-line sandbox correction. These are validation references, not proof of the pending acceptance rows.

A12 supporting authorization proof: 11/11 workbench PostgreSQL tests passed after the shared settings operation extension. A Master authorized by the original project owner can modify an existing project skill through the same strict service used by the UI; stale timestamp conflicts, another project's setting ID, and member attempts at workspace/project edits are denied. This is service-level evidence; a real native Master modifying settings through the resumed MCP bridge is still pending.

A01 actual HTTP + preserved runtime PostgreSQL proof (2026-10-06 local): a disposable `example.invalid` member signed in with HTTP 200; its snapshot contained only the fixture project. A different project's conversation and private Work both returned HTTP 403, as did project instructions and project-skill writes. No invitation email was sent and no real person or existing project membership was altered. Safe evidence is `/tmp/menoteam-auth-proof.json`; fixture credentials are deliberately excluded from docs. Browser role-surface proof is still required before marking A01 fully Proven.

A10 GitHub source partial proof (2026-10-06 local, app baseline `009dca77615b3c0f597d1b4e16c4a065c6088882`): through the authenticated Menoteam API, imported public PR [#1](https://github.com/blossomsai/menoteam/pull/1) into project `project_be86f6f5-6f25-44b3-af6f-5a85b75a29c8`. The project feedback intake was verified disabled. The server returned HTTP 200 and deterministic source message ID `source:project_be86f6f5-6f25-44b3-af6f-5a85b75a29c8:github:blossomsai/menoteam:pull:1`; the stored reference identifies itself as external source material, not instructions. Repeating the same POST returned HTTP 200 with the same ID; snapshot count remained one before and after. No Slack message/post or GitHub write occurred. This proves public GitHub PR import plus project routing and duplicate handling locally; signed Slack event verification/routing is still unproven, so A10 remains Pending.

Latest supporting contracts: workbench PostgreSQL 13/13 and Connector lifecycle 5/5 passed, with full typecheck clean. Implementation/review claim changes Work to `in_progress`; an explicit run pause changes it to `paused`; completing a native turn does not mark Work done before independent verification. Claim filters let the connector run at most one Master alongside a worker, or two unrelated workers when no Master occupies capacity. URL metadata rejects credential-bearing/query URLs, and manual source/skill import rechecks authorization after external retrieval before persistence. These are focused contract checks, not full live scheduling or native delivery proof.
