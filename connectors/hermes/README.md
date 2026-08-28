# Hermes Master Connector

This adapter connects one always-on local Hermes agent to the central Menoteam
Gateway. It does not connect Hermes directly to Slack.

```bash
./setup.sh install --config /secure/path/master-hermes.env \
  --repository-cwd /absolute/path/to/repository

./setup.sh status --endpoint master-hermes
```

The background service starts Hermes Gateway with an authenticated API bound to
loopback, then uses Hermes' named Responses conversation for durable Master
context. Work Map and Agent Gateway are configured as Hermes MCP servers.

See [Agent Network quickstart](../../docs/agent-network-v1.md) for the central
operator and teammate steps.
