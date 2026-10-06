# Baseline snapshot plan for Menoteam dogfood

Date: 2026-10-06. **No commit or staging was performed.** This is an inventory to prepare an isolated, reviewable dogfood baseline after the parallel implementation is reviewed.

## Workbench frontend owned by frontend_delivery

- New: `src/workbench/web/**`
- New: `vite.workbench.config.ts`, `tsconfig.workbench-ui.json`
- New: `tests/workbench-routes.test.ts`
- New: `docs/frontend-delivery-audit.md`, `docs/dogfood-ui-followups.md`

## Parallel implementation in the working tree

These files were created or changed during the current coordinated app implementation. Keep them as one candidate app snapshot, but have their owners review the final diff before choosing what to stage:

- Backend/API and database: `src/workbench/*.ts`, `migrations/003_workbench.sql`, `migrations/004_workbench_constraints.sql`, `migrations/005_workbench_bridge_tokens.sql`, `tests/workbench-postgres.test.ts`, and `src/db/in-memory-repository.ts` (modified to support the app's persistence/test boundary), plus shared build/runtime files `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, and `Dockerfile`.
- Local Connector/runtime: `src/connector/**`, `src/local/**`, `tests/connector-*.test.ts`, `tests/local-*.test.ts`, `vite.local.config.ts`, `tsconfig.local-ui.json`.
- Product/acceptance material created in this implementation: `docs/cloud-delivery-plan.md`, `docs/full-app-acceptance-ledger.md`, `docs/full-app-delivery-plan.md`, `docs/local-workspace.md`, `docs/personal-workspace-foundation-options.md`, `docs/personal-workspace-mvp-screens.md`, `docs/personal-workspace-requirements.md`, and `components.json`.
- Legacy docs edited as part of product alignment: `CONTEXT-MAP.md`, `CONTEXT.md`, `PRODUCT.md`, `README.md`, `docs/agent-network-v1.md`, `docs/connect-agents.md`, `docs/idea-bank.md`, `docs/menoteam-product-vision.md`, `docs/menoteam-research-background.md`, `docs/work-map-v1-spec.md`, `docs/worldview-manifesto-v0.1.md`, and `src/gateway/CONTEXT.md`.

## Prototype source and generated files

The V2/V3 prototype source, screenshots, design notes and their prototype-only tests are included explicitly in the baseline to preserve the product's design history and keep the repository's test suite intact: `docs/prototypes/**` and `tests/prototype-*.test.ts`. They are reference material only and are not included in the production app bundle. Generated `.impeccable/` caches and prototype `dist/` outputs are ignored and excluded.

## Snapshot procedure

1. Review the complete staged/unstaged diff by ownership area and confirm every implementation owner has finished.
2. Confirm `.env`, `.env.*`, backups, database files, connector tokens, build output, dependencies, and other local-only secrets are ignored and absent from the candidate.
3. Stage explicit paths only. Preserve the existing user prototype and history; do not reset or clean unrelated files.
4. Make a baseline commit only after the parent review authorizes it, then create isolated dogfood worktrees from that exact revision. Record the baseline commit hash in the acceptance ledger before creating the first app-originated Work.
