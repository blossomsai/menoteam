# Paxel

Source snapshot: [paxel.ycombinator.com](https://paxel.ycombinator.com/), [data handling](https://paxel.ycombinator.com/data-handling), and [upload script](https://paxel.ycombinator.com/upload.sh), checked on 2026-06-29.

## What It Is

Paxel analyzes local AI coding-agent sessions to build a profile of how a person builds with AI. It reads Claude Code, Codex CLI, Cursor, and related transcript sources, then produces reports across steering, execution, engineering, product instinct, and planning.

It is not an execution system. It is a behavioral mirror.

## Methodology

Paxel learns from actual usage traces instead of asking the user to fill out a preference form.

Inputs:

- Claude Code JSONL under `~/.claude/projects/`
- Codex CLI sessions under `~/.codex/sessions`
- Cursor workspace storage
- Git history and commit metadata
- Optional repository-level code metrics
- Tool-use summaries and bounded session events

Pipeline shape from the upload script:

- Check Docker.
- Authenticate the user.
- Run analysis locally in a container.
- Discover projects and sessions.
- Parse transcripts.
- Summarize sessions through a cloud LLM proxy.
- Group commits and sessions into work streams.
- Extract steering traces and decision exchanges.
- Redact sensitive content.
- Analyze code quality locally.
- Score episodes across five axes.
- Upload redacted summaries, scores, metadata, and telemetry.
- Run server-side cohort and profile synthesis.

The key methodology is "behavior-derived profile." The user is understood from how they actually steer, interrupt, plan, decide, ship, and react.

## API And Interface

Primary command:

```bash
curl -fsSL https://paxel.ycombinator.com/upload.sh | bash
```

Common flags:

```bash
upload --project NAME
upload --since 2m
upload --all
upload --no-repo
upload --no-sentry
upload --clear-cache
```

Scope modes:

- Run from a parent folder to analyze many repos.
- Run from a project folder to focus on one repo.
- Use `--project` to select by repo name.
- Use `--no-repo` to skip repo mounting and git analysis.

What stays local according to the data-handling page:

- source file bodies
- working-tree snapshots
- full raw transcripts
- raw agent responses
- full tool outputs
- diffs and patch content

What is uploaded:

- scores
- behavioral summaries
- session metadata, including file paths
- git commit metadata
- per-commit numstat
- redacted decision records
- bounded transcript excerpts
- pipeline telemetry
- aggregate code quality metrics when repo analysis is enabled

Redaction includes common API keys, provider tokens, OAuth tokens, JWTs, private keys, database URLs with credentials, and environment-variable style secrets.

## Use Cases

- Understand how a builder uses AI across projects.
- Identify steering patterns, planning habits, model preferences, and productive times.
- Compare report snapshots over time.
- Aggregate profile across multiple machines.
- Learn where a builder's AI collaboration behavior has a growth edge.
- Mine local agent transcripts for calibration input.

## Pros

- Uses real behavior, not self-reported taste.
- Works across common agent tools.
- Local container analysis reduces raw data exposure.
- Clear privacy boundary language.
- Report/profile distinction is useful: one upload vs pattern over time.
- The scoring axes map well to agent-collaboration quality.
- It captures steering, course corrections, frustration, planning, and agent parallelism.

## Cons And Risks

- It is retrospective. The report does not itself improve the next agent run.
- Some bounded excerpts and LLM proxy payloads still leave the machine.
- File paths, git remotes, commit metadata, and behavioral signals can be sensitive.
- Scoring can turn rich human judgment into gamified archetypes.
- The privacy model is detailed but operationally complex.
- It depends on transcript formats and local tool storage conventions.
- It may overfit to coding sessions and miss non-coding taste.

## What Menoteam Should Learn

- The best onboarding data may already exist in local agent transcripts.
- Taste and working style can be inferred from steering patterns, not only final artifacts.
- User frustration and correction are high-value alignment signals.
- Reports should distinguish snapshot vs evolving profile.
- Privacy boundaries must be product-level, not buried in policy.
- Local-first processing can make high-context profiling acceptable.
- Behavioral axes are useful, but they should feed future work, not end as a scorecard.

## What Menoteam Should Avoid

- Do not make the product a personality report.
- Do not gamify the user's AI behavior as the main value.
- Do not upload raw transcripts or source code.
- Do not infer immutable traits from temporary behavior.
- Do not treat a profile as truth. It should be contestable and revisable through chat.
- Do not stop at analytics. Menoteam must change future autonomous work.

## Strategic Implications

Paxel is a strong onboarding and calibration reference.

Menoteam can use a Paxel-like path:

```text
local transcripts
  -> behavioral extraction
  -> taste / judgment / steering profile
  -> chat-based correction
  -> operating philosophy
  -> future agent behavior
```

The final product should not be "your builder archetype." It should be "your agents now act with a better understanding of your philosophy."

## Product Questions For Menoteam

- What transcript fields are enough to learn taste without uploading raw history?
- Can users correct the profile through chat and see exactly what changed?
- How should Menoteam distinguish stable philosophy from project-specific behavior?
- Should Menoteam index Claude Code, Codex, Cursor, Hermes, and OpenHands histories locally?
- What privacy promise is simple enough for users to trust?
