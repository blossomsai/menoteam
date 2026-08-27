# Menoteam Work Map V1

Product and architecture specification. Agreed design as of August 27, 2026.

## 1. Purpose

Work Map gives a team of humans and their existing agents one maintained understanding of the work. Humans stay in Slack, Discord, or another channel they already use. Agents stay in their existing harnesses. Every participant can read and maintain the same Work Map through MCP.

The system adds three things:

1. A central Work Map that connects durable work, ownership, hierarchy, and dependencies.
2. One Living Doc for every Work Node and one concise Teammate Memory for every teammate.
3. A Master that answers from shared context or routes a request to the smallest relevant set of teammate agents.

The system does not run agents or manage their access to repositories and documents. It assumes each agent already has the access required to do its work.

## 2. First Principles

- **Existing channels are the interface.** A team should not have to move its conversation into a new collaboration app.
- **Existing agents are the actors.** Work Map does not replace Codex, Claude, Gemini, or another harness.
- **Shared context is central.** All agents read and write the same team-owned source instead of maintaining incompatible copies.
- **Ownership belongs to a human.** A model, harness, or agent address may change without changing who owns the work.
- **Master is a point of contact, not a manager.** It answers and routes; it does not delegate execution, supervise agents, or track their completion.
- **Humans retain authority.** Agents may recommend and maintain context, but humans confirm new ownership and can override any routing decision.
- **Less is more.** Work Node, Living Doc, and Teammate Memory are sufficient for V1. Additional planning entities require evidence that these three cannot carry the meaning.

## 3. V1 Boundaries

Work Map V1 includes:

- One trusted team per deployment.
- One central Work Map for the entire team, with projects and areas represented as graph branches.
- One default team agent per human, with a platform-specific address for each channel where that agent is reachable.
- One explicit Master point of contact.
- Remote MCP access for all agents.
- A read-only dashboard backed by the same central data.
- PostgreSQL persistence, revision history, export, backup, and self-hosted deployment.

Work Map V1 explicitly does **not** include:

- A Runner, Agent Bridge, compatibility adapter, hosted harness runtime, or background daemon on a teammate's computer.
- Agent creation, awakening, execution, scheduling, delegation, or completion tracking.
- Slack or Discord credentials stored by the Work Map service.
- Repository, GitHub, GitLab, or document access management.
- Background repository ingestion or automatic PR/deployment synchronization.
- Channel transcript ingestion or message history storage.
- Personal memory, private projects, or personal data.
- Working notes, supporting-note objects, or indexing of teammates' private documents.
- Separate Activity, Evidence, Forecast, Expertise, Candidate, or Workload domain entities.
- A writable dashboard, Kanban editing, drag-and-drop, forms, or dashboard status controls.
- Multi-team SaaS, per-user accounts, RBAC, or granular write permissions.
- Public REST, GraphQL, SDK, webhook, or MCP Resource APIs.
- Redis, Kafka, Elasticsearch, a graph database, a vector database, or microservices.

## 4. Participants

### Human

A teammate who asks questions, gives feedback, confirms ownership, and owns Work. A human may work across multiple projects and roles.

### Default Team Agent

The channel-native agent normally contacted for a human's Work. Each human has one logical default team agent, although its mention address may differ by platform. Changing the harness or address does not change Work ownership.

A human may mention any teammate agent directly. Master is the main shared point of contact, not a mandatory intermediary.

### Master

A channel-native agent with the Master Skill, Work Map access, and the team's ordinary repository and document access. Master is the main point of contact for shared questions and routing.

Master does not ask other agents to execute work. It mentions them so they can communicate directly with the human in the original thread.

### Work Map Service

The central, platform-neutral service that persists and exposes Team Ground Truth. It does not connect to Slack or Discord and does not know how to awaken an agent.

### Native Channel

Slack, Discord, or another communication platform where a supported harness can already be mentioned, awakened, and allowed to reply. V1 supports only these native channel capabilities; it has no fallback adapter.

## 5. Domain Model

### 5.1 Work Map

The Work Map is one team-wide graph. A project or area is a branch, not a separate map. This lets Master derive workload across projects and discover related ownership without introducing an org chart.

Graph relationships are intentionally limited to:

- **Parent/child:** one Work is part of a broader Work.
- **Dependency:** one Work depends on another Work.
- **Owner:** every Work has exactly one human owner.

### 5.2 Work Node

A Work Node represents a durable outcome or capability that deserves independent, lasting team context. If something does not deserve a Living Doc, it should normally remain part of an existing Work instead of becoming a new node.

Every Work Node contains:

- A stable reference and clear title.
- Exactly one human owner.
- The ownership source (`confirmed`, `inferred`, or `unresolved`) and a small
  set of human-readable evidence when ownership was inferred.
- `current` or `completed` state.
- An optional parent and zero or more dependencies.
- A concise current summary written in natural language.
- Exactly one Living Doc.
- A revision and timestamps.

`completed` means the currently committed scope is complete and no active effort remains. It is not an immutable terminal state. Master may reopen a completed Work when new effort continues the same durable outcome.

Work Nodes are not deleted or archived in V1. Completed Work remains durable, searchable, and available as context.

Ownership provenance is a field on Work, not a separate Evidence or Candidate
entity. A direct human assignment is `confirmed`. Repository history may
suggest `inferred` ownership, but commits and PRs do not prove accountability;
the dashboard labels that uncertainty until a human confirms or corrects it.
Changing the owner directly clears stale inference unless the caller supplies
new provenance for the new owner.

Master decides whether to reuse, reopen, or create a child Work:

- The same durable outcome reuses or reopens the existing Work.
- A separately ownable outcome with independent long-term context becomes a child Work.
- Something merely related does not count as an existing match.
- `v2`, `v3`, and similar names are used only when the product genuinely has an external version boundary.

This is a judgment encoded in the Master Skill, not a rigid server algorithm. When the choice is ambiguous, Master explains its recommendation and lets a human decide.

### 5.3 Living Doc

Every Work Node has exactly one Living Doc. It is the canonical, human-readable explanation of the Work and is rendered directly in the dashboard.

The Living Doc:

- Is stored separately from any private or temporary document a teammate creates while working.
- Is continuously rewritten to reflect the best durable understanding of the Work.
- Carries enduring context, decisions, expected behavior, progress, timeline, and relevant references in natural language when those facts matter.
- Remains useful after completion. If later work replaces an earlier truth, the document says what replaced it rather than becoming an abandoned legacy document.
- Is not an activity log or a container for working notes.

### 5.4 Teammate Memory

Each human has one team-readable Teammate Memory. It is a living summary of durable work-related context useful for routing, such as demonstrated strengths, recurring responsibilities, and relevant history.

Teammate Memory rules:

- Hard limit: 200 words.
- Preferred size: 120–180 words, but it may be shorter when little is known.
- Never invent content to fill space.
- Never include personal/private context.
- Do not duplicate current workload; derive workload from currently owned Work.
- Rewrite the summary as understanding changes; do not append a chronological log.
- All trusted agents may read and update it in V1.

### 5.5 Meaningful Progress

After making meaningful progress, an agent maintains shared context before ending the work session:

1. Update the Work Node summary when the current situation changed.
2. Update the Living Doc when durable understanding changed.
3. Update Teammate Memory only when durable routing context about a person changed.

Agents write coherent natural language. V1 does not split progress into Activity, Evidence, State, or Forecast records. Routine edits that do not change shared understanding require no update.

## 6. Master Behavior

### 6.1 Activation

Master acts only when explicitly mentioned as `@Master`. It ignores channel messages that do not mention it.

Every teammate agent follows the same activation principle: it responds when explicitly mentioned or routed to. This prevents passive surveillance and accidental agent loops.

### 6.2 Sufficiency Before Routing

When mentioned, Master first retrieves the smallest useful amount of shared context. It may read the Work Map, Living Docs, Teammate Memories, and its ordinary code/document sources.

Master then decides:

- **Enough information:** answer directly without mentioning another agent.
- **Partially enough:** answer the known portion and mention only the agents needed for identified gaps.
- **Not enough:** mention the smallest relevant set of agents and explain what each should clarify.

For example, "What has Alice worked on recently?" should normally be answered from Alice's owned Work, Teammate Memory, and recent repository evidence. Alice's agent is mentioned only when the answer is outside Master's visibility.

### 6.3 Existing Work

If a request clearly belongs to existing Work, Master routes unresolved questions or feedback to that Work's owner's default agent. Master may mention multiple agents when the request genuinely crosses Work boundaries, but each mention must name the missing information or perspective.

Mentioned agents reply directly in the original Slack or Discord thread. Master does not wait, aggregate, or track their completion. A human may later explicitly ask `@Master` to summarize the thread.

Agents may mention other agents only for a concrete information gap and must state that gap. They must not automatically mention each other back and forth.

### 6.4 New Work

When no suitable Work exists, Master:

1. Reads the nearest related graph branches.
2. Reads Teammate Memories and derives current workload from the Work Map.
3. Uses relevant commits, PRs, repositories, and documents available through its existing access.
4. Recommends one potential human owner and briefly explains why.
5. Lets a human confirm or override the recommendation.
6. Atomically creates the Work Node and its Living Doc only after confirmation.
7. Announces the new Work in the originating channel.

Direct assignment is also confirmation. If a human directly asks Alice's agent to own new Work, Alice's agent may create the Work with Alice as owner. If the assignment appears wrong or ambiguous, Alice's agent may mention Master for rerouting.

### 6.5 Conflicting Sources

The Work Map is Team Ground Truth, not an infallible oracle. Repository, PR, deployment, and business documents are external evidence that can reveal stale or incomplete shared context.

When sources conflict, Master:

- States the conflict instead of silently choosing a convenient source.
- Separates confirmed facts from unresolved interpretation.
- May update the Work Node or Living Doc when evidence proves a durable fact.
- Mentions the owner agent when the conflict concerns intention, timeline, product meaning, or another fact that evidence cannot settle.

A merged PR, for example, proves that code merged; it does not by itself prove that a feature shipped.

## 7. Channel Behavior

- The same Work Map may be accessed from Slack and Discord.
- A teammate record stores the default agent's platform-specific mention addresses.
- Master uses the address for the channel where the request originated.
- If an owner is known but their agent has no address in the current channel, Master says that routing is unavailable instead of pretending it succeeded.
- When new Work or an owner change originates in a channel, the acting agent announces it in that channel. Every successful change immediately appears in the dashboard.
- Routine Work Node, Living Doc, and Teammate Memory updates appear in the dashboard without a separate broadcast, unless an agent is naturally replying in the active thread.
- The Work Map service never stores channel tokens or posts channel messages; the channel-native agent makes the reply or announcement.

## 8. Dashboard

The V1 dashboard is read-only and renders the same central data exposed through MCP. Humans request corrections through Slack, Discord, or a teammate agent.

### Work View

- Graph/tree view of Work hierarchy and dependencies.
- List view for scanning, filtering, and searching the same Work.
- Current Work emphasized by default.
- Completed Work collapsed by default but searchable and durable.
- Node detail shows owner, state, current summary, parent, dependencies, revision time, and the full Living Doc.

### Team View

- Teammate name and reachable default-agent addresses.
- Current owned Work and workload derived from the Work Map.
- Full Teammate Memory.

V1 has no dashboard editing, Kanban board, forms, activity feed, working-note browser, or separate document library.

## 9. MCP Interface

All agents connect to the same remote Streamable HTTP endpoint:

```text
https://team.example.com/mcp
```

The server is stateless between tool requests. Durable state belongs in PostgreSQL, not in an MCP session or an agent process.

Entity references are stable, typed, opaque identifiers. Clients must not derive meaning or database structure from a reference.

### 9.1 Public Tools

#### `list(kind, filters, cursor?)`

Returns deterministic, paginated compact summaries. Every response includes
`total_count`, the full number of results matching the supplied filters,
independent of the current page.

- `kind`: `work` or `teammate`.
- Work filters: exact `title`, `parent`, `ancestor`, `owner`, `state`. `ancestor` includes
  the referenced Work root and every descendant in its parent hierarchy;
  `parent` remains an exact immediate-parent filter.
- Work results include reference, title, owner, owner source, state, graph
  relationships, current summary, `subtree_count` (the Work itself plus all
  descendants), update time, and revision. Full owner evidence stays in `read`
  so compact enumeration does not repeat repository history. `total_count`
  counts filter matches; it is not a branch size unless the filter itself uses
  `ancestor`.
- Teammate results include reference, name, and available default-agent addresses; full memory is returned only by `read`.

#### `search(query, cursor?)`

Returns relevance-ranked compact Work and teammate results with `total_count`
for the full matching result set. V1 uses PostgreSQL full-text search and
trigram similarity. The agent performs semantic judgment over the returned
summaries; V1 does not maintain embeddings or a vector database.

#### `read(ref)`

Returns one complete entity:

- Work reference: Work Node and its Living Doc together.
- Teammate reference: default-agent addresses and complete Teammate Memory.

#### `create_work(...)`

Atomically creates one Work Node and its required Living Doc at revision 1. It
may record owner source and compact evidence; omitted provenance means a
confirmed direct assignment. Human confirmation is a Master/Team Agent Skill
behavior, not a second server-side workflow object.

#### `update_work(ref, expected_revision, changes)`

Updates owner and its provenance, state, graph relationships, current summary,
and/or Living Doc in one transaction. The update succeeds only when
`expected_revision` matches the current revision.

#### `update_teammate(ref, expected_revision, changes)`

Creates or updates a teammate record, including display name, default-agent addresses, and/or Teammate Memory. `expected_revision: 0` creates a missing reference; an existing teammate requires its current revision. The server rejects duplicate identities, memory over 200 words, and outdated revisions.

### 9.2 Concurrency

Reads return a revision. Updates provide that revision as `expected_revision`. If another agent wrote first, the server rejects the stale update. The agent must read the latest content, reconcile the changes, and try again.

This optimistic concurrency rule prevents an old Living Doc or Teammate Memory from silently overwriting newer Team Ground Truth.

### 9.3 Public Compatibility Surface

The only stable V1 public interfaces are:

1. The six MCP tool schemas and their structured results.
2. A versioned JSON/Markdown export format.

Dashboard `/api/*` routes and the PostgreSQL schema are internal implementation details. V1 does not promise public REST, GraphQL, SDK, webhook, or MCP Resource compatibility.

V1 exposes no delete or archive tool.

## 10. Skills

### Master Skill

Installed only on Master. It defines explicit activation, sufficiency checking, direct answering, routing, owner recommendation, human confirmation, Work creation, conflict handling, and channel announcements.

### Team Agent Skill

Installed on each default team agent. It defines explicit activation, relevant context retrieval, same-thread replies, direct-assignment handling, and maintenance of Work Node, Living Doc, and Teammate Memory after meaningful progress.

Every Team Agent treats MCP content as team-visible. It must keep personal and private-project context out of Work Map writes even when its harness can access that information.

Skills contain judgment and interaction policy. MCP stores and retrieves shared truth. The database does not attempt to encode Master reasoning.

## 11. Technical Architecture

Work Map is a stateless modular monolith:

```text
                         /mcp
Native agents ── HTTPS ───┐
                          ├── TypeScript/Fastify service ── PostgreSQL
Humans ──────── HTTPS ────┤
                         /dashboard
```

The deployable application contains:

- The official MCP TypeScript SDK and Streamable HTTP handler.
- Fastify HTTP serving, validation, and security middleware.
- One domain/service layer used by MCP and the dashboard.
- A read-only React/Vite dashboard compiled into the same application image.
- PostgreSQL access and versioned SQL migrations.

The application is horizontally scalable behind a load balancer because request handlers hold no authoritative state. PostgreSQL is the sole data store.

PostgreSQL stores current entities, relationships, full-text indexes, and revision snapshots. Parent/child relationships use a foreign key; dependencies use a relationship table. Living Docs remain Markdown text. No graph database or document store is required.

The minimal logical storage model is:

```text
works
- ref, title, owner_teammate_ref, state
- parent_ref, current_summary, living_doc_markdown
- revision, created_at, updated_at

work_dependencies
- work_ref, dependency_ref

teammates
- ref, display_name, agent_addresses
- memory, revision, created_at, updated_at

entity_revisions
- entity_kind, entity_ref, revision
- full_snapshot, created_at
```

Foreign keys and uniqueness constraints protect graph and identity integrity. Search indexes cover Work titles, summaries, Living Docs, teammate names, and Teammate Memories.

Redis is added only if a proven cross-node subscription or event-delivery requirement appears. V1 channel awakening and replies remain native to Slack/Discord agents, so no broker or background worker is required.

## 12. Security Boundary

V1 defers user accounts, RBAC, and per-agent permissions, but it does not expose an unprotected internet write endpoint.

- `MCP_API_KEY`: instance-level bearer credential used by agents for MCP read/write access.
- `DASHBOARD_PASSWORD`: separate instance-level credential that grants only read-only dashboard access.
- Dashboard sessions are stateless eight-hour `HttpOnly; SameSite=Strict` cookies. The cookie contains a versioned expiry, random nonce, and HMAC signature; its signing key is derived from `DASHBOARD_PASSWORD` with a domain-separated context, so replicas with the same password can verify it without shared session storage. Restart does not revoke valid cookies. Logout clears only the current browser; rotate `DASHBOARD_PASSWORD` to revoke cookies if one is stolen.
- TLS is required outside a private network.
- The server validates origins/hosts, validates every tool input, applies request-size limits, and rate-limits remote access.
- Database credentials remain server-side.
- Personal data and private project context must never be written into Team Ground Truth.
- Every connected agent uses the same trusted-team read/write capability in V1; the service does not pretend this is actor-level authorization.

This is soft trusted-team isolation, not a complete authorization system.

## 13. Persistence, Revisions, and Recovery

Durability has three distinct layers:

### Revision History

Every successful Work or teammate update stores an immutable full snapshot for that revision. Revisions are retained indefinitely in V1 and allow recovery from mistaken edits. Revision history is not modeled as an Activity feed.

### Export

An operator command exports a versioned JSON representation and human-readable Markdown. Export supports portability and review; it is not an MCP tool and is not a database backup.

### PostgreSQL Backup

The distribution provides documented `backup` and `restore` commands using PostgreSQL's standard dump and restore tools. The official instance schedules verified backups. Self-hosted teams connect the same command to their scheduler or use their managed PostgreSQL backup system.

Database migrations:

- Are versioned and forward-only.
- Run under a PostgreSQL advisory lock so only one application replica migrates at a time.
- Refuse to start an older application against a newer unsupported schema.
- Require an operator backup before a major upgrade.
- Rely on backup restoration rather than promising that arbitrary schema changes can be safely reversed.

## 14. Open-Source Distribution

The entire deployable stack is licensed under Apache-2.0:

- Server and dashboard.
- MCP schemas and handlers.
- Master and Team Agent Skills.
- Database migrations.
- Docker and deployment configuration.

The official instance and self-hosted deployments run the same artifact. V1 is not open-core and does not depend on a private hosted control plane.

Published releases provide:

- A pinned, versioned container image.
- `docker-compose.yml` with PostgreSQL for a simple deployment.
- `DATABASE_URL` support for teams using managed PostgreSQL; this remains the same PostgreSQL code path.
- `.env.example`, health checks, migration handling, backup/restore commands, and upgrade notes.
- Master and Team Agent Skills in directly installable folders.
- Example MCP configuration using the deployment URL and secret API key.

A team should be able to deploy the service, connect its agents, and initialize teammate records without modifying source code.

## 15. Acceptance Scenarios

V1 is complete only when these flows work end to end:

1. **Direct answer:** A human asks `@Master what is Alice working on?`; Master answers from shared context without mentioning Alice's agent.
2. **Existing Work routing:** A human gives feedback on an existing feature; Master identifies its owner and mentions that owner's reachable agent in the same thread.
3. **Partial answer:** Master answers the known portion and mentions two agents only for two clearly stated information gaps.
4. **New Work:** Master finds no existing Work, recommends one owner using related Work, memory, workload, and external evidence, waits for human confirmation, then creates the Work and Living Doc atomically.
5. **Direct assignment:** A human assigns new Work directly to Alice's agent; the agent creates it with Alice as owner or asks Master to resolve ambiguity.
6. **Meaningful progress:** An agent changes the current summary and Living Doc without creating an Activity record or working note.
7. **Reopen or child:** Master reopens the same durable Work for a continuation and creates a child only for a separately ownable outcome.
8. **Concurrency conflict:** Two agents edit the same Living Doc; the stale update is rejected and no content is silently lost.
9. **Conflicting evidence:** A PR is merged while the Work remains current; Master reports what is confirmed, does not claim deployment, and requests owner clarification when needed.
10. **Missing channel address:** Master identifies the owner but states that routing is unavailable in the current platform.
11. **Dashboard:** A human can browse graph and list views, read every Living Doc, inspect team context, and cannot mutate data.
12. **Self-hosting:** A second team launches the published application and PostgreSQL containers, connects MCP clients, installs the Skills, and creates its independent Work Map.
13. **Recovery:** An operator exports data, backs up PostgreSQL, restores the deployment, and sees identical current entities and revision history.

## 16. Deferred Until Proven Necessary

- Multi-team hosted SaaS and tenant isolation.
- User accounts, OAuth, RBAC, and authenticated actor attribution.
- Per-field or per-project permissions.
- Dashboard editing and PM workflow controls.
- Automatic repository, PR, deployment, or document synchronization.
- Agent scheduling, execution, supervision, and completion tracking.
- Cross-channel notification fan-out.
- MCP subscriptions, Resources, prompts, or additional tool families.
- Semantic embeddings, vector search, graph databases, and recommendation services.
- Public application APIs beyond MCP and export.

These are not hidden V1 requirements. Each requires a concrete use case before entering the product.
