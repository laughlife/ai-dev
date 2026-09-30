# Lifecycle Engine Plugin (Plan 8 T5)

Lifecycle Engine 插件：持久会话的上下文遥测、阈值分带、checkpoint、代际换代
（rotation）、恢复（restore）与崩溃对账（reconcile）。共享 core 为
`.opencode/lib/lifecycle-core.ts`（T4），存储为 T3 已提交的 schema（共用
`runtime/tasks.db`）。本插件只做"被显式调用才行动"的 facade：
**不注册自动 hook、不启用自动换代、绝不触碰 Mem0 与业务仓库写入**。

- Plugin id: `lifecycle-engine`
- 工具 namespace：`lifecycle`（生产恰好 5 个工具；marker-gated 测试钩子不算生产工具，见下）
- Architecture Source of Truth：`diagrams/multi_agent_framework_v3_workspace.drawio`
- 遥测协议（normative）：`docs/runtime-context-telemetry.md`（OpenCode 2.0.20 实测 VERIFIED）
- Checkpoint 合同：`templates/checkpoint.schema.json`（schema_version 1）
- 阈值配置（每次现读、不硬编码）：`framework-config/lifecycle.yaml`

## 目录结构

```text
.opencode/plugins/lifecycle-engine/
├─ index.ts      插件入口：共享 lifecycle core + 5 个 lifecycle 工具（+条件注册 test hook）
├─ hooks.ts      marker-gated 测试钩子（生产加载时不注册）
├─ schema.sql    §T3 lifecycle_events / lifecycle_rotations 表（幂等 IF NOT EXISTS）
└─ README.md     本文件

共享实现（非本插件私有）：
.opencode/lib/lifecycle-core.ts       T4 facade：telemetry / 分带 / checkpoint / rotation / restore / reconcile
.opencode/lib/lifecycle/*.ts          state-machine / rotation / reconcile 共享模块；telemetry、checkpoint、types 保留为离线合同与测试参考，生产 facade 的兼容边界仍在 lifecycle-core.ts
.opencode/lib/global-lock.ts          进程级 per-session_key 锁（与 runtime core withLock 同一把锁）
```

## 工具面（namespace `lifecycle`，恰好 5 个）

所有工具接受 `session_key`（原样存储的键，含 scoped key）或
`project_id + role` 简写（经 runtime core `sessionKey()` 解析）；输入不符返回
`INVALID_INPUT` / `SESSION_NOT_FOUND`，绝不猜测。返回一律为结构化 JSON
（`{ ok, status, code?, detail? , ... }`）。

| 工具 | 说明（输入 → 输出，高层） |
| --- | --- |
| `lifecycle_status` | 给 `session_key` 或 `project_id + role` → 单会话全量生命周期视图：registry 行（最新 generation）+ 已验证 telemetry（tokens/limit/pct/source/at）+ 分带评估（thresholds、band、recommended_action、band_state）+ `lifecycle_state` + checkpoint 路径/存在性 + last/incomplete rotation + 最近事件（`events_limit` 默认 10、上限 100）。默认纯读；仅 `refresh:true` 时先做一次实测（写 telemetry 5 列 + 1 条事件行） |
| `lifecycle_list` | 可按 `session_key` / `project_id` / `role` 等值过滤，纯只读列出每个 key 最新 generation（包含 scoped role），不调用模型 |
| `lifecycle_checkpoint` | 输入 `session_key`（+`force`）→ "ensure"语义：该代已有 checkpoint 文件且非 force 则 `CHECKPOINT_REUSED`；否则先取一次**验证过**的实测（拿不到就 `CHECKPOINT_TELEMETRY_UNAVAILABLE`，绝不带估算值落盘），组装 v1 checkpoint（活跃 task/workflow 引用、只读 git 状态、有界摘要）经 schema 校验后原子写入，返回 `CHECKPOINT_WRITTEN` + `checkpoint_path`（相对 `runtime/`）+ 路径/摘要/git 摘要。成功后 `lifecycle_state → CHECKPOINT_READY`（仅在原值为 band 标签或 null 时） |
| `lifecycle_rotate` | **手动换代 API**。输入 `session_key`（+`reason`、`force`）。无 `force` 时必须存在验证过的 `context_pct` 且分带达到 ROTATE_AFTER_ATOMIC_STEP / HARD_ROTATE，否则 `ROTATION_TELEMETRY_UNAVAILABLE` / `ROTATION_NOT_DUE`。成功输出 `ROTATED`：rotation_id、from/to generation、新旧 session_id、checkpoint_path、old_row(ARCHIVED)/successor_row(ACTIVE, HANDOFF_READY) |
| `lifecycle_reconcile` | 崩溃/半途失败换代账本对账。输入可选 `session_key`（缺省扫全库非终态 rotation 行）。每 key 在锁内逐行解决：仅当后继已注册且与 ledger 记录的 session ID 相同才滚动提交；未注册或无法验证的后继一律安全失败并保留旧代 ACTIVE。输出 `incomplete_found` + 每行 resolution；**绝不新建第二个后继、绝不删除任何 OpenCode 会话** |

`restoreSession` 目前是 lifecycle core 的受控 API（不是生产工具），用于主控在
`HANDOFF_READY` 后执行人工 restore/reload 流程；它同样只接受合法 v1 checkpoint，
没有 checkpoint 时拒绝伪造上下文。生产工具面严格保持上述 5 个名称。

## 遥测与"零估算"政策（normative）

- 协议 = `docs/runtime-context-telemetry.md`：取 `ctx.session.context()` 中
  **最新一条携带 `tokens` 的 assistant 消息**，total =
  input+output+reasoning+cache.read+cache.write；limit = 该消息
  `{providerID, id}` 在 `ctx.model.list()` 目录中的 `limit.context`；
  pct = `Math.round(total/limit*100)` — 与 Desktop UI 逐字节同式。
- 明确禁止（`approximation_allowed: false` 为 Plan 8 常设规则）：字符/4、
  本地 tokenizer、session 累计 tokens 当上下文、按模型名猜窗口、任何
  fallback 数值。拿不到就返回 `null` / `TELEMETRY_UNAVAILABLE` 状态（保留上次已验证列值），
  **永不伪造数字**；实测缺失时不清掉上一次已验证样本。
- 分带阈值只在 `framework-config/lifecycle.yaml`（60 / 60-70 / 70 / 80），
  每次调用现读；配置缺失/非法即结构化失败，代码内无任何 band 字面量。
- compaction 后 pct 骤降是**协议内的预期行为**（context view 以最新
  compaction 为界），消费方不得当作测量故障。

## lifecycle_state 与 rotation 状态

`sessions.lifecycle_state`（与 Plan 5 `sessions.status` 严格分离）：

```text
ACTIVE → CHECKPOINT_READY → ROTATE_PENDING → HARD_ROTATE   （分带标签）
ROTATING → ARCHIVED / ROTATION_FAILED / HANDOFF_READY / STALE （换代/恢复流程专属）
```

- 分带评估只会覆盖 4 个 band 标签；ROTATING / ARCHIVED / STALE /
  ROTATION_FAILED / HANDOFF_READY 归换代与恢复流程独占，绝不被写回。
- `lifecycle_rotations.status`：`PREPARING → SUCCESSOR_CREATED → INITIALIZED →
  COMMITTED`，任一失败落 `FAILED`（错误详情入 `error` 列）；每步先落库再
  await（崩溃恢复锚点）。换代失败时**旧代保持 ACTIVE 可用**；已创建未初始化的
  后继会话只记录、永不删除（audit）。

## Checkpoint / 换代 / 恢复语义要点

- Checkpoint 实例是 runtime 状态：`runtime/checkpoints/<sanitized-session-key>/
  gen-XXXX-<checkpoint-id>.json`，原子写（tmp + fsync + rename）；内容 = v1
  schema：已验证 context 三件套 + 活跃 task/workflow refs + 只读 git 状态
  （rev-parse / status --porcelain，≤200 行）+ 有界摘要（≤20000 字符、
  排除 tool output、落盘前密钥脱敏）。**Mem0 只存 restore 引用，本插件从不调用
  Mem0**。
- Rotation 严格顺序（全程持 per-session_key 全局锁）：刷新遥测并复核阈值 →
  强制写新 checkpoint 并再次复核 → PREPARING 落库 → 创建后继 → **先持久化**
  `successor_session_id` + SUCCESSOR_CREATED → switchAgent → switchModel →
  base scope + checkpoint 恢复上下文 → INITIALIZED → 单事务（注册后继行 +
  归档旧行 + replaced_by + COMMITTED）。模型按已有配置/旧行显式值解析，
  为 null 则 `MODEL_UNASSIGNED`，绝不猜测。锁非重入：facade 注入 `*Locked` 原语。
- 后继行的最终态 = `status ACTIVE` + `lifecycle_state HANDOFF_READY`，这是
  **现阶段的主真相（primary truth）**：引擎完成"建档 + 播种上下文"，但工作
  的接续由人工在 Desktop UI 打开该后继会话完成（manual UI handoff）。插件与
  文档一律不得声称任务已被自动续跑。

## 新鲜会话规则（不受本引擎换代）

lifecycle 换代只针对 `framework.yaml` 声明的持久管理角色
（`managed_roles`: project-main / project-reader；drawio 中 global-orchestrator
同为 managed）。以下角色按架构定义**永远使用新鲜会话，不存在复用与换代**：

- `reviewer`：`per-review-round` + `always_new_session: true`（每轮审查全新
  会话，禁止复用；workflow-engine §52 同规则）
- `api-runner` / `test-runner`：`test-round-scoped`，每个测试轮次新建 ephemeral
  会话（Task Bus §37 路径），不注册 `sessions` 表

对这些角色调用生命周期工具只得到只读视图/常规校验，不产生换代语义。

## 自动化开关与边界（当前阶段）

- `framework.yaml`：`runtime_registry.automatic_rotation: false`、
  `workflow_engine.automatic_lifecycle_rotation: false`、
  `lifecycle_engine.automatic_rotation: false` — **保持 false**。
  观察性 context/compaction hook 不执行换代；正式 admission 开关仍关闭。Plan 8 冒烟阶段 + 独立
  Reviewer PASS 之前不得启用自动换代。
- lifecycle-agent profile 仍为 advisory 模式，本插件不改变其权限。
- 未实现：自动分带触发、UI 会话自动接管、Mem0 读写、Git 写操作、
  新表/改表（引擎自身从不执行 DDL）。

## 测试钩子（marker-gated，TEST-ONLY，非生产工具）

- 仅当插件**加载时**存在标记文件 `runtime/.lifecycle-test-hooks`（由主控管理，
  插件绝不创建/删除），才额外注册 `lifecycle_test_hook`；否则生产 tool registry
  恰好看到 5 个工具，钩子逻辑全部空转。
- 钩子状态仅存内存（reload 即清空），`seed_telemetry` 用于隔离测试行，
  `force_phase_failure` 在真实 rotation 阶段消费；它不是生产工具，不得被任何生产路径调用或在其文档/返回中
  与 5 个生产工具并列为"第 6 个生命周期能力"。

## 数据库

共用 `runtime/tasks.db`（经共享 runtime core 的既有 db 句柄；不另开库、不改
`sessions` / `tasks` 结构）。

- `lifecycle_events`：append-only 账本（当前实现统一写入 `TELEMETRY_SAMPLE`，其中
  `stored:false` 表示本次无法取得完整验证值；另有 checkpoint/rotation 状态事件 /
  LIFECYCLE_STATE_CHANGED / CHECKPOINT_WRITTEN / CHECKPOINT_REUSED /
  ROTATION_STARTED / ROTATION_COMMITTED / ROTATION_FAILED / ROTATION_RECONCILED /
  SESSION_RESTORED / SESSION_RESTORE_FAILED），行只插入不更新；事件插入失败
  绝不中断换代主流程（rotation 行才是权威）。
- `lifecycle_rotations`：每行一次换代（from→to generation、checkpoint_path、
  successor_session_id、status、error），与 `sessions.replaced_by` 链互为审计。

## 错误码表（主要）

| 错误码 | 含义 |
| --- | --- |
| SQLITE_RUNTIME_UNAVAILABLE / LIFECYCLE_SCHEMA_UNAVAILABLE / SESSIONS_V2_COLUMNS_MISSING | 存储/模式未就绪（T3 schema 须经共享 core 幂等建表） |
| INVALID_INPUT / SESSION_NOT_FOUND | 输入与定位校验 |
| LIFECYCLE_CONFIG_LOAD_FAILED / LIFECYCLE_CONFIG_INVALID / YAML_PARSER_UNAVAILABLE | lifecycle.yaml 现读失败；拒绝用默认值评估 |
| CHECKPOINT_TELEMETRY_UNAVAILABLE / CHECKPOINT_SCHEMA_VIOLATION / CHECKPOINT_WRITE_FAILED | checkpoint 无验证值不落盘 / 违反 v1 schema 拒写 / 原子写失败 |
| ROTATION_NOT_ACTIVE / ROTATION_IN_PROGRESS / ROTATION_STATE_CONFLICT | 只换 ACTIVE 代；未决 rotation 须先 reconcile；绝不双后继 |
| ROTATION_TELEMETRY_UNAVAILABLE / ROTATION_NOT_DUE | 无验证 pct 且未 force；分带未达换代线 |
| ROTATION_CHECKPOINT_FAILED / MODEL_UNASSIGNED / SESSION_CREATE_FAILED / SESSION_INIT_FAILED / ROTATION_COMMIT_FAILED | 换代各阶段失败；旧代保持 ACTIVE，rotation 落 FAILED |
| RESTORE_NOT_NEEDED / RESTORE_CHECKPOINT_NOT_FOUND / RESTORE_CHECKPOINT_FILE_MISSING / RESTORE_CHECKPOINT_UNPARSEABLE / RESTORE_CHECKPOINT_INVALID / RESTORE_STATE_CONFLICT / RESTORE_REGISTER_FAILED | 恢复前置与校验（无 checkpoint 不恢复；非 v1/非本 key 拒用） |

## 契约

- 遥测：`docs/runtime-context-telemetry.md`（T1 VERIFIED）
- Checkpoint：`templates/checkpoint.schema.json`（schema_version 1）
- 阈值与角色生命周期：`framework-config/lifecycle.yaml`（drawio 镜像，冲突时
  drawio wins）
- 开关：`framework-config/framework.yaml`（automatic_rotation 保持 false）
