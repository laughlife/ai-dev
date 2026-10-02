# Plan 12.1 Boundary Contract：Control Plane 边界与 Schema Vocabulary

**状态：CONTRACT_FROZEN（只冻结词汇、类型和验证规则；不创建数据库、不接入 Scheduler、不实现 UI）。**

Plan 12.1 把 Plan 12.0 的边界设计固化为可复用的 JSON Schema 和 TypeScript
校验契约。Schema 文件是结构词汇，`.opencode/lib/plan12-contract.ts` 是执行时
的语义校验器；两者都不代表 `runtime/control-plane.db` 已经创建，也不把内存
`workflow_run.waves` 升级为持久证据。

## 1. 权威来源、写入者与读取者

| 字段/对象 | 权威来源 | 允许写入者 | 允许读取者 |
| --- | --- | --- | --- |
| `drawio_*_sha256` | `diagrams/multi_agent_framework_v4_completion_guard.drawio` 与其受控编译结果 | Architecture Compiler 的显式 Apply 流程 | Compiler、Reviewer、Control Plane 只读投影 |
| `ir_sha256` | Architecture IR 编译产物 | Architecture Compiler | 配置校验、Reviewer |
| `config_revision`、状态和父版本 | Control Plane 配置快照 | 显式 Apply/Rollback 事务 | Workflow 启动器、Completion Guard、Reviewer |
| `model_catalog` | provider 运行时 catalog 或已验证配置证据 | Catalog 采集器/配置 Apply | 路由校验、Scheduler、Reviewer |
| `route_bindings` | 架构路由与精确模型目录引用 | 配置 Apply；不可由运行时自动改写 | Dispatcher、Completion Guard、Reviewer |
| `workflow_runs` | 实际 Workflow 启动/结束事件 | Runtime Evidence Writer | Completion Guard、审计、只读 UI |
| `workflow_waves`、`workflow_wave_nodes` | Scheduler 的持久化提交 | Runtime Evidence Writer | Completion Guard、审计、只读 UI |
| `workflow_lock_events` | 锁服务的 acquire/wait/release 等事件 | Lock Evidence Writer | Scheduler 审计、Completion Guard |
| `execution_events` | 执行器/运行时事件流 | Runtime Evidence Writer | Completion Guard、Reviewer、只读 UI |
| `workflow_config_snapshots` | Apply 时冻结的完整配置 | Control Plane Snapshot Writer | 所有事实写入器、Reviewer |
| `payload_sha256`、`idempotency_key` | 事实提交时的 canonical JSON 计算 | Evidence Writer | 去重、审计、Reviewer |

显示层只能读取已经提交的 Control Plane 事实，并必须同时返回
`evidence_level`、`evidence_ref`、`config_revision`、`source` 和验证状态。UI、日志
和文档不能写回架构、快照或事件账本。

## 2. 数据边界与证据等级

| 等级 | 含义 | 允许进入哪个持久边界 | 可否单独作为完成证据 |
| --- | --- | --- | --- |
| L0 | 计划声明、依赖、资源和策略 | 计划/配置文件；不进入事实账本 | 否 |
| L1 | 内存调度结果或 `workflow_run` 返回值 | 不直接持久化为事实 | 否 |
| L2 | `tasks.result_json` 中的嵌入结果 | `runtime/tasks.db` 的既有任务结果 | 只有经过 schema、digest、identity 和事务复核才可升级 |
| L3 | 带公共 envelope 的持久运行事实 | 未来 `runtime/control-plane.db` | 是，需满足完整性和审计规则 |
| L4 | Completion Guard 最终结论 | 只写交付/审计结论 | 只有 L3 完整、Reviewer PASS 且 guard 事务成功才成立 |

L3 六张事实对象是：`workflow_runs`、`workflow_waves`、
`workflow_wave_nodes`、`workflow_lock_events`、`execution_events`、
`workflow_config_snapshots`。它们共享以下公共 envelope 字段：

```yaml
schema_version: 1
config_revision: <不可复用的版本标识>
source: <事实写入来源>
observed_at: <UTC ISO-8601，必须以 Z 结尾>
payload_sha256: <canonical JSON（排除自身字段）的小写 SHA-256>
idempotency_key: <事实命名空间内唯一>
evidence_level: L3
```

`payload_sha256` 的 canonicalization 递归按 Unicode code point 排序对象键，数组
顺序保持语义；`undefined`、`NaN`、`Infinity`、函数、Symbol 和非普通对象拒绝。
时间只接受 UTC ISO-8601，哈希只接受 64 位小写十六进制。相同 key 与相同 digest
返回原提交结果；相同 key 与不同 digest 必须返回
`EVIDENCE_IDEMPOTENCY_CONFLICT`。

`payload_digest` 是 `execution_events` 对外部 payload 的独立摘要，不能与公共
`payload_sha256` 互换；`sequence` 是锁/执行事件序号，`event_seq` 是 node 对执行
事件流的引用序号；`wave_index` 在同一 run 内从 0 递增且不可重复。

## 3. 状态、版本和 identity 规则

### 3.1 `config_revision`

配置 revision 是 opaque、不可复用、不可原地覆盖的标识。状态转换固定为：

```text
DRAFT → VALIDATED → STAGED → APPLIED → ACTIVE → SUPERSEDED
   └──────────────→ REJECTED                 └→ ROLLED_BACK
SUPERSEDED ──(已审计的 rollback target)──→ ACTIVE
```

替换已有 revision 必须带 `parent_revision`，且 parent 必须存在；唯一 genesis
快照可以没有 parent。任意时刻只能声明一个 ACTIVE revision。Apply、Rollback 和
Reconcile 均追加 audit，绝不覆盖旧 snapshot。

新 Workflow 在启动事务中绑定当时的 ACTIVE revision；已启动 Workflow、wave、
event 和 retry 默认继续引用原 snapshot。不同 revision 的 run/wave 混用返回
`WORKFLOW_REVISION_MIXED`；retry 必须生成新 `run_id` 和递增 `attempt`，不得复用
父 run id。

### 3.2 模型和路由 identity

`provider_id`、`model_id`、`variant` 分列保存。`runtime_id` 只能由精确的
`provider_id/model_id[#variant]` 组成；`display_name` 从不参与身份匹配。只有
provider catalog、明确的已验证配置或架构给出的精确 ID 才能登记；未知精确 ID
拒绝。`qwen3.8-max` 只表示已有配置候选，不表示 provider 可用，也不被替换。

`MODEL_UNASSIGNED` 是终态路由状态，不能自动转换为 `BOUND`；`UNAVAILABLE` 不得
继承父 Agent 模型。`xxl-job` 的 route 必须保持 `MODEL_UNASSIGNED`，不得创建会话、
materialize 或 dispatch 依赖该模型的 node。模型能力（包括 context limit）缺失、
过期或探测失败时为 `UNAVAILABLE`，不能猜测默认模型。

`route_bindings` 还必须保存 `runtime_id`（`MODEL_UNASSIGNED` 时显式为 `null`）
和可空的 `evidence_ref`；`BOUND` 路由必须同时提供 `model_ref`、精确的
provider/model、`runtime_id` 和配置 revision。`model_catalog` 的 `evidence_ref`
也必须显式存在，允许为 `null`，以区分“无探测证据”和字段遗漏。

## 4. 运行时数据库边界

当前 `runtime/tasks.db` 继续承载既有 sessions、tasks、workflows、workflow_nodes
和 lifecycle 表。Plan 12.1 不修改它，也不从它缺少 wave/lock 表推导出运行时事实。

未来 `runtime/control-plane.db` 才承载上述六类 L3 事实及 append-only audit。事实
写入必须在一个事务中验证父 snapshot、run identity、wave 唯一性、sequence、digest
和 idempotency。任意一项失败都 fail-closed；不得写部分 wave，也不得用内存返回
值补写历史。

Mem0 只保存经过授权的长期框架知识和决策摘要。run/wave/node/lock/event 原始事实、
payload、凭据、业务数据、临时队列和审计 journal 不进入 Mem0；需要长期引用时只
保存脱敏的文档链接/摘要，并保留可验证 evidence_ref。

## 5. Apply、Rollback、Audit 与 Drawio 保全

Apply 顺序为 prepare → validate → stage → commit → reconcile。validate 必须检查
schema、路径边界、route 唯一性、模型精确 ID 和 raw/semantic/round-trip hash；
commit 以 CAS 更新唯一 ACTIVE 指针。失败时 target 为 `REJECTED`，旧 ACTIVE 不变。
Rollback 只改变新 Workflow 的默认指针，不重写正在运行的 Workflow 或旧事实。

Audit 记录 actor、时间、操作、source/target revision、Drawio raw/semantic hash、
IR/config/model/route digest、结果、错误码、受影响路径和审批证据；Audit 追加写，
不能由 UI 删除。

`drawio_raw_sha256` 证明原始字节，`drawio_semantic_sha256` 证明声明的 IR 投影；
lossless serializer 还必须验证 `roundtrip_raw_sha256` 和
`roundtrip_semantic_sha256`。未知 `mxCell`、页面、样式、geometry、顺序、编码和
压缩信息丢失或 hash 不匹配时返回 `DRAWIO_ROUNDTRIP_MISMATCH` 并停止 Apply。当前
Plan 12.1 不修改 v4 Drawio，也不声称已有 round-trip writer。

## 6. Plan 12.2 使用方式

Plan 12.2 的 `control-plane.db` migration 和 append-only writer 必须直接使用本
阶段的 JSON Schema、canonical digest 和 TypeScript validator：

1. 启动时先读取已存在的 `workflow_config_snapshots`，拒绝未知 revision。
2. 每个事务先验证公共 envelope，再按 fact type 验证字段、identity、sequence 和
   parent 关系。
3. 以 `(idempotency_key, payload_sha256)` 做幂等接受；digest 冲突立即拒绝并审计。
   `config_digest` 同时必须等于 `sha256Canonical(JSON.parse(canonical_json))`；
   `payload_sha256` 只排除自身字段，数组顺序不变。
4. 将失败状态写为 `INCOMPLETE`/`FAILED`，把 `EVIDENCE_WRITE_FAILED` 事件交给
   Completion Guard；不能返回 `FINAL_REPORT_ALLOWED`。
5. writer 只追加 L3 事实，查询层按 run 的 `config_revision` 隔离新旧 Workflow。

Plan 12.2 仍不能创建 UI、替换 Qwen、为 `xxl-job` 猜测模型，或把当前
`runtime/tasks.db` 改作 Control Plane 账本。后续 12.3 才能在这些契约之上实现
snapshot/CAS/Rollback journal。
