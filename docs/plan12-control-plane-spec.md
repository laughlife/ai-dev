# Plan 12.0 Control Plane 与 Runtime Evidence 规格设计

**状态：SPEC_ONLY（仅设计与审计，尚未部署数据库、接口或完整 UI）**

本规格由明确的 Plan 12.0 需求启动。它不改变 Plan 11 的验收结论：Plan 11
仍为 `PASS`，`framework_v1: RELEASE_READY`。本阶段不修改当前 v4 Drawio、业务
仓库、生产数据库、Mem0 或运行时生产数据，也不替换模型路由。

## 0. 已核验基线

- GitHub `master` 当前 HEAD：`f91eba754c365e73d6f5962c4b53cc0c2bed21f4`。
- 当前本地 HEAD 是本次未 push 的规格提交；GitHub `master` 仍保持上述
  `f91eba...`，两者不通过 pull/fetch/push 自动同步。
- `architecture-sync check --format=json`：`IN_SYNC`。
- 只读盘点 `runtime/tasks.db`：表为 `lifecycle_events`、
  `lifecycle_rotations`、`registry_meta`、`sessions`、`tasks`、
  `workflow_nodes`、`workflows`；共 77 列，无 `wave`、`lock` 或 `parallel`
  命名对象/列。
- `workflow_run` 返回的 `waves[]` 是 scheduler 的运行期结果；当前 Control
  Plane 只能从 task result 中解析嵌入 JSON，不能把它当作 Runtime DB 的持久
  事实。
- `runtime/control-plane.db` 当前不存在。本规格提出它作为未来独立的事实账本，
  不把缺表解释为已有证据。
- 现有 `tools/control-plane/server.mjs` 的 automatic-rotation 423 响应仍带有
  “Plan 8 final acceptance evidence is still required”的历史提示；这是待后续
  更新的适配层文案，不改变 Plan 11 当前 `PASS / RELEASE_READY` 门禁事实。
- `framework-config/runtime-model-map.yaml` 仍列出
  `bailian-token-plan/qwen3.8-max`；配置存在不等于 provider 可用。`xxl-job`
  的模型仍为 `MODEL_UNASSIGNED`，规则不变。

## 1. 目标与非目标

目标是为 Control Plane 建立可审计的数据边界、不可变配置版本和运行时事实契约：

1. 能区分架构意图、派生配置、任务账本、调度事实和展示投影。
2. 能证明一个 Workflow 使用了哪个配置版本、路由绑定和精确模型 ID。
3. 能以事件和摘要重建 wave、锁和执行顺序；内存返回值不能单独升级为证据。
4. 事实写入失败时，Completion Guard 必须 fail-closed。
5. Apply、Rollback、Audit 可恢复、可追溯，且不改变已启动 Workflow 的配置。

非目标：本阶段不实现完整 UI、不把 `runtime/tasks.db` 改造成 Control Plane
账本、不启用 automatic lifecycle rotation、不改变 xxl-job 模型分配、不修改
Drawio 内容，也不把运行时事实写入 Mem0。

## 2. 五层边界

| 层 | 权威内容 | 允许的写入者 | 不能承担的职责 |
| --- | --- | --- | --- |
| `diagrams/multi_agent_framework_v4_completion_guard.drawio` | 架构角色、模型意图、生命周期、路由、项目关系、lane 与 guard | 明确授权的架构编辑流程 | 运行时状态、provider 可用性、wave 事实 |
| Architecture IR | Drawio 的结构化、规范化编译投影和 raw/semantic hash | Architecture Compiler | 第二真相源；不保留完整视觉 DOM 就不能宣称 round-trip |
| `framework-config/` | IR 的派生配置候选、模型映射、路由和策略 | 显式 Apply 流程 | 当前运行事实、历史版本覆盖、模型在线可用性 |
| `runtime/tasks.db` | 现有 sessions/tasks/workflows/workflow_nodes/lifecycle 运行账本 | 既有 Runtime Registry、Task Bus、Workflow Engine | 不存在的 wave/lock/evidence 表；不承载新 Control Plane 事实 |
| `runtime/control-plane.db` | Plan 12 新增的不可变 config snapshot、run/wave/node/lock/event/evidence 账本 | Control Plane Evidence Writer（事务写入） | 架构真相源、业务数据、Mem0、UI 临时缓存 |

数据流固定为：`Drawio → IR → config_revision → explicit Apply → snapshots →
Workflow start binding → runtime facts → read-only Control Plane projection`。
Control Plane 只能展示已提交事实；不能从 UI 反向修改 Drawio 或旧 Workflow。

## 3. `runtime/control-plane.db` 建议模式

本表只是规格，不代表当前数据库已创建。所有表使用 UTF-8、UTC ISO-8601 时间，
主键采用不可复用 UUID/ULID；JSON 字段必须同时保存 canonical digest。每个事实
写入携带 `schema_version`、`config_revision`、`source`、`observed_at`、
`payload_sha256` 和 `idempotency_key`。

为避免表格缩写产生歧义，以上字段是所有六张事实表的公共强制列；下表只重复
列出各表特有字段。`idempotency_key` 在同一事实命名空间内唯一；快照也必须有
可重放的 key，即使它不是执行事件。

### 3.1 Workflow 与 wave

| 表 | 建议字段（类型） | 约束与语义 |
| --- | --- | --- |
| `workflow_runs` | `run_id TEXT PK`；`workflow_id TEXT`；`parent_run_id TEXT NULL`；`config_revision TEXT NOT NULL`；`plan_digest TEXT NOT NULL`；`idempotency_key TEXT UNIQUE`；`attempt INTEGER`；`trigger TEXT`；`project_id TEXT`；`status TEXT`；`started_at/ended_at TEXT`；`outcome_digest TEXT`；`evidence_write_status TEXT`；`error_code/error_detail TEXT`；`engine_version TEXT` | run 在启动时绑定 config snapshot；retry 使用新 `run_id`、递增 attempt 和 parent_run_id，不覆盖旧 run；`evidence_write_status` 必须为 `COMPLETE` 才可进入最终 guard。 |
| `workflow_waves` | `run_id TEXT`；`wave_id TEXT`；`wave_index INTEGER`；`ready_set_digest TEXT`；`policy_digest TEXT`；`parallelism INTEGER`；`status TEXT`；`started_at/ended_at TEXT`；`lock_snapshot_json TEXT`；`evidence_digest TEXT` | PK `(run_id,wave_id)`，UNIQUE `(run_id,wave_index)`；wave_index 在同一 run 内单调，从 0 开始；没有持久提交就没有证据。 |
| `workflow_wave_nodes` | `run_id/wave_id/node_id TEXT`；`attempt INTEGER`；`task_id TEXT`；`route TEXT`；`resource_digest TEXT`；`lock_key_json TEXT`；`status TEXT`；`event_seq INTEGER`；`started_at/ended_at TEXT`；`result_digest/error_code TEXT`；`session_id TEXT`；`config_revision TEXT` | PK `(run_id,wave_id,node_id,attempt)`；每个 node 必须能回溯到 task、route、session 和 execution event。 |

### 3.2 锁、执行和配置

| 表 | 建议字段（类型） | 约束与语义 |
| --- | --- | --- |
| `workflow_lock_events` | `event_id TEXT PK`；`run_id/wave_id/node_id TEXT`；`lock_key TEXT`；`event_type TEXT`（ACQUIRE/WAIT/RELEASE/CONFLICT/EXPIRE）；`owner_token TEXT`；`sequence INTEGER`；`occurred_at TEXT`；`outcome TEXT`；`error_code TEXT`；`idempotency_key TEXT UNIQUE` | 进程内 Promise chain 不是持久锁事实；每次尝试、等待、冲突、释放都写事件。sequence 在 `(run_id,lock_key)` 内单调。 |
| `execution_events` | `event_id TEXT PK`；`idempotency_key TEXT UNIQUE`；`run_id/wave_id/node_id/task_id TEXT`；`attempt INTEGER`；`event_type TEXT`；`status TEXT`；`sequence INTEGER`；`payload_digest TEXT`；`source TEXT`；`observed_at TEXT`；`error_code TEXT` | append-only；重复投递以 idempotency key 去重，payload digest 不一致必须拒绝并报警。 |
| `workflow_config_snapshots` | `config_revision TEXT PK`；`parent_revision TEXT NULL`；`source_kind TEXT`；`drawio_raw_sha256 TEXT`；`drawio_semantic_sha256 TEXT`；`ir_sha256 TEXT`；`config_digest TEXT`；`model_catalog_digest TEXT`；`route_bindings_digest TEXT`；`canonical_json TEXT`；`state TEXT`；`created_by TEXT`；`created_at TEXT`；`activated_at TEXT`；`rollback_of TEXT NULL` | snapshot 不可变；ACTIVE 只能有一个；每个 run/wave/event 必须引用一个存在的 revision。 |

建议索引：`workflow_runs(status,started_at)`、`workflow_waves(run_id,wave_index)`、
`workflow_wave_nodes(run_id,node_id)`、`execution_events(run_id,sequence)`、
`workflow_lock_events(run_id,lock_key,sequence)`。所有外键约束缺失或 digest 不
匹配都使证据写入失败。

## 4. `config_revision` 生命周期

`config_revision` 是单调、不可复用、不可原地覆盖的 opaque ID，至少包含随机
部分和创建时间；不能用 Git HEAD 单独代替。状态机为：

```text
DRAFT → VALIDATED → STAGED → APPLIED → ACTIVE → SUPERSEDED
                         └──────────────→ REJECTED
ACTIVE ────────────────────────────────→ ROLLED_BACK
SUPERSEDED ──(audited rollback target)──→ ACTIVE
```

- `DRAFT`：记录来源和父 revision，未用于 Workflow。
- `VALIDATED`：Drawio/IR/config/model/route digest、schema、边界和 round-trip
  检查通过。
- `STAGED`：生成文件和 snapshot 已写入临时区，等待显式 Apply。
- `APPLIED`：文件目标和 snapshot 一致，但尚未成为新 Workflow 默认版本。
- `ACTIVE`：通过 CAS 将唯一 active pointer 从 parent 切换到该 revision。
- `SUPERSEDED`：被下一版本替代；旧 run 仍使用其 snapshot。经过审计的回滚目标
  可以沿显式 `rollback_of` 事件重新转为 `ACTIVE`。
- `REJECTED` / `ROLLED_BACK`：Apply 或运行后审计失败；保留失败原因和回滚来源。

新 Workflow 在创建时绑定当时的 ACTIVE revision；旧 Workflow、retry、reviewer
round 均固定原 revision。Rollback 只移动“新 run 默认版本”的 active pointer：
当前 ACTIVE revision 转为 `ROLLED_BACK`，已验证的目标 revision 从 `SUPERSEDED`
转为 `ACTIVE`，并以 CAS 保证任意时刻只有一个 ACTIVE；不重写旧 Workflow、wave
或 event。

## 5. `model_catalog` 与 `route_bindings`

Plan 12.0 不把这两个结构当作现有表；它们可先作为
`workflow_config_snapshots.canonical_json` 的强制子对象，后续再拆表。

```yaml
model_catalog:
  - model_ref: <opaque stable ref>
    provider_id: <exact provider id>
    model_id: <exact provider model id>
    variant: <exact reasoning/variant or null>
    runtime_id: <provider/model[#variant]>
    source: runtime_catalog | verified_config | unavailable_probe
    availability_status: VERIFIED | UNKNOWN | UNAVAILABLE | EXPIRED
    capabilities: { context_limit: integer|null, input: boolean, output: boolean }
    verified_at: <UTC timestamp>
    evidence_ref: <read-only probe/evidence id>
    config_revision: <revision>

route_bindings:
  - route_id: <architecture route id>
    project_id: <project id or null>
    role: <architecture role>
    model_ref: <catalog ref or null>
    provider_id: <exact provider id or null>
    model_id: <exact model id or null>
    variant: <exact variant or null>
    status: BOUND | MODEL_UNASSIGNED | UNAVAILABLE | REJECTED
    config_revision: <revision>
    evidence_ref: <catalog evidence id or null>
```

`runtime_id` 的格式必须是已发现并验证的精确
`provider_id/model_id[#variant]`。只能从运行时 provider catalog、明确的已验证
配置证据或架构指定的精确 ID 登记；字符串格式解析不等于 provider 可用。未知、
过期、无 `limit.context` 或探测失败都标记 `UNAVAILABLE`，不猜测、不替换、不
继承父模型。`qwen3.8-max` 的配置存在不产生可用性结论；不得替换它。`xxl-job`
的 `MODEL_UNASSIGNED` 仍是 fail-closed 规则。

## 6. Apply、Rollback 与 Audit

Apply 必须分成 prepare、validate、stage、commit、reconcile 五步：

1. prepare 读取 Drawio、IR、配置、catalog 和 bindings，计算全部 digest。
2. validate 检查 schema、路径边界、模型可用性、route 唯一性和 round-trip。
3. stage 将 immutable snapshot 和文件候选写入 staging，并 fsync/journal。
4. commit 以 CAS 更新 active pointer；文件同步必须可重放，不能依赖内存 catch
   才能恢复。
5. reconcile 重启后比较 pointer、snapshot、文件 digest；不一致进入
   `RECONCILIATION_REQUIRED`，禁止新 Workflow 使用未确认版本。

当前 compiler 已有 scope/YAML/generated-marker preflight、staging/backups 和
内存回滚，但没有持久 journal、active revision CAS 或跨文件/DB 崩溃恢复；本
规格把它们列为后续实现要求，不能把当前 `IN_SYNC` 解释成已具备这些保证。

每次 Apply、Rollback、Reject、Reconcile 写 append-only audit：actor、时间、
source revision、target revision、raw/semantic/config/model/route digest、操作、
结果、错误码、affected paths、审批/证据引用。Audit 记录不能写入 Mem0，也不能
被 UI 删除。

## 7. Drawio 信息保全与 round-trip hash

当前 parser/IR 只提取架构投影，semantic hash 会移除 `source`；它不保全页面、
样式、geometry、未知 `mxCell` 属性或压缩策略。因此当前 `IN_SYNC` 不代表
round-trip 保真。

Plan 12 的 Apply 前置条件必须同时满足：

- 原始 Drawio bytes 的 `drawio_raw_sha256` 不变，除非变更明确来自架构编辑者。
- 规范化 IR 的 `drawio_semantic_sha256` 与 config snapshot 一致。
- round-trip serializer 保留未知节点、属性、样式、geometry、页面顺序和编码/
  压缩策略；导入→导出后计算 `roundtrip_raw_sha256` 与
  `roundtrip_semantic_sha256`。
- raw hash 只能证明字节一致，semantic hash 只能证明已声明投影一致；两者都
  通过才允许 Apply。任何未知信息丢失、hash mismatch 或 serializer 不支持都
  fail-closed。

## 8. Plan 12.1–12.8 依赖关系

```text
12.1 Boundary + schema vocabulary
  └─→ 12.2 control-plane.db migration + append-only event writer
        └─→ 12.3 config_revision snapshots + Apply/CAS/Rollback journal
              └─→ 12.4 model_catalog/route_bindings probe + MODEL_UNASSIGNED gate
                    └─→ 12.5 workflow run/wave/lock evidence adapter
                          └─→ 12.6 Completion Guard evidence integration
12.2 + 12.3 ─→ 12.7 Drawio lossless round-trip/hash hardening
12.6 + 12.7 ─→ 12.8 read-only Control Plane projection/UI + independent acceptance
```

- `12.1` 是所有阶段的前置，冻结字段、枚举、digest 和 ownership。
- `12.2` 先于 `12.3`，否则没有可验证的事实落点；`12.3` 先于 `12.4`。
- `12.4` 先于 `12.5`，`12.5` 先于 `12.6`；各阶段必须保留前一版本的兼容读路径。
- `12.7` 依赖 `12.2/12.3`，可与 `12.4/12.5/12.6` 并行设计，但其通过是最终
  Apply release gate 的前置条件。
- `12.5` 先写事实再接 Completion Guard；不能从 result envelope 回填历史事实。
- `12.6` 依赖事实 writer、config snapshot 和模型 gate 的事务语义。
- `12.8` 等待 `12.6/12.7`；UI 只读展示已提交事实，不能替代底层契约。

以上阶段均需独立 Reviewer、`git diff --check`、architecture-sync 和边界验证；
没有新的明确需求时，不自动推导 12.1 之后的实施。
