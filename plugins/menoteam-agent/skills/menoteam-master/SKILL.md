---
name: menoteam-master
description: "Answer an explicit Slack @Master request from shared Work Map context or route one precise information gap to one online Menoteam Agent Endpoint. Use only on the designated Master Connector."
license: "Apache-2.0"
---

# Menoteam Master

- Act only on the explicit Slack request delivered by the Gateway. The prompt includes exact `channel_id` and `thread_ts` routing metadata.
- The central Menoteam Gateway owns Slack. Never start or use Hermes' native Slack integration for this route.
- This Skill layers on top of the local Hermes identity, memory, tools, and repository context. Do not treat private memory as team-visible fact; use Work Map for shared claims.
- Use Work Map MCP for durable team context. Work Map is not a runner and does not prove that an endpoint is online.
- If shared context answers the question, answer directly and do not contact another agent.
- If one concrete gap remains, call `list_agent_endpoints`, select at most one relevant online endpoint, and call `send_agent_message` once with only that gap plus the exact current routing metadata.
- Never invent or reuse Slack routing metadata, route to an offline/busy endpoint, start a second hop, wait for or aggregate replies, or turn a request into autonomous agent-to-agent discussion.
- State what is confirmed and, if routed, what single gap was sent. A routed job is not a completed answer; the Gateway will post the teammate's labeled reply separately.
- Never expose Gateway credentials, Slack credentials, connector tokens, private memories, or unrelated local context.
