# Plan 12.5-R2：Workflow 实时证据与隔离权限

本轮只扩展 Workflow Engine 的观测和安全边界，不改变 Ready Queue、lane 并发、ownership、资源冲突判定或 Worker session 复用规则。证据写入仅在 `PLAN12_CONTROL_PLANE_DB` 明确指向隔离数据库时启用；未设置该变量时引擎保持既有运行路径。

## 字段生产映射

| 字段 | 生产函数 / 时点 | 持久化 | 缺失处理 |
| --- | --- | --- | --- |
| `run_id` | `createRuntimeEvidenceCollector()` 在 Workflow 执行开始前分配 UUID | `workflow_run_events` 全程贯穿，终态写入 `workflow_runs` | 未配置隔离 Control Plane 或缺少快照时返回 `PLAN12_RUNTIME_ADAPTER_LIVE_BLOCKED`，不派发节点 |
| `wave_id`, `wave_index` | Scheduler 形成真实 wave 后，由 `recordWaveStart()` 记录 | lifecycle event；wave 完成后写不可变 `workflow_waves` 事实 | 不从摘要回填；事件失败则 Workflow BLOCKED |
| `config_revision` | `execution_policy.config_revision`，并由隔离 DB 中 ACTIVE 不可变 snapshot 校验 | 所有 L3 事实和 lifecycle event | 缺失、未知或非 ACTIVE 直接阻断 |
| `node_id`, `task_id`, `attempt` | 已物化的 `workflow_nodes` / Task Envelope，在节点派发前读取 | `workflow_wave_nodes` 和事件表 | 不生成事后 ID；无 Task 行不派发 |
| `session_key`, `session_id` | `ensureScopedSession` / `sendScopedSession` 的实际返回值 | wave node 事实与 tasks.db 原有 Result Envelope | `NODE_STARTED` 允许在 Worker 建立前保持空值；终态 node 事实没有真实 `session_id` 时由 Adapter 阻断，不宣称完成 |
| `started_at`, `ended_at` | Scheduler 节点和 wave 边界的 `nowIso()` | lifecycle event、wave/node 事实 | 仅接受执行时采集的 UTC 时间 |
| 资源锁事件 | 当前 Workflow Engine 只有进程内 `withLock` 链，R2 不把计划摘要冒充 ACQUIRE/RELEASE | 若未来提供真实 lock-provider callback，再写 `workflow_lock_events` | 当前无真实锁能力时保持缺口，不生成假事件 |
| execution events | `recordNodeStart/Finish` 在真实节点调用前后追加 | `workflow_run_events`；节点完成事件同时落 `execution_events` | 写入失败返回 `EVIDENCE_WRITE_FAILED` 并保留可回读错误 |
| payload digest/reference | 原始节点结果在 finish 边界用 canonical JSON 计算 SHA-256 | `payload_digest`, `payload_ref` | 不从 Scheduler 摘要补造 |

`workflow_run_events` 是为 RUN_STARTED/WAVE_STARTED 等早于 wave/node 的事件增加的最小兼容表。它保持 append-only、允许 wave/node/task 为空，并不创建虚假外键；事件 Writer 仍校验 UTC 时间、canonical `payload_sha256`、digest 格式、workflow identity 和连续 sequence。严格节点事件仍使用现有 `execution_events` 外键。由于 RUN_STARTED 必须先于 `workflow_runs`，此表不声明 `run_id` 外键，而是用同一 run 的不可变 workflow identity 和 sequence 校验保持边界。

## 隔离权限双门禁

`execution_policy` 是结构化输入并随 plan 持久化。`mode=isolated_fixture` 默认拒绝 Mem0、生产 DB 和业务仓库写入，并要求显式 `config_revision`。当 `allowed_roots` 非空时，Planner 和节点门禁都要求 `project_root`/`project_path` 等结构化路径落在 allowlist 内。Planner DAG 在物化前调用 `validatePlannerExecutionPolicy`；节点派发在任务改为 RUNNING、创建 session 或调用 Task Bus 前再次调用 `validateNodeExecutionPolicy`。拒绝返回 `MEM0_WRITE_FORBIDDEN`、`PRODUCTION_DB_WRITE_FORBIDDEN`、`BUSINESS_REPO_WRITE_FORBIDDEN` 或 `ROOT_SCOPE_FORBIDDEN`，不会创建/执行被禁止节点。

隔离 Worker session 同时携带 OpenCode V2 `permissions` deny rules（`mem0_*`、`mem0_handoff_*`、数据库 MCP 工具），作为工具执行层的第二道防线。临时 Smoke 配置必须显式关闭相关 MCP server；旧越权记录 `memory_id=0d72575d-b4ab-420a-beb0-229a6dc5de2e` 只作为事故证据保留，本轮不删除、不再次写入。

## Append-only 与故障语义

Workflow 不更新 Control Plane 的 RUNNING 行为 COMPLETED。同一 run 的开始/结束由有序 lifecycle events 表达，终态以一次不可变 `workflow_runs` 事实写入；wave/node 完成后一次性写入对应不可变事实。批量写入任一事实失败时事务回滚，返回 `PLAN12_RUNTIME_EVIDENCE_BLOCKED`/`EVIDENCE_WRITE_FAILED`；失败库不可写回时只保留外部错误回执，不声称证据完整。

## 当前收口状态

Plan 12.5-R2：**PASS**。五个实时 marker、真实 Desktop Runtime session/time、
隔离 Control Plane DB 回读、digest round-trip 和 Mem0=0 均已记录在
`docs/plan12-5-workflow-runtime-evidence-adapter.md` 的 Live artifact 中。
本节后面的 `LIVE_BLOCKED` 文字是本轮之前的条件性 fail-closed 规则或历史尝试，
不是当前状态；12.6 现在只消费已提交的 L3 事实，不重新执行 Desktop Runtime。

### 最终收口（2026-10-06）

当前已核实的最新真实运行是 **live v2**，使用 Desktop `opencode v2.0.23`，写入隔离 DB
`C:/Users/Administrator/AppData/Local/Temp/opencode/plan12-final-v2-20261006-4c37812d/control-plane.db`
（sha256 `0AFFD510D39270F6ED05D8D4682C9F8FBB11BF3A2D12CC402414F6D210081EF4`，
`config_revision=plan12-final-v2-20261006-4c37812d`，`ACTIVE`）。smoke run
`aa97bf7f-b876-4823-952f-fc718b8b4219`（workflow `44940f00-6ea5-41e8-95b3-e6d3eb9e80e1`）为
`COMPLETED`，同 wave 两个无依赖 `code_read` worker 重叠 ≈14.088s，raw model
`deepseek/deepseek-flash#default`、canonical `deepseek/deepseek-flash`，无伪造锁事件。

Plan 12.5/12.6 scope = **PASS**、L3 verification = **PASS**；`delivery=none` 使整体保持
`FINAL_REPORT_BLOCKED` / `DELIVERY_PENDING`，**非 L4**。结构化回读见
[`plan12-5-6-final-readback.json`](plan12-5-6-final-readback.json)，正式收口说明见
[`plan12-5-6-final-closeout.md`](plan12-5-6-final-closeout.md)。

**历史：** 上一版 v1 run `4bbda1c3-a807-4d58-9323-8046cd2817de`（workflow
`2d304a17-5df5-4240-81f0-c9e848f11064`，revision `plan12-final-20261006-8abc6b7c`）
作为历史保留，不再是当前状态。

## 验收边界

R2 的 fixture 契约测试覆盖 Planner/dispatch 双门禁、run 级事件无伪造 FK、append-only、digest 重启回读和 ACTIVE revision 校验。历史条件规则是：真实 Desktop Runtime Smoke 只有在新的隔离产物同时包含认证路径、两 Worker 节点、真实 session/time、隔离 DB 回读和 Mem0=0 时，才可输出 `PLAN12_RUNTIME_WORKFLOW_SMOKE_PASS`；否则当时保持 `LIVE_BLOCKED`。该条件已由当前 Live artifact 满足，不构成当前 12.6 阻塞。
