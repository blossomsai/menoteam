# Team Workbench v2：screen inventory 与需求覆盖

> Historical research/proposal, retained for provenance. Not current UI requirements. The 2026-10-06 [product direction](../../../../PRODUCT.md) and its linked requirements supersede conflicting navigation, workflows and feature claims here.

**2026-10-02 · IA proposal · prototype review**

本文把已确认的功能需求映射到建议的 operation views、可执行动作和关键失败/恢复状态，供用户 review one-page prototype gallery 与 IA 方案。旧四屏 board 已 superseded，保留历史文件。16 个 views 是功能覆盖 review proposal，不是 16 个一级导航项，也不表示每个内部技术细节都应成为页面。

## IA 与导航

- **Global**：Portfolio / Overview、Execution Profiles、Recovery；Connect Project 是首次接入 onboarding。
- **Project 主入口**：Work、Work Map、Agents、Quality、Releases、Settings。
- **Reviews** 是 Work 内由 rules 触发的 exception queue，不是所有 work 都经过的审批 inbox。
- **Settings** 中 Rules、Skills、Members & Access、Connections 都是有完整信息与实际操作的 views，不能用一个模糊的“Settings”标签代替其 UI。
- **Work Detail** 从 Work、Work Map、Agents、Quality、Releases 或 Reviews 的当前上下文打开；按需要呈现为 detail route 或 panel，保留 source、work identity 与返回上下文。
- Global project search/filter 与 project 内 work search/filter 提供快速定位，不扩张授权范围。

## 16-view inventory

| ID | Operation view | 用户要完成的事 | 主动作 | IA 归属 |
| --- | --- | --- | --- | --- |
| V01 | Portfolio / Overview | 扫描项目状态、Master freshness、work、阻塞和需本人判断事项 | 打开项目或恢复受阻 work | Global |
| V02 | Connect Project | 连接本机目录或真实 clone GitHub repo，确认项目目标和接入结果 | Connect/clone 并检查 checkout | Onboarding |
| V03 | Project Workspace | 默认展示目标、进展、阻塞、结果、待决定事项和下一步 | 创建/继续 work；询问 Master 并打开关联改动、测试或发布 evidence | Project · Work |
| V04 | Work Map | 查看依赖、责任人、并发分工、整合责任和结果 | 打开 work 或处理依赖/阻塞 | Project · Work Map |
| V05 | Work Detail | 默认展示目标、进展、关键变化、结果和下一步；按需展开原始日志 | 继续/恢复 work；询问 Master/负责人；打开关联 diff、测试和发布 evidence | Contextual detail |
| V06 | Agents + Agent Detail | 默认展示 worker 目标、进展、阻塞、结果、下一步和最近有意义的变化；不是 event stream | 分派/启动/停止 worker；询问负责 Agent 并检查其引用的改动/测试；需要时展开 run events | Project · Agents |
| V07 | Local Resources & Tools | 检查本机 host freshness、checkout、工具可用性、共享资源占用 | 重连 host 或处理资源冲突 | Project · Agents / contextual status |
| V08 | Quality Evidence | 检查完整 required gate 与独立 browser/app/computer QA 的结果 | 查看实际失败证据并进入修复；按规则重跑 | Project · Quality |
| V09 | Releases | 查看质量门禁结果及 integration、remote merge、deploy、post-deploy verification 收据 | 检查或恢复允许执行的阶段 | Project · Releases |
| V10 | Reviews | 处理 rules 指定的审核：实施前看 plan、预期影响和拟执行动作；或在允许范围内代码准备好后审具体受限动作 | approve、reject 或 request changes；尚未产生的 diff/QA 标“尚未产生”，不为补 evidence 提前执行受限改动 | Project · Work exception queue |
| V11 | Project Rules | 维护版本化 scope、change/risk classification、required checks/QA 与 review gates | 编辑并保存规则版本 | Project · Settings |
| V12 | Skills Library + Proposal | 检查 skill 与 observer 提案的依据、适用范围和差异 | 编辑、adopt 或 reject 提案 | Project · Settings |
| V13 | Members & Access | 设置 private/invite/join 与 project-scoped access | 邀请、接受/加入、检查/调整权限 | Project · Settings |
| V14 | Connections | 检查 GitHub、Slack connection、授权 scope、项目 channel 与 sync freshness | Connect、reconnect 或修复权限 | Project · Settings |
| V15 | Execution Profiles | 显示当前 subscription、状态和可用 subscription/account/config profiles，保持 active work 原身份 | 手动切换默认 profile、查看配额/兼容性；不增加 Billing 页 | Global |
| V16 | Recovery | 对账中断状态与可能的外部副作用后安全接续 | 核对 side effects，再 resume/restart | Global |

## 默认信息层级：工作状态优先

Portfolio、Project Workspace、Work Map 与 Agent detail 默认先呈现目标、进展、阻塞、结果、待决定事项和下一步。用户可点开询问 Master 或负责 Agent；回答链接相关改动、测试和发布 evidence。产品不是 log viewer：底层 durable events、checkpoints 和 receipts 仍保留以供恢复、追责、排障；原始日志仅在按需展开时出现。无需增加页面，也不以更多指标、日志或技术面板代表成熟度。

## 需求 → screen → action → failure/recovery 覆盖

| 已确认需求 | Screens | 主动作 | 必须可 review 的失败/恢复状态 |
| --- | --- | --- | --- |
| 多个真实项目，各自保持长期、独立 Master context | V01–V05 | Connect project；打开或继续该项目的 Master/work | Portfolio empty；context 不可读；host offline；host last-seen/freshness；重连后保留项目身份和待续 work |
| 既有本机目录和 GitHub 实际 clone；GitHub 是 v1 必需 | V02、V07、V14 | 选择目录或 clone repo；查看权限、checkout、连接 scope | access denied；clone failed/partial；目标路径冲突；checkout 丢失；connection stale；保留输入并给出可执行的 retry/reconnect |
| Slack 为 v1 必需；Codex、Slack、dashboard 跨入口使用同一 work context | V01、V03、V05、V14 | 从 source link 打开同一 work；继续对话/查看更新 | connector offline；last sync stale/unknown；重复 event 不重复建 work；仅在已确认时声称已排队/同步；Slack 双向更新对应同一 context |
| 外部 source 保持权威、可追溯并去重 | V03、V05、V14 | 打开 source；识别 source owner、同步时间和对应 Menoteam work | source 不可达；同步冲突；duplicate delivery/webhook；内容更新晚到；不伪造本地副本为权威事实，清楚标 unknown/stale |
| Work Map 显示进度、依赖、handoff 与责任归属 | V03–V06 | 打开 work、查看/处理依赖、检查 owner | map stale；缺少 owner；依赖阻塞；无关 work 仍可查看/继续 |
| 多个本机 Codex worker 真正并发，隔离共享执行环境并负责整合 | V04、V06、V07 | 同时启动/分派 workers；查看 bound profile、工具占用与 integrated output | 启动失败；browser/port/DB/desktop tool 冲突；checkout/write 冲突；merge/integration conflict；明确 integration owner；仅暂停受影响步骤，不静默覆盖 |
| merge/deploy 前执行全部 team/project required tests、lint、QA，不可按 diff 省略 | V08、V05、V09、V11 | 查看适用规则和全集 gate；对集成 revision 执行 required checks | 检查 missing、skipped、unavailable、failed、stale 或证据缺失；gate 不得显示通过；revision/rules/environment 改变时旧证据标失效 |
| 独立 browser/app/computer QA 的真实证据 | V08、V05 | 检查观察到的 UI/行为、工具来源、revision 与结果 | 工具未配置/缺失；host offline；probe/capture 失败；检查内容与 revision 不符；CLI exit 0 不替代产品 QA |
| 小改动满足完整 gate 后自动 merge/deploy 并完成 post-deploy verification | V05、V08、V09、V11 | 查看规则分类和各发布阶段 evidence | 不出现日常人工 Accept；merge/deploy 失败；部署后验证 pending/failed；未验证成功不得标 delivered |
| Major change 按 project rules 在指定 gate 人工 review，其他独立工作可继续 | V05、V09、V10、V11 | 可在实施前 review plan、预期影响和拟执行动作；或在允许范围内准备完成后 review 具体受限动作 | review pending；规则版本未知/冲突；reject/request changes；尚未产生的 diff/QA 标“尚未产生”，不得提前执行受限改动来补证据；批准不等于 QA 通过；只阻塞依赖该决策的动作 |
| Team/project rules 明确 workflow scope、change/risk 分类、全部检查和人工 gate | V08–V11 | 查看、编辑完整规则与当前版本影响 | 未保存/冲突规则；缺少适用检查或 gate；不虚构风险阈值；agent 不可任意自分级 |
| Skills observer 给出可编辑提案，由用户决定采纳 | V12 | 查看观察依据、scope 和 diff；编辑/adopt/reject | 依据缺失；proposal stale；adopt 冲突；不得静默改 skills 或 project rules |
| 支持 private project、邀请与加入，并按 project scope 授权 | V02、V03、V13 | 设 private/invite；邀请、accept/join；查看有效权限 | pending invite、expired/revoked/denied；join host unavailable；scope 错配；不暴露本机目录或个人 credentials |
| 显示当前 subscription 并手动切换可用 subscription/account/config profiles；保留同一 work context 和 active worker 身份 | V06、V15、V05 | 查看当前 subscription/profile 状态与可选项；切换 default profile | quota exhausted；profile unavailable/incompatible；切换失败；running worker 身份不变；可继续或清楚说明无法 resume；无需 Billing 页 |
| 安全恢复与外部副作用对账 | V05、V09、V15、V16 | 查看 checkpoint 和外部结果；reconcile 后选择 resume/restart | host 状态 stale/offline；操作结果 unknown；merge/deploy/Slack action 可能已发生；重试前必须对账并显示已知副作用与剩余不确定性 |
| 成熟、可日用 UI，状态明确且控制一致 | 全部 views | 通过常见 search/filter/table/detail/action 完成任务 | 按场景覆盖 skeleton/loading、empty、permission denied、offline/stale、disabled、error/success、keyboard focus 与可恢复动作 |

## 跨 screen evidence 规则

- 同一个 work 有稳定身份，外部 source link 指回 Slack/GitHub 等权威来源；入口不同不产生重复 history。
- 每个 QA/release evidence 指明 revision、rules version、environment、责任与状态。missing、failed、pending、stale、unknown 是不同状态；Quality 提供实际失败证据与修复入口，Releases 提供质量门禁和 release receipts。
- Browser/app/computer QA 指明实际观察到的行为和证据；单纯 command exit code 不是该项证明。
- Review decision 只放行命中规则 gate 的具体动作；不代表 QA、merge、deploy 或 post-deploy verification 已成功。
- Host offline 时保留 context 并标出 freshness；不暗示本机 worker 离线期间仍在跑。Recovery 面向可读的影响/状态/下一步，并保留 side-effect reconciliation；原始事件仅为排障按需查看。
- integration owner 明确；worker 输出、冲突与最终集成结果可追溯。
- 外部副作用结果 unknown 时先 reconcile 再重试，防止重复发送、merge 或 deploy。

## Prototype gallery 分组

交付为同一 scrollable page 上的完整 16-view gallery，包含四张 2×2 sheet；每张图可放大到能读出表格字段、状态、source 与 evidence。保持以下图片名和分组：

| PNG | 2×2 views |
| --- | --- |
| `01-project-work.png` | V01 Portfolio · V02 Connect · V03 Project Workspace · V04 Work Map |
| `02-execution-quality.png` | V05 Work Detail · V06 Agents + Agent Detail · V07 Local Resources & Tools · V08 Quality Evidence |
| `03-delivery-learning.png` | V09 Releases · V10 Reviews · V11 Rules · V12 Skills Library + Proposal |
| `04-team-continuity.png` | V13 Members & Access · V14 Connections · V15 Execution Profiles · V16 Recovery |

UI 使用虚构数据，并区分 source of truth 与本地同步信息、操作状态与 QA evidence。图库仅用于 review，不声称能力已实现。

## 视觉约束与 scope

使用专业日常 operation UI：熟悉一致的 shadcn/Tailwind vocabulary，12–14 px 左右的数据文字、清楚层级、合理信息密度、可排序/过滤的操作表、selected detail、evidence 和明确 next action。状态兼顾文字/图标，不只靠颜色。Forest/cypress、gongbi、terrace、grain 等过去风格已解除为硬性要求；视觉根据操作可读性与团队日常使用来定。

不增加 sprints、metrics、billing、cloud/server runtime 或 formal workflow DSL。成熟度来自确认工作路径与关键失败/恢复状态能被实际检查，不靠膨胀菜单、卡片或伪流程。

## Review checklist

- [ ] Review 建议的 IA：16 个 operation views；一级 project nav 为 Work / Work Map / Agents / Quality / Releases / Settings。
- [ ] Review 建议的层级：Reviews 位于 Work exception queue；Global Overview / Profiles / Recovery；Connect 为 onboarding。
- [ ] Review 建议的 Settings 子 views：Rules、Skills、Members & Access、Connections 均有完整可 review UI。
- [ ] 检查四张 PNG 与 one-page gallery 中 16 views 是否全部呈现，图片是否可读、可放大。
- [ ] 逐行确认需求矩阵中的 action 与失败/恢复态可在 proposed screens 中辨认。
- [ ] 确认图像提案与实现/生产验收证据清晰区分。
