# Hermes MoA

Source snapshot: [agent/moa_loop.py](https://github.com/NousResearch/hermes-agent/blob/main/agent/moa_loop.py), [hermes_cli/moa_config.py](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/moa_config.py), [hermes_cli/moa_cmd.py](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/moa_cmd.py), [hermes_cli/models.py](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/models.py), checked in [NousResearch/Hermes-Agent](https://github.com/NousResearch/Hermes-Agent) at `7cfa2fa` from 2026-06-29.

## What It Is

Hermes MoA is a Mixture of Agents runtime for one Hermes turn. It is implemented as a virtual model provider with named presets. Reference models analyze the current state in parallel. An aggregator model receives their advisory outputs and remains the only acting model.

This is not a team of autonomous agents. It is a judgment-amplification pattern.

## Methodology

The core rule:

```text
many references advise -> one aggregator acts
```

Reference models:

- receive a trimmed advisory view of the current conversation
- are told they are not the acting agent
- cannot call tools
- cannot run commands
- cannot access files or URLs
- should identify missed issues, risks, better approaches, and useful next steps

Aggregator:

- receives reference outputs as private guidance
- owns the user-visible answer
- owns tool calls
- remains inside the normal Hermes loop

The slash command is deliberately not a normal model tool. It marks one turn as MoA-enabled, then Hermes' normal conversation loop still owns tool calling and termination.

## API And Interface

CLI management:

```bash
hermes moa list
hermes moa configure
hermes moa delete <name>
```

Provider integration:

- `moa` appears as a provider label "Mixture of Agents".
- MoA presets can be selected like model presets.
- The MoA client returns non-streaming output.

Default config in `moa_config.py`:

- preset name: `default`
- reference models:
  - `openai-codex:gpt-5.5`
  - `openrouter:deepseek/deepseek-v4-pro`
- aggregator:
  - `openrouter:anthropic/claude-opus-4.8`
- reference temperature: `0.6`
- aggregator temperature: `0.4`
- max tokens: `4096`
- enabled: `true`

Runtime details:

- Max reference worker count: 8.
- Reference calls run through the normal provider resolution path.
- Tool result text is truncated for reference advisors with a head/tail budget.
- Tool calls themselves remain high-signal and visible to the reference view.
- Reference failures do not abort the whole turn. They become labeled notes.
- MoA presets cannot recursively reference another MoA preset.
- A hidden marker can encode a one-shot MoA turn for frontends that only send text.

## Use Cases

- Strategic planning where multiple model families can critique blind spots.
- High-risk engineering changes where one model acts but others review.
- Product / design judgment where competing taste models surface different failure modes.
- Research synthesis where one model consolidates multiple perspectives.
- Debugging when a single model may get trapped in its own assumptions.

## Pros

- Improves judgment without creating an org chart.
- Keeps accountability simple: one model acts.
- Reference models can be cheap, diverse, or specialized.
- Parallel fanout keeps latency bounded by the slowest reference, not sum of references.
- The aggregator sees critiques before acting.
- Failure isolation is good: one bad reference should not wedge the turn.
- The no-recursive-MoA guard avoids runaway trees.

## Cons And Risks

- MoA is stateless by itself.
- Reference outputs can increase cost and latency.
- If the advisory view is too compressed, references may critique the wrong thing.
- If the aggregator is weak or overly deferential, it may average advice instead of deciding.
- If the references are too similar, MoA adds expense without diversity.
- It does not create persistent human philosophy, memory, or trace.
- It can make the system feel smarter while still lacking responsibility semantics.

## What Menoteam Should Learn

- Use multiple perspectives to improve judgment, not to simulate an organization.
- Keep one accountable acting loop.
- Make advisors explicitly non-acting.
- Label advisory outputs so they are inspectable.
- Use MoA for uncertain judgment points, not every routine action.
- Avoid recursive agent trees by default.

## What Menoteam Should Avoid

- Do not make "multi-agent" mean many actors all mutating state.
- Do not let reference models call tools unless there is a clear isolation model.
- Do not use MoA as a substitute for durable memory.
- Do not confuse model diversity with human taste alignment.
- Do not expose every internal advisory thought as user-facing output.

## Strategic Implications

MoA is useful for Menoteam as a small, elegant reasoning pattern:

```text
philosophy/context/goal
  -> reference advisors critique
  -> one actor decides and acts
  -> trace records advisor disagreement and final rationale
```

This could help Menoteam preserve taste while avoiding bureaucracy. The user does not need five agents arguing in public. They need a low-cost, high-quality decision process where one agent acts to the standard of the human.

## Product Questions For Menoteam

- When should Menoteam automatically invoke MoA: high risk, low confidence, user taste ambiguity, or strategic goal creation?
- Should Menoteam store reference disagreement as part of trace?
- Should different advisors represent models, skills, past user examples, or domain standards?
- How do we prevent MoA from becoming default cost inflation?
- Can the aggregator be constrained by the user's living philosophy rather than only current prompt context?
