# Team Workbench V3 · Design contract

Updated 2026-10-06. Operate mode: calm, readable, compact product UI. [Requirements](../../../personal-workspace-requirements.md) define behavior; [screen contract](../../../personal-workspace-mvp-screens.md) defines navigation. Do not restore older concepts from historical screenshots or prompts.

## Implementation

Use React, Tailwind utilities, and shared shadcn/ui primitives. No custom component CSS or inline styles. Theme tokens live in the Tailwind entry; there is one neutral light theme and no appearance picker. Use theme colors, restrained accent selection, fine borders, visible keyboard focus, and the system sans font.

## Space and hierarchy

Persistent project sidebar on desktop, compact project navigation on small screens. Lists and settings use the available content width. Breadcrumbs show the current hierarchy and current page once. No top-right search/avatar duplication.

All projects uses bordered project conversation cards, two columns when space permits and one on narrow screens. Each card has an independent history scroller and fixed composer. Do not collapse full conversation history behind a summary or typing modal.

Project Master shows one project's conversation without project tabs, redundant status strip, review banner, or Work list action. Its optional context panel opens on explicit selection and does not change due to incoming messages.

Work detail is a stable left/right split: work content left, participant conversation right. Left tabs are Overview / Changes / QA, default Overview. Related sources and optional Delivery appear within Overview. Keep scrolling bounded and stack the panes on small screens.

## Messages and input

Master-only conversations do not repeat You/Master labels. Multi-participant Work messages show the participant name and first-character avatar (M, C, Q). Agent text is unboxed; user messages align right with a subtle fill. No copy button. Hover/focus reveals timestamps without layout shift; Agent timestamps are right of the message, user timestamps left. Touch users can see timestamps without hover.

Composer is a single-line capsule with plus, input, microphone, circular send. Preserve IME-safe sending. Plus/microphone are presentational icons only; do not reintroduce upload/recording implementations.

## Work and settings

Changes shows file paths, aggregate and per-file additions/deletions, line numbers and red/green diff rows. Files start collapsed. QA records result, reason and evidence; it is not a separate global page. Deployment and verification are distinct in Overview and only appear for relevant work.

Instructions is a free-text document with edit/save/cancel and optional insertable suggestions. No mandatory rule sections. Skills lists installed items and offers Create / GitHub URL / Marketplace; catalog and additions are examples. Members is invite-only. Provider connections are rows, with Add connection and default selection. No Local environment or observer proposals.

## Truthfulness

Keep current product decisions separate from prototype capabilities. Do not describe sample interactions as real installs, model login, permissions enforcement, automatic source matching, or execution. The user has authorized design work, not implementation of these services.
