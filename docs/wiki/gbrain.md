# GBrain

Source snapshot: local `gbrain 0.42.51.0` CLI inspected on 2026-06-29.

## What It Is

GBrain is a personal knowledge brain. It stores pages, files, links, timelines, tags, code indexes, transcripts, reports, jobs, and multi-source knowledge. It can query with hybrid retrieval, serve as an MCP server, and stream relevant pages into agent context through watch mode.

For Menoteam, GBrain is best understood as memory substrate, not product shape.

## Methodology

GBrain treats personal knowledge as a local or remote brain with structured operations:

- pages with frontmatter and markdown content
- full-text and hybrid search
- embeddings and multi-query expansion
- tags, backlinks, graphs, timelines
- multi-source sync across repos / brains
- code symbol indexing and graph traversal
- files and storage routing
- transcript salience and anomaly tools
- capture / brainstorm / lateral idea generation
- background jobs
- MCP serving for agents
- push-based context volunteering with `watch`

The methodology is "durable searchable substrate." It does not decide what the user should value, but it makes prior knowledge retrievable.

## API And Interface

Setup:

```bash
gbrain init
gbrain doctor --fast --json
```

Pages:

```bash
gbrain get <slug>
gbrain put <slug>
gbrain list
gbrain delete <slug>
```

Search:

```bash
gbrain search <query>
gbrain query <question>
gbrain ask <question>
```

Useful query options:

- `--limit`
- `--detail low|medium|high`
- `--lang`
- `--symbol-kind`
- `--near-symbol`
- `--walk-depth`
- `--source-id`
- `--since`
- `--until`
- `--salience`
- `--recency`
- `--cross-modal`
- `--adaptive-return`
- `--autocut`
- `--relational`

Sync:

```bash
gbrain sync --repo <path>
gbrain sync --watch --interval N
gbrain sync --all
gbrain sync --strategy code
```

Code indexing:

```bash
gbrain code-def <symbol>
gbrain code-refs <symbol>
gbrain code-callers <symbol>
gbrain code-callees <symbol>
gbrain reindex-code
```

Agent-facing context:

```bash
gbrain serve
gbrain serve --http --port N
gbrain watch --json
gbrain --tools-json
```

`gbrain watch` reads conversation turns and volunteers relevant pages with confidence-gated rationales. The MCP server exposes tools such as get page, put page, list pages, search, query, tags, and image search.

## Use Cases

- Long-term personal memory for projects and decisions.
- Repository and code-symbol recall.
- Agent-accessible knowledge through MCP.
- Multi-source workspace knowledge across repos.
- Local transcript lookup and salience / anomaly detection.
- Brainstorming by combining retrieved context with lateral search.
- Durable reports, notes, and exported markdown.

## Pros

- Rich retrieval surface.
- Works as CLI and MCP.
- Supports both polished pages and recent transcript/salience signals.
- Code indexing makes it better than generic vector memory for engineering.
- Multi-source support maps well to a person with many projects.
- Watch mode can volunteer context without requiring every agent to search manually.
- Soft delete, restore, history, lint, doctor, and health commands show operational maturity.

## Cons And Risks

- It is a substrate, not a workflow.
- Retrieval quality depends on sync freshness, source scoping, and embeddings.
- PGLite single-writer constraints can matter for concurrent agent use.
- Too many commands and modes can overwhelm a product surface.
- Memory can become a junk drawer if capture lacks evaluation.
- Search can find context, but it cannot decide what matters.

## What Menoteam Should Learn

- Memory should support pages, code, transcripts, files, links, and graph edges.
- Agents need both pull search and push context.
- Source scoping is important. A person's projects are not one flat pile.
- Code-symbol retrieval is critical for engineering autonomy.
- Salience and recency are different axes from semantic relevance.
- MCP serving lets existing agents use the brain without native integration.
- Capture and sync should be boring, incremental, and inspectable.

## What Menoteam Should Avoid

- Do not become a memory app.
- Do not make users manage memory taxonomy before they get value.
- Do not assume retrieval equals alignment.
- Do not write all philosophy into unstructured pages without evaluation.
- Do not let stale memory silently guide autonomous work.
- Do not hide source boundaries.

## Strategic Implications

GBrain can be Menoteam's long-term memory layer:

```text
Menoteam philosophy / goals / traces / reflections
  -> stored as pages, links, timelines, and source-scoped records
  -> retrieved through GBrain or similar substrate
  -> injected into future agent work
```

But Menoteam needs an opinionated layer above memory:

- what gets remembered
- what gets revised
- what counts as a standard
- what evidence changed a belief
- when memory should be ignored
- how a trace becomes future judgment

## Product Questions For Menoteam

- Should GBrain be an optional connector or the default memory substrate?
- What Menoteam objects should map to pages: philosophy, goals, decisions, traces, evaluations, reflections?
- How should stale or contradicted memory be marked?
- Can `gbrain watch` be used as a low-friction context injection mechanism for Codex / Claude Code / Hermes?
- What memory write policy prevents junk accumulation?
