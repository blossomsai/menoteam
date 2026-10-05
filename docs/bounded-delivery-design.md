# A14：基于现有 Work 的最小 Delivery 增量

状态：architecture proposal，尚未实现。Reviewer baseline 为 `c50d855`；本文件不授权任何自动 merge/deploy。

## 当前可复用的基础与真正缺口

现有 `Project.repositoryUrl` 已绑定 GitHub repository；`Run.requestedBy`、actor membership、run lease/generation、source intake 的有限 `allowedActions` 可复用。Connector 已有 isolated Work checkout、checkpoint commit、完整文件 fingerprint、diff identity、review target affinity 和 durable outbox。`Artifact.kind='delivery'` 与 Overview 已能承载交付结果，不需要 Release 页面或 Scope 审批。

现有 `deliveryAuthorization` 是 prompt context，不是权限。当前还没有发布 branch、创建 PR、merge、deploy 的 executor；`WORKBENCH_GITHUB_TOKEN` 只用于 source retrieval，不能假定其有写权限。QA 记录指纹，但 review 目前只有文字结果，没有可验证的 `approved / changes_requested / insufficient_evidence` disposition。Operator staging Menoteam 的动作不能算 Work runtime 具备 delivery 能力。

## 一个操作接口，一条已有队列模式

新增 Master tool `request_delivery` 与同一 browser API `POST /works/:id/delivery`。二者使用相同 service，返回 durable operation ID；不直接运行模型提供的 shell。参数只接受：

```ts
{
  candidateRunId: string;
  candidateRevision: string; // 现有 diff identity
  action: 'create_pr' | 'merge_pr' | 'deploy';
  targetId?: string;         // 仅配置好的 deployment target
  requestId: string;
}
```

Repository、base branch、PR number、head SHA、deploy command/host 均从已保存的 project/candidate/operation 推导，不由模型任意指定。第一步复用 `wb_records(kind='run')` 与现有 Run queue/lease/outbox，不新建 delivery table/engine/broker。固定操作 run 使用 internal `kind='delivery'` 与 validated `operation.action='create_draft_pr'`，不调用 LLM、不套 Agent profile，也不新增 UI tab。模型选择只对 native run 生效，delivery claim 要求明确的 Git/GitHub capability。DB 事务只记录/claim/fence；GitHub/Git 网络操作在事务之外执行。

每次 effect 前检查原始 actor 当前权限与 project grant。Source intake 默认没有该 action。Reviewer 仍只有证据读取；Master 不能通过自由文本 Instructions 或普通 `update_settings` 悄悄启用 merge/deploy。

## 权限只补在现有 connection，不做新审批产品

在现有 project GitHub connection 中增加严格验证的 delivery policy：固定 repository、base branch、是否允许 create PR / merge、允许的 deployment target IDs、required check names。只有 project owner/admin 可以改；安全配置与自由文本 Instructions 分开。默认 merge/deploy 未开启；运行时只按当前保存的配置执行。用户可以在原 conversation 明确一次授权或设置长期授权，记录原 message ID 与 configuring actor，随后 Master 在授权内工作，不需要逐项弹出新的 Scope 流程。

用户已经授权团队完成 Menoteam、使用提供的 server 并部署，因此本任务的 operator staging 不需重复索要授权。但 durable app 仍需记录该授权对应的 repository/branch/target；现有 operator 身份不是任意项目、任意成员或后续每个 Work 的通用权限。Slack outbound、其他 repository、未知 production target 不包含在这份授权里。

凭据保留在 operator/Connector protected configuration 或 server secret store；模型只看 capability 状态，不拿 GitHub token、SSH key。第一版支持一个实际配置好的 GitHub 凭据与一个 target 即可，先验证权限，不做 provider/secret-management 平台。

## 三个固定操作

### 1. Create PR：先交付一个可 review 的真实结果

绑定原 implementation Connector 的 saved checkout。重新检查 registered Work mapping、candidate commit、clean status、完整 fingerprint 与 diff identity；拒绝改过的候选。确认 push URL 与 `Project.repositoryUrl` 一致，固定 branch 为 `codex/menoteam/<workId>/<candidateShaPrefix>`。只新建该 branch，或接受已存在且 SHA 完全相同的 branch；不 force-push、不修改主 checkout、不由模型选择 remote。

发布 branch 后记录 remote head SHA，再按相同 head/base 查找或创建 PR，body 带 operation ID 作为 retry marker。网络 timeout 后先查询远端 branch/PR，不能假定失败再创建第二份。使用已有 Artifact delivery 保存 PR URL/number、candidate SHA、base、operation ID；Changes 显示 PR，Overview 显示 Created。PR creation 可在 QA 未全通过时以 draft 状态提供 review，不伪装为可 merge。

### 2. Merge：消费证据，不解析「看起来没问题」

增加一个严格 validated review result，至少包含 targetRunId、candidate SHA、fingerprint、disposition、finding IDs。由实际 reviewer run 返回，Connector/server 验证 target binding 后存入 QA；Master 自己的总结不能替代。只有 `approved`、required QA checks 全通过且绑定相同 fingerprint、无未解决 blocking findings 才允许 merge。`insufficient_evidence` 必须阻止自动 merge。

从 delivery operation 推导 PR，重新读取 GitHub head SHA；merge 请求带保存的 candidate SHA，head 换了就失败。GitHub merge API 支持 `sha` precondition，head 不符返回409。保留 repository branch protection/merge queue/CI 规则，禁止 bypass。见 [GitHub merge API](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request)。

不能把 reviewed head 等同于最终 integrated bytes：base 变化可能改变合并结果。最小支持方式是使用 repository 已配置的 up-to-date required checks 或 merge queue，检查实际 integrated candidate。没有已验证的保护/集成检查时先不启用自动 merge，而不是用本地的「测试通过」冒充集成验证。记录 actual merge commit SHA；后续 deploy 必须针对这个 SHA，而不是继续使用原 PR head。

### 3. Deploy：先接一个固定、可回查的 target

只允许配置好的 target adapter；优先使用已有 repository CI/deployment workflow，不把任意 SSH/shell 作为模型工具。Target 固定 repo、workflow/environment、已允许的参数与 verification URL；执行 exact merge SHA，保留现有 environment protections。若没有这样的 pipeline，先由 operator 建立一次，不要把目前的手工 staging script 直接包装成任意远程命令。

可用 GitHub Deployment 记录 exact SHA、environment、operation ID，并禁用其 `auto_merge`，避免交付过程中悄悄换代码。Deployment API 接受 SHA，但创建 record 只代表请求，需要实际 target executor 与完成状态。见 [GitHub Deployments API](https://docs.github.com/en/rest/deployments/deployments#create-a-deployment)。

部署、transport retry 与 process restart 后按 deployment/workflow ID 回查；返回 accepted/queued 不等于 deployed。记录 resulting build digest、commit、deployment ID、实际运行版本。Deploy success 后再做既定健康检查与实际用户流程验证，QA 留证；Overview 显示 `PR → Merged → Deployed → Verified`，没有部署环节的 Work 不出现这条状态。

## 可执行拆分与验收

1. Luna 实现固定 branch publication + Draft PR creation、复用 Run queue/lease/outbox 与 Changes/Overview 连接；Sol review scope/credential/remote mutation/idempotency。真实 disposable branch 验证 create/retry/restart，一次请求只得到一个 PR，不修改当前主 checkout。
2. Luna 增加 structured reviewer disposition 与 same-candidate delivery gate；Sol 验证 stale QA、changed PR head、revoked actor、insufficient review、base/integration changes 全部阻止 merge。先在 disposable PR 证明保护行为，之后才配置已授权的实际 branch。
3. 接一个真实 staging target，证明 exact merge SHA、重复请求、disconnect/restart、failed deploy 和 post-deploy flow evidence。Production policy 未配置时明确 unavailable；不因此创建额外 tab、approval page 或 generic workflow engine。

现阶段缺口：真实 GitHub write credential 未验证；repository protections/required checks 未核实；structured review disposition 未实现；durable delivery operation/executor 未实现；runtime staging target 未绑定；real deploy/post-deploy proof 未完成。因此 A14 保持 Pending，不能从129 tests 或 operator staging 推断为 Proven。


## 当前批准的第一个增量：只有 Create Draft PR

本阶段不实现 merge/deploy；上述两步保留为后续必须完成的 A14 增量。Master `request_delivery` 当前只接受 `{workId,candidateRunId,candidateRevision,action:'create_draft_pr',requestId}`。Browser 共用同一 service。返回 queued delivery Run，现有 claim/event/complete 恢复路径处理它；completion 仍唤醒同一个 Project Master。`targetConnectorId` 必须是原 candidate Connector，review/Master lease token不能执行此操作，source intake没有创建PR的权限。

服务端从目标 diff artifact 的 `candidateRevision` 解析 Git commit SHA，从 QA artifact 获取完整 `candidateFingerprint`，不能把 diff identity 当作 Git SHA。保存不可变快照：project/work/actor、candidateRunId、artifactRevision、commitSha、fingerprint、baseRevision、configured baseBranch、deterministic remote branch、operation phase和 external result IDs。原 Run lease/generation、actor reauthorization、同 Work writer reservation、`wb_requests` idempotency 与 outbox皆复用。新增的数据只是 Run.operation 和 delivery artifact，不造第二套 queue。

双层 dedup：client `requestId` 保持重试稳定；server另用 `(projectId,workId,candidateRunId,commitSha,'create_draft_pr')` canonical key记录 wb_requests，使 Master用新requestId再要求同一candidate时也返回同一delivery Run。GitHub副作用不能靠DB宣称 exactly-once：固定 remote branch，push前检查 absent/exactSHA；每次创建PR前按head/base查询，PR body带operation marker；timeout后先回查而非盲重做。分阶段保存 `queued → published → pr_created` 与 GitHub IDs。

执行器只读取已注册 candidate checkout；确认 clean、HEAD exact SHA、full fingerprint、artifactRevision、remote URL全匹配。只 push固定branch上的exact commit；无force-push、无任意remote或模型shell参数、不重写当前主checkout。创建 `draft:true` PR，返回其真实URL/number/headSHA。PR body仅使用Work标题、明确的变更/验证摘要和operation marker，不自动导出完整聊天。没有GitHub write capability时明确 unavailable，不把existing read token假装可用。

Draft PR不是merge approval：没有全绿QA也能提供review对象，但必须展示真实失败/unknown状态。Merge/deploy和structuredreviewdisposition在本阶段保持未实现；不把Draft PR成功写成Done或Delivered。

### 独立验证合同

- Real PG：并发请求/requestId重试/换requestId但samecandidate只产生一个delivery Run；角色撤销、别项目candidate、伪造revision、已失效connector拒绝；队列/lease过期不重复native execution。
- Git测试：changedHEAD、dirtycheckout、changedfingerprint、remote不同、同branch不同SHA均拒绝；正常case只发布exactSHA，主checkout与其它Work不变。
- HTTP fault tests：push/PR创建成功后丢response，重启仍回查同一branch/PR；phase证据落库后不重复效果。Mock结果不替代realPR proof。
- Real disposable Draft PR：通过Menoteam实际Master请求，原Connector发布，GitHub查询确认 `draft=true`、headSHA正确、base正确；retry只返回同一PR，Changes/Overview可查看。这个结果只能证明A14的PR子步骤。

## Profile/Skill 的最小完整用户路径（待确认，未实施）

PRODUCT/requirements 规定 Agent profiles 是 workspace 复用的 model/skills preferences；当前 UI 仅在 Project settings 创建 project skills。只过滤 global skills 会留下空控件，不是完整修复；自动给 profile 加 projectId 又会把一套 reusable profiles 拆成多套。

保持一套 workspace profiles：在 profile 创建/编辑表单旁提供 inline `Create reusable skill`，复用已存在的 `POST /settings {kind:'skill',name,data}`（无 projectId）和 workspace-admin 权限；新 global skill 自动选中。没有 global skills 时显示这个入口，或允许只选 model/reasoning 创建 profile，不呈现无内容的多选控件。Project settings Skills 保留项目技能的创建/import/list，不增加 tab 或设置层。

如需复用已安装的 project skill，由同时有源项目访问权与 workspace 管理权的用户显式 `Copy to reusable skill`，创建新的 global ID、保留来源引用；不 silent promote 原 skill，也不随意暴露未授权项目内容。第一步的完整路径可以只实现 inline text creation，GitHub import/copy 沿用同一 storage service 后补，不能提前显示不可用控制。

Workspace profile create/patch 即验证每个引用存在、kind='skill'、无 projectId；UI仅列出 global skills，makeRun仍重验以防历史数据/删除。旧非法引用明确报告skill ID，并允许管理员选择global replacement或显式copy后修正，不silentdrop、不在另一个Projectdispatch时才失败。不自动注入全部projectskills，不新增Work/profile设置层。
