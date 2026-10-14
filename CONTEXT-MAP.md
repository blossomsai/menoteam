# Context map

Updated 2026-10-06. Distinguish current product direction from implemented service contracts.

## Current product knowledge

[PRODUCT.md](PRODUCT.md) is the current direction. [Requirements](docs/personal-workspace-requirements.md) and [screen contract](docs/personal-workspace-mvp-screens.md) define the multi-project Master workbench. Work has a current Overview, artifacts/QA, and a shared Agent/Master/subagent conversation. Work Map does not require a standalone graph UI or a fixed form. Project instructions and workspace profiles/providers are separate scopes.

## Existing implementations

- [Work Map V1](CONTEXT.md): durable Work Nodes, human ownership, Living Docs and Teammate Memory. These are existing API/storage terms, not mandatory new UI entities.
- [Agent Gateway V1](src/gateway/CONTEXT.md): explicit opt-in routing to local agent sessions. It does not prove autonomous project coordination.
- [Local execution experiment](docs/local-workspace.md): separate port-4311 prototype and runner.
- [V3 design prototype](docs/prototypes/2026-10-02/team-workbench-v3/README.md): port 4313, sample data, no real execution/integrations.

V1 Master → Work Map/Gateway relationships remain service contracts. Future Master scheduling, source intake, settings modification and skills installation require explicit implementation design; do not infer them from static UI or rewrite service behavior through documentation alone.
