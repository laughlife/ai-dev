# Plan 11 交付链

Workflow Engine 在 Planner 计划物化前补齐一条确定性的交付 DAG：

```text
独立 Reviewer PASS
        ↓
documentation_update
        ↓
long_term_memory_write
```

Reviewer PASS 是验证节点的状态与独立 Reviewer 结果，不是 Planner 文本中的声明。两个交付节点使用固定依赖，因此会在同一次 `workflow_run` 中自动进入后续 wave；Memory 节点不能绕过 Documentation 节点。

每个工作流的交付契约包含两个真实证据引用：

- `docs/workflows/<workflow_id>/delivery.md`
- `memory:workflow:<workflow_id>`

Documentation Agent 与 Memory Agent 必须在 JSON 输出的 `artifacts` 数组中返回对应证据。调度器只接受 Agent 实际返回的证据；没有输出、空数组、或缺少契约引用时，将任务标记为失败并保持 Completion Gate fail-closed。实现不会创建伪造的文件或 Mem0 记录，也不会把临时任务状态写入长期记忆。

架构定义的 Documentation 模型为 DeepSeek-V4.1-Flash，Memory 模型为 GPT-5.6 Sol Fast。当前代码只负责按 `routing.yaml` 解析这些角色；模型不可用时由 Task Bus 返回阻断结果，不继承主控模型。

验证：

```text
node --experimental-strip-types --test .opencode/tests/delivery-chain.mjs
node --experimental-strip-types --test .opencode/tests/workflow-team-worker-sessions.mjs
node --experimental-strip-types .opencode/tests/plan9-architecture-smoke.mjs
node --experimental-strip-types .opencode/tests/completion-guard-hard-gate.mjs
node --experimental-strip-types .opencode/tests/plan11-production-acceptance.mjs
```
