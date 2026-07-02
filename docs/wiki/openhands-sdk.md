# OpenHands Software Agent SDK

Source snapshot: [OpenHands/software-agent-sdk](https://github.com/OpenHands/software-agent-sdk), checked at `e6b56be` from 2026-06-27. Repository page showed latest release `v1.29.3` on 2026-06-26 when checked.

## What It Is

The OpenHands Software Agent SDK is a Python and REST API layer for building agents that work with code. It provides composable primitives for LLMs, agents, tools, conversations, workspaces, local execution, and remote Agent Server execution.

It is the execution substrate behind OpenHands CLI, OpenHands Cloud, and Agent Canvas.

## Methodology

The SDK reduces a coding agent to explicit components:

```text
LLM + Agent + Tools + Conversation + Workspace
```

The core idea is not "a chatbot." It is a programmable loop where:

- An `LLM` handles provider/model calls.
- An `Agent` owns the prompt, context, and tools.
- A `Tool` exposes capabilities such as terminal, file editing, task tracking, MCP, or custom functions.
- A `Conversation` binds the agent to a workspace and run loop.
- A `Workspace` is either local or remote / ephemeral.
- The Agent Server exposes the same idea over REST and WebSocket for remote control surfaces.

This is a clean execution model. It is not a product philosophy model.

## API And Interface

Basic Python usage from the README:

```python
import os

from openhands.sdk import LLM, Agent, Conversation, Tool
from openhands.tools.file_editor import FileEditorTool
from openhands.tools.task_tracker import TaskTrackerTool
from openhands.tools.terminal import TerminalTool

llm = LLM(model="gpt-5.5", api_key=os.getenv("LLM_API_KEY"))

agent = Agent(
    llm=llm,
    tools=[
        Tool(name=TerminalTool.name),
        Tool(name=FileEditorTool.name),
        Tool(name=TaskTrackerTool.name),
    ],
)

conversation = Conversation(agent=agent, workspace=os.getcwd())
conversation.send_message("Write 3 facts about the current project into FACTS.txt.")
conversation.run()
```

Context and skills:

- `AgentContext` can add skills.
- Skills can be always-active or keyword-triggered.
- `system_message_suffix` and `user_message_suffix` can append prompt context.
- `load_public_skills=True` can load public skills from OpenHands/extensions.
- Custom system prompt templates can be supplied with `system_prompt_filename`.

Agent Server:

- FastAPI REST surface under `/api/**`.
- WebSocket / SSE event channels for live conversation updates.
- Workspace management endpoints for saved local directories.
- Conversation service with persistence.
- Stress tests for parallel subagents, long-running bash, slow webhooks, backpressure, and resource budgets.

Compatibility policy:

- REST API breaks require deprecation notices.
- Deprecated endpoints or contracts need a runway of five minor releases before removal.
- CI compares OpenAPI schemas with `oasdiff`.
- WebSocket / SSE endpoints are not covered by that OpenAPI policy.

## Use Cases

- Build a small one-off coding agent.
- Run routine dependency updates or repo maintenance.
- Build a remote agent service that frontends can control.
- Embed coding agents into CI / GitHub workflows.
- Use public skills and plugins to adapt to repo tooling such as `uv` or `deno`.
- Build a custom agent runtime with a proven conversation/tool/workspace model.

## Pros

- The primitives are direct and composable.
- The same agent can run locally or behind a server boundary.
- Agent Server gives UI products a clear API instead of shelling out ad hoc.
- Skills are first-class context, not just prompt fragments.
- MCP and custom tools fit the model.
- API compatibility discipline matters for external clients.
- Stress tests show serious attention to long-running and concurrent behavior.

## Cons And Risks

- It is code-agent specific. Menoteam needs a wider work framework.
- The SDK does not answer which goal should exist or what good means.
- It can tempt us to start with execution APIs before the philosophy layer is clear.
- Tool and workspace abstractions can become the product surface by accident.
- Skills are procedural context, but without reflection they can become static recipes.
- Remote server semantics require security, auth, persistence, and compatibility work.

## What Menoteam Should Learn

- Use existing execution primitives instead of inventing a coding runtime.
- Keep agent, tool, conversation, and workspace as separate concepts.
- Treat skills as procedural memory with triggers.
- Keep local and remote workspaces abstracted behind a backend boundary.
- API compatibility matters if Menoteam becomes a framework others build on.
- Stress long-running behavior, not just happy-path chat.

## What Menoteam Should Avoid

- Do not define Menoteam as an SDK first.
- Do not expose Python classes as the central product idea.
- Do not confuse "agent can run tools" with "agent knows what matters."
- Do not build a full Agent Server unless a thin bridge cannot work.
- Do not make every work domain fit coding-agent assumptions.

## Strategic Implications

The SDK is a substrate candidate. Menoteam can use it for execution while owning the layer above:

```text
Menoteam:
  philosophy, goals, standards, reflection, trace

OpenHands SDK:
  agents, tools, conversations, workspaces, server execution
```

The strategic lesson is to keep Menoteam implementation-agnostic. If OpenHands SDK is the best coding substrate, use it. If Claude Code, Codex, Hermes, or Kimi is better for a run, route there. Menoteam's moat should not be "we wrote another agent runner."

## Product Questions For Menoteam

- What is the minimum adapter from Menoteam goal state to `Conversation.send_message()`?
- Should Menoteam inject philosophy as `AgentContext` skills, system suffixes, or external trace?
- What information should come back from the SDK run for evaluation: final message, changed files, tool events, cost, tests, artifacts?
- Can Menoteam remain compatible with multiple execution SDKs through a small run record schema?
- Should Menoteam have its own skills format or map onto existing skills where possible?
