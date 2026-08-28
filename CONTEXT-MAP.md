# Context Map

## Contexts

- [Work Map](./CONTEXT.md) — maintains durable Work, ownership, Living Docs, and Teammate Memory
- [Agent Gateway](./src/gateway/CONTEXT.md) — transports explicit Slack requests to opt-in local agent sessions and returns labeled replies

## Relationships

- **Master → Work Map**: Master reads and updates durable team context through the Work Map MCP service.
- **Master → Agent Gateway**: Master uses the separate Gateway MCP service only when a human-visible request has a concrete information gap for one online Agent Endpoint.
- **Agent Gateway → Work Map**: No direct dependency. Routing traffic, presence, prompts, and replies are not Work Map records.
- **Agent Gateway → local harness**: A Local Connector polls outbound for one Agent Endpoint and resumes its own Linked Session.
