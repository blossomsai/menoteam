# A14：基于现有 Work 的最小 Delivery 增量

状态（截至集成候选 `c082127d71ccbcf16b7affb79154b90b2e87ec37`）：固定 Connector executor 可通过 Master 请求创建 Draft PR；真实 PR #3 证明了旧候选的 Draft PR 子流程，但该候选早于当前集成版本，不能作为当前应用的发布候选。原生 `merge_pr` 能力正在开发；`deploy`、部署后验证和版本回滚尚未实现。这里的真实状态以 acceptance ledger 的最新记录为准。

历史基线：以下 2026-10-06 初始检查针对 shared backend `080e485f651ae2fd1d4a457f4c85620cd281b358`（包含 validation checkpoint `59c78c416e5989a4e31224d368f0a19edec5bcb4`），当时确实没有 `request_delivery` route/tool 或固定 delivery executor。该段只记录当时的状态，不代表当前能力。本文件不执行或授权新的远端副作用。

## 当前可复用的基础与真正缺口

现有 `Project.repositoryUrl` 已绑定 GitHub repository；`Run.requestedBy`、actor membership、run lease/generation、source intake 的有限 `allowedActions` 可复用。Connector 已有 isolated Work checkout、checkpoint commit、完整文件 fingerprint、diff identity、review target affinity 和 durable outbox。`Artifact.kind='delivery'` 与 Overview 已能承载交付结果，不需要 Release 页面或 Scope 审批。

现有 `deliveryAuthorization` 是 prompt context，不是权限。固定 branch publication 和 Draft PR executor 已实现；真实 PR #3 只证明旧候选的 PR 创建子流程，不证明当前 `c082127` 集成版本已发布。原生 `merge_pr` 正在开发，deploy executor 尚未实现。以 `c082127` 为基线，QA 已记录候选指纹，但 review 结果仍是自由文本，缺少绑定同一候选的可验证 `approved / changes_requested / insufficient_evidence` disposition。Operator staging Menoteam 的动作不能算 Work runtime 具备 delivery 能力。

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

## Profile/Skill 的最小完整用户路径（已实现基础，browser 验证仍待完成）

PRODUCT/requirements 规定 Agent profiles 是 workspace 复用的 model/skills preferences；此前 UI 仅在 Project settings 创建 project skills；当时只过滤 global skills 会留下空控件，不是完整修复。这个历史问题已由下面的 inline reusable skill 路径解决；自动给 profile 加 projectId 又会把一套 reusable profiles 拆成多套。

已集成于 `a6c326b66956591ee7fc5876c2f8838a067aaeaa`：保持一套 workspace profiles，在 profile 创建/编辑表单旁提供 inline `Create reusable skill`，复用已存在的 `POST /settings {kind:'skill',name,data}`（无 projectId）和 workspace-admin 权限；新 global skill 自动选中。没有 global skills 时显示这个入口，或允许只选 model/reasoning 创建 profile，不呈现无内容的多选控件。Project settings Skills 保留项目技能的创建/import/list，不增加 tab 或设置层。

如需复用已安装的 project skill，由同时有源项目访问权与 workspace 管理权的用户显式 `Copy to reusable skill`，创建新的 global ID、保留来源引用；不 silent promote 原 skill，也不随意暴露未授权项目内容。当前已实现 inline text creation，global GitHub import/copy 尚未实现；project GitHub import 是独立已验证 API 路径。后两项复用同一 storage service 后补，不能提前显示不可用控制。

已实现的 backend guard：Workspace profile create/patch 即验证每个引用存在、kind='skill'、无 projectId；UI仅列出 global skills，makeRun仍重验以防历史数据/删除。旧非法引用明确报告skill ID，并允许管理员选择global replacement或显式copy后修正，不silentdrop、不在另一个Projectdispatch时才失败。不自动注入全部projectskills，不新增Work/profile设置层。这个集成 checkpoint 已通过真实 PostgreSQL full suite 132/132 与 typecheck/build；后续133-test checkpoint属于后续tree，不能倒算为本commit结果。Browser profile创建/编辑与真实run复用仍需要独立观察。


## Draft PR 之后必须完成的增量：Merge → Deploy → Verify

以下是下一项可实施 specification，不是现有能力。A14 不会因 Draft PR 成功而缩小为 PR-only；完整目标仍包含经过授权的 merge、真实 deploy、用户流程验证和失败恢复。先复用已验收的 Draft PR operation 格式，再增加两个固定 action；不要先造通用 delivery engine。

### 现有代码边界与最小修改面

当前 shared backend 的 `actorAuthorized` 仅验证原始 actor 存在/项目 membership，**不足以授予 merge/deploy**；`leased` 验证 connector grant/lease/generation，也不能代替 delivery 权限。必须在同一 settings/membership 事务边界下，追加 delivery action 的 owner/admin + 当前严格 policy 检查。现有 artifact endpoint 接受 unknown data，review approval 与 delivery receipt 需新增 kind-specific validated shape，不能让 implementation/Master 伪造 reviewer approval。复用现有 `wb_records`、`wb_requests`、Run queue、租约、outbox、原 Master completion wakeup；无需新表、新 broker、新页面。

实施分配：Luna 在固定 delivery executor 与严格 schema 上增量实现；Sol 独立审查授权、external-effect retry 与 exact candidate 绑定。Frontend 只在 Overview/Changes 显示来自 delivery artifacts 的实际阶段和失败原因，不用 native run completed 推导 Delivered。测试先 fake GitHub/target fault injection，再用真实 disposable PR 和 isolated staging target 验证；不能以 mock 替代真实闭环。

### 一个 repo policy，一条 exact-candidate 请求

复用现有 project GitHub connection，严格保存 `repository`, `baseBranch`, `mergeMethod`, `allowedActions`, `requiredChecks`, `deploymentTargetId`, `configuredBy`, `authorizationMessageId`, `updatedAt`。这条结构化记录由已授权 owner/admin 设置；自由文本 `deliveryAuthorization` 仍只是 context。`authorizationMessageId` 是依据引用，不是任意用户写一句话即可获得权限。无需 Scope 审批页面：同一 conversation/settings 操作可以表达现有授权，但服务端必须确认 configuring actor 的真实权限。

在现有 delivery request 中使用：

```ts
// workId 在既有 Work route 或 Master tool 中绑定。
{ action: 'merge_pr', priorDeliveryRunId, reviewRunId, requestId }
{ action: 'deploy', priorDeliveryRunId, targetId, requestId }
```

`merge_pr` 仅消费已保存的 PR-creation receipt；`deploy` 仅消费同 Work 的 verified merge receipt。服务端推导 repo/PR/head/base/merged SHA，模型不能传任意 URL、branch、host、command、image tag 或替换 candidate。保存不可变 operation snapshot + current policy reference；role/policy/connector grant 每次 effect 前复核，policy 更新不会把旧 operation 自动升级授权。复用 canonical idempotency key：merge 为 `(project,PR,expectedHeadSHA,action)`；deploy 为 `(project,target,mergedSHA,action)`。相同请求返回同一 operation；失败/unknown 不靠新 requestId 随意再执行。

Source intake 默认不包含这两个 action；reviewer read-only token、普通 member、跨项目 Master、过期 lease 均不得执行。GitHub read credential 不得因配置里写了 allowedActions 就被视为 write credential。Connector 只接明确 delivery capability；原 native agent 获得普通 shell 能力不代表获准执行 merge/deploy。

### Merge gate：三个身份不能混为一谈

保留 `artifactRevision`（diff identity）、`candidateFingerprint`（文件内容）与 `candidateSha`（Git commit）三个字段。增加最小 reviewer QA result：

```ts
{ targetRunId, candidateSha, candidateFingerprint,
  disposition: 'approved' | 'changes_requested' | 'insufficient_evidence',
  findings: [{ id, blocking, summary }], evidenceArtifactIds }
```

服务端只接受当前有效 `kind=review` run 在其 assigned candidate 上提交此结果；evidenceArtifactIds 必须同项目/候选、原始 QA 检查是实际记录，不由模型 invent。Approval 只能表达 reviewer 判断，不能把 command exitCode/unknown checks 改成 passed。所有 required checks 必须 bound to full candidate fingerprint、exitCode=0、非 stale；存在 blocking finding 或 evidence 不足即拒绝。后续实现改变 bytes/head 后需要新 review，Master 不能通过修改 finding 文本消除 gate。

PR 必须同 configured repo/base，非 closed-unmerged，head 等于 reviewed candidateSha。Draft 必须通过经过授权的固定 ready operation/上游正常 review 流程变为可合并状态，不能跳过 GitHub draft/protection。Merge method 固定；禁用 branch-protection bypass/admin override。最后 GitHub merge 请求携带 exact expected head `sha`，不匹配则409，**不自动换成最新 head 重试**。

Head 绑定仍不够：读取 base SHA 后再 merge 存在竞态。第一实现只支持已核实的 GitHub strict up-to-date required checks/merge queue，且 checks 来源可信；依赖 GitHub 在副作用处原子执行保护。若仓库没有可验证的 integration protection，则明确 unavailable，不用「我们刚看过 base」假装阻止竞态。集成候选的检查与实际 merge SHA 都记录在 receipt；GitHub head `sha` precondition 并不单独保证 base 不变。官方：[merge API](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request)。

发生 timeout 或进程重启，先查询同一 PR 是否 merged，并核对已保存 head/base/method、actual merge commit 与目标 branch ancestry；匹配则补 receipt，未知则保留 interrupted/unknown 并继续回查，不能盲目第二次 merge。Lease 只 fence 本地队列，不能撤回已在途 GitHub 请求；外部查询/固定 operation identity 才处理该窗口。授权撤销阻止新的 effect，已完成 effect 如实记录，不能谎称撤销已发生的 merge。

### Deploy gate：只接一个具有持久 receipt 的固定 staging target

第一 target 使用已配置的 repo deployment workflow 或固定 operator-managed adapter；参数只有保存的 merged SHA 与 operation ID。Target 配置固定 environment、executor ID、verification URLs、version-report contract、已批准 rollback 规则。Adapter credential 不进入模型 tool args、artifact或prompt，不提供远程 shell proxy；任务凭证只允许这一 repo/target/action。

目标端必须以 operation ID 持久记录 accepted/running/succeeded/failed 与 immutable image digest + source SHA，并在同 target 上串行切换。优先由现有 CI/environment concurrency 执行；没有这项能力时先实现**这个固定 target**的 receipt/锁，而不是用自动 retry workflow dispatch 代替 idempotency。Workflow dispatch HTTP 204 没有足够的完成 receipt；收到204只记 requested，dispatch timeout 先按 operation marker 回查，无法确认时 unknown，不自动重复部署。官方：[workflow dispatch API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)。

Deployment record 使用 exact merged SHA、operation ID、environment，禁用 `auto_merge`；它只是追踪，不是部署成功证明。真实 executor 必须报告 GitHub deployment/workflow run ID、actual build digest/source SHA 与实际服务 version endpoint。只接受同 target、同 operation 的 receipt，不能让任意 callback 宣称成功。官方：[Deployment API](https://docs.github.com/en/rest/deployments/deployments#create-a-deployment)。

状态由证据推进：`requested → deployed → verified`；workflow green 只能证明 executor 完成，`deployed` 还需实际服务版本匹配 digest/SHA，`verified` 需既定 health + auth + 一项真实 Menoteam user flow。应用/schema变化后检查 Work/conversation/settings persistence 与授权隔离；无部署环节的 Work 不显示这条状态。Verification failed 时保持 deployed-but-unverified，不能标 Done。A15 的 backup export 当前仍被 automatic approval review 拒绝，依赖其前提的 staging 步骤不绕过、不开始。

### Rollback 是有证据的固定动作，不是逆向 merge

Merge 不自动 revert。Deploy 前记录同 target 的前一个已验证 digest/SHA、migration compatibility 与 configuration version。第一次交付先选择 additive/backward-compatible schema；不可兼容迁移或无有效 previous digest 时阻止发布，不能用删除数据/倒跑 migration 冒充 rollback。

健康/流程失败时，只能依据 project 已授权 policy 自动切回保存的前一 digest，或在 conversation 请求已有 owner/admin 决定；不重新 build mutable tag、不执行模型提供的命令。记录 rollback operation、真实目标版本和验证结果；数据库 volumes 与 V1/Caddy 原路由保留，回滚 app 不代表回滚已写数据。Rollback失败明确 failed、保留服务与证据，不能覆盖原 deploy failure。至少一次 isolated target drill 证明切回版本和 persisted data 可用，才能启用实际自动 rollback。

### 下一增量的可判定 acceptance

| 场景 | 必须观察到的结果 |
|---|---|
| Member/source/reviewer请求merge或deploy；actor/policy/grant撤销 | 服务端拒绝，外部调用计数零；同项目admin授权正常，不扩大其他项目能力 |
| 旧QA、不同fingerprint/head、insufficient review、blocking finding、missing integration protections | 拒绝merge；不自动替换SHA或忽略check |
| 请求与真实merge之间head/base变化 | exact-head precondition/protected integration拒绝或等待；不合并未审查候选 |
| Merge成功后响应丢失 + connector重启/lease换代 | 查询原PR、补actualmergedSHA receipt；一个canonicaloperation，无第二次副作用 |
| Deploy同SHA并发请求、dispatch/target成功后响应丢失 | 同target串行、同operationreceipt；unknown可回查，不能盲发第二次dispatch |
| Target返回错误SHA/digest、workflow只accepted、服务版本不符、user flow失败 | 不显示Verified/Done；原因与真实版本在Work中可见 |
| Deploy失败/verification失败 + rollback | 固定previousdigest恢复；version+userflow+persistence证明；无previous/迁移不兼容则先拒绝 |
| 真实disposablePR与isolatedstaging | nativeMaster请求→实际保护merge→exactmergedSHA部署→真实版本+用户流程证据，Overview/Changes/QA可回查 |

完成标准是最后一行真实闭环并通过以上拒绝/fault cases；PG/mock tests只是支持证据。当前 read-only 审查没有运行任何 GitHub write、remote mutation 或 deployment，A14/A15 状态不因此改变。


## 已核实的 GitHub dependency — 2026-10-06

Parent 在本轮对 baseline `080e485f651ae2fd1d4a457f4c85620cd281b358` 之后的设计文档候选 `e122a10cc907d0d41be68c4c7920c37b5fe5b2e2` 做只读 GitHub 检查：`repos/blossomsai/menoteam` 返回 public、default branch `main`，当前 authenticated actor 的 `admin`/`push` permissions 为 true；`branches/main/protection` 返回 HTTP404 `Branch not protected`；`rules/branches/main` 返回空数组，exit0。未执行远端 mutation。这是点时事实，不表示已授予任意 Work 自动 merge/deploy，也不能从 repository permissions 推导 target credential 或真实部署能力。

因此第一次实际 merge 有明确、可完成的 dependency：由现有 owner/admin 在已授权 repository 上配置并测试所需 checks 与 up-to-date integration protection，随后按上面的 exact-head gate 验证。用户现有 full-app 授权覆盖通过 delegated workflow 做这项更强保护配置；具体配置形成 reviewable 实施任务后执行，不额外发明 generic approval gate。现有保护不能绕过或削弱；这是下一增量的配置/验收工作，不是无限期等待一个假定存在的保护。配置前先确认 repo 实际 CI check names/可信来源，以及公开仓库现有规则能力，不能在代码里填写虚构 required checks。

如果用户明确选择一个 guarded alternative，必须记录其实际 trade-off 与执行边界再实现/验收：例如明确授权的一次 operator merge 使用 reviewed exact head，随后只对 actual merged SHA 运行 integration checks，未通过之前禁止 deploy；它不能宣称提供原子的 base-before-merge 保证，也不能被 Master 默认为长期 bypass policy。自动 runtime merge 若没有可验证的 upstream integration gate，仍 unavailable；operator 的这条一次性交付依据不会悄悄扩大其他项目权限。选择具体 alternative 是一个明确交付决策，不新增 Scope page 或通用审批体系。

下一项真实证明应记录 protection 配置/检查结果或用户明确接受的 guarded alternative、exact reviewed head、actual merge SHA 和 integration checks，再推进 fixed-target deploy。当前无 GitHub write/merge/protection mutation，A14 的完整交付目标不变。
