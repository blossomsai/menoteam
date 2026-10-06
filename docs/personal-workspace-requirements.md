# Menoteam 工作台 · 当前需求

2026-10-06。当前产品依据；取代旧的 16-view、Scope review、固定 Rules 表单等方案。界面合同见 [屏幕规格](personal-workspace-mvp-screens.md)，实现边界见 [V3 README](prototypes/2026-10-02/team-workbench-v3/README.md)。

## 核心

每个项目有持续的 Master，维护上下文、协调负责 Agent 和 subagents。用户可通过对话提出目标、修改优先级和补充约定。Work Map 是组织工作与上下文的概念，不是额外的图页面或一套强制数据库字段。

每项 Work 有简短、自由文本的 Overview，反映当前有效的目标和必要限制。只有约定变化才更新；未确认的建议保留在对话中。对话保留讨论与决定的历史。没有独立 Notes、Scope 页面或普通范围澄清审批流。

## 对话与工作

- All projects：每项目一张完整对话 card，独立滚动、底部固定单行 composer。宽屏两列，窄屏一列。
- Project Master：一个项目的完整对话，占用可用空间；没有 project tabs、重复状态条、Ask Master 或 Work list 按钮。
- Work detail：左侧 Overview / Changes / QA，右侧默认显示 Agent、Master、subagent 和用户的对话。不需要 Chat with Agent。
- 多参与者消息显示名称和名称首字母头像。时间戳 hover 显示并保留布局空间；Agent 时间在消息右侧，用户时间在左侧，无 copy 按钮。
- New work 打开该项目 Master，预填可编辑的 “Help me plan a new work: ”，不自动发送。
- Work list 使用 All / In progress / Paused / Done；Queued 示例仍可在 All 查看。复杂内部阶段不扩展一级导航。

## 工作成果

Overview 包含任务定义、当前情况与 Related 来源；涉及发布时显示简短 Delivery 状态和默认折叠的详情。Changes 显示文件路径、增删行数、红绿 diff 和行号；文件默认折叠。QA 展示测试、检查、失败原因及证据。测试通过不等于部署，部署不等于实际流程验证通过。研究/文档工作不强制出现 Release。

## 设置

- Project instructions：自由文本项目长期约定，placeholder 和可选建议可插入编辑；保存前不应用。没有固定 scope、change classification 或审批模板。具体项目仍可明确规定必要确认和质量要求。
- Skills：已安装列表；Add skill 提供 Create、GitHub URL、Marketplace，区分 skill 和包含多个 skills 的 plugin。Observer proposals 暂不提供。
- Members：邀请管理。没有公开搜索、Join request 或 Private project 开关。
- Connections：项目的 GitHub、Slack 等来源连接。
- Agent profiles：工作区复用的模型、skills、工具偏好。
- Model providers：可添加多个连接，显示 provider、名称、连接方式、状态和默认标记；不叫 Codex accounts。认证方式和 runtime 兼容性留待实现验证。
- 不提供 Local environment、Appearance 独立设置。执行环境能力仍可能必要，但不等于必须有独立页面。

## 后续实现能力（不是当前已交付）

Master 能扫描获准的 PR/issues/Slack feedback：相关消息归入已有 Work，独立目标建立新 Work，保留来源与回溯。匹配不明确时澄清，不能因为新增消息就静默扩大任务或权限。

Master 能通过对话修改当前设置、创建或添加 skills，并让设置页面显示同一份配置。遵从实际用户权限和项目/工作区归属；凭证连接使用相应授权入口。

保留持续上下文、唤醒、接续、并行协调和质量验证的产品目标。具体 runtime、持久化、调度、授权与 provider 支持尚待实现。不能从静态页面推断生产闭环已可用。参考 [foundation candidates](personal-workspace-foundation-options.md)，不将参考项目当已选定依赖。

## 当前范围

当前只做 English design prototype，使用 React + Tailwind CSS + shadcn/ui，无自定义组件 CSS。附件与语音仅为 icons；未来语音方向是转文字、用户编辑后发送。不是现在实现真实上传、录音、认证、安装或部署。
