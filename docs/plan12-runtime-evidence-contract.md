# Plan 12.0 Runtime Evidence Contract

**状态：SPEC_ONLY；本文件定义契约，不声明任何新运行时证据已经存在。**

本契约补充 `docs/plan12-control-plane-spec.md`，约束 Workflow、Scheduler、
Control Plane、Completion Guard 和 Reviewer 对“运行时事实”的共同含义。Plan 11
仍保持 `PASS / framework_v1: RELEASE_READY`；本契约不会把现有 `tasks.db` 缺少
wave 表解释成 Plan 11 缺陷，也不会把历史 `workflow_run.waves` 升级为事实。

现有 Control Plane 是 `runtime/tasks.db` 的只读投影；其 automatic-rotation 历史
提示和从 task result 解析的 wave 展示都属于实现现状，不能改变本契约的 L3 事实
要求，也不能把 Plan 11 门禁重新标为 BLOCKED。

所有 L3 事实表共享强制 envelope 列：`schema_version`、`config_revision`、
`source`、`observed_at`、`payload_sha256`、`idempotency_key`。下文表级字段是
这些公共列之外的特有列；缺少任一公共列时，记录不可升级为 L3。

## 1. 事实等级与来源

| 等级 | 例子 | 可否作为 release evidence |
| --- | --- | --- |
| L0 计划声明 | `plan_json.depends_on`、`resources.exclusive`、workflow policy | 否；只能说明意图 |
| L1 运行期返回 | `workflow_run` 返回的 `waves[]`、内存 scheduler runState | 否；调用结束后不可独立审计 |
| L2 任务结果嵌入 | `tasks.result_json` 中的 wave/evidence JSON | 只有经过 schema、digest、run identity 和 DB 提交复查后才可升级 |
| L3 持久事实 | `runtime/control-plane.db` 的 run/wave/node/lock/event 行 | 是；必须有 config revision、source、时间和 hash |
| L4 完成结论 | Completion Guard `FINAL_REPORT_ALLOWED` / `COMPLETED` | 只有 L3 事实齐全、独立 Reviewer PASS 且 guard 事务提交成功时才成立 |

Control Plane 的展示值必须带 `evidence_level` 和 `evidence_ref`。没有 L3 行就
显示 `UNVERIFIED`，不能用空数组、推断并行度或历史文档填充。

## 2. 运行时事件契约

### 2.1 Run、wave、node identity

- `run_id` 对一次执行尝试唯一；retry/rework 新建 run，不复用旧 run。
- `workflow_id` 标识逻辑 Workflow；`parent_run_id` 指向被 retry 的尝试。
- `wave_id` 在 run 内唯一，`wave_index` 从 0 单调递增；不能以同一 index
  覆盖已有 wave。
- `node_id` 来自 plan；`attempt` 从 1 递增；`task_id`、`session_id`、`route` 和
  `config_revision` 必须从实际调用上下文写入。
- `event_seq` 在 `(run_id)` 内单调；`payload_digest` 对 canonical JSON 计算，
  不能对格式化文本或 UI 摘要计算。

### 2.2 原子提交边界

每个 wave 的事实提交必须在一个 SQLite transaction 中完成，至少包括：

```text
workflow_runs status/evidence_write_status
workflow_waves
workflow_wave_nodes
workflow_lock_events
execution_events
```

提交前验证：父 run/config snapshot 存在、wave index 未占用、node 属于 plan、
lock sequence 连续、event idempotency 未冲突、所有 digest 可重算。重复事件在
`idempotency_key` 相同且 digest 相同时返回原提交结果；相同 key 不同 digest 必须
返回 `EVIDENCE_IDEMPOTENCY_CONFLICT`。

任何一项写入失败都回滚本次 transaction，并把 run 标为
`evidence_write_status=FAILED` 或 `INCOMPLETE`（若连状态更新也失败，则由外层
返回不可完成错误并保留可诊断日志）。不得写出部分 wave、伪造 `PASS` 或用
`workflow_run` 返回值补写缺失历史。

## 3. Completion Guard 规则

Completion Guard 在 `completion_final_report_permission` 前必须检查：

1. run 的 `config_revision` 对应 ACTIVE/历史 snapshot 且 digest 完整。
2. 计划中的每个 node 都有 L3 `workflow_wave_nodes` 和必要的 execution events。
3. 所有 lock acquire/release/conflict 事件满足 sequence 和 owner 约束。
4. `workflow_runs.evidence_write_status=COMPLETE`，run/wave/node 状态闭合。
5. 必要 Reviewer PASS、delivery evidence 和 architecture evidence 均存在。

任一检查失败返回 `COMPLETION_GUARD_BLOCKED`，`final_report_permission=false`，
Workflow 状态保持原状态或进入显式 `EVIDENCE_INCOMPLETE`；不能返回
`FINAL_REPORT_ALLOWED`。如果事实写入失败发生在业务执行已经成功之后，业务结果
仍可保留在其原仓库/任务结果中，但交付结论必须阻断，等待人工/重试补齐同一 run
的可验证事件；不得新造 wave 或覆盖旧事件。

这扩展了现有 Completion Guard 的范围。当前 guard 只检查 `workflows`、
`workflow_nodes`、`tasks` 和 review/delivery history；在 Plan 12 实现前，它不能
声称已验证 wave、lock 或 control-plane evidence。

## 4. 模型精确 ID 与 `MODEL_UNASSIGNED`

### 4.1 发现流程

1. 读取当前 config revision 的 route binding。
2. 从 provider 的运行时 catalog 获取精确 `provider_id`、`model_id`、variant 和
   `limit.context`；记录探测时间、catalog digest 和 evidence ref。
3. 以精确键 `{provider_id, model_id, variant}` 匹配；不得按 display name、模糊
   前缀、旧 session、父 Agent 或“同系列模型”替换。
4. provider 不可达、catalog 缺少条目、limit 缺失或证据过期时为
   `UNAVAILABLE`，不是可用。

`framework-config/runtime-model-map.yaml` 中的 Qwen 条目只表示配置候选。不得
因为它存在就宣称 Qwen 可用，也不得把它替换成另一个 provider/model。任何规格、
测试或证据不得猜模型 ID。

### 4.2 Fail-closed

当前 `xxl-job` 的 `project_sessions.model.runtime_id` 为 `null`，
`resolveRoleModel` / `resolveTaskRoleModel` 必须返回 `MODEL_UNASSIGNED`：

- 不创建 session；
- 不 materialize 或 dispatch 依赖该模型的 Workflow node；
- 不继承父会话模型；
- 不使用默认模型、Qwen 替代或 display name 猜测；
- 返回 `BLOCKED`/`MODEL_UNASSIGNED`，记录 route、project、role、revision 和
  evidence status；
- Completion Guard 不得把该 node 当作完成。

该规则对新旧 Workflow 都适用；配置 Apply 不能偷偷为旧 Workflow 补绑定。

## 5. 新旧 Workflow 配置隔离

- Workflow start 在同一 transaction 读取 ACTIVE `config_revision`，写入
  `workflow_runs` 和 `workflow_config_snapshots` 引用。
- 后续 Apply、Rollback、model probe 或 route change 不改变已启动 run 的 revision。
- retry/rework 属于原 run 的派生尝试，默认复用父 run snapshot；若明确选择新
  revision，必须创建新的 root run 并写明原因，不能静默混用。
- 新 run 只能使用新的 ACTIVE revision；旧 revision 可读但不可成为新默认。
- Control Plane 查询必须按 run 的 revision 过滤，禁止把多个版本的 wave、模型、
  lock 合并成一个当前状态。

## 6. Apply、Rollback、Audit 事件

每个 config event 至少包含：`audit_id`、actor、operation、source_revision、
target_revision、Drawio raw/semantic hash、IR/config/model/route digest、时间、
审批证据、结果和 error code。事件 append-only。

- Apply 失败：target revision `REJECTED`，旧 ACTIVE 保持不变。
- Apply 成功：先提交 snapshot，再 CAS 切换 active pointer，最后 reconcile 文件。
- Rollback：当前 ACTIVE revision 标记为 `ROLLED_BACK`，已验证的
  `SUPERSEDED` 目标 revision 以 CAS 转为 `ACTIVE`，只把新 Workflow 默认 pointer
  指向该目标并写 `rollback_of`；正在运行的 Workflow 不回写。
- 重启发现 pointer、文件或 snapshot 不一致：状态为 `RECONCILIATION_REQUIRED`，
  禁止新 run，直到独立审计确认。
- Audit 缺失不能被 UI 或 Reviewer 的口头结论补足。

## 7. Drawio hash 与信息保全契约

`drawio_raw_sha256` 证明原始字节；`drawio_semantic_sha256` 证明声明的 IR 投影；
`roundtrip_raw_sha256` / `roundtrip_semantic_sha256` 证明 serializer 没有丢失
信息。导入/导出必须保留未知 `mxCell`、页面、geometry、style、非架构 metadata、
顺序和编码/压缩策略。

当前 compiler 的 semantic hash 会排除 `source`，parser 也没有完整 serializer，
所以现有 `IN_SYNC` 不能满足本节。任何 round-trip mismatch 都必须返回
`DRAWIO_ROUNDTRIP_MISMATCH`，阻止 Apply；不得通过删除未知字段或只比较 IR 来
绕过。

## 8. 证据查询与 Reviewer 验收

Control Plane API 未来必须默认只读，并返回：

```yaml
evidence_ref: <event/run digest>
evidence_level: L0|L1|L2|L3|L4
config_revision: <revision>
source: runtime/control-plane.db | runtime/tasks.db | task_result | plan_declaration
verified_at: <UTC timestamp>
verification: PASS | UNVERIFIED | BLOCKED
```

Reviewer 必须分别核对：事实来源、digest 可重算、run/retry identity、配置版本、
MODEL_UNASSIGNED、Completion Guard fail-closed、旧新 Workflow 隔离、Drawio hash
和业务仓库边界。没有 L3 事实时，Reviewer 只能返回 `UNVERIFIED`，不能把 UI 波形、
日志或文档推断成 PASS。

## 9. 与 Plan 12.1–12.8 的依赖

`12.1` 冻结本契约的 enums、identity、digest 和表关系；`12.2` 实现 append-only
writer；`12.3` 实现 snapshot/CAS/Rollback；`12.4` 实现 catalog probe 和模型
fail-closed；`12.5` 将 scheduler 的 runState 转为原子 L3 facts；`12.6` 将
Completion Guard 接入 L3 completeness；`12.7` 完成 Drawio lossless round-trip；
`12.8` 才能提供只读 API/UI 和独立验收。

依赖为：`12.1 → 12.2 → 12.3 → 12.4 → 12.5 → 12.6`，并行支线为
`12.2 + 12.3 → 12.7`，最终为 `12.6 + 12.7 → 12.8`。`12.7` 可以与
`12.4/12.5/12.6` 并行设计，但未通过 round-trip gate 时不得发布 Apply 或
最终 UI/Reviewer 结论。
