# Menoteam · Current product direction

Updated 2026-10-06. This is the product direction agreed during the V3 prototype review. It supersedes earlier UI proposals, not the implemented V1 service contracts.

## Purpose and users

Menoteam is a multi-project agent workbench. People set goals and give feedback; each project's Master maintains context, coordinates responsible Agents and subagents, and follows work through to a result. It supports engineering, research, and document work without forcing every project into a software release workflow.

## Current source of truth

- [Requirements](docs/personal-workspace-requirements.md): product decisions and future capabilities.
- [Screen and navigation contract](docs/personal-workspace-mvp-screens.md): current labels, hierarchy, and interactions.
- [V3 design](docs/prototypes/2026-10-02/team-workbench-v3/DESIGN.md): visual and component conventions.
- [V3 prototype](docs/prototypes/2026-10-02/team-workbench-v3/README.md): build, scope, and verification boundaries.
- [Context map](CONTEXT-MAP.md): separates current product concepts from existing implementation contracts.

When these conflict with older proposals, use these current documents. Sample copy in the prototype is illustrative, not a universal policy.

## Product principles

1. Conversation is the primary way to direct work. Settings and work artifacts remain directly inspectable.
2. Each Work has a current Overview and a continuous conversation. Do not introduce mandatory scope forms, fixed note templates, or a separate review workflow.
3. Work detail shows work on the left and its participants' conversation on the right. Overview, Changes, and QA are the only work tabs.
4. Keep team preferences flexible through free-text Project instructions. Real permissions must be enforced by the implementation, not merely written in instructions.
5. Reuse context: relevant GitHub/Slack feedback links back to existing Work; an independent goal may become a new Work.
6. Use React + Tailwind CSS + shadcn/ui. No custom component CSS, CSS modules, inline styles, or @apply component rules. Product text is English; Chinese localization is deferred.
7. Report evidence accurately: tests passed, deployed, and verified are different facts. Do not imply live integrations or execution from sample data.

## Product surface

All projects presents independently scrollable project conversation cards. A Project Master is one focused conversation, without duplicate project tabs. Work rows open the detail page. New work opens Master with an editable preset prompt; it does not send automatically.

Project settings: Instructions, Skills, Members, Connections. Workspace settings: Agent profiles, Model providers. Providers are a list of connections with Add connection and a default marker. Projects are not publicly searchable; membership is invitation-based.

Master should eventually modify settings and create/add skills through conversation, with changes reflected in settings and constrained to the user's permissions and intended project/workspace.

## Current delivery boundary

Port 4313 is a static, example-data design prototype. Upload and microphone controls are icons only. It does not implement provider authentication, skill installation, autonomous Master operation, external source scanning, deployment, or real collaboration. The separate port-4311 execution experiment and V1 Work Map/Gateway code are not implementations of this complete product direction.

## Accessibility

Keep keyboard navigation and visible focus, readable contrast, non-color status cues, responsive layouts, and independent conversation scrolling. Build/typecheck is not visual or production acceptance.
