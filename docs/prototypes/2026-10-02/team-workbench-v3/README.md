# Team Workbench V3 · Current design prototype

Updated 2026-10-06. Current review surface: http://127.0.0.1:4313/. Ten example-data views, with English product text. See [product direction](../../../../PRODUCT.md), [requirements](../../../personal-workspace-requirements.md), [navigation](../../../personal-workspace-mvp-screens.md), and [design](DESIGN.md).

## Scope

Static React gallery with local sample interactions, not a connected product. All projects contains scrollable conversation cards; Project Master is one focused conversation; Work detail has Overview / Changes / QA on the left and the participants' conversation on the right.

Project settings: Instructions, Skills, Members, Connections. Workspace settings: Agent profiles and Model providers. Instructions are free text with optional starting points. Skills and providers have local add/create examples. File/image and microphone controls are icons only. No real upload, recording, authentication, GitHub import, marketplace install, external polling, autonomous execution, or deployment is performed.

Some conversation drafts/history use sessionStorage; other demo forms are component-local and may reset on refresh. This is not a persistence or recovery contract. Sample timestamps, identities, diff, checks and delivery receipts are illustrative. No live or production claim follows from rendering them.

## Build and serve

From the repository root:

```sh
node_modules/.bin/tsc --noEmit --project docs/prototypes/2026-10-02/team-workbench-v3/tsconfig.json
node_modules/.bin/vite build --config docs/prototypes/2026-10-02/team-workbench-v3/vite.config.ts
python3 -m http.server 4313 --bind 127.0.0.1 --directory docs/prototypes/2026-10-02/team-workbench-v3/dist
```

If 4313 already has a listener, reuse it rather than starting a second server. Rebuild `dist/` after changes and refresh. Port 4311 is a separate execution experiment; `/dashboard` is the V1 service UI.

## Styling contract

React + Tailwind CSS + shared shadcn/ui components only. JSX contains utility classes and responsive/state variants. `src/style.css` contains only Tailwind import/source discovery and shadcn theme tokens. No custom CSS selectors, CSS modules, inline style objects, or @apply component classes. Semantic classes retained in JSX are DOM hooks, not stylesheet rules.

## Verification

Use typecheck, build, and the focused prototype route/source/scroll tests. Record results per change; do not preserve a historical test count or process PID as current proof. Browser visual QA has been blocked in this environment; build success is not visual acceptance. Retired appearance, project-tab and dictation code/tests are removed rather than retained as product requirements.
