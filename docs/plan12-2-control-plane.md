# Plan 12.2 Control Plane SQLite Migration 与 Append-only Evidence Writer

**状态：IMPLEMENTED（仅 Plan 12.2）**

Plan 12.2 在 Plan 12.1 契约之上提供独立的 `runtime/control-plane.db` 初始化、
幂等事实写入和只读查询。实现位于
`.opencode/lib/plan12-control-plane.ts`，DDL 位于
`.opencode/lib/plan12-control-plane-schema.sql`。调用方必须显式传入数据库路径；
测试只使用临时 fixture，不会打开或修改 `runtime/tasks.db`。

## Schema 摘要

数据库启用 `foreign_keys=ON`、WAL 和 busy timeout，`PRAGMA user_version=1`。
公共 evidence envelope 在六张表中保存：
`schema_version`、`config_revision`、`source`、`observed_at`、
`payload_sha256`、`idempotency_key`、`evidence_level`、`fact_type`。

| 表 | 主键/自然唯一键 | 关系 |
| --- | --- | --- |
| `workflow_config_snapshots` | `config_revision`；`idempotency_key` | `parent_revision` 自引用 |
| `workflow_runs` | `run_id`；`idempotency_key` | config snapshot、parent run |
| `workflow_waves` | `(run_id,wave_id)`；`(run_id,wave_index)` | workflow run、config snapshot |
| `workflow_wave_nodes` | `(run_id,wave_id,node_id,attempt)` | wave、config snapshot |
| `workflow_lock_events` | `event_id`；`idempotency_key` | wave、config snapshot |
| `execution_events` | `event_id`；`(run_id,sequence)` | wave、config snapshot |

`evidence_idempotency` 是跨表幂等索引，保存 key、digest、fact type、目标表和
记录主键。它使相同 key 在不同表之间也不能产生第二条事实。

每张事实表和幂等索引都有 `BEFORE UPDATE`/`BEFORE DELETE` trigger，统一返回
`APPEND_ONLY_UPDATE_FORBIDDEN` 或 `APPEND_ONLY_DELETE_FORBIDDEN`。自然唯一键和
外键由 SQLite 强制；序列、状态、时间、hash、revision 和模型规则由
Plan 12.1 TypeScript validator 强制。

## Writer API

`initializeControlPlaneDatabase({ dbPath })` 创建目录、打开数据库并执行可重复迁移；
`migrateControlPlaneDatabase(store)` 可安全重复执行。`ControlPlaneStore` 和同名
函数导出以下写入接口：

- `appendEvidence`
- `appendWorkflowRun`
- `appendWorkflowWave`
- `appendWorkflowWaveNode`
- `appendWorkflowLockEvent`
- `appendExecutionEvent`
- `appendWorkflowConfigSnapshot`

写入结果明确区分 `INSERTED`、`IDEMPOTENT` 和 `REJECTED`。拒绝结果包含稳定
`code`、`detail` 和可选 `path`，包括 schema validation、
`EVIDENCE_IDEMPOTENCY_CONFLICT`、`FOREIGN_KEY_CONSTRAINT`、自然键冲突和数据库
写入失败。所有单事实写入在 `BEGIN IMMEDIATE` 中执行；`appendEvidenceBatch` 在
同一事务中追加多个事实，任何中途失败都会回滚已经写入的事实和幂等索引。

重复提交的判定顺序是：完整 envelope 且 key 已存在时比较 digest；digest 相同
返回原记录，digest 不同 fail-closed。缺少 envelope 字段的请求仍先经过 schema
校验，不会因为复用了旧 key 而被错误接受。

查询接口为 `getWorkflowRun`、`listWorkflowWaves`、`listWorkflowWaveNodes`、
`listExecutionEvents` 和 `getEvidenceByIdempotencyKey`，默认只读，支持按
`workflow_id`、`run_id`、`wave_id` 和 `node_id` 过滤。

## 恢复与边界

提交后的事实在关闭并重新打开进程后仍可查询，随后可以继续追加依赖该事实的
wave/node/event。并发 writer 依靠 SQLite `BEGIN IMMEDIATE`、WAL、busy timeout、
全局幂等索引和自然唯一键保证单条事实只出现一次；不同 workflow 使用不同 run
和 key 时可以并行写入。

Plan 12.2 不接入 Scheduler、Completion Guard、UI、model catalog、route binding
运行时切换或 Apply/Rollback。它不创建或迁移 `runtime/tasks.db`，不修改业务仓库、
生产 DB、Drawio、Mem0 或用户提供的 patch。
