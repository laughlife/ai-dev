# Plan 12.4 模型目录与路由门禁

Plan 12.4 将模型身份、运行时探测事实和路由绑定保存到指定的
`runtime/control-plane.db`。`runtime/tasks.db` 仍由既有调度器管理，不读取或写入
模型目录表。

## 精确身份

`provider_id`、`model_id` 和 `variant` 分列保存，`exact_model_ref` 由三者按
`provider/model[#variant]` 组成。`display_name` 只用于显示，不能参与路由或门禁。
目录条目还保存运行时来源、版本、探测时间、探测状态、错误、元数据摘要以及
`config_revision`。静态配置不能产生 `AVAILABLE`：该状态必须引用成功的
`runtime_model_probes` 记录；Qwen 的配置候选因此不会自动被当作可用模型。

## 运行时探测

`recordRuntimeProbe` 只保存带 endpoint、runtime_version、workflow-engine 插件
状态和工具列表的事实。插件未加载或缺少 `workflow_plan`、`workflow_run`、
`workflow_execute`、`workflow_get`、`workflow_list` 时，探测不能产生
`AVAILABLE`。探测事实和模型目录写入同一份全局 evidence idempotency 索引，重复
摘要幂等接受，复用 key 写入不同摘要返回
`EVIDENCE_IDEMPOTENCY_CONFLICT`。

## 路由与门禁

`route_bindings` 为每个正式角色保存 workflow/project scope、lane、模型精确身份、
状态和配置版本。`xxl-job` 没有明确模型时固定为 `MODEL_UNASSIGNED`，不会借用其他
项目模型。任何非 `BOUND` 路由在 `validateRouteBinding` 中 fail-closed：

- `MODEL_UNASSIGNED` → `MODEL_UNASSIGNED`
- `UNAVAILABLE` → `MODEL_UNAVAILABLE`
- `REJECTED` → `MODEL_ROUTE_REJECTED`
- 缺失身份 → `MODEL_ID_MISSING`
- 不存在目录 → `MODEL_CATALOG_NOT_FOUND`
- 版本不一致或已 superseded/rolled back → `MODEL_CONFIG_REVISION_CONFLICT`
- 没有成功 runtime probe → `MODEL_RUNTIME_PROBE_REQUIRED`

门禁没有默认模型、静默 fallback 或跨 revision 读取。模型目录、路由、探测和门禁
审计均使用 append-only 表和触发器；变更通过新事实和新的配置版本表达。

## 表边界

- `model_catalog`：精确模型身份和最新探测关联。
- `route_bindings`：配置版本下的角色路由绑定。
- `runtime_model_probes`：真实 endpoint 探测事实，包含工具可达性。
- `model_route_audit_events`：探测、绑定、拒绝和门禁事件。

这些表只在显式指定的 control-plane 数据库中初始化。Plan 12.4 不接入 Scheduler、
Completion Guard、Apply/Rollback 流程，不创建生产数据库，不自动替换 Qwen 或任何
架构模型。
