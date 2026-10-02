# Plan 12.4 验收记录

## 范围

本阶段只增加 Control Plane 的模型目录、路由绑定、真实探测记录和运行前门禁。
Scheduler、Workflow Engine、Completion Guard、业务仓库和生产数据库没有接入或改写。
所有专用 fixture 都使用操作系统临时目录；它们不是生产 L3 事实。

## 事实与边界

`model_catalog`、`route_bindings`、`runtime_model_probes` 和
`model_route_audit_events` 属于 `runtime/control-plane.db` 的 Plan 12.4 表，均有
append-only trigger，并共用 `evidence_idempotency`。`provider_id`、`model_id`、
`variant` 和 `exact_model_ref` 分列保存；display name 仅供展示。只有带成功
`runtime_model_probes` 外键的 `runtime_probe` 条目才可声明 `AVAILABLE`。

Route admission 要求同一 `config_revision` 下存在 AVAILABLE 目录条目；
`MODEL_UNASSIGNED`、`UNAVAILABLE`、`REJECTED`、缺少精确身份、缺失目录、版本不一致、
`SUPERSEDED` 或 `ROLLED_BACK` 都返回结构化拒绝并追加审计。没有默认模型、跨项目
借用或静默 fallback。`xxl-job` 仍固定为 `MODEL_UNASSIGNED`。

## 真实 Runtime 结果

真实 Desktop-managed OpenCode V2 记录在
[`plan12-4-runtime-probe.md`](plan12-4-runtime-probe.md)：版本 `2.0.20`，endpoint
`http://127.0.0.1:49374`，workflow-engine plugin 显示 active，目录 API 广告了
provider/model 条目；五个新鲜 workflow RPC 返回 `rpc.unavailable`。因此本阶段真实
探测状态是：

```text
PLAN12_RUNTIME_MODEL_PROBE_BLOCKED
reason=workflow-engine public RPC route unavailable
```

目录广告没有被转换成 AVAILABLE。`qwen3.8-max` 只保留为精确配置候选，未推断可用性，
没有自动替换；没有为 xxl-job 猜测模型。

## 专用验证

隔离契约测试：

```text
node --experimental-strip-types .opencode/tests/plan12-model-route-contract.mjs
node --experimental-strip-types .opencode/tests/plan12-model-route-gates.mjs
```

两项测试覆盖精确身份、四种目录状态、BOUND 与三种 fail-closed 路由、xxl-job、
Qwen 不替换、幂等冲突、审计、revision 隔离、superseded/rollback 和重启恢复，输出：

```text
PLAN12_MODEL_CATALOG_PASS
PLAN12_ROUTE_BINDING_PASS
PLAN12_MODEL_UNASSIGNED_GATE_PASS
PLAN12_MODEL_ROUTE_GATES_PASS
```

只读真实探测脚本为：

```text
node --experimental-strip-types .opencode/tests/plan12-runtime-model-probe.mjs
```

它不打开或写入任何数据库；Runtime 认证或 workflow RPC 不可达时只输出
`PLAN12_RUNTIME_MODEL_PROBE_BLOCKED`，绝不伪造 AVAILABLE。

## 明确未做事项

本阶段没有实现 Plan 12.5 之后的 adapter、Completion Guard 接入、UI、自动 Apply、
模型替换或调度器改造；没有修改 `runtime/tasks.db`、Drawio、Mem0、业务仓库或用户补丁。
