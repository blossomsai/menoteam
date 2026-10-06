# Workbench frontend delivery audit

Date: 2026-10-06

The `/workbench/` React app is a real-data shell over the authenticated Workbench API. It does not include gallery/example content or synthesize success evidence. It uses React, Tailwind CSS v4, and the repository's shadcn/ui components; the stylesheet contains Tailwind theme tokens and imports only, with no authored component selectors.

The implemented surfaces are All projects, focused Project Master, Work list and split Work detail, project Instructions/Skills/Members/Connections, and workspace Agent profiles/Model providers. The live UI includes bounded conversation history with older-page loading, shared browser drafts, project instructions and insertable optional starters, invite/member APIs, manual and GitHub `SKILL.md` creation/import, profile model/reasoning/skill selection, structured diff/QA evidence, and run controls. GitHub/Slack connection references and Codex-host provider records are labeled as unverified metadata; account authentication is owned by the local Connector. The current provider surface does not yet satisfy the required connection list, Add connection, and effective default-selection behavior. Marketplace/catalog installation and plugin-versus-skill import are not implemented and remain full-app requirements. Runtime adapters beyond the currently validated Codex host have not been determined; this audit does not imply support for every vendor.

Outstanding acceptance: prove real provider connection management and selection/default semantics without ineffective metadata-only controls; implement Marketplace/catalog and plugin-versus-skill import with source/provenance, scope, permission, and installation-status evidence.

## Local checks

- `pnpm exec tsc --noEmit -p tsconfig.workbench-ui.json` — passed.
- `pnpm exec vitest run tests/workbench-routes.test.ts` — 4 passed: empty-workspace Connect, explicit missing project, cross-project Work detail, and project-role affordance logic.
- `pnpm exec vite build --config vite.workbench.config.ts` — passed; output is `dist/workbench/web` to keep the API runtime bundle intact.

## Browser evidence (supporting only)

The parent reviewer reported a successful login, project creation, and Project Master load with no browser-console errors; an unsent Master draft survived navigation to All projects; and project Instructions saved and remained after reload. In a separate Chrome tab, I signed into the disposable owner account, confirmed the All projects card and its Master composer, opened the project's Work list (including the New work → Master preset and All / In progress / Paused / Done filters), and reached Instructions with the shared Instructions / Skills / Members / Connections navigation. These observations support **A02** (persistent project/conversation/settings behavior in the disposable runtime) and **A03** (some real-state navigation/layout behavior). They do not prove restart persistence, full mobile/desktop coverage, the complete Work detail/settings surfaces, production behavior, or any broader acceptance row. A02 and A03 remain **Pending** in the acceptance ledger until their full proof requirements are met.

UI second-member proof was not attempted. The task requested a second test-member flow, but the Computer Use Confirmation Policy requires action-time confirmation before “creating or materially expanding security-sensitive access.” Inviting a member creates project access, so I interpreted that rule as requiring user confirmation before submitting the invite. I did not call the invite API, and no automatic approval rejection occurred. A01's second-user UI proof therefore remains pending; existing backend authorization tests are separate evidence and do not substitute for it.
