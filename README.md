# Menoteam Work Map

One shared source of truth for a team of humans and their existing AI agents.

Work Map is a small, self-hosted service that keeps three things together:

- a graph of owned Work and its dependencies;
- one maintained Living Doc for each piece of Work;
- short Teammate Memory that helps the Master suggest an owner when none exists.

Any MCP-capable harness can read and update the same map. A channel-native
Master in Discord or Slack can answer from that shared context or route a
specific gap to the relevant human's agent. Work Map itself does not run agents,
connect to chat platforms, or copy private agent memory.

## What V1 includes

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
# Replace every placeholder in .env, then:
docker compose up -d --build
```

Open `http://127.0.0.1:3000/dashboard`, then follow:

1. [Self-host Work Map](docs/self-hosting.md)
2. [Connect existing agents and Discord](docs/connect-agents.md)
3. [Read the V1 product and architecture spec](docs/work-map-v1-spec.md)

Do not expose the service directly to the public internet. Put HTTPS and access
control in front of it, and treat the shared MCP key as full team read/write
authority. The dashboard password is separate and read-only. Discord bot tokens
remain only in the selected channel-native harness.

## Scope

V1 deliberately has no agent runner, hosted control plane, per-user RBAC,
working-note entity, or Slack/Discord adapter. Existing harnesses own model
sessions and channel delivery; Work Map owns shared context.

The broader Menoteam worldview is preserved in the
[manifesto](docs/worldview-manifesto-v0.1.md), [idea bank](docs/idea-bank.md), and
[reference wiki](docs/wiki/README.md). The canonical product language is in
[`CONTEXT.md`](CONTEXT.md).

## License

Apache License 2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
