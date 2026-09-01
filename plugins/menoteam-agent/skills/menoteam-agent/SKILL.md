---
name: menoteam-agent
description: "Pair, verify, remove, or troubleshoot this host's opt-in Menoteam Connector. Use when the user asks to connect this Codex to Menoteam or check its connector status."
license: "Apache-2.0"
---

# Menoteam Agent Connector

This plugin is the installable package. Its Connector script is the explicit local process that makes Codex reachable. Installing the plugin alone does not start a daemon and does not expose the user's current Desktop chat.

## Safety boundary

- Prefer Gateway device pairing. Generate connector credentials locally, send only their SHA-256 digests to Gateway, and display only the short approval code.
- Accept only an HTTPS Gateway URL, except `http://localhost` for local testing.
- Keep the endpoint token in the host's secret mechanism or process environment. Never write it into the repository, a prompt, Slack, or a tracked config file.
- The Connector makes outbound requests only. Do not open a local inbound port or give it a Slack app/bot token.
- The linked Codex thread runs with a `read-only` sandbox. Approval requests are sent to Codex auto-review so bounded MCP calls can proceed without an unattended human prompt; the Connector itself rejects interactive requests.
- One endpoint maps to one dedicated resumable Codex thread. Never claim this is the user's foreground Desktop chat or that unsaved UI state is inherited.
- Codex inherits this host's Codex account/config, MCP registrations, skills, repository instructions, and permitted environment. It does not inherit another person's private state.
- Route at most one hop. Do not let an agent automatically call another agent from a Gateway-originated request.

## Install or verify

Locate the plugin root from this `SKILL.md`. The setup launcher is at `../../scripts/setup.sh`, the Connector is at `../../scripts/connector.mjs`, and the self-check is at `../../scripts/self-check.mjs`.

1. Run the self-check without secrets.
2. Confirm the exact HTTPS Gateway URL and intended repository directory with the user. This explicit local repository confirmation is required.
3. Run the pairing command from the intended repository:

```bash
/absolute/path/to/plugin/scripts/setup.sh connect \
  --gateway-url https://agents.example.com \
  --repository-cwd /absolute/path/to/repository
```

4. Report the verification URL, short approval code, and confirmed repository path. Wait while an admin approves that exact code. Never display or inspect the locally generated connector or Work Map proxy token.

Pairing always creates a teammate Codex endpoint. It cannot create or promote a Master. The default architecture uses the separate Hermes Master Connector. Legacy operator handoff installation remains available only for existing deployments and deliberate Master setup.

Check status with `../../scripts/setup.sh status --endpoint <assigned-id>`. A successful local service start is not proof of Gateway presence; confirm real readiness from the Gateway admin page or Master's `list_agent_endpoints`, then route one harmless read-only question and verify that the labeled answer appears in the original Slack thread.

To remove only the local runtime, run `../../scripts/setup.sh uninstall --endpoint <assigned-id>`. This keeps Codex and the plugin installed.

## What to report

Report these proofs separately:

1. Plugin installed and visible after a new Codex session starts.
2. Connector process running with a healthy outbound Gateway poll.
3. Endpoint shown online by the Gateway.
4. One harmless request resumed the dedicated local Codex thread.
5. The Gateway posted the labeled reply into the original allowlisted Slack thread.

Do not treat any one proof as evidence of the others. If the computer sleeps, shuts down, or stops the Connector, the endpoint is offline.
