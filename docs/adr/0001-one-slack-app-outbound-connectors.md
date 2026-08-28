---
status: accepted
---

# Use one Slack app with a central Gateway and outbound local Connectors

Menoteam uses one centrally operated Slack app and Agent Gateway. The default
Master is an always-on Hermes agent, while each opt-in teammate Codex connects
through its own outbound-only Connector and per-endpoint credential. This
preserves visible logical speakers without consuming one Slack app per
colleague, keeps Slack secrets off agent computers, and accepts that a sleeping
or powered-off computer makes that endpoint unavailable. Claude remains a
future adapter, not a claimed V1 capability.
