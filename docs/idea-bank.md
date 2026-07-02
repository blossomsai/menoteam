# Idea Bank

Working notes for products, protocols, and reference systems that may inform Menoteam. This is not a product spec.

Last checked: 2026-06-29.

## Reading Lens

Menoteam is aiming for a light, elegant, meta framework for philosophy-driven autonomous work. References are useful when they clarify what to borrow, what to avoid, or what should remain an external connector.

Detailed notes live in the [Reference Wiki](wiki/README.md).

## References

### Paperclip

Sources: [website](https://paperclip.ing/), [GitHub README](https://github.com/paperclipai/paperclip), [SPEC.md](https://github.com/paperclipai/paperclip/blob/master/doc/SPEC.md), [ROADMAP.md](https://github.com/paperclipai/paperclip/blob/master/ROADMAP.md)

Paperclip is a human control plane for AI labor. Its core objects are company, org chart, agent, task, heartbeat, budget, governance, plugin, and audit log.

Useful:

- Bring-your-own-agent framing.
- Goals and tasks carry context.
- Heartbeats let agents keep operating.
- Governance and budget make autonomy controllable.
- Trace and audit are first-class.

Watch out:

- Org chart-first modeling can turn autonomy into company bureaucracy.
- A thick control plane may bury the more important layer: human philosophy, judgment, and standards.

Menoteam implication:

Use the seriousness of a company, not the bureaucracy of an org chart.

### OpenHands Agent Canvas

Sources: [OpenHands README](https://github.com/OpenHands/OpenHands), [Agent Canvas README](https://github.com/OpenHands/agent-canvas)

OpenHands is moving toward Agent Canvas: a self-hosted developer control center for coding agents and automations. It can run OpenHands, Claude Code, Codex, Gemini, or any ACP-compatible agent across local, remote, and cloud backends. It also supports scheduled and event-triggered automations with integrations such as Slack, GitHub, and Linear.

Useful:

- Separates frontend control surface from agent server backends.
- Supports local, Docker, VM, cloud, and enterprise infrastructure.
- Automations can run on schedules or webhooks.
- Existing agents become backends rather than being replaced.

Watch out:

- This is still a developer control center. Menoteam should not become another dashboard for launching agents.

Menoteam implication:

OpenHands is a strong connector/runtime target. Menoteam should sit above or beside it as a philosophy, goal, and reflection layer.

### OpenHands Software Agent SDK

Source: [Software Agent SDK README](https://github.com/OpenHands/software-agent-sdk)

The SDK provides Python and REST APIs for building code-working agents with tools, conversations, local workspaces, and ephemeral remote workspaces. It supports one-off tasks, routine maintenance, major multi-agent tasks, skills, plugins, and remote agent server workflows.

Useful:

- Clean separation between agent, tool, conversation, and workspace.
- Remote Agent Server offers a practical boundary for running agents outside the local machine.
- Skills/plugins show how procedural knowledge can be attached to agents.

Watch out:

- SDK primitives are execution primitives, not meaning primitives.

Menoteam implication:

Treat OpenHands SDK as an execution substrate. Menoteam should decide what work matters and how it should be judged, then let substrates like this execute.

### Hermes Agent

Source: [Hermes Agent README](https://github.com/NousResearch/Hermes-Agent)

Hermes is a self-improving AI agent with a built-in learning loop. It creates skills from experience, improves skills during use, searches past conversations, builds a user model across sessions, runs through CLI and messaging gateways, supports scheduled automations, delegates to isolated subagents, and can run on local, Docker, SSH, Singularity, Modal, and Daytona backends.

Useful:

- Learning loop is native, not bolted on.
- Skills are procedural memory.
- Past conversation search and user modeling are central.
- Messaging platforms are continuous interfaces, not separate products.
- Terminal backends let the same agent live in different environments.

Watch out:

- A self-improving agent can still be agent-centric rather than framework-centric.

Menoteam implication:

Hermes is close to the "agent that grows with you" direction. Menoteam should stay more meta: a framework for philosophy, goals, traces, and standards that can shape Hermes-like agents.

### Hermes MoA

Sources: [moa_loop.py](https://github.com/NousResearch/hermes-agent/blob/main/agent/moa_loop.py), [moa_config.py](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/moa_config.py), [moa_cmd.py](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/moa_cmd.py), [models.py](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/models.py)

Hermes' current MoA means Mixture of Agents. It is implemented as a virtual model provider with named presets. Reference models run in parallel and provide private advisory context. The aggregator is the acting model and remains the only model that answers the user or calls tools.

Key details:

- Reference models are advisors, not actors.
- Reference calls run in parallel with a cap on concurrency.
- Tool calls and tool results are flattened into advisory text so reference models can reason about the current state without owning tools.
- The aggregator receives the reference context and acts in the normal Hermes loop.
- MoA presets cannot recursively reference other MoA presets.
- Presets are configurable through `hermes moa configure`.

Useful:

- Multiple models improve judgment without creating an org chart.
- Advisory models can critique the current state while one model owns action.
- The process is visible through labelled reference outputs before aggregation.

Watch out:

- MoA improves reasoning quality, but it does not by itself provide persistent philosophy, goal memory, or long-running trace.

Menoteam implication:

MoA is a good pattern for judgment amplification: many perspectives, one acting loop. Menoteam can use this without turning into multi-agent bureaucracy.

### Hermes Goal Loop

Source: [goals.py](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/goals.py)

Hermes has persistent session goals. A goal stays active across turns; after each turn, an auxiliary judge decides whether the goal is done, should continue, or should wait for async work. Goals can carry a structured completion contract: outcome, verification, constraints, boundaries, and stop condition.

Useful:

- Durable goals can continue across turns.
- Judge failures fail open so work is not wedged.
- WAIT prevents busy-work while async processes run.
- Completion contracts make "done" evidence-based.

Watch out:

- A goal loop is still task-level unless connected to deeper human philosophy and reflection.

Menoteam implication:

This is a strong reference for long-running autonomous work. Menoteam should extend the idea upward: goals should emerge from philosophy and feed reflection back into standards.

### Paxel

Sources: [website](https://paxel.ycombinator.com/), [data handling](https://paxel.ycombinator.com/data-handling), [upload.sh](https://paxel.ycombinator.com/upload.sh)

Paxel analyzes local Claude, Codex, and Cursor sessions to build a profile of how someone works with AI. It reports behavior across steering, execution, engineering, product instinct, and planning. Its pipeline keeps source code and full raw transcripts local, while uploading scores, summaries, redacted decisions, metadata, and bounded excerpts.

Useful:

- Agent-session history is a rich source for learning a human.
- Builder profiles can come from actual behavior, not questionnaires.
- Privacy boundaries are part of the product shape.

Watch out:

- Retrospective analytics do not automatically change future autonomous work.

Menoteam implication:

Use Paxel-like transcript analysis as an onboarding and calibration input, not as the product endpoint.

### GBrain

Source: local `gbrain 0.42.51.0` CLI inspection.

GBrain is a personal knowledge brain with pages, capture, hybrid query, multi-source sync, code indexing, transcripts, watch mode, brainstorm, jobs, and MCP serving.

Useful:

- Durable semantic substrate for memory and project knowledge.
- Can index repositories and code symbols.
- Can connect agent context to persistent pages and prior transcripts.

Watch out:

- Memory substrate is not a product philosophy.

Menoteam implication:

Use GBrain as a long-term memory/search layer. Do not make Menoteam a memory app.

## Current Synthesis

Menoteam should stay thin:

- Paperclip: control plane reference, but avoid org-chart-first structure.
- OpenHands: execution/control surface reference, but avoid becoming an agent launcher.
- Hermes: learning-loop and goal-loop reference, but stay framework-level.
- Hermes MoA: judgment amplification reference, but keep one accountable acting loop.
- Paxel: human-learning input, but not the final product shape.
- GBrain: memory substrate, not the product itself.

The durable Menoteam layer remains:

```text
human philosophy -> goal formation -> autonomous work -> trace -> evaluation -> reflection
```
