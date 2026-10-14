# 工作台 · 当前导航与页面合同

2026-10-06。替代 16-view proposal。以下是 [V3 原型](prototypes/2026-10-02/team-workbench-v3/README.md) 的 10 个 review views；review gallery 不是产品一级菜单。

| View | 页面 | Breadcrumb / 标签顺序 |
| --- | --- | --- |
| V01 | All projects | Workspace → All projects |
| V17 | Project Master | Project → Master |
| V03 | Work list | Project → Work |
| V05 | Work detail | Project → Work → Work ID |
| V02 | Connect project | Workspace → Connect project |
| V11 | Project instructions | Project → Project settings → Instructions |
| V12 | Skills | Project → Project settings → Skills |
| V13 | Members | Project → Project settings → Members |
| V14 | Connections | Project → Project settings → Connections |
| V15 | Workspace settings | Workspace → Workspace settings → Agent profiles / Model providers |

Sidebar：All projects；各项目展开 Master、Work、Project settings；底部 Add project、Workspace settings。顶部不重复显示搜索和用户头像。

Project settings tabs：Instructions / Skills / Members / Connections。
Workspace settings tabs：Agent profiles / Model providers。
Work detail tabs：Overview / Changes / QA。Related 位于 Overview，Delivery 按需出现。左侧工作内容，右侧参与者对话；默认同时显示。

## 交互

- All projects 的每张 card 展示完整对话，独立滚动并固定 composer。单个项目 Master 与它共用项目历史和草稿。
- Project Master 不重复 project tabs，按需打开右侧 Work/source 内容；新消息不抢占该 panel。
- Work row 直接到对应详情；New work 到项目 Master 并预填草稿，不自动发送。
- 默认头像取名称首字符；Master 专属对话无需每条重复角色名，多参与者 Work 对话显示名称。
- 单行 capsule composer：plus、输入、microphone、send。附件/语音不执行真实操作。
- Changes 文件默认折叠；展开后显示红绿行与增删计数。QA 的证据按需展开。
- 不提供 Ask Master、Chat with Agent、重复返回/Work list 按钮、待审 banner 或 copy 操作。

## 已撤销页面

V04 Work Map 合并到 V03。V06 Agents、V08 Quality、V09 Releases、V10 Reviews 不再是独立页面；职责归入 Work detail / conversation。V07 Local environment、V16 Recovery 不再是设置目的地。旧 URL 仅作兼容，不能据旧 view ID 恢复已撤销功能。

## 范围

这是导航与设计合同，不是数据库 schema 或真实集成验收。V3 部分非 Field Notes 项目设置仍是 bounded sample，不代表完整多项目功能。
