# Menoteam 背景研究：Lauren Tan、Grok Bots 与 agent workflow

研究日期：2026-09-28。供理解 [Menoteam product vision](menoteam-product-vision.md) 的背景材料；竞争事实不等于产品判断，公开视频自述也不等于独立验证。

## Lauren Tan、pstack 与 DUNE

Lauren Tan（GitHub: [poteto](https://github.com/poteto)）在 Cursor Compile London 演讲中自述上月约 2,000 PR；活动标题也使用 “last month”。演讲录制版的 00:15 幻灯片同样显示 2,000。较早 workshop 另有上月约 1,000、本月 12 日接近 800 的自述。数字来自不同时点与材料，不构成稳定生产基准；没有独立数量核实，也没有质量、回滚、漏检或 ROI 审计。PR 数量本身不是交付价值。[Cursor Compile London](https://cursor.com/compile/london) · [演讲录制版](https://x.com/poteto/status/2102050467505430555)

Menoteam 的 100+ agents 同时工作 是愿景中的容量目标，不是 Lauren 经审计的数据，也不代表当前能力或已验证容量。

**pstack** 是 Cursor 插件仓库中公开的 MIT 插件，包含多种 skills 与 playbooks；poteto-mode 会按任务挑选工作流。[插件目录](https://github.com/cursor/plugins/tree/main/pstack) 展示的可借鉴方法包括：把启动、健康检查、真实操作和结果证据写成 verification skill；用 Feature Map 导航用户入口；让独立 verifier 检查改动；盲评 skill 输出；把重复纠正编码为结构、类型和工具检查。[验证技能示例](https://github.com/poteto/verification-skill-example)、[创建验证技能](https://github.com/cursor/plugins/blob/main/pstack/skills/create-verification-skill/SKILL.md)、[结构化编码原则](https://github.com/cursor/plugins/blob/main/pstack/skills/principle-encode-lessons-in-structure/SKILL.md)。pstack 是公开方法与文件，不是完整 agent runtime；依赖、环境或团队流程不保证随插件打包，照搬不能保证复现其 PR 产量。

**DUNE** 在 workshop 中是 Grok Bot 内部 Electron 应用的架构原则集合。公开视频展示功能文件隔离、renderer 与 host/process 的类型化边界、状态唯一写入方，以及“小而明确的例外须作为架构改变审查”，以减少并行修改时共享注册表、重复状态和隐式跨层耦合。演讲 47:16–47:29 将 DUNE 说成一组理念；目前未找到 DUNE 公开源码，因此这是视频观察与作者自述，不是对 xAI 全部系统的审计，也不是可验证实现。Lean/TLA+ 等形式化方法仅属探索方向，现有材料不足以称其为 DUNE 已证实的组成或效果。[Workshop](https://www.youtube.com/watch?v=Cmoh-yR-usA)

这里讨论的是演讲中的 Grok Bot 工作流：**outer loop** 接收 Slack、监控及业务工具事件，再分派 cloud agents；执行与验证由 agents 及项目约束完成。不把它与 Grok foundation model 或 pstack runtime 混为一谈。视频展示的是特定团队实践；缺少公开实现、独立复现及质量/成本对照，无法推断普适 ROI。

观看范围说明：2026-09-24 已完整阅读两支公开视频自动字幕并核对选定 slides；本次沿用该复核，没有于 2026-09-28 重看。不是连续逐秒观看全片或逐句人工听写，字幕以画面核对为准。

- Cursor Compile 原始录制（X，38:01）：00:15 为 2,000 PR/月自述；27:15 展示 Feature/Entrypoint/Transcript card/Client/Host 概念；29:20 展示唯一写入方及两个 agents 分别新增功能文件；32:34–34:37 说明 Slack/监控 outer loop 分派 cloud agents；35:00 展示 Benny 的旧版复现、main 已修复结果。
- Workshop（YouTube，59:40）：37:00–37:12 自述架构迁移投入 600 多 PR；41:00 起谈 DUNE；47:44 slide 列出 Contract 原则；51:29 提到 AI lab 有 unlimited tokens。

这些是视频中的自述和演示，不是独立验证。[Cursor Compile 原始录制](https://x.com/poteto/status/2102050467505430555) · [Workshop](https://www.youtube.com/watch?v=Cmoh-yR-usA)

## 与现有产品的重叠

功能重叠说明客户已有替代路径，增加了获客与迁移门槛；它不自动否定 Menoteam 的愿景。竞争者的实际功能边界应按官方文档理解，预览/beta 也不能写成普遍可用。

- **Jira / Atlassian**：治理 agent loops 将既有 Jira 工作与执行、团队标准和 AI review 连接；Code Context 为 beta，governed loops 等部分能力处于 private early access。Atlassian 另有 Forge remote agents preview。故“Jira 只记录工作”已不准确，且可用性仍有阶段差异。
- **Linear**：coding sessions 可在 sandbox 编码、运行应用并用浏览器验证，支持产出 PR；agent 可由人作为 owner 委托并关联 Issue。每个 coding environment 对应一个 repo 的执行方式，不足以断言 Linear 无法协调跨项目工作。[Coding sessions](https://linear.app/docs/coding-sessions) · [Agents in Linear](https://linear.app/docs/agents-in-linear)
- **GitHub**：Issues、Projects、Actions 与 Copilot cloud agent 可以组合成工作流；cloud agent 单次运行围绕一个 repo，修改并提交一个 PR。这个边界支持验证跨仓衔接是否仍昂贵，不代表组织级协调不存在。
- **Glean**：Auto mode 可组合工具与 skills，并调用注册的第三方 A2A agents；Independent Agents 可持续处理共享工作，当前为 beta。企业搜索与 agent 能力已有交集。
- **Paperclip**：公开定位是管理由人和 agents 组成的组织。README 是产品说明；执行语义文档描述独立 review、resume 和 issue dependency wakeups，公开实现可见依赖解除唤醒逻辑。源码阅读只覆盖相关文件，不构成完整运行或生产可靠性审计。

因此 Menoteam 要证明的是：在配置良好的现有工具之上，仍能让某类工作减少协调与重复验收成本，同时质量不下降。跨仓版本组合、环境和可重跑验收是待测假设，不是无人覆盖的市场空白。竞争是可以接受的：Menoteam 拟提供的原生 agent 执行属于产品设计的核心，Paperclip 可作为对照或互补组件；集成支持与自有 agents 并行发展。若 repo skills、脚本或 connectors 已能达到同等效果，也应视为有效的简化路径。

## 注释来源

**一手作者/产品材料**

- 作者资料：[GitHub poteto](https://github.com/poteto)；数字口径见正文的 [Cursor Compile London](https://cursor.com/compile/london) 与录制版。Workshop 另有不同月份的数量自述，不能拼接成稳定 benchmark。
- pstack：[插件目录](https://github.com/cursor/plugins/tree/main/pstack)、[创建 verification skill](https://github.com/cursor/plugins/blob/main/pstack/skills/create-verification-skill/SKILL.md)、[skill eval playbook](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/playbooks/eval.md)、[shipping playbook](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/playbooks/shipping.md)。
- 视频复核来源与时间戳见上文；复核于 2026-09-24 完成，未做全程画面连续观察。

**竞品官方资料**

- [Atlassian governed agent loops 与可用状态](https://www.atlassian.com/blog/jira/governed-agent-loops)、[Forge remote agents preview](https://developer.atlassian.com/platform/forge/remote-agents-in-jira/)。
- [Linear coding sessions](https://linear.app/docs/coding-sessions)。
- [GitHub Projects](https://docs.github.com/en/issues/planning-and-tracking-with-projects/learning-about-projects/about-projects)、[Copilot cloud agent](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent)。
- [Glean Auto mode](https://docs.glean.com/agents/auto-mode-agent)、[Independent Agents](https://docs.glean.com/agents/independent-agents)。
- [Paperclip README](https://github.com/paperclipai/paperclip)、[API overview](https://docs.paperclip.ing/reference/api/overview/)、[执行语义](https://github.com/paperclipai/paperclip/blob/master/doc/execution-semantics.md)、[dependency wakeup 实现](https://github.com/paperclipai/paperclip/blob/master/server/src/services/issue-dependency-wakeups.ts)。文档/API 可说明产品接口范围，源码结论仅限已读文件，均未在此部署验证。
