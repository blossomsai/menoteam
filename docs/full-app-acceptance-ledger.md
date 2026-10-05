# Full app acceptance ledger

2026-10-06. Status at creation: **not delivered**. Record evidence here only after inspecting actual results. Supporting unit tests do not establish a real adapter/browser/dogfood result.

| ID | Required result | Authoritative proof | Status |
|---|---|---|---|
| A01 | Real member login and invite-only workspace/project authorization | Two authenticated users; unauthorized project reads/mutations/artifacts/connector claims rejected | Partial |
| A02 | Persistent cloud projects, Work, conversations and settings | Real PostgreSQL migration, save/read, process restart and browser refresh | Partial |
| A03 | V3 navigation/layout connected to real state | Desktop/mobile browser observations of project cards, focused Master, Work split, Overview/Changes/QA, settings | Partial |
| A04 | Real continuous Master and model-driven delegation | Saved Master harness thread + tool traces creating/updating Work and dispatching Luna/Sol, no canned routing | Proven |
| A05 | Outbound connector executes only authorized repository/work | Real Codex run, isolated worktree and denied out-of-grant claim/action | Partial |
| A06 | Real diff and revision-bound QA | Git diff matches displayed files/counts/lines; actual checks and failure evidence match recorded revision | Partial |
| A07 | Feedback continues same Work and responsible Agent | User correction, continued thread/checkpoint, updated diff/QA, preserved conversation | Partial |
| A08 | Pause/cancel/offline/restart cannot duplicate side effects | Controlled process/network interruption, lease fencing, local process cleanup/reconciliation and resumed run | Partial |
| A09 | Concurrent unrelated work progresses safely | Two projects/worktrees, distinct Luna/Sol runs, no cross-project state or writer collision | Pending |
| A10 | Real GitHub and Slack sources | Authorized repository/issue/PR fetch; verified signed Slack event; duplicate handling and project routing | Partial |
| A11 | Flexible instructions, profiles/providers and skills are effective | UI and Master mutate same authorized persistent settings; subsequent run observes selection/content; real Codex connection and create/GitHub skill import proof (marketplace and other providers deferred) | Partial |
| A12 | Master setting/skill changes obey permissions | Allowed change visible in UI; denied workspace/project/grant escalation proven | Partial |
| A13 | Menoteam builds Menoteam | Feature and bug Work initiated in app, Luna implementation, Sol independent review, feedback loop and recovery; exact run/artifact links | Partial |
| A14 | Authorized PR/merge/deploy tracked truthfully | Real PR URL + revision, independently checked merge/deploy and user-flow verification; project authorization record | Pending |
| A15 | Cloud delivery preserves existing services/data | Server inventory, backup + restore proof, isolated candidate HTTPS test, V1 regression and rollback proof | Partial — export blocked |
| A16 | Required regression/security/quality pass for candidate | Actual PostgreSQL suite, backend/UI/runtime tests, typecheck/build, independent review tied to candidate revision | Partial |

## Evidence entry format

For each row append date, candidate revision, executor/reviewer, commands or browser observations, result, artifact/run/PR references and any limits. Use **Partial** when actual evidence covers only part of the required result; identify the remaining gap. Change to **Proven** only when the evidence directly covers the full row. Tests alone do not establish native execution, browser acceptance or production delivery. **Pending** means the required real workflow has not yet been demonstrated. Do not reduce the requirement.

## Historical supporting evidence — 2026-10-06

The paragraphs below describe evidence available at each checkpoint. Their earlier Pending statements are historical; the current table and consolidated result section supersede them.

Initial backend integration passed 8 real PostgreSQL tests: member sessions, project/conversation persistence, idempotent submission and run-scoped event/artifact replay, Master tool authorization and membership revocation, concurrent claim exclusivity, stale-generation fencing, pause/stop/resume and connector revocation, raw password preservation, nested credential metadata rejection, active cancellation writer reservation and signed inbound source deduplication. V1 PostgreSQL repository 2 tests also passed on the same isolated test service. These checks re-create the Fastify app against existing PostgreSQL state; they do not prove host/database restart or real connector/browser recovery. All full acceptance rows remain Pending.

Disposable validation container: `menoteam-workbench-validation`, PostgreSQL16, loopback55439, database `menoteam_workbench_test`, no attached user volumes. Tests must not run against live/staging data because the workbench fixture clears its isolated tables.

### Codex continuation feasibility proof

A real Luna native thread `01a10d2d-e944-7581-bf22-9cad0e640175` called a temporary stdio MCP `probe_ping` successfully before and after `thread/resume`, returning `MENOTEAM_MCP_ALIVE` on both turns. `config.mcp_servers` was supplied on both start/resume, with an explicit `enabled_tools` allowlist and per-tool `approval_mode: approve`; shell approval remained `never`. This establishes MCP continuation feasibility, not yet actual Menoteam Master acceptance. A prior probe discovered the tool on both turns but `never` without per-tool configuration rejected MCP calls; discovery alone was not counted as successful proof.

The exact per-tool configuration is documented in [official OpenAI MCP docs](https://learn.chatgpt.com/docs/extend/mcp?surface=cli). The production bridge must expose only bounded Menoteam tools, enforce current run/member grants in the server, and keep connector credentials out of native prompts and persisted configuration values.

Independent parent regression run: 111/111 tests across 20 files passed against the disposable PostgreSQL service, zero skipped. A later focused workbench run passed 9/9, adding frozen profile/model/skill selection and server-derived runtime evidence checks. These fixtures establish contract behavior; fixture thread IDs are not real native execution proof. Runtime-provider UI must distinguish discovered availability from a completed native turn. This first release uses host-authenticated Codex; saved provider metadata and additional account/default selection are deferred and are not claimed effective.

Focused recovery checks: workbench PostgreSQL 10/10 passed (browser cannot bypass connector stop proof; unexpected physical stop remains interrupted), integrated Connector lifecycle 3/3 passed (native thread continuity parameter, bounded bridge token, process-stop ordering, pending-event preservation). These mocked lifecycle checks are supporting evidence, not actual native crash/restart or dogfood completion.

Connector lifecycle suite now 5/5 passed. One test uses a real loopback HTTP server that accepts an event then drops the TCP response and accepts completion then drops its response: stable event IDs deduplicate, the terminal result is reconciled, and the native adapter is invoked once. The native adapter itself is mocked in this test. Latest full typecheck and build passed; real Codex Master/dogfood and native process crash/restart evidence remain pending.

Baseline snapshot: `9dbe7e0aaa2761258319b631af6c6660d669ee63` (`Build real Menoteam workbench baseline`). After the final Master read-only sandbox correction, local `pnpm test` passed 111 tests and skipped 12 PostgreSQL-only tests because `WORK_MAP_TEST_DATABASE_URL` was not configured in this shell; `pnpm typecheck` and `pnpm build` passed. The root separately reported 123/123 tests with the disposable PostgreSQL service configured before that one-line sandbox correction. These are validation references, not proof of the pending acceptance rows.

A12 supporting authorization proof: 11/11 workbench PostgreSQL tests passed after the shared settings operation extension. A Master authorized by the original project owner can modify an existing project skill through the same strict service used by the UI; stale timestamp conflicts, another project's setting ID, and member attempts at workspace/project edits are denied. Native success-path evidence is now also recorded below. The permission-negative coverage remains service-level; the native success does not prove an unauthorized Master escalation attempt.

A01 actual HTTP + preserved runtime PostgreSQL proof (2026-10-06 local): a disposable `example.invalid` member signed in with HTTP 200; its snapshot contained only the fixture project. A different project's conversation and private Work both returned HTTP 403, as did project instructions and project-skill writes. No invitation email was sent and no real person or existing project membership was altered. Safe evidence is `/tmp/menoteam-auth-proof.json`; fixture credentials are deliberately excluded from docs. Browser role-surface proof is still required before marking A01 fully Proven.

A10 GitHub source partial proof (2026-10-06 local, app baseline `009dca77615b3c0f597d1b4e16c4a065c6088882`): through the authenticated Menoteam API, imported public PR [#1](https://github.com/blossomsai/menoteam/pull/1) into project `project_be86f6f5-6f25-44b3-af6f-5a85b75a29c8`. The project feedback intake was verified disabled. The server returned HTTP 200 and deterministic source message ID `source:project_be86f6f5-6f25-44b3-af6f-5a85b75a29c8:github:blossomsai/menoteam:pull:1`; the stored reference identifies itself as external source material, not instructions. Repeating the same POST returned HTTP 200 with the same ID; snapshot count remained one before and after. No Slack message/post or GitHub write occurred. This proves public GitHub PR import plus project routing and duplicate handling locally; signed Slack event verification/routing is still unproven, so A10 remains Pending.

Latest supporting contracts: workbench PostgreSQL 13/13 and Connector lifecycle 5/5 passed, with full typecheck clean. Implementation/review claim changes Work to `in_progress`; an explicit run pause changes it to `paused`; completing a native turn does not mark Work done before independent verification. Claim filters let the connector run at most one Master alongside a worker, or two unrelated workers when no Master occupies capacity. URL metadata rejects credential-bearing/query URLs, and manual source/skill import rechecks authorization after external retrieval before persistence. These are focused contract checks, not full live scheduling or native delivery proof.

Reviewer evidence-access supporting contract: PostgreSQL 14/14 and Connector lifecycle 5/5 passed after adding a review run-scoped bridge. A reviewer can read only its assigned Work and target candidate run's complete diff/QA artifacts; other Work/run IDs, project-wide context, mutations, and connector enrollment operations are denied. Original actor authorization and live lease/generation remain checked on every tool call. Real native reviewer evidence retrieval remains pending until the controlled runtime upgrade. Native review stays in a read-only filesystem sandbox.

Integrated reviewer-MCP candidate validation: full typecheck and build passed; the entire regression suite passed 129/129 tests across 23 files with the isolated PostgreSQL database configured, zero skipped. Native reviewer MCP discovery/call proof is a separate pending step; mocked or service-level tests do not establish it. No active runtime was restarted during these checks.

## Consolidated real-workflow results — 2026-10-06

This snapshot records inspected runtime/service evidence and the parent's actual browser/test observations. It does not claim full app delivery. Exact IDs below were confirmed with the runtime operator or Git; no abbreviated IDs were expanded by inference.

### A04 — Proven: continuous native Master

The real Project Master uses native thread `01a10d56-deaf-7252-b344-8265905ab408`. Its persisted server tool journal (`wb_requests`, scoped to the corresponding Master run) records successful model-selected operations across continued turns:

- `run_fe778cec-9841-4ead-af17-03de0a199216`: `read_context`.
- `run_34f3bdf8-6d87-475b-85eb-90041bd222f9`: `create_work` and `read_work`, creating `work_8cad4193-ad91-4957-b9d9-fdfa72ca26d2`.
- `run_e7a69457-467e-4d24-ae38-fc9e272e7ba4`: `create_work` and `dispatch`.
- `run_c1ad03f8-6cf2-4572-8b16-6ef513ee623f`: `read_work`, `post_message` and `dispatch` for Search Work `work_78a91e0a-e608-49d7-9e40-89628c661746`.
- `run_5180c996-7721-4af7-8b29-d8cdf340b166`: `read_work` and `read_run` for independent Sol review `run_2014c2b2-649e-4ae8-b54d-2bdc6029dee8` and feedback.
- `run_b8863b4d-1f17-44a1-b3fa-c9857126115f`: `read_work` and `read_run` for implementation/feedback evidence.
- `run_30c2057e-bac1-4790-936a-3ba95707d70e`: `read_run`, `read_work`, `post_message` and `update_work` for the Instructions bug.
- `run_2e7a6f0f-1be5-4de2-b55a-be491fe44b7f`: `read_work` for both dogfood Works, `update_work` and `dispatch`. The actual update result restored bug Work overview from null at revision 2 to 456 characters at revision 3. This was a native Master tool operation, not an operator database write.
- `run_5c77d487-ad06-4c18-8780-bab02ee07ed1`: `read_work`, `read_run` for supplemental review and `post_message`, still using the same Master thread.

Native tool outputs are persisted in the project conversation. The parent observed Master create/read/update Work and delegate implementation to Luna and independent review to Sol in the app. This covers A04's continuous, model-driven coordination requirement; it does not prove every setting mutation, source adapter or delivery action.

### A06/A07/A13 — Partial: Search feature and independent current-candidate review

Search Work is `work_78a91e0a-e608-49d7-9e40-89628c661746`. Initial Luna implementation `run_db1751c0-df36-4c41-83e2-aea04aa94f8f` completed at generation 2 after resume, using native thread `01a10d5d-9f76-7ae2-9bf2-a83860efdb80`; feedback `run_9de55c92-6fc5-42f6-8a0a-a03678d66d81` completed at generation 1 in that same responsible-Agent thread. This is actual continuity evidence, not a full crash-safety drill. The real implementation candidate is Git commit `1e45dc3b03e88609107c9f8b276b9a8fa8ad6c34`; the continued feedback run is `run_9de55c92-6fc5-42f6-8a0a-a03678d66d81`.

The search candidate was integrated into the reviewed app baseline by cherry-picking only its three-file change: original `1e45dc3b03e88609107c9f8b276b9a8fa8ad6c34` → integration commit `b2738cd3de01b94ca276406e14d923ca9024bd33` (parent `a6c326b66956591ee7fc5876c2f8838a067aaeaa`). The resulting commit touches only `src/workbench/web/App.tsx`, `src/workbench/web/routes.ts`, and `tests/workbench-routes.test.ts` (40 insertions, 5 deletions); it preserves the prior authorization, profile-scope and other hardening already in the integration baseline. Focused route tests passed 5/5; `pnpm run typecheck`, `pnpm run workbench:build`, and `git diff --check` passed. A full `pnpm test` run with local listener permission passed 114 tests and skipped 19; the two PostgreSQL suites (17 workbench tests and 2 repository tests) were skipped because `WORK_MAP_TEST_DATABASE_URL` was not configured in that shell. This does not replace the separately reported database-backed 18/18 run. Browser QA remains Pending: the previously rejected localhost QA target was not retried or bypassed, so Work is not marked Done.

Follow-up full-suite validation on current integration tree `7b2d5f8` (which includes `b2738cd`): the parent ran `pnpm test` against the isolated `menoteam_workbench_test` PostgreSQL database, with `WORK_MAP_TEST_DATABASE_URL` set for that run. Result: **133/133 tests passed across 23 files, zero skipped**, exit 0, 17.23 seconds (2026-10-06 03:56:38, execution session `22254`). This supersedes the 114/19 shell-only run for the integrated tree. The earlier 18/18 database result refers to a prior candidate checkpoint and is not combined into this 133-test result. Browser QA remains Pending.

Supplemental Sol review `run_489ce606-63fa-42e3-95f9-551a83347d4f` uses native thread `01a10d6d-60f1-71c3-982d-3b45ce462ff9`. Its actual scoped MCP journal (`tools:run_489ce606-63fa-42e3-95f9-551a83347d4f`) shows successful `read_work` returning five Work artifacts and successful `read_run` for the assigned feedback candidate returning its two artifacts. The current diff and QA share revision `876b5b3f959c94d6a0a1d3e2884b392a484f2946f03f995e26746c9759c3ff29`. The review conclusion reports no actionable code findings and five fresh QA checks bound to candidate fingerprint `80417e307551b7a1d082d1293fc6772c30b0b5e49e34221e5fd73822a49fa08b`.

This is real native evidence access, superseding the earlier MCP-pending checkpoint. Attempts to read the original implementation and prior review returned HTTP 403 / `Reviewer can read only assigned candidate run`, as required by the current narrow review grant. That proves the access boundary, not historic audit coverage. Historic evidence access and exact repaired browser behavior remain unverified. The previously rejected browser target was `127.0.0.1:4313`; no retry or alternative path was used to bypass the rejection. Feature implementation, feedback and current-candidate independent review are demonstrated; A13 still needs the complete bug/recovery/browser loop.

### A13/A16 — Partial: Instructions bug candidate validation

Bug Work `work_49d7ada0-7ebf-494c-b8aa-0853190fada5` initial Luna run `run_27ccda33-9efd-4fed-b06d-a50cc2b0110f` and follow-up `run_f0f271f5-5356-4c55-971e-422712c42a53` both completed at generation 1 using native thread `01a10d78-3602-7480-bbb7-a37eabb3f1a0`. The initial run produced candidate `7c9091643b88dc5a08beb4102ff658d71021c3ae`. At 03:24:50, the parent independently ran `pnpm exec vitest run tests/instructions-draft.test.ts tests/workbench-postgres.test.ts` in that candidate checkout with the isolated `menoteam_workbench_test` PostgreSQL database: 16/16 passed across two files, zero skipped, exit 0 (execution session `76102`). This is evidence for that exact older candidate. The later same-thread follow-up adds concurrency/in-flight-save handling and requires its own tests and independent review; the 16/16 result does not certify the newer candidate or browser flow.

The later same-thread candidate `75097bb5ee3a040cfea6975518c720934ad809ae` was independently tested by the parent at 03:47:07 against the disposable PostgreSQL database: instructions-draft 3 plus workbench PostgreSQL 15 = **18/18 passed**, two files, zero skipped, exit 0. This includes concurrent `Promise.all` saves yielding one HTTP 200 and one HTTP 409 with the winning value persisted, plus the in-flight draft helper. This newer candidate result supersedes the older 16/16 checkpoint for candidate validation; native independent review and browser repair acceptance remain separate.

The separate central partial-Work update repair is commit `fc0c394e1899464902240c5286e72ffa3eb7ed3c`: omitted optional fields no longer erase the existing overview/status. Its PostgreSQL regression verifies Master and UI partial updates preserve stored fields and sources, while an explicit empty overview still clears it. The later actual Master restoration is recorded under A04 above; no operator database repair was used.

### A11 — Partial: actual fixed-reference GitHub skill import

An authenticated owner used the real local API at `http://127.0.0.1:3200` to import [the Master skill at an immutable Git reference](https://github.com/blossomsai/menoteam/blob/e48c02339ade6dd3806f3015a0c74be1c1adae30/plugins/menoteam-agent/skills/menoteam-master/SKILL.md) into disposable fixture project `project_5d082173-126b-4363-860c-92af8076dcd1`. That project's repository URL is empty: the supported path is an explicitly supplied GitHub URL, not a claim that imports are restricted to the connected repository.

Source commit: `e48c02339ade6dd3806f3015a0c74be1c1adae30`. Persisted skill: `setting_57f30077-f35a-4283-9583-89f0bd0dbbda`, 1,601 bytes, content SHA-256 `f056ff142cd0db5accb6a4ea2ef77a2a2211cd8012d12d5880a8c48cf6737992`. A subsequent snapshot returned the same setting ID, kind, project, source URL and exact content. Evidence comes from the frontend agent's actual authenticated API interaction and source-reference check; no separate proof file was created.

No imported skill was executed, no GitHub write occurred, and no real project/member was mutated. UI copy now permits a user-specified GitHub repository URL. Browser import verification remains unavailable following automatic approval rejection. A separate disabled project skill was changed by native Master, as recorded below; effective reuse of an imported skill in a subsequent run and browser verification still need proof, so A11 remains Partial. Additional provider adapters and marketplace installs remain explicitly deferred; host-authenticated Codex is the supported runtime.

### A11/A12 — Partial: native Master project-skill create, update and read

On 2026-10-06, native Master run `run_60d33dc0-99c6-4865-891b-ce46e2c60f4b` on thread `01a10d56-deaf-7252-b344-8265905ab408` operated on project `project_be86f6f5-6f25-44b3-af6f-5a85b75a29c8`. Its persisted `wb_requests` journal records `read_context` → `create_skill` and `update_settings` on the same skill setting `setting_51e627c2-dd39-430f-bb5e-94352cbbde9d` → `read_context` returning the saved skill → `post_message`. The setting is kind `skill`, named “Menoteam acceptance note”, project-scoped, and `enabled: false`; the saved content is the acceptance note. The parent independently saw the saved result reported in the live Master UI at 03:56.

This proves one native authorized project-skill create/update/read path. The skill was disabled and was not attached to a profile or run, so no execution or effect on a subsequent Work is claimed. It does not prove workspace-skill/profile behavior, browser editing, or a native authorization-negative attempt. A11 and A12 remain Partial.

### A15 — Partial: inventory only, backup export blocked

Read-only server inventory identified the existing V1 PostgreSQL volume `menoteam_menoteam-postgres` and Gateway volume `menoteam_menoteam-gateway`; the app container is stateless. No backup job was visible in Docker, but external backup scheduling is unknown.

Automatic approval review rejected the proposed production-data export before execution. The proposed local destination was `backups/a15-v1-20261006`; specific user authorization for that export/destination is still required. No production data payload was exported/copied, no backup or restore artifact was created, no alternative export path was attempted, and V1/Caddy/volumes were not modified. Inventory does not establish backup, restore, isolated HTTPS staging, rollback or V1 regression. The separate staging runbook is a plan only, not executed delivery evidence.

### Remaining acceptance limits

A01 has real disposable-user HTTP isolation proof but lacks browser role-surface verification. A02 has real persisted records but lacks a complete host/database restart drill. A03 has partial app browser observations, not full responsive navigation acceptance. A05 has actual bounded native execution and service denial tests, not the whole out-of-grant adapter workflow. A08 has generation/resume and mocked/transport-loss supporting checks, not a complete controlled native crash/reconciliation proof. A09 remains Pending for actual concurrent unrelated-work isolation. A10 has real GitHub import/dedup but lacks real signed Slack intake. A14 remains Pending: draft PR implementation is a separate dogfood increment; no real PR/merge/deploy closure is claimed. A16's historical full suite and exact candidate checks do not certify the latest changing integrated candidate.

### Current integration checkpoint — reusable profile skills

The integrated workspace-profile form now creates reusable skills inline using the existing workspace setting service and selects only workspace skills. Project skills remain project-scoped; legacy invalid references must be removed explicitly, never silently promoted. Backend profile create/update and dispatch share scope validation, so a reusable profile cannot leak project instructions into another project. A PostgreSQL regression verifies rejected create/update leaves persisted references intact and the same workspace skill is frozen into runs in two authorized projects.

After the UI/backend/import-test changes and this ledger consolidation, the frozen integration tree passed `pnpm test` with real disposable PostgreSQL: **132/132 tests across 23 files, zero skipped**, exit 0 (03:46:06; session `76210`). `pnpm typecheck`, `pnpm build` and `git diff --check` also passed. This is a current supporting integration checkpoint; browser profile editing, real imported-skill execution and the later dogfood candidate are separate acceptance steps. The active runtime was not restarted.
