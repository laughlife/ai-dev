# Plan 11 真实生命周期验收记录

2026-10-01 通过 Desktop V2 的真实 `lifecycle` 生产工具对
`project:ruoyi-vue-pro:reader` 执行了只读状态检查、checkpoint、强制 rotation
和两次 reconcile。运行时版本和会话来自真实 Runtime Registry；没有直接写
SQLite、没有修改业务仓库、没有修改配置，也没有启用 automatic rotation。

真实结果：

- `lifecycle_status` 返回 generation `2`、session
  `ses_f13476d28ffeuq6UZovPjdgHxD`，`context_tokens=45824`，但
  `context_limit=null`、`context_pct=null`。
- `lifecycle_checkpoint` fail-closed，返回
  `CHECKPOINT_TELEMETRY_UNAVAILABLE`，因为 Desktop V2 的
  `ctx.model.list()` 没有为架构指定的 `deepseek/deepseek-flash` 返回可验证的
  `limit.context`。
- `lifecycle_rotate(force=true)` 同样 fail-closed，明确返回“不生成 checkpoint
  就拒绝 rotation”，且没有写入 `lifecycle_rotations`。
- 第一次和第二次 `lifecycle_reconcile` 都返回
  `{"ok":true,"status":"OK","incomplete_found":0,"count":0}`，证明空
  rotation ledger 的 reconcile 是幂等的。

随后对架构注册的 Project Main `project:ruoyi-vue-pro:main` 又执行了一次真实
状态检查。该会话为 generation `1`、session
`ses_f1347dd61ffe7TclIzrRRPlDR6`、模型
`openai/gpt-5.6-sol-fast#high`，但同样返回 `context_limit=null` 与
`context_pct=null`。Global Orchestrator 因此按 no-estimation 规则没有继续调用
checkpoint、rotation 或 reconcile；没有生成新的 lifecycle ledger 行。

这是真实运行时的安全失败证据，不能替代 Plan 8 要求的成功
rotation/restore/reconcile 记录；在获得可验证的模型 context limit 前，Plan 11
门禁必须继续拒绝 `RELEASE_READY`。

## 后续隔离 fixture 成功证据

同一 Desktop V2 Runtime 随后在新建的 `xxl-job` Project Reader 隔离 fixture 上
取得了可验证的 `deepseek/deepseek-flash` `limit.context=1000000` 和
`context_pct=5`。真实链路完成了 checkpoint `CHECKPOINT_WRITTEN`、generation 1→2
的 `ROTATED`、generation 2 archive、generation 3 `RESTORED`，以及两次
`OK/incomplete_found=0` reconcile。原始结构化证据、会话 ID、checkpoint 路径和
fresh Reviewer PASS 记录在 `docs/plan8-rotation-evidence.json`；此前的安全失败
记录仍保留为独立历史，未被改写。
