# Workflow Engine Plugin (Plan 7 Phase 4 — T7a + T7b)

Workflow Engine 插件：Planner 驱动的 Task DAG 工作流。T7a 交付规划半区
（plan / 校验 / 物化 / 只读查询），T7b 交付执行半区（自动 DAG 调度器、
并行 wave、Reviewer PASS/FIX/REWORK 闭环、安全重试、marker-gated 测试钩子、
workflow_execute 组合入口）。

## 目录结构

```text
.opencode/plugins/workflow-engine/
├─ index.ts      插件入口：共享 core + 5 个 workflow 工具（+条件注册 test hook）
├─ schema.sql    §31 workflows / workflow_nodes 表（幂等 IF NOT EXISTS）
├─ dag.ts        纯函数：DAG 确定性校验 / 受影响子图 / JSON 提取
├─ planning.ts   纯函数：Planner prompt（§35）+ JSON repair prompt（§36）
├─ scheduler.ts  T7b：自动调度器（wave 分组/锁/scoped 执行/safe retry）+ 纯函数
├─ review.ts     T7b：Reviewer 闭环（§50-§59：verdict 解析/rework 子图重放）
├─ hooks.ts      T7b：测试钩子（§84/§85，marker-gated，仅内存态）
└─ README.md     本文件
```

## Implemented（Plan 7 清单）

- §31 workflows / workflow_nodes 表（共用 runtime/tasks.db，幂等建表）
- §34-§38 workflow_plan：Planner scoped session → 确定性解析/校验（绝不让
  LLM 判环）→ 有限 JSON repair → 单事务物化 node tasks；**绝不自动 run**（§67）
- §39-§44 workflow_run：自动调度循环、依赖就绪判定、parallel wave
  （Promise.allSettled，max_parallel 截断）、route 安全分级 + 锁
- §45-§49 scoped session：planner（`workflow:<wf>:planner`）、feature-executor
  （`workflow:<wf>:project:<pid>:feature-executor`，attempt/rework 间自然复用，
  模型严格来自 agents.yaml project_sessions，null → BLOCKED/MODEL_UNASSIGNED
  绝不猜）；最终 PASS 后 archiveScopedSession（只标记 ARCHIVED，不删 OpenCode 会话）
- §50-§59 Reviewer 闭环：independent_review task（§51 五要素 objective）、
  每轮 fresh reviewer session（§52，ephemeral 天然满足）、严格 verdict 解析
  （§53，parseReviewerResultText）、invalid 允许 1 次全新重审（§54）、
  PASS 收尾（§55）、FIX/REWORK 机械重放受影响子图（§56-§58，
  computeDescendantSubgraph，无关并行分支不动）、rework 上限（§59）
- §60-§62 safe retry：仅执行类错误码 × retry.safe_routes × 预算内；
  BLOCKED 类绝不重试；never_retry_routes 绝不重试
- §68/§69 workflow_run / workflow_execute（plan + run 组合，Global
  Orchestrator 标准入口）
- §70/§71 workflow_get / workflow_list（纯 DB read，有界）
- §84/§85 测试钩子（marker-gated，见下）

## Not implemented（Plan 7 范围外 / 后续 Plan）

- context telemetry、60/70/80 上下文轮换
- checkpoint / restore（Workflow 断点续跑仅有 BLOCKED/RUNNING 状态的
  workflow_run 重入恢复，不是完整 checkpoint 机制）
- drawio → framework-config 自动解析同步
- Documentation / Memory 的 reviewer-pass 自动触发链（Plan 9 闭环；
  Task Bus 侧 §64/§65 严格校验已就绪）
- workflow cancel / 暂停（无此工具）

## 工具面（namespace `workflow`）

生产恰好 5 个工具：workflow_plan / workflow_run / workflow_execute /
workflow_get / workflow_list。仅当插件加载时存在标记文件
`runtime/.workflow-test-hooks`，才额外注册第 6 个 TEST-ONLY 工具
`workflow_test_hook`（见"测试钩子"）。

## 状态机

Workflow（§32，workflows.status）：

```text
PLANNING → READY → RUNNING → (REVIEWING ⇄ REWORKING) → COMPLETED
                     │                                    
                     ├→ FAILED（node 失败/REVIEW_RESULT_INVALID 等，写 finished_at）
                     ├→ BLOCKED（node BLOCKED / 基础设施故障；不写 finished_at，
                     │           修复后再次 workflow_run 可续跑）
                     └→ REWORK_LIMIT（rework_cycle 超限，写 finished_at）
```

- terminal：COMPLETED / FAILED / REWORK_LIMIT（workflow_run 不重跑，返回现态）
- 可续跑：READY / RUNNING（陈旧）/ BLOCKED / REVIEWING / REWORKING
- PLANNING → workflow_run 返回 WORKFLOW_NOT_READY
- 同 workflow 已有活跃调度循环 → WORKFLOW_ALREADY_RUNNING（fail-fast，
  另有 `workflow:<id>` 锁兜底）

Node（workflow_nodes.status）：

```text
READY → RUNNING → COMPLETED            （无 review gate）
                → REVIEWING → REVIEW_PASSED   （gate：verdict PASS）
                            → READY(attempt+1)（gate：FIX/REWORK 子图重放）
                → FAILED               （重试预算耗尽/不可重试）
                → BLOCKED              （MODEL_UNASSIGNED 等 BLOCKED 类）
```

node 完成态 = COMPLETED / REVIEW_PASSED；依赖就绪判定只看完成态。
续跑时 BLOCKED/RUNNING node 会按其 task 实际状态自动 reconcile。

## Wave 策略（§40-§44，参数全部现读 workflow.yaml）

- ready nodes 按 rowid（拓扑）序切分为 wave，单 wave ≤ `scheduler.max_parallel`
- wave 内 `Promise.allSettled` 真并发；route 分级决定执行体锁：
  - `safe_routes`（code_read / project_analysis / project_coordination /
    api_runtime_call / api_regression）→ 无额外锁，真并行
  - `project_serial_routes`（code_change / api_code_change / build_and_test /
    documentation_update）→ `withLock("project:<pid>:write")`：同 project 串行，
    不同 project 可并行
  - `global_serial_routes`（database_write / database_ddl / database_backup →
    `global:database`；long_term_memory_write → `global:memory`）→ 全局串行
  - 不在任何清单的 route → 保守按 project_serial 处理
- 执行路径：code_change / api_code_change → workflow-scoped feature-executor
  会话（ensureScopedSession/sendScopedSession，withTaskLock 内置 RUNNING 迁移）；
  其他 route → bus.dispatchTask（persistent/ephemeral 既有路径原样复用）
- workflow_run 返回 `waves[]`（node_ids / parallelism / locks / 每 node
  started_at/ended_at），并发 wave 的时间戳重叠即并行证据

## Retry 策略（§60-§62，现读 workflow.yaml retry 段）

task FAILED 后同时满足才自动重试：

1. `retry.enabled: true`
2. 错误码属执行类：WAIT_TIMEOUT / SESSION_CREATE_FAILED / SESSION_INIT_FAILED /
   EXECUTION_FAILED / NO_ASSISTANT_RESULT / NO_ASSISTANT_TEXT（含 hook 强制同名码）
3. route ∈ `retry.safe_routes` 且 ∉ `retry.never_retry_routes`（后者优先）
4. 该 node 当前 attempt 已用重试次数（从 task_history 推导，跨续跑持久）
   < `retry.max_retries`

重试 = 新建 task（同 envelope，parent_task_id=失败 task），node attempt 不变、
状态回 READY；BLOCKED 类错误码（MODEL_UNASSIGNED / DEPENDENCY_NOT_READY /
ROUTE_PRECONDITION_UNSATISFIED）绝不重试，必须先解决阻塞原因。

## Reviewer 闭环与 rework 上限（§50-§59）

- gate node（plan.review.required=true）task COMPLETED → node REVIEWING →
  workflow REVIEWING → 创建 independent_review task（§51 五要素）→ dispatch
  （fresh ephemeral reviewer session，禁止复用）
- verdict 经 parseReviewerResultText 严格解析；invalid → 新建 reviewer task
  重审 1 次（旧 task 不修改）；第二次仍 invalid → workflow FAILED /
  REVIEW_RESULT_INVALID
- PASS → node REVIEW_PASSED；全部 node 完成 → 归档各 (wf,pid) scoped
  feature-executor 会话 → workflow COMPLETED
- FIX / REWORK → rework_cycle+1；超过 `review.max_rework_cycles`（现值 2）→
  workflow REWORK_LIMIT 停止；否则 workflow REWORKING，用
  computeDescendantSubgraph(plan, target, gate) 只重放 target..gate 受影响
  子图：每 node 新建 task（objective 追加 REVIEW FINDINGS JSON + FIX
  "局部修复最小改动" / REWORK "结构性返工重核 acceptance criteria" 注明，
  parent=上一版 task，context_refs 追加 review task），attempt+1、回 READY；
  无关并行分支的 COMPLETED node 不动；feature-executor scoped 会话同 key 复用
- review_history_json 每轮追加 {task_id, round, session_id, verdict, ts}

## 测试钩子（§84/§85，TEST-ONLY，marker-gated）

- 标记文件：`D:\ai-dev\runtime\.workflow-test-hooks`（由主控管理，插件绝不
  创建/删除）。**仅在插件加载时检查**：加载时不存在 → 生产模式，恰好 5 个
  工具，hook 逻辑全部空转；加载后出现标记文件 → 需重载插件（保存插件文件
  触发 watcher 热重载）才会注册 `workflow_test_hook`
- 状态仅存内存 Map，插件 reload 即清空
- 动作：
  - `force_verdict {workflow_id, verdicts:[PASS|FIX|REWORK,...]}`：FIFO 队列，
    每轮 review 消费一个；消费时仍创建真实 reviewer task 行（审计），但结果
    为合成合法 reviewer-result JSON（session_id=null，summary 注明 forced by
    test hook）——零模型消耗
  - `force_failure {workflow_id, node_id, code, times=1}`：该 node 接下来
    times 次执行不真实 dispatch，直接落 FAILED（error=`<CODE>: forced by test
    hook`）——零模型消耗；强制码同样参与 §60-§62 重试判定
  - `clear {workflow_id?}` / `list`
- 生产 tool registry 永远看不到该工具（§84/§85 约束）

## 错误码表

| 错误码 | 来源 | 含义 |
| --- | --- | --- |
| WORKFLOW_NOT_FOUND | run/get | workflow_id 不存在 |
| WORKFLOW_NOT_READY | run | workflow 仍在 PLANNING |
| WORKFLOW_ALREADY_RUNNING | run | 同 workflow 已有活跃调度循环 |
| WORKFLOW_STATE_INVALID | run | 状态不可续跑（非 resumable 集） |
| PLAN_INVALID | plan | Planner 输出两次校验失败（未物化任何 task） |
| DAG_CYCLE | plan 校验 | depends_on 成环（validator errors 内） |
| MATERIALIZE_FAILED | plan | 物化事务失败整体回滚 |
| MODEL_UNASSIGNED | plan/run | 角色模型未配置；BLOCKED，绝不猜/继承/默认 |
| WORKFLOW_CONFIG_LOAD_FAILED | run | workflow.yaml 读取失败 |
| NODE_FAILED | run | 某 node 失败（重试预算耗尽/不可重试）→ workflow FAILED |
| REVIEW_RESULT_INVALID | run | reviewer 结果两次非法 → workflow FAILED |
| REVIEW_DISPATCH_FAILED / reviewer dispatch code | run | reviewer task 执行失败 → workflow FAILED |
| REWORK_LIMIT | run | rework_cycle 超过 review.max_rework_cycles |
| WORKFLOW_BLOCKED | run | node BLOCKED → workflow BLOCKED（可续跑） |
| STALE_RUNNING_NODE | run | 上次进程遗留 RUNNING task（可续跑） |
| SCHEDULER_STALLED / SCHEDULER_ITERATION_LIMIT | run | 防御性停机（理论上不可达） |
| SQLITE_RUNTIME_UNAVAILABLE / CONFIG_ROOT_NOT_FOUND | 全部 | 基础设施守卫 |
| HOOK_NOT_ENABLED | test hook | 无标记文件时调用 hook 处理器（理论不可达：工具未注册） |

task 级错误码（Task Bus 语义，见 task-bus README）：DEPENDENCY_NOT_READY、
ROUTE_PRECONDITION_UNSATISFIED、WAIT_TIMEOUT、SESSION_CREATE_FAILED、
SESSION_INIT_FAILED、EXECUTION_FAILED、NO_ASSISTANT_RESULT、
NO_ASSISTANT_TEXT 等。

## 数据库

共用 `runtime/tasks.db`（与 runtime-registry / task-bus 插件同一库，经共享
core 的 db 句柄；本插件不另开数据库、不修改既有 `sessions` / `tasks` 表结构）。

- `workflows`：workflow_id PK / primary_project_id / objective / status /
  planner_task_id / planner_session_id / plan_json / rework_cycle / 时间戳
- `workflow_nodes`：PK(workflow_id, node_id) / current_task_id / attempt /
  status / review_task_id / last_verdict / task_history_json /
  review_history_json / updated_at + idx_workflow_nodes_workflow 索引

## 配置（现读，不硬编码策略数值）

- `framework-config/workflow.yaml`：planner.route、planner.json_repair_attempts、
  scheduler.max_parallel、parallel_policy 三组 routes、review.max_rework_cycles、
  retry.enabled / max_retries / safe_routes / never_retry_routes
- `framework-config/projects.yaml` / `agents.yaml` / `routing.yaml` /
  `task-bus.yaml`：经 bus.loadBusConfig() 每次调用现读

## 契约

- Planner 输出：`templates/workflow-plan.schema.json`（schema_version 1）
- Node/Reviewer 物化：`templates/task-envelope.schema.json`（bus.createTask）
- 任务结果：`templates/result-envelope.schema.json`（bus.buildResult）
- Reviewer 输出：`templates/reviewer-result.schema.json`（verdict PASS/FIX/REWORK）
