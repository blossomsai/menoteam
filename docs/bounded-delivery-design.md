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

Repository、base branch、PR number、head SHA、deploy command/host 均从已保存的 project/candidate/operation 推导，不由模型任意指定。增加一个 `wb_delivery_operations` 表，而不是新的业务 Work 类型或 broker：project/work/actor/candidate ID、action、phase/status、generation/lease、external IDs、error，唯一键 `(project_id, request_id)`。DB 事务只记录/claim/fence；GitHub/Git/CI 网络操作在事务之外执行。

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

1. Luna 实现固定 branch publication + PR creation、operation table/lease/outbox 与 Changes/Overview 连接；Sol review scope/credential/remote mutation/idempotency。真实 disposable branch 验证 create/retry/restart，一次请求只得到一个 PR，不修改当前主 checkout。
2. Luna 增加 structured reviewer disposition 与 same-candidate delivery gate；Sol 验证 stale QA、changed PR head、revoked actor、insufficient review、base/integration changes 全部阻止 merge。先在 disposable PR 证明保护行为，之后才配置已授权的实际 branch。
3. 接一个真实 staging target，证明 exact merge SHA、重复请求、disconnect/restart、failed deploy 和 post-deploy flow evidence。Production policy 未配置时明确 unavailable；不因此创建额外 tab、approval page 或 generic workflow engine。

现阶段缺口：真实 GitHub write credential 未验证；repository protections/required checks 未核实；structured review disposition 未实现；durable delivery operation/executor 未实现；runtime staging target 未绑定；real deploy/post-deploy proof 未完成。因此 A14 保持 Pending，不能从129 tests 或 operator staging 推断为 Proven。
