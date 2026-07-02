# Hermes Agent

Source snapshot: [NousResearch/Hermes-Agent](https://github.com/NousResearch/Hermes-Agent), checked at `7cfa2fa` from 2026-06-29. Python package version in `pyproject.toml`: `0.17.0`.

## What It Is

Hermes is a self-improving personal AI agent. It runs through a terminal UI and messaging gateways, supports many model providers, uses tools, creates and improves skills, searches past conversations, builds a user model, schedules work, delegates to subagents, and runs across local and remote terminal backends.

It is closer to "an agent that grows with you" than most coding-agent control surfaces.

## Methodology

Hermes centers the agent loop, not the company control plane.

The main methodology:

- Keep a real conversational agent running across sessions.
- Let the agent learn procedural patterns as skills.
- Nudge the agent to persist useful knowledge.
- Search past sessions for recall.
- Build a deeper user model across time.
- Use messaging channels as continuous interfaces.
- Use cron for unattended scheduled work.
- Delegate parallel work to isolated subagents.
- Support multiple terminal backends so the agent is not tied to one laptop.

The deeper insight is that learning is built into the agent's operating loop, not treated as an external analytics report.

## API And Interface

Primary CLI:

```bash
hermes
hermes model
hermes tools
hermes config set
hermes gateway
hermes setup
hermes update
hermes doctor
```

Important user surfaces:

- CLI TUI with slash commands, multiline editing, history, interruption, and tool output.
- Messaging gateway for Telegram, Discord, Slack, WhatsApp, Signal, and other platforms.
- Shared slash commands across CLI and messaging.
- `/model`, `/skills`, `/compress`, `/usage`, `/insights`, `/retry`, `/undo`, `/new`, `/reset`.
- Cron scheduler for natural-language scheduled work.
- Tools and toolsets for filesystem, terminal, browser, memory, MCP, and more.
- OpenClaw migration for settings, memories, skills, allowlists, messaging settings, keys, TTS assets, and workspace instructions.

Backends:

- Local
- Docker
- SSH
- Singularity
- Modal
- Daytona

Provider model:

- Nous Portal
- OpenRouter
- OpenAI
- user endpoints
- provider switching via `hermes model`
- lazy provider / tool dependencies where possible

## Use Cases

- Personal always-available agent accessed from phone, terminal, or chat app.
- Scheduled daily reports, backups, weekly audits, reminders, and unattended tasks.
- Cloud VM agent that keeps working while the laptop is closed.
- Research and coding work with subagents.
- User-specific agent that accumulates skills and remembers prior sessions.
- Migration path for OpenClaw users who want a more continuous personal agent.

## Pros

- Learning loop is native.
- Skills are treated as procedural memory.
- Conversation recall and user modeling are central.
- Messaging channels make the agent live where the user already works.
- Cron makes autonomy continuous without requiring a human prompt.
- Subagents support parallelism without requiring a permanent org chart.
- Backends are practical and varied.
- Provider switching reduces model lock-in.
- The project takes install and cross-platform support seriously.

## Cons And Risks

- It is still one agent-centered worldview.
- The product can become a very capable personal agent rather than a general framework.
- Self-improvement needs governance. An agent that edits its own skills can compound mistakes.
- Messaging gateways increase surface area: auth, identity, session isolation, notifications, and platform quirks.
- More backends mean more operational complexity.
- The learning loop may learn behavior without extracting the deeper philosophy behind behavior.

## What Menoteam Should Learn

- Learning must be in the loop, not only in onboarding.
- Skills are a natural shape for reusable procedural standards.
- Past conversations and session search are a core source of human preference.
- Messaging channels are not peripheral. They may be the real interface for long-running work.
- Scheduled work should produce deliverables and reports, not just reminders.
- Backends should be replaceable.
- Migration from existing agent ecosystems matters.

## What Menoteam Should Avoid

- Do not become a single-agent product if the deeper value is a framework.
- Do not let "self-improving" mean uncontrolled self-modification.
- Do not equate remembered facts with learned philosophy.
- Do not put every feature in one agent process.
- Do not require the user to live in a new app if Slack, Discord, Feishu, DingTalk, terminal, or Codex already carry the work.

## Strategic Implications

Hermes is one of the closest references for Menoteam's emotional direction: low communication cost, personal continuity, taste learning, and autonomous follow-through.

But Menoteam should stay one level more meta:

```text
Hermes:
  the agent learns and works

Menoteam:
  the framework shapes how agents learn, choose goals, continue, ask, evaluate, and reflect
```

Hermes can be a runtime target, a design reference, and possibly a connector. Menoteam should not copy its whole agent surface.

## Product Questions For Menoteam

- What parts of Hermes learning should be represented as Menoteam philosophy state?
- Should Menoteam produce skills that Hermes can load?
- Can Menoteam use Hermes as one executor while still preserving its own trace and evaluation layer?
- How should Menoteam govern self-improving skills?
- What is the minimum long-running agent interface needed across CLI and messaging platforms?
