# Plan 12.3 config_revision、Apply/CAS 与 Rollback Journal

**实现范围：Plan 12.3 控制面配置生命周期；没有进行生产配置切换。**

本阶段沿用 Plan 12.1 的字段、状态机与 canonical digest，以及 Plan 12.2 的独立
SQLite evidence ledger。Plan 11 继续保持 `PASS / framework_v1: RELEASE_READY`。
实现入口为 `.opencode/lib/plan12-config-revision.ts`，兼容迁移仍由
`.opencode/lib/plan12-control-plane.ts` 执行。调用者必须为测试提供隔离数据库路径。

## 数据权威与写入边界

| 对象 | 职责与写入规则 |
| --- | --- |
| `workflow_config_snapshots` | immutable snapshot：保存 revision、parent、来源、canonical 配置内容、各项 digest 和创建审计字段。已有 append-only triggers 保留；payload、revision 内容及快照中的初始 `state` 不原地修改。 |
| `config_revision_state` | mutable lifecycle projection：保存 `current_state`、`version`、父 revision、各生命周期时间、reason 与 correlation。每次状态更新均检查旧状态和旧版本。它不能替代快照内容。 |
| `config_active_head` | 仅 `head_key=global` 的唯一 active pointer，保存 `active_revision`、CAS version 和更新时间。它表示以后启动的新 Workflow 的默认候选版本。 |
| `config_revision_journal` | append-only 历史：每条合法状态边或拒绝的操作写独立记录。SQLite triggers 拒绝 UPDATE/DELETE。 |
| `config_operation_idempotency` | append-only 操作回执：以 idempotency key 保存 canonical request digest、操作、目标、关联 ID、成功或失败回执。 |

`config_revision_state` 的 ACTIVE 状态具有唯一索引，全局 head 只能有一行；CAS
更新同时检查旧 revision 与 head version。快照与状态投影分别表达“配置内容”和
“生命周期位置”，读取者必须使用 `effective_state` 或状态投影，不能把快照中的
初始 `state=DRAFT` 当作当前状态。旧 Plan 12.2 writer 的表、字段和快照只追加语义
保持兼容。

新 child revision 可以是 DRAFT，但必须引用存在的 `parent_revision`；父关系描述
修订来源，不代表把父状态复制到子 revision。Plan 12.3 创建入口检查原始 envelope
digest 和快照结构后保存 child DRAFT，不改变 Plan 12.1 既有 validator 对状态边的
规则。相同 revision 不允许覆盖内容。

## 生命周期与 API

生命周期合法边继续由 `validateConfigRevisionTransition` 定义：

```text
DRAFT → VALIDATED → STAGED → APPLIED → ACTIVE → SUPERSEDED
VALIDATED / STAGED / APPLIED → REJECTED
ACTIVE → ROLLED_BACK
SUPERSEDED → ACTIVE（仅经审计的 CAS Rollback）
```

现有 Plan 12.1 契约还允许 DRAFT → REJECTED；Plan 12.3 保留该失败关闭边。
`transitionConfigRevision` 负责普通逐边转换，拒绝使用该入口直接转为 ACTIVE、
SUPERSEDED 或 ROLLED_BACK；pointer 状态只允许由 Apply/Rollback 的 CAS 操作改变。
未知状态、非法边、缺失 revision 或操作审计字段都返回结构化失败。

模块提供：`createConfigRevision`、`getConfigRevision`、
`getActiveConfigRevision`、`transitionConfigRevision`、`applyConfigRevision`、
`rollbackConfigRevision`、`listConfigRevisionJournal`。写操作成功返回 INSERTED、
APPLIED 或 IDEMPOTENT；失败返回 REJECTED 及 code/detail/path。

## Apply、CAS 与失败审计

Apply 输入包含 `expected_active_revision`（首个激活显式使用 null）、
`target_revision`、`idempotency_key`、actor、reason 和 correlation_id。整个操作在
SQLite `BEGIN IMMEDIATE` 中读取 head、检查 CAS、改变状态投影、追加 journal、
记录操作回执并更新 head；任意中途数据库失败回滚全部变化。

只有 VALIDATED、STAGED 或 APPLIED 目标可 Apply。目标从 VALIDATED 开始时逐边
追加 STAGED、APPLIED、ACTIVE；从 STAGED 开始时逐边追加 APPLIED、ACTIVE；从
APPLIED 开始时追加 ACTIVE。不会跳过状态机边。旧 ACTIVE 先在同一事务内转为
SUPERSEDED，新目标再成为唯一 ACTIVE，head 以旧 revision 和旧 version 做条件
更新。CAS 不一致返回 `CAS_CONFLICT`，不会替换已被其他操作更新的 active head。

请求摘要由 Plan 12.1 canonical JSON 计算。相同 idempotency key 和完全相同请求
返回已保存回执；请求不同返回 `EVIDENCE_IDEMPOTENCY_CONFLICT`。失败回执也被保留，
重放失败请求不会突然变为成功。可诊断的业务拒绝写入失败操作回执，并在 revision
存在时追加不改变状态的 REJECTED journal。不存在的目标通过操作回执留痕，不能
伪造 snapshot 外键。数据库故障使事务回滚并返回结构化数据库错误。

Journal 保存 journal ID、revision、operation、from/to state、expected/actual
revision、actor、reason、correlation/idempotency key、snapshot payload digest、
UTC 时间、result、error code/detail。支持按 revision、correlation_id 和
idempotency_key 查询一次操作的所有状态边或失败记录。

## Rollback 与 Workflow 隔离

Rollback 必须指定预期当前 ACTIVE revision 与旧目标 revision。目标必须存在、
内容完整且当前状态为 SUPERSEDED；REJECTED、ROLLED_BACK、尚未激活的配置以及
自身回滚均拒绝。包含 `MODEL_UNASSIGNED` route binding 的目标配置 fail-closed，
不会为 xxl-job 或其他未分配路由补模型、继承父 Agent 模型或猜测模型 ID。

成功事务追加当前 ACTIVE → ROLLED_BACK 与目标 SUPERSEDED → ACTIVE 两条 journal，
同时更新状态投影和全局 head。CAS 冲突或目标拒绝时 active revision 不变；重复
相同请求幂等。并发 Rollback 使用与 Apply 相同的数据库锁和 head CAS，不能覆盖
另一操作已提交的版本。

这些操作只改变控制面默认 pointer，不更改既有 `workflow_runs.config_revision`、
wave、node、lock 或 execution event。旧 Workflow 固定旧 snapshot，后续事实仍
通过 Plan 12.1/12.2 的 revision 关联校验；不能混入新的配置。Plan 12.3 没有接入
Scheduler/Worker，也没有切换真实业务 Workflow。

## 验收与阶段限制

专用测试使用操作系统临时 fixture，覆盖状态边、不可变 payload/parent/digest、
Apply/Rollback CAS 和幂等、跨进程并发、事务原子性、append-only journal、重启
恢复与旧 Workflow 版本隔离。fixture 的 PASS 是实现验证，不是生产 L3 runtime
evidence；生产数据库未通过这些测试初始化或切换。

本阶段未实现 Plan 12.4 model catalog/provider 探测或 route binding 替换、Plan
12.5 runtime adapter、Plan 12.6 Completion Guard 集成、Plan 12.7 Drawio
round-trip、Plan 12.8 UI，也未改变 Scheduler、automatic lifecycle rotation、
Qwen 配置候选或 xxl-job `MODEL_UNASSIGNED` 规则。未写 Mem0，未修改业务仓库、
Drawio、生产 DB、`runtime/tasks.db` 及其 WAL/SHM，未操作用户补丁。
