# Plan 12.6：Completion Guard L3 Evidence Integration

Plan 12.5-R2 已收口为 PASS，真实 Runtime 证据写入和隔离权限双门禁完成。本阶段把同一份已提交的 L3 Control Plane 事实接入 Completion Guard；它不从 `workflow_execute` 返回摘要、tasks.db 结果或旧文档补造事实。

## 判定边界

`completion_final_report_permission` 和 `completion_finalize` 对带有
`metadata.runtime_evidence_required=true` 或
`metadata.execution_policy.mode=isolated_fixture` 的 Workflow 执行额外 L3 检查。Legacy Workflow 没有该声明时保持 Plan 9 的既有检查和兼容读路径。

L3 检查只读打开 `execution_policy.control_plane_db` 指定的数据库。路径必须显式存在，并且位于 Workflow 的 `allowed_roots` 或 fixture root 下；不会调用初始化器，不会创建默认 `runtime/control-plane.db`，不会写 Control Plane、tasks.db、业务仓库或 Mem0。

如果同一 `workflow_id` 存在多个 Control Plane run，调用方必须传入 `run_id`；Guard 返回 `EVIDENCE_RUN_AMBIGUOUS`，不按时间或摘要猜测。retry 使用独立 `run_id`，并继续校验 parent/config_revision 关系。

## L3 完整性检查

Guard 按单一 run 和单一 `config_revision` 校验：

1. `workflow_runs` 存在、状态为 `COMPLETED`、时间闭合、`evidence_write_status=COMPLETE`，且 run digest 与计划 digest 一致。
   所有 L3 事实（run、snapshot、wave、node、execution、lock、lifecycle）还必须保有 schema/version、source、observed_at、idempotency、payload hash 等公共 envelope；observed_at 以及各自生命周期时间必须是 UTC ISO-8601。
2. 配置快照存在，状态属于 ACTIVE 或已提交的历史 `SUPERSEDED`/`ROLLED_BACK`，配置和模型/路由 digest 完整。
3. `workflow_run_events` 从 sequence 1 连续到末尾，包含 `RUN_STARTED` 和最后的 `RUN_FINISHED`，不存在 `EVIDENCE_WRITE_FAILED`，run/workflow/revision 身份一致。
4. 每个 required plan node 都有终态 `workflow_wave_nodes`、真实 session、task、起止时间和对应 wave；每个 node 至少有匹配的 `NODE_FINISHED` execution event。
5. wave index、node attempt、execution sequence、payload reference 和 digest 保持一致。wave/node 的派生 `workflow_id` 不参与重算，以保持 Writer 的原始 canonical digest 语义。
6. 已存在的锁事件按 `(run_id, lock_key)` 校验连续 sequence 和 owner 生命周期。没有真实锁 provider 且 node 没有声明 lock key 时不生成、不要求伪造锁事实。
7. node route 只允许当前 revision 中唯一的 `BOUND` route binding；provider/model/variant/exact reference、AVAILABLE catalog、AVAILABLE probe、probe id 和 runtime version 必须一致。现有 Plan 12.4 模型表没有重复的公共 envelope 列时，Guard 校验其等价的 source/time/config/idempotency/hash 字段，并重算存储行或旧 Writer alias 的 canonical digest，同时核对 `evidence_idempotency` 链；篡改模型状态、身份或 payload 会阻断。`MODEL_UNASSIGNED`、`UNAVAILABLE`、`REJECTED` 均 fail-closed。
8. 锁事件只能引用已规划的 wave/node 和 node 声明的 lock key；非法 `lock_key_json`、孤立事件、未知 key、owner/sequence 不一致或未释放均阻断。每个 node 的 attempt 必须从 1 连续递增，旧 attempt 必须有 execution `NODE_FINISHED` 以及 lifecycle `NODE_STARTED`/`NODE_FINISHED` 闭合证据。

L3 checker 成功返回 `verification=PASS`、`evidence_level=L3`。对声明 Runtime evidence 的 Workflow，`completion_final_report_permission` 只返回 `FINAL_REPORT_PREAUTHORIZED`，表示只读预授权，不宣称 L4 或 `FINAL_REPORT_ALLOWED`。只有既有 Reviewer、delivery、child-task 检查也通过，并且 `completion_finalize` 事务成功提交后，最终结果才可返回 `COMPLETED`、`final_report_permission=true`、`evidence_level=L4`。没有 Runtime evidence 声明的 Legacy Workflow 保留 `FINAL_REPORT_ALLOWED` 的兼容读状态，但仍只返回 `evidence_level=UNVERIFIED`，不会被自动升级为 L4。`delivery=none` 不绕过 Plan 9 delivery gate，因此 Plan 12.5 execution-only Smoke 的 `DELIVERY_PENDING` 仍是预期结果。

## 失败语义与并发

Control Plane 不可读、快照缺失、run 歧义、生命周期缺口、digest 不一致、模型未绑定或 evidence write 失败都返回 `COMPLETION_GUARD_BLOCKED`，`permission=false`，不修改 Workflow 状态。`completion_finalize` 会在自己的事务中重新执行同一 evidence check，不复用先前 permission 结果。

写入失败的 run 不会被补造为成功；如果只存在 `EVIDENCE_WRITE_FAILED` 事件，Guard 保留可诊断阻断原因。append-only 事实、run identity 和 config revision 不被覆盖。

## 验收

```text
PLAN12_COMPLETION_GUARD_EVIDENCE_PASS
```

测试覆盖：完整 L3 fixture、canonical digest 回读、显式隔离 DB、缺失 DB fail-closed、Legacy 兼容、finalize 阻断不改状态、模型精确身份和 lifecycle gate。Plan 12.5 的真实 Live artifact 继续作为事实生产来源；本阶段不重新执行 Desktop Runtime。
