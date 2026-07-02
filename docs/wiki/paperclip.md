# Paperclip

Source snapshot: [paperclipai/paperclip](https://github.com/paperclipai/paperclip), checked at `e6407b3` from 2026-06-28, plus [paperclip.ing](https://paperclip.ing/), [SPEC.md](https://github.com/paperclipai/paperclip/blob/master/doc/SPEC.md), [ROADMAP.md](https://github.com/paperclipai/paperclip/blob/master/ROADMAP.md), and plugin / API docs.

## What It Is

Paperclip is an open-source control plane for running teams of AI agents as a company-like system. It does not try to be the agent runtime. It coordinates agents that already exist, such as Claude Code, Codex, Cursor, OpenClaw, Hermes, CLI scripts, HTTP workers, and other webhook-capable tools.

Its core product claim is operational: define a business goal, hire a team, approve the strategy, set budgets, then let agents work through tickets, heartbeats, and monitored execution.

## Methodology

Paperclip's world model is "company as control plane."

The key objects are:

- Company: the top-level isolation and operating object.
- Board: the human governance surface with override power.
- Agent: an employee with role, title, reporting line, adapter config, permissions, and budget.
- Goal / initiative: the reason work exists.
- Issue / task: the executable work object.
- Heartbeat: the wake-up mechanism that causes an agent to check context and act.
- Budget: the hard operational bound on token / LLM spend.
- Governance: approval gates, strategy review, pause / resume / terminate, and rollback.
- Activity / audit log: durable record of actions, comments, cost events, approvals, and work products.
- Skill: procedural knowledge installed into a company and materialized into agent workspaces.
- Plugin: instance-wide extension package for connectors, workspace tools, automation, or UI surfaces.

The central design move is that work does not float as chat. Work is attached to company, project, goal, task, owner, cost, run, and audit trail.

## API And Interface

Paperclip exposes a RESTful JSON API. Company-scoped endpoints carry `:companyId` in the path. Mutating requests during heartbeats include an `X-Paperclip-Run-Id` header so writes can be traced to a run.

Notable API surfaces:

- Auth: agent API keys and short-lived run JWTs injected as `PAPERCLIP_API_KEY`.
- Dashboard: company health summary for stale tasks, costs, and agent situational awareness.
- Routines: `GET /api/companies/{companyId}/routines`, `POST /api/companies/{companyId}/routines`, manual runs, schedule / webhook / API triggers.
- Costs: cost event ingestion, summaries by agent / project, budget thresholds, 80 percent warnings, 100 percent hard stops.
- Skills catalog: read-only catalog endpoints.
- Company skills: install, import, create, update, delete, fork, versions, update-status, reset, audit, stars, comments.
- Secrets: company-scoped encrypted secrets, vault configuration, health checks, import preview / import, and run-time injection.
- Plugins: manifest-declared capabilities, scoped routes under `/api/plugins/:pluginId/api/*`, worker-side host RPC calls, UI contributions.

The quickstart is intentionally one command:

```bash
npx paperclipai onboard --yes
```

Local mode uses embedded Postgres and local files. Production can point to external Postgres and custom deployment.

## Use Cases

- Solo operator coordinating many coding, marketing, support, research, and ops agents.
- Autonomous company simulation where agents have roles, reporting lines, recurring duties, and budgets.
- Long-running routine work, such as daily reports, weekly audits, content batches, code maintenance, and monitoring.
- Multi-company experimentation, where one Paperclip deployment manages several isolated ventures.
- Agent workforce dashboard where the user wants phone-friendly visibility and manual override.

## Pros

- Clear mental model. The company metaphor makes autonomy legible to non-agent experts.
- BYO agent. Paperclip does not force a single runtime.
- Goals flow into tasks. The agent sees why a task exists, not only the task body.
- Heartbeats create continuity without requiring a permanently running agent loop.
- Budget hard stops make runaway autonomy visible and bounded.
- Tickets and audit logs make work traceable.
- Skills store treats procedural knowledge as managed company material, with provenance, versions, drift checks, and trust levels.
- Plugin architecture aims to keep core governance intact while adding capabilities.

## Cons And Risks

- Org chart-first modeling can hard-code management bureaucracy too early.
- "Company" is a strong metaphor. It can hide cases where the right shape is a personal operating philosophy, a goal graph, or a lightweight agent ritual.
- The control plane is thick: identity, budgets, tasks, skills, routines, plugins, secrets, audit, storage, and UI.
- The visible product can become the ontology. Once the UI is a company dashboard, users may optimize for managing agents rather than shaping judgment.
- Access control and plugin trust are hard. Paperclip's plugin spec names current caveats around same-origin UI, local filesystem persistence, single-node assumptions, and cloud-readiness.
- The agent inner loop is delegated to adapters. This is a strength, but it means Paperclip does not solve agent judgment by itself.

## What Menoteam Should Learn

- Make work traceable across goals, actions, artifacts, evaluations, and reflections.
- Autonomy needs budget, pause, override, and audit primitives.
- A system can support many runtimes without owning them.
- Procedural knowledge should have lifecycle: install, fork, version, audit, reset, update.
- Heartbeats are a useful pattern for "continue when there is enough context."
- Explicit governance is not anti-autonomy. It is what lets autonomy be trusted.
- Portable templates matter, but they should carry philosophy and standards, not only org structure.

## What Menoteam Should Avoid

- Do not make org chart the first object.
- Do not turn a person's taste into a role hierarchy.
- Do not make the dashboard the product.
- Do not imply that every agent needs a title, boss, or reporting line.
- Do not copy a full REST control plane before the real primitive is proven.
- Do not treat tasks as the deepest unit. For Menoteam, task traces should sit under philosophy, judgment, and goal formation.

## Strategic Implications

The user corrected an important point: if the person is treated as the company, Menoteam must follow the person. So Menoteam should not reject "company" completely. It should reject org chart as the default inner model.

Useful translation:

```text
Paperclip company -> Menoteam person's operating world
Paperclip board -> human responsibility and taste
Paperclip goal -> philosophy-derived goal
Paperclip heartbeat -> justified continuation
Paperclip audit -> trace and reflection substrate
Paperclip skill store -> procedural standard library
Paperclip budget -> attention / money / risk boundary
```

The key strategic move is to keep Paperclip-like operational seriousness while replacing org structure with philosophy structure.

## Product Questions For Menoteam

- What is the smallest object that can hold a goal, its reason, its standard, its evidence, and its trace?
- Can a "company" be modeled as a person's living operating context rather than an org chart?
- What is the Menoteam version of a heartbeat that checks not only "what task is next" but "is continued action still justified"?
- How much governance can be inferred from taste and boundaries before the user must configure explicit policy?
- Should Paperclip be a connector target, a competitor, or a source of compatible concepts?
