# Menoteam 四屏 board generation prompt

> Historical research/proposal, retained for provenance. Not current UI requirements. The 2026-10-06 [product direction](../../../PRODUCT.md) and its linked requirements supersede conflicting navigation, workflows and feature claims here.

Input references: overview/setup PNGs and the first board PNG from the same imagegen session. Final generation mode: built-in.

- Overview screenshot: `/Users/yili/.codex/generated_images/01a0f69d-dd16-7d01-8aca-990918cd12ef/exec-e59bb702-3204-4d47-9506-f8802d8b1e25.png`
- Setup screenshot: `/Users/yili/.codex/generated_images/01a0f69d-dd16-7d01-8aca-990918cd12ef/exec-ad8b3559-8ce2-4101-af57-db3c0378f704.png`
- First board PNG (targeted revision input): `/Users/yili/.codex/generated_images/01a0f69d-dd16-7d01-8aca-990918cd12ef/exec-24e6c51b-e470-4278-9dff-c954c91453d3.png`

## Board generation
Use case: ui-mockup / compositing. Create ONE SINGLE-PAGE prototype presentation board showing ALL FOUR Menoteam application screens together in a clean 2 × 2 grid. This single board replaces separate screen outputs. Request a very high-resolution 4K landscape board around 3840 × 2560 so each screenshot remains readable. No devices, perspective, browser windows, external commentary, explanatory captions, or marketing.

Input image 1 = the approved-looking Project Overview screenshot. Input image 2 = the matching Project Setup screenshot. Preserve their overall interface content and exact visual world in the TOP ROW, scaling proportionally. Use them as the app chrome and design-system reference for the two NEW screens in the BOTTOM ROW. All four panels must have matching scale, dimensions, typography, sidebar width, forest/silver-grey palette, botanical terrace artwork, subtle grain, fine dividers and shadcn-like 6px-corner controls. A pale silver-grey board background with small consistent gutters and discreet headings above each panel. Keep the full panel contents visible; do not crop buttons or sidebars.

Board arrangement and exact short panel headings:
TOP LEFT: “01 项目总览” — retain image 1 with three projects, normal autopilot progress and ONE large permission change awaiting review.
TOP RIGHT: “02 项目接入” — retain image 2 with actual-clone concept, team Slack already connected, one natural-language project goal and Master suggested QA/release rules. No extra manual configuration forms.
BOTTOM LEFT: “03 项目工作区” — NEW interface in the same shell, Field Notes selected in the project sidebar. Main heading “Field Notes”. Small tabs “Work Map” selected, “Master”, “设置”. Header status “Autopilot 运行中”.
Show ONE compact work block for “修复重复保存”, with source “Slack · #field-notes” and “实现中”.
Below it a restrained dependency layout, not a sprawling network: one request “重复保存反馈” leads to two workers in parallel:
“Worker A” / “客户端去重” / “进行中”
“Worker B” / “API 写入检查” / “进行中”
Their thin connecting lines converge at “整合负责人”, then “独立 QA” / “待开始”. Clear parallel responsibility and subsequent independent verification.
Below, a compact Master update “两个 worker 正在并行修复，整合后进行独立 QA。” and one single input with placeholder “继续这个项目…” and a simple send icon. No large chat transcript. Keep whitespace and let the map read at a glance.
BOTTOM RIGHT: “04 工作详情” — NEW interface in the same shell. Main heading “修复重复保存”, success status “已交付”. A small source line “Slack · #field-notes”; compact label “项目规则：小改动”. A readable vertical delivery timeline, with green checks and the following verbatim short items:
“调查与修复”
“全部 required checks 通过”
“独立 QA 通过”
“自动 merge”
“自动 deploy”
“部署后验证通过”
An understated evidence footer “Revision · Rules · Environment” and an ordinary “查看证据” link. This small change proceeds automatically, no human Approve/Accept button, no review prompt. Do not imply QA alone is final delivery. No invented test commands, pass counts, percentages, actual credentials or technical recovery jargon.

Shared visual direction: calm muted forest tones, soft silver-grey rectangular terraces, slender cypress botanical forms and delicate gongbi detail. Artwork stays in unoccupied sidebar or margins, never under text or inputs; modest artwork area so four operating interfaces remain the subject. Refined, crisp, clear text, minimal copy. UI labels are Chinese mixed with the specified English. The panel headings are the only board-level text. All sample data is fictional. Deliver one complete cohesive 2×2 board, showing exactly four DISTINCT screens with their distinct tasks; no duplicate screens, fifth inset, omitted screen, cut-off content or isolated screen output.

## Targeted revision
Use case: precise-object-edit / ui-mockup. Edit the attached SINGLE-PAGE 2×2 Menoteam prototype board. Preserve ALL four screens, board headings, layout, exact text, palette, illustration, typography, sidebar and scale. Do not redesign anything. Change ONLY the dependency connector arrows inside the bottom-left “03 项目工作区” panel.

The Work Map must have a simple, acyclic TOP-TO-BOTTOM flow:
1. Top node “重复保存反馈”.
2. Split into parallel “Worker A / 客户端去重” and “Worker B / API 写入检查”, with arrows entering the TOP of both worker boxes.
3. Connect the BOTTOM of both worker boxes with a tidy merging horizontal connector; then one downward arrow entering the TOP of “整合负责人”.
4. One downward arrow from the BOTTOM of “整合负责人” entering the TOP of “独立 QA”.
All arrowheads point DOWN toward the next step. Remove every upward arrowhead, reverse path or cycle. Use thin muted sage connectors, same line style as existing.
Keep the node positions, labels and states unchanged. The diagram should be readable as request → two parallel workers → integration → independent QA. Other three screens and all other content are invariant. Keep exactly one single 2×2 board. Request the largest available output resolution, without inventing more UI detail.

实际交付图片为 1536 × 1024；4K 仅为 prompt 请求。
