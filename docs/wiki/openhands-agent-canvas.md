# OpenHands Agent Canvas

Source snapshot: [OpenHands/agent-canvas](https://github.com/OpenHands/agent-canvas), checked at `5c85309` from 2026-06-27. Package version in `package.json`: `1.1.0`.

## What It Is

OpenHands Agent Canvas is a self-hosted developer control center for coding agents and automations. It runs a frontend that connects to one or more agent backends. Those backends can run locally, in Docker, on VMs, in company infrastructure, or through OpenHands hosted offerings.

It supports OpenHands directly and can use external ACP-compatible agents such as Claude Code, Codex, Gemini CLI, or custom ACP servers.

## Methodology

Agent Canvas separates control surface from execution backend.

The main boundary is:

```text
Agent Canvas UI -> Agent Server -> agent runtime / ACP subprocess -> tools / workspace
```

The UI renders conversation, terminal, browser, files, settings, backend management, onboarding, and automation surfaces. It does not execute agent actions directly. It also does not own the sandbox layer. Those live behind the configured backend.

This is a good separation because the user can switch between backends without switching the whole frontend or mental model.

## API And Interface

Primary CLI:

```bash
npm install -g @openhands/agent-canvas
agent-canvas
```

Modes:

```bash
agent-canvas --frontend-only
agent-canvas --backend-only
```

Development modes include Docker, direct host, automation backend, mock frontend, standalone app build, and library build.

Important architecture surfaces:

- Agent Server REST API: runs multiple agents on one machine.
- Automation Server: scheduled or event-triggered agent runs.
- Ingress proxy: routes frontend, agent server, and automation traffic behind one origin.
- Backend registry: Agent Canvas can connect to multiple Agent Server instances.
- Settings API: stores active backend, agent settings, model settings, secrets, and UI state.
- ACP settings: `agent_kind`, `acp_server`, `acp_command`, `acp_model`.
- Secrets panel: stores provider credentials as named environment variables for the backend.

ACP agent defaults:

- Claude Code: `npx -y @agentclientprotocol/claude-agent-acp`
- Codex: `npx -y @zed-industries/codex-acp`
- Gemini CLI: `npx -y @google/gemini-cli --acp`

Self-hosting uses `LOCAL_BACKEND_API_KEY` and public mode. The docs warn that a direct host backend gives agents filesystem and network access on that host.

## Use Cases

- A developer wants one browser UI for several coding agents.
- A team wants a shared remote backend for code review, dependency updates, and routine engineering tasks.
- A user wants cloud or VM agents to continue while the laptop is closed.
- A company wants scheduled automations integrated with Slack, GitHub, Linear, Notion, Datadog, or similar systems.
- A product wants to embed OpenHands UI modules in another host app.

## Pros

- Strong separation between frontend and backend.
- Works with existing coding agents instead of replacing them.
- Backend switching is first-class.
- Local, Docker, VM, cloud, and enterprise deployment paths are clear.
- ACP support lets external CLIs keep their own tools, credentials, and execution semantics.
- Security warnings are explicit: filesystem access and public exposure are called out.
- The package can be standalone app or embedded library.
- Mock mode and isolated dev state make frontend iteration practical.

## Cons And Risks

- It is still developer-centric. It starts from conversations, files, terminal, browser, and automation.
- The system can become a "better cockpit" rather than a higher judgment layer.
- Agent choice and backend choice are operational settings, not philosophy.
- Public self-hosting requires real security discipline. A backend can be equivalent to remote shell access.
- Credentials are still operationally complex across host login, API keys, Docker, cloud, OAuth token materialization, and per-provider quirks.
- It does not define a durable goal / reflection / philosophy substrate.

## What Menoteam Should Learn

- Treat existing agents as backends, not as competitors.
- Keep execution hosts swappable.
- Preserve a thin frontend / backend boundary.
- Do not assume all execution happens on the user's laptop.
- A backend can carry its own credentials and runtime state. Menoteam does not need to own every secret or workspace.
- ACP is a useful adapter boundary for Claude Code, Codex, Gemini, and custom agents.
- Automations need scheduled and event-triggered starts, not only manual chat starts.

## What Menoteam Should Avoid

- Do not become another agent launcher.
- Do not center the product around terminal/browser/file panes unless the task requires it.
- Do not treat backend switching as the main product value.
- Do not make Menoteam's identity depend on OpenHands-specific APIs.
- Do not hide security risk behind "local" language. Local agents can still be dangerous.

## Strategic Implications

Agent Canvas is probably a connector target, not the thing Menoteam should become.

Menoteam can sit above it:

```text
Menoteam philosophy / goals / standards / trace
  -> dispatch to Agent Canvas backend
  -> backend runs OpenHands / Claude Code / Codex / Gemini
  -> results return as artifacts and trace events
  -> Menoteam evaluates and reflects
```

The strategic opportunity is to make Menoteam the layer that knows why work matters and how it should be judged, while Agent Canvas knows how to start and monitor coding agents.

## Product Questions For Menoteam

- Should Menoteam dispatch into Agent Canvas through Agent Server, ACP, or a lighter text-level bridge?
- What Menoteam state must survive backend switching?
- Can Menoteam be useful with no UI, only as a context / goal / standard layer injected into Agent Canvas conversations?
- How should Menoteam represent work done in external backends without mirroring the whole backend database?
- What is the minimum trace event schema needed to evaluate an Agent Canvas run?
