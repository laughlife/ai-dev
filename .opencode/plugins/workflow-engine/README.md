# Workflow Engine Plugin (Plan 7 Phase 4 — T7a)

Workflow Engine 插件：Planner 驱动的 Task DAG 工作流。当前为 T7a 阶段
（规划 + 校验 + 物化），调度器 / Reviewer 闭环由 T7b 落地。

## 目录结构

```text
.opencode/plugins/workflow-engine/
├─ index.ts      插件入口：共享 core + 5 个 workflow 工具注册
├─ schema.sql    §31 workflows / workflow_nodes 表（幂等 IF NOT EXISTS）
├─ dag.ts        纯函数：DAG 确定性校验 / 受影响子图 / JSON 提取
├─ planning.ts   纯函数：Planner prompt（§35）+ JSON repair prompt（§36）
└─ README.md     本文件
```

## 工具面（namespace `workflow`，恰好 5 个）

| 工具 | 状态 | 说明 |
| --- | --- | --- |
| workflow_plan | ✅ 已实现 | Planner 规划 → 确定性校验 → 物化为 Task Bus 任务；**不自动 run**（§67），成功后 workflow=READY |
| workflow_get | ✅ 已实现 | 纯 DB read：workflow 行（含 plan）+ nodes（current task / task history / review history / verdict，§70） |
| workflow_list | ✅ 已实现 | 过滤 project_id / status / limit（默认 20，最大 100），newest first（§71） |
| workflow_run | ⏳ T7b | 占位：返回 NOT_IMPLEMENTED_YET（自动调度 / 并行 wave / Reviewer 闭环） |
| workflow_execute | ⏳ T7b | 占位：返回 NOT_IMPLEMENTED_YET（plan + run 组合，Global Orchestrator 标准入口） |

## workflow_plan 流程（§34/§36/§38）

```text
validate project (projects.yaml)
→ insert workflows 行 status=PLANNING
→ bus.createTask 创建 Planner task（route = workflow.yaml planner.route）
→ planner 模型显式解析（agents.yaml，null → workflow FAILED / MODEL_UNASSIGNED，绝不猜）
→ ensureScopedSession(workflow:<id>:planner) + sendScopedSession(规划 prompt)
→ extractJsonObject + validateWorkflowPlan（确定性，绝不让 LLM 判环）
→ 失败且 planner.json_repair_attempts>=1：validator errors 发回同一 session 修正 1 次
→ 二次仍失败：workflows=FAILED / PLAN_INVALID，不物化任何 task
→ 成功：plan_json 落库 → Planner task 落 COMPLETED（buildResult+persistResult）
→ 单事务物化（§38）：按 Kahn 拓扑序逐 node bus.createTask
  （parent_task_id=planner task；depends_on 按 node_id→task_id 映射转 dependencies，
   拓扑序保证创建某 node 时其依赖的 task_id 已存在）
  + workflow_nodes 行（READY / attempt=1 / task_history）+ workflows=READY
→ 任一物化失败整体回滚，workflows=FAILED（plan_json 保留供审计）
```

## 数据库

共用 `runtime/tasks.db`（与 runtime-registry / task-bus 插件同一库，经共享
core 的 db 句柄；本插件不另开数据库、不修改既有 `sessions` / `tasks` 表语义）。

新增表（schema.sql，setup 时幂等执行）：

- `workflows`：workflow_id PK / primary_project_id / objective / status
  （PLANNING·READY·RUNNING·BLOCKED·REVIEWING·REWORKING·COMPLETED·FAILED·REWORK_LIMIT，§32）
  / planner_task_id / planner_session_id / plan_json / rework_cycle / 时间戳
- `workflow_nodes`：PK(workflow_id, node_id) / current_task_id / attempt /
  status / review_task_id / last_verdict / task_history_json /
  review_history_json / updated_at + idx_workflow_nodes_workflow 索引

## 配置（现读，不硬编码策略数值）

- `framework-config/workflow.yaml`：planner.route、planner.json_repair_attempts
  （T7b 将消费 scheduler / parallel_policy / review / retry 段）
- `framework-config/projects.yaml` / `agents.yaml` / `routing.yaml` /
  `task-bus.yaml`：经 bus.loadBusConfig() 每次调用现读

## 契约

- Planner 输出：`templates/workflow-plan.schema.json`（schema_version 1）
- Node 物化：`templates/task-envelope.schema.json`（经 bus.createTask）
- Planner task 结果：`templates/result-envelope.schema.json`（bus.buildResult）

T7b 将补全：workflow_run 调度器（并行 wave / max_parallel）、Reviewer 闭环
（PASS/FIX/REWORK、rework_cycle、computeDescendantSubgraph 消费）、
workflow_execute 组合入口、archiveScopedSession 收尾。
