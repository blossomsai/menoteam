# Menoteam Agent Gateway

Menoteam Agent Gateway is the team's real-time, opt-in transport between one Slack app and explicitly connected local agent sessions. It exists to route bounded human-visible requests without turning Work Map into a runner or copying private agent memory into a central service.

## Language

**Agent Gateway**:
The one central transport that accepts verified Slack mentions, routes one-hop requests, tracks fresh presence, and posts labeled replies.
_Avoid_: Master server, control plane, Work Map runner

**Local Connector**:
An outbound-only process on a teammate's computer that authenticates one Agent Endpoint and resumes its Linked Session.
_Avoid_: Slack bot, remote shell, daemon plugin

**Agent Endpoint**:
A configured, authenticated address for one teammate-and-harness pairing, such as `alice-codex`.
_Avoid_: User account, Slack app, model instance

**Linked Session**:
The one resumable local harness thread reserved for requests received by an Agent Endpoint.
_Avoid_: Current chat, foreground Desktop thread, universal memory

**Master Endpoint**:
The single Agent Endpoint that receives explicit Slack mentions first and may route one precise gap through the Gateway MCP tools.
_Avoid_: Manager, autonomous orchestrator, supervisor

**Presence**:
A short-lived observation that a Local Connector recently polled or is handling one request.
_Avoid_: Availability promise, employee status, uptime record

**Speaker Label**:
The human-readable logical identity prepended to a reply posted by the one shared Slack bot.
_Avoid_: Slack bot identity, impersonation, separate app
