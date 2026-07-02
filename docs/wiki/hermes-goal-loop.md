# Hermes Goal Loop

Source snapshot: [hermes_cli/goals.py](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/goals.py), checked in [NousResearch/Hermes-Agent](https://github.com/NousResearch/Hermes-Agent) at `7cfa2fa` from 2026-06-29.

## What It Is

Hermes' goal loop is a persistent session goal system. A user sets a standing goal. After each agent turn, an auxiliary judge decides whether the goal is done, should continue, or should wait for async work. If it should continue, Hermes feeds a continuation prompt back into the same session.

This is a strong reference for long-running autonomy.

## Methodology

The core loop:

```text
set goal -> agent works -> judge evaluates -> done / wait / continue
```

Design invariants from the source:

- A goal is stored per session in `SessionDB` metadata under `goal:<session_id>`.
- `/resume` can recover the active goal.
- Continuation is a normal user message, not a system prompt mutation.
- The toolset is not swapped during continuation.
- Judge failure fails open to continue.
- A new real user message preempts the continuation prompt and pauses goal continuation for that turn.
- The judge can return `DONE`, `WAIT`, or `CONTINUE`.
- WAIT can park on a process session, PID, or time delay.
- Turn budget prevents infinite loops.

## API And Interface

Main classes and functions:

- `GoalContract`
- `GoalState`
- `GoalManager`
- `parse_contract(text)`
- `draft_contract(objective)`
- `judge_goal(...)`
- `gather_background_processes(...)`
- `run_kanban_goal_loop(...)`

Defaults:

- `DEFAULT_MAX_TURNS = 20`
- `DEFAULT_JUDGE_TIMEOUT = 30.0`
- `DEFAULT_JUDGE_MAX_TOKENS = 4096`
- `DEFAULT_MAX_CONSECUTIVE_PARSE_FAILURES = 3`

Goal contract fields:

- `outcome`
- `verification`
- `constraints`
- `boundaries`
- `stop_when`

Judge verdict shapes:

```json
{"verdict": "done", "reason": "..."}
{"verdict": "continue", "reason": "..."}
{"verdict": "wait", "wait_on_session": "...", "reason": "..."}
{"verdict": "wait", "wait_on_pid": 123, "reason": "..."}
{"verdict": "wait", "wait_for_seconds": 60, "reason": "..."}
```

Continuation prompts come in three forms:

- plain goal
- goal with structured completion contract
- goal with subgoals

When a contract is present, the continuation prompt tells the agent to satisfy verification evidence before claiming done and to stay within constraints / boundaries.

## Use Cases

- A coding task that may take many turns.
- A long-running test or CI process where the correct action is to wait.
- A project cleanup where the agent should keep finding and resolving related work until evidence says it is done.
- A background task in a kanban worker.
- A user wants to state intent once and let the agent continue until done or blocked.

## Pros

- It makes continuation explicit.
- It avoids system prompt mutation, preserving prompt caching and reducing hidden state.
- It gives the judge a small, structured job.
- WAIT prevents busy-work while async processes run.
- Completion contracts make "done" evidence-based.
- Parse-failure auto-pause catches weak judge models before they burn all turns.
- User messages still preempt autonomous continuation.
- Persistence across resume makes long work less fragile.

## Cons And Risks

- The loop is still task-centered.
- The judge can be wrong, weak, or over-lenient.
- Fail-open is pragmatic, but it can continue bad work if the judge is broken.
- Done can become too dependent on the last assistant response rather than actual external state.
- A continuation prompt can keep the agent busy without creating strategic progress.
- The contract fields are strong, but they still need human philosophy to know what is worth doing.

## What Menoteam Should Learn

- Durable goals need their own lifecycle.
- "Continue" should be a decision, not an accident.
- Autonomy needs a formal WAIT state.
- Evidence should be required before declaring done.
- Completion contracts should include outcome, verification, constraints, boundaries, and stop condition.
- Long-running work should survive context changes.
- User interruption should not be treated as failure.

## What Menoteam Should Avoid

- Do not let every goal loop become task tunnel vision.
- Do not use a judge without storing why it judged done / continue / wait.
- Do not rely only on the last message for evaluation when artifacts or tool state are available.
- Do not make autonomous continuation silent. The trace should show why it continued.
- Do not treat turn budget exhaustion as success.

## Strategic Implications

Hermes' goal loop can become one Menoteam execution pattern, but Menoteam should extend it upward.

Menoteam goal loop:

```text
human philosophy
  -> goal proposed or accepted
  -> completion contract
  -> autonomous run
  -> judge / evaluator
  -> trace
  -> reflection back into standards
```

Hermes focuses on whether a session goal is satisfied. Menoteam should ask an additional question: did this goal and its execution improve or reveal the user's operating philosophy?

## Product Questions For Menoteam

- Should Menoteam draft completion contracts through chat, transcript analysis, or examples of accepted work?
- Should every goal have a reflection output after completion?
- What evaluator can use artifacts, tests, diffs, and user taste examples, not only assistant text?
- How should the system decide when a goal is worth pursuing without user instruction?
- How can Menoteam show a 10-day goal trace without becoming a task dashboard?
