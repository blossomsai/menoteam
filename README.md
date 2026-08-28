# Menoteam

Shared context and opt-in local agent routing for a team of humans and their existing AI agents.

The repository contains two deliberately separate services:

- **Work Map** is durable Team Ground Truth: Work, ownership, Living Docs, and Teammate Memory.
- **Agent Gateway** is optional real-time transport: one Slack app routes explicit requests to online local Connectors and returns labeled replies.

Work Map is a small, self-hosted service that keeps three things together:

- a graph of owned Work and its dependencies;
- one maintained Living Doc for each piece of Work;
- short Teammate Memory that helps the Master suggest an owner when none exists.

Any MCP-capable harness can read and update the same map. In the default Agent
Network, one always-on Hermes Master answers the team's single Slack bot and may
route one precise gap to an online colleague's Codex Connector. Work Map itself
does not run agents, connect to chat platforms, or copy private agent memory.

## What Work Map V1 includes

- six authenticated Streamable HTTP MCP tools: `list`, `search`, `read`,
  `create_work`, `update_work`, and `update_teammate`;
- PostgreSQL storage with forward-only migrations;
- a read-only list, graph, and detail dashboard;
- a Master Skill and a Team Agent Skill;
- Docker Compose self-hosting and backup/restore commands;
- a Safe Driver Plan importer that derives Work from the latest main branch and
  uses repository history as owner evidence.

## Start

Requirements: Docker with Compose and three separate high-entropy secrets:
database, MCP, and dashboard credentials.

```bash
cp .env.example .env
# Replace every placeholder in .env and add:
# APP_IMAGE=ghcr.io/e2023/menoteam-work-map:v0.1.1
docker compose pull app
docker compose up -d --no-build
```

This is the published-image path for a new team. Use the source-build flow in
the [self-hosting guide](docs/self-hosting.md) only when you deliberately want
to run locally reviewed source.

Open `http://127.0.0.1:3000/dashboard`, then follow:

1. [Self-host Work Map](docs/self-hosting.md)
2. [Set up one Slack app, Master, and each Codex](docs/agent-network-v1.md)
3. [Advanced: connect other native harnesses](docs/connect-agents.md)
4. [Read the V1 product and architecture spec](docs/work-map-v1-spec.md)

Every teammate Codex installs the same team plugin but receives its own endpoint
token. Hermes Master uses the small connector in `connectors/hermes/` on a
separate always-on macOS or Linux host. A sleeping teammate computer simply
appears offline.

Do not expose the service directly to the public internet. Put HTTPS and access
control in front of it, and treat the shared MCP key as full team read/write
authority. The dashboard password is separate and read-only. Slack credentials
belong only on the central Agent Gateway.

## Scope

Work Map V1 deliberately has no agent runner, hosted control plane, per-user
RBAC, working-note entity, or Slack/Discord adapter. The optional Agent Gateway
is a sibling bounded context: it transports explicit requests but does not own
Work, copy private memory, or write activity logs into Work Map.

The broader Menoteam worldview is preserved in the
[manifesto](docs/worldview-manifesto-v0.1.md), [idea bank](docs/idea-bank.md), and
[reference wiki](docs/wiki/README.md). The canonical product language is in
[`CONTEXT-MAP.md`](CONTEXT-MAP.md).

## License

Apache License 2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
