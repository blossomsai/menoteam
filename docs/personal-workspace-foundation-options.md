# 个人工作台 foundation 选项

> Research snapshots and candidates, not selected dependencies or current UX requirements. See [current requirements](personal-workspace-requirements.md). Repository activity, capabilities and licenses below were not reverified during this documentation cleanup.

**2026-10-02 · Draft · provisional；产品底座尚未选定**

## 判断原则

把“产品体验与责任模型”和“本地 agent runtime / orchestration”分开评估。Menoteam 继续提供个人多项目 Master、Work Map、rules、团队项目边界与证据体验；基础设施优先复用官方 Codex 本地运行能力，再比较是否需要 Paperclip 一类控制面。开源体量、stars 和年限只是 adoption 信号；更有用的质量线索是当前维护活动、清晰的模块边界、可执行的 CI/typecheck/test/e2e 与恢复、安全契约。它们都不能单独证明质量或适配度。

## 候选比较

| 候选 | 快照与许可证 | 可对应的能力 | 与本项目的主要代价 / 未知 |
| --- | --- | --- | --- |
| [OpenAI Codex](https://github.com/openai/codex) | [GitHub API](https://api.github.com/repos/openai/codex)：2025-04-13 创建、2026-10-02 推送、127,562 stars、Apache-2.0。项目年限短于其高 adoption 所暗示的感觉。 | 官方本地执行入口：`codex exec resume` 可恢复 CLI 任务；[Codex App Server](https://learn.chatgpt.com/docs/app-server) 面向 rich client 提供认证、历史、approval 和 stream events；[developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli) 与 [credential store](https://learn.chatgpt.com/docs/auth) 提供命令和本地身份管理边界。现有 Codex runtime 是可复用的开源 foundation。 | 不提供 Menoteam 的 Work Map、成员/项目权限、GitHub/Slack 协作或集成 QA 流程。App Server 在账号、用量受限时的跨 profile/session 接续语义，以及 Desktop 与 CLI 的 session 共享，尚未证明。先验证原生接口是否覆盖恢复、切换、审批/工具事件，再决定是否需要自写 runtime 层。 |
| [Paperclip](https://github.com/paperclipai/paperclip) | [GitHub API](https://api.github.com/repos/paperclipai/paperclip)：2026-03-02 创建、2026-10-02 推送、96,010 stars、MIT；约七个月项目。Stars 显示关注度，不代表多年成熟。 | [README](https://github.com/paperclipai/paperclip) 描述本地 Node/React server、embedded PostgreSQL、agent/task 控制面；[Codex adapter](https://github.com/paperclipai/paperclip/blob/master/docs/adapters/codex.md) 支持同机 Codex 与 session continuity；[roles/invites](https://github.com/paperclipai/paperclip-docs/blob/main/docs/administration/roles-and-permissions.md)、[private deployment](https://github.com/paperclipai/paperclip/blob/master/docs/deploy/deployment-modes.md)、GitHub/Slack connections 可对应团队与连接需求。 | 自托管本地模式与“不新增托管服务/cloud execution”相容；但引入的组织/公司、agent hierarchy、控制面和数据库都要对照现有 Work Map 成本。现有 server 为 Express，而 Menoteam 为 Fastify。评估 extension/adapters 或有界 fork 是否能减少总自建代码与运维；不能因为它完整就默认迁移。可借鉴原子 checkout、持久 run、恢复记录、成员权限和审计。 |
| [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) | [GitHub API](https://api.github.com/repos/BloopAI/vibe-kanban)：2025-06-14 创建、2026-09-19 推送、28,241 stars、Apache-2.0。公司官方说明项目将由 community 维护。 | [README](https://github.com/BloopAI/vibe-kanban) 与 [官方文档](https://vibekanban.com/docs/supported-coding-agents) 显示本地 Codex CLI、并行 workspace、diff review、browser preview/devtools、inspect 与 device emulation；适合作为隔离并发和集成 QA 交互的具体参照。 | [Bloop 停运说明](https://www.vibekanban.com/blog/shutdown) 明确其远端 issues/comments/projects/organisations 服务会停用，local workspaces 继续可用；不应把旧团队云功能当作首期 private invite 基础。Rust + TS 项目也不是现有 Fastify app 的轻量嵌入件。社区后续维护力度仍需观察。 |
| [OpenHands / Agent Canvas](https://github.com/OpenHands/OpenHands) | [GitHub API](https://api.github.com/repos/OpenHands/OpenHands)：2024-03-13 创建、2026-10-02 推送、89,770 stars、MIT。仓库年限不等于当前 Canvas 子产品同等成熟。 | [当前 README](https://github.com/OpenHands/OpenHands) 说明 Canvas 可本地运行、通过 ACP 使用 Codex，并有 Slack/GitHub automation 和不同 agent backend；可参照本地控制面、runtime 切换和集成入口。 | Canvas 包含 frontend、agent server 与 automation backend；即使全在本机运行，仍增加一套服务和 runtime 面。团队 invite/member 是否满足本项目的 private per-project join，本轮未确认。局部复用需先划清 ACP、服务和数据边界。 |

## 暂定方向

优先做 **Menoteam product layer + 原生本地 Codex foundation** 的 bounded proof：首期在本地 Codex 执行，GitHub 与 Slack 必须可用；未来可评估 shared web host。保留现有项目、Work Map 和团队 scope；先尝试 App Server / CLI 的官方 resume、session/history、auth 与事件接口，runner 只负责把 Menoteam work 映射为本机 Codex 运行并持久化结果。当前单一本地 coordinating host 是建议，远端成员访问路径需验证。参考 Paperclip 的 run/ownership/recovery 契约和 Vibe Kanban 的 worktree/QA review；不复制其完整产品模型。Paperclip 仍是可认真评估的 orchestration foundation：若对照证明扩展或有界 fork 比本地实现成员邀请、持久恢复、并发控制与证据记录更少自建代码、更低维护负担，可选它；不能先验排除。

判定不以“能启动 Codex”或 CLI exit code 为准。验证应覆盖同一条真实反馈从 **Master → 多个隔离本地 workers → 集成 revision 与完整 required checks → 远端 merge → deploy → 部署后验证** 的闭环，并覆盖小改动自动推进、大改动按项目 rules 指定审核点等待人工 review、手动 profile 切换后恢复，以及受邀成员的项目 scope 和 Slack/GitHub 事件。发布前完整运行团队/项目规定的全部 required tests、lint 和 QA；agent 不得按 diff 选择性省略。流程与检查证据绑定集成 revision、rules version 与 environment；小改动满足项目 change/risk rules 和完整质量门槛后自动 merge/deploy，无例行人工 Accept。大改动可先自主调查并准备 review 材料，但审核通过前不执行项目 rules 限制的动作。验证 QA 必须接入实际授权的本机 browser/native/computer tools；不能假设 Codex Desktop 的工具、会话或身份自动继承到 CLI/App Server。背景研究中的 Lauren Tan、pstack 与 DUNE 只作方法参考；DUNE 部分来自公开视频观察，既有背景研究未找到公开实现，不据此声称通用框架。方法上可参考 project rules、verification / Feature Map、独立 verifier QA，以及通过功能边界与唯一写入责任减少并行耦合；skill observer 提出改进，由用户编辑或采纳。见[背景研究](menoteam-research-background.md)。比较各选项新增的自有代码、服务、数据模型和恢复状态后再选 product base。

**已核验事实**：日期、push 时间、stars、license 来自上述四个 GitHub 官方 API 仓库记录；产品能力与约束来自各自 README/官方文档或维护者公告。**架构判断**：兼容度、应复用范围、MVP 验证闭环与相对维护成本是基于当前 Menoteam 需求的推断；未完成集成试验前不作兼容或成熟度保证。

## Model providers 候选（2026-10-05）

[Hermes Agent provider adapters](https://github.com/NousResearch/hermes-agent/tree/main/providers) 是值得优先验证的 reuse candidate，可先评估提取现有 adapters，避免假定要从零构建。其 `ProviderProfile`、`plugins/model-providers/<name>/` 与 registry 覆盖统一 profile、provider adapter 和注册/路由；但实现依赖 `hermes_cli/auth.py`、`runtime_provider.py`、agent/transports，部分 provider 还需专用 token resolution。估工期前应先验证 extraction/dependencies、authentication refresh、license 和目标 runtime compatibility。未来真实 provider implementation 先做小范围 proof；目前未安装或集成，不代表容易复用，也不能从 Hermes 支持某 provider 推断本地 Codex runtime 可用。

## Always-on work reference（2026-10-05）

[OpenMuse](https://github.com/CopilotKit/openmuse) 的 README 自述其处于 Alpha，并列出 durable task plans、progress/input requests、pause/resume/cancel/retry、saved receipts、SQL leases recovery、带去重 alerts 与 failure backoff 的 goals tracking、personal context/background-update preferences，以及主/side chat 持久化 RichThreads；后者依赖 CopilotKit Intelligence project key（该 service 不属于 repo 的 MIT scope）。它也有自己的 server、task worker、browser worker。以上是 README claims，不是已核验的代码或 runtime proof；可作为机制候选，后续需验证与 local Codex 的集成、持久化/调度能否拆分，以及依赖边界。Alpha 不能作为 production maturity 证明。

用户提及的 Muse、Grok bots、OpenAI dots 是 UX reference，不代表本产品已有相同功能。未来 Master 可探索持续的 project context/goals、event/scheduled wakeups、background work/recovery、克制的主动汇报，以及将新输入接回已有 Work，并受 project rules/approval bounds 约束。这里的 always-on 指持续责任与可靠唤醒，不是无限模型循环或给每个 agent 新建环境；不因此引入完整 personal-assistant UI 或云依赖。

## Codex conversation UX reference（2026-10-05）

[OpenAI Codex](https://github.com/openai/codex) 可作 conversation UX / future integration reference：Project Master conversation 持续保留；right content panel 默认关闭，用户显式点击 Work、source 或 result 后打开，关闭后回到 conversation；新消息不抢占已打开的 panel。当前 Work detail 默认显示右侧 Agent/Master/subagent 对话，不再使用 “Talk to agent” 入口。这是产品体验方向，不表示可复用 Codex Desktop panel 源码或已接通 Menoteam backend。
