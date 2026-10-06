# Local workspace execution experiment · port 4311

> Separate earlier execution experiment, not the current 4313 design prototype. See [current product](../PRODUCT.md). Keep these runtime instructions for users of the existing code; do not use its acceptance workflow or visual styling as V3 requirements.

The UI is React with shadcn/ui components and Tailwind CSS 4; `pnpm run build` bundles it into `dist/local/web`, and its theme lives in `src/local/web/src/styles.css`. Add official components with `pnpm exec shadcn add button input textarea badge label popover --path src/local/web/src/components/ui`.

Run `npm run local:start`, then open <http://127.0.0.1:4311/> (the same shell is also available at `/local`). The process binds only to loopback. `PORT`, `LOCAL_DATA_DIR`, and `CODEX_BINARY` can be set for a different local port, data folder, or Codex executable. State is stored atomically in `data/local-workspace/state.json` (ignored by Git); one service process owns a data folder at a time.

If an abrupt stop leaves the default `data/local-workspace/service.lock`, first confirm the workspace service and its previous Codex process/commands have stopped. Then remove only `data/local-workspace/service.lock` and run `npm run local:start` again. Preserve `state.json`; it contains the projects, jobs, and Work Map snapshot. After restart, use the interrupted job's UI recovery action to confirm the old process stopped and release its reserved slot/path. If `LOCAL_DATA_DIR` points elsewhere, use that directory's `service.lock` instead.

Connect an existing absolute project directory. Repository URLs are optional GitHub metadata and are never cloned. Each project links to a regular Work Map Work owned by `teammate_self`; queued and completed executions remain separate local job records. The prototype does not complete Work automatically.

The snapshot endpoint is `GET /api/local/snapshot`. Projects are created with `POST /api/local/projects` and updated with `PATCH /api/local/projects/:id`. Submit work with `POST /api/local/projects/:id/jobs` using `{ "prompt": "...", "mode": "read-only", "requestId": "..." }`; `workspace-write` is available only when explicitly selected. Reusing a project request ID returns the original job. Jobs can be cancelled at `/api/local/jobs/:id/cancel`, retried as a new checkpointed execution at `/api/local/jobs/:id/retry`, accepted at `/api/local/jobs/:id/accept`, and reconciled after a restart at `/api/local/jobs/:id/reconcile` with `{ "stopped": true }`.

Codex runs through the installed `codex exec --json` CLI and reuses that CLI's local login. See [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode). Runs use `gpt-6-luna`, medium reasoning, `approval_policy="never"`, and the selected sandbox. This prototype does not synchronize Codex Desktop sessions, resume threads, clone repositories, merge changes, or send results to external systems. A retry starts a fresh run and asks Codex to inspect the current workspace because an interrupted attempt may have already changed files.

At most two jobs run at once; jobs sharing a Git common directory serialize, including linked worktrees, and non-Git projects serialize by canonical directory. On service restart, a previously running job becomes `interrupted` and reserves capacity and its project path until a person confirms the previous process stopped. The service never kills a process based only on persisted process identity. Job output/events and each acceptance evidence entry are bounded. A successful Codex exit moves a job to `needs_review`; human acceptance adds a run record to its linked Work summary and Living Doc.

The service accepts same-origin JSON mutations only, rejects cross-site fetches, and permits only localhost Host values. It is a single-user local prototype, not a remotely reachable daemon.

## Visual direction

This direction applies only to the `/local` personal prototype; the existing Work Map dashboard stays unchanged. Use warm silver-gray `#eceee7`, deep pine green `#243c33`, fine rules, and calm low-saturation layers. The original artwork is [cypress-terraces.png](../src/local/assets/cypress-terraces.png); its generation prompt and provenance are in [cypress-terraces.prompt.md](../src/local/assets/cypress-terraces.prompt.md). Keep the artwork in the Work Map area’s open margin, clear of text and inputs rather than underneath them.
