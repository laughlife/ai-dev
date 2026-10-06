# Plan 12.5 / 12.6 最终收口（Closeout）

本文件是 Plan 12.5（Workflow Runtime Evidence Adapter）与 Plan 12.6（Completion
Guard L3 Evidence Integration）的正式收口文档。

> 当前状态更新（本轮 task `70372e0b-…`，documentation-agent，workflow
> `e357ef66-…` node `sync-final-closeout-evidence`）：本节点**仅**把测试证据引用
> 刷新到本轮真实原始日志——targeted `6418b041-…` 与 full30 `9a1c66d0-…`
> （目录 `runtime/plan12-final-logs-20261006/`）。**live v2 事实不变**：
> workflow `44940f00-…` / run `aa97bf7f-…` / `config_revision
> plan12-final-v2-20261006-4c37812d`。此前的 v1 运行（workflow `2d304a17-…` /
> run `4bbda1c3-…` / revision `plan12-final-20261006-8abc6b7c`）以及上一轮测试证据
> （targeted `c65b5ae2-…` / full30 `b9287486-…`）是历史，保留在“历史”一节，不再是
> 当前证据。structured 回读见
> [`plan12-5-6-final-readback.json`](plan12-5-6-final-readback.json)。

## 结论（必须准确表述）

| 维度 | 结论 |
| --- | --- |
| Plan 12.5 / 12.6 **scope** | **PASS** |
| L3 证据 **verification**（真实 run） | **PASS** |
| **delivery** | **DELIVERY_PENDING**（`delivery=none`） |
| 整体框架终态 | **FINAL_REPORT_BLOCKED**，**不是 L4 COMPLETED** |

> scope PASS 与 L3 PASS 表示“本阶段实现、测试、真实运行与证据链成立”；
> 由于 `delivery=none`，架构 delivery gate 未通过，整体保持
> `FINAL_REPORT_BLOCKED` / `DELIVERY_PENDING`。本文档**不**声称全框架 L4 COMPLETED。

## 当前真实运行证据（live v2）

隔离 Control Plane DB（只读）：

- 路径 `C:/Users/Administrator/AppData/Local/Temp/opencode/plan12-final-v2-20261006-4c37812d/control-plane.db`
- sha256 `0AFFD510D39270F6ED05D8D4682C9F8FBB11BF3A2D12CC402414F6D210081EF4`，
  size 315392，mtime `2026-10-06T08:01:13.707Z`，WAL 0B / SHM 32768B
- `runtime_root=D:/ai-dev`，`policy=explicit-runtime-root-v1`，
  `allowed_roots=[C:\Users\Administrator\AppData\Local\Temp\opencode\plan12-final-v2-20261006-4c37812d]`（lexical == real）
- `config_revision=plan12-final-v2-20261006-4c37812d`，状态 `ACTIVE`（version 4，
  validated `07:59:26.157Z` / activated `07:59:26.166Z`），全部行 `evidence_level=L3`
- 单 run 库：runs 1 / waves 1 / wave_nodes 2 / run_events 8 / execution_events 2 /
  lock_events 0 / probes 1 / catalog 1 / route_bindings 2 / audit 4

workflow（`runtime/tasks.db` 只读）：`44940f00-6ea5-41e8-95b3-e6d3eb9e80e1`

- 状态 `REVIEW_PASSED`，`finished_at=null`，`completion_guard_finalized_at=null`，
  `rework_cycle=0`，planner task `526c5505-c9c5-4de4-9995-841e5f89e570`
- `execution_policy.mode=isolated_fixture`，`delivery=none`，禁 Mem0 / 生产 DB /
  业务仓库写入，`config_revision=plan12-final-v2-20261006-4c37812d`

run：`aa97bf7f-b876-4823-952f-fc718b8b4219`

- `attempt=1`，`trigger=workflow_execute`，`status=COMPLETED`，
  `source=workflow-engine-live-r2`，`engine_version=workflow-engine-r2`，
  `evidence_write_status=COMPLETE`
- `started_at=2026-10-06T08:00:39.470Z`，`ended_at=2026-10-06T08:00:56.508Z`
- `plan_digest=d5267a67…7fe3`，`outcome_digest=6a402191…b59c`

wave：`aa97bf7f-…:wave:0`，`wave_index=0`，`parallelism=2`，`status=COMPLETED`

- `ready_set_digest=5d0a59ba…fa48`，`policy_digest=44136fa3…aff8a`（等于 `sha256("{}")`），
  `evidence_digest=d0dd72dc…daec`
- `lock_snapshot_json=[]`，`lock_events_count=0`（无真实锁 provider，未伪造 ACQUIRE/RELEASE）

同 wave 双 worker（两个无依赖独立 `code_read` 节点，实测并发）：

| node | task | session | raw model | event_seq | 时间 |
| --- | --- | --- | --- | --- | --- |
| `read-architecture-fingerprints` | `87defa1d-70fe-4d9f-a1ea-19f04a946d7a` | `ses_eefc561bbffe1Pi7zo9NfMRVZx` | `deepseek/deepseek-flash#default` | 1 | `08:00:39.487Z → 08:00:53.575Z` |
| `read-probe-summary` | `42712ea6-c8fa-4d19-8d8d-8cb0c5535793` | `ses_eefc561bdffelYrLNBfHMkVRUs` | `deepseek/deepseek-flash#default` | 2 | `08:00:39.481Z → 08:00:56.480Z` |

- 两条 distinct session，重叠 `2026-10-06T08:00:39.487Z → 08:00:53.575Z` ≈ **14.088s**
- 两条 worker session 均 `generation=1`、`agent_id=project-reader`、注册表 canonical
  `deepseek/deepseek-flash`、`status=ARCHIVED`（保留未删除）
- run events 8 条：`RUN_STARTED, WAVE_STARTED, NODE_STARTED(read-probe-summary),
  NODE_STARTED(read-architecture-fingerprints), NODE_FINISHED(read-architecture-fingerprints),
  NODE_FINISHED(read-probe-summary), WAVE_FINISHED, RUN_FINISHED`；execution events 2 条

### 模型身份（raw / default / canonical）

| 项 | 值 |
| --- | --- |
| raw（实际返回） | `deepseek/deepseek-flash#default` |
| canonical（normalized） | `deepseek/deepseek-flash` |
| provider / model / agent | `deepseek` / `deepseek-flash` / `project-reader` |
| Runtime 版本 | **Desktop 2.0.23** |
| probe | `desktop-probe-c76a5337-1bbb-4933-a1c4-f3e6d524bff2`，`AUTHENTICATED_DESKTOP`，endpoint `desktop-cli://opencode-api`，status `AVAILABLE` |
| probe 响应 | session `ses_eefc6a1ffffe1HnfTLro4np7Bj`，message `msg_11039727f001B43Eu7msv9BqaD`，challenge `PLAN12_TARGET_PROBE_3c0d6e89-…`，`response_text_sha256=da324546…e36c` |
| catalog | `catalog-plan12-final-v2-20261006-4c37812d-code_read`，`AVAILABLE` |
| route | `code_read`，`BOUND`，`source=runtime_probe`，role `Project Reader` |

严格身份：`requested_model_ref == response_model_ref == exact_model_ref == deepseek/deepseek-flash`；
raw telemetry 保留 `#default`，formal/catalog 使用 canonical。`xxl-job` 仍为 `MODEL_UNASSIGNED`，Qwen fallback 禁止。

### 三个真实架构 hash（独立复算，全部匹配）

- `drawio_raw_sha256` = `bc90b6cc473132b4fba6f3e2d07b2bb22aa14050469cf8fdd890e8e296bff89c`
- `drawio_semantic_sha256` = `e07ad9438642c75ba1124157ce18fb904b602f112d1fa1e795a8a32359453996`
- `ir_sha256` = `10b669102430ee32b5c00aa1e4f4ba74e22cd348a2ab66598340f9a2ceda57c6`

源文件 `diagrams/multi_agent_framework_v4_completion_guard.drawio`（size 89695，
mtime `2026-09-30T11:48:37.725Z`）。三者本轮均由 compiler 独立复算：raw 由字节、
semantic 由 `semanticHash(parseDrawio(source))`、IR 由
`sha256(canonicalJson(parseDrawio(realpath(source))))`；`architecture-sync check`
输出 `IN_SYNC`。注意 IR 内嵌 `source.file`，该 `ir_sha256` 只在 canonical
realpath（反斜杠）形式下成立。

## 当前验证矩阵

| 验证 | task | 结果 |
| --- | --- | --- |
| targeted（**本轮**） | `6418b041-c963-47f2-ac1d-1e27271d7f91`（test-runner） | **7/7 命令**，exit 0；11/11 `node:test` 断言 |
| 正式全量回归（**本轮**） | `9a1c66d0-a27a-4ab4-8dce-cd0a8b311f3d`（test-runner） | **30/30 PASS**，`RELEASE_READY`，exit 0 |
| 独立 static Reviewer（历史） | `4c37812d-edb3-4a83-af33-ce11c5cc16d1`（reviewer） | verdict `PASS`，`findings=[]` |
| Desktop 2.0.23 probe-init（历史） | `38983736-aaf3-485f-a3b5-32fb8ec2df7f`（api-runner） | `{ok:true,status:INITIALIZED}` |
| 真实 live v2 smoke | `44940f00-…` / run `aa97bf7f-…` | 同 wave 双 worker 重叠 ≈14.088s |

- 本轮 targeted 7 个文件由 test task `6418b041-…` 的 7 条真实命令逐一执行，全部
  exit 0。数量取自实际输出：`plan12-runtime-fixture-contract` 报 `node:test` 6/6、
  `plan12-5-r2-contract` 5/5，共 **11 个 `node:test` 用例**；其余 5 个为自定义断言
  脚本，输出显式 PASS marker（含 `PLAN12_DEFAULT_IDENTITY_CHAIN_PASS`，对应
  “最后 correlation 消息边界 + rawmissing FAILED”修复）。**不套用历史 “16”**。
- 回归 30 项见 `tools/regression/manifest.mjs`（29 个 `test()` + 1 个
  `release_gate:true` 的 `production-acceptance-gate`）。

### 本轮真实测试原始日志（`runtime/plan12-final-logs-20261006/`）

targeted（task `6418b041-…`，workflow `e357ef66-…` node `targeted-seven-rawlogs`，
cwd `D:/ai-dev`，node v24.16.0，UTC `08:23:33.035Z → 08:23:36.326Z`）：

| # | 命令（`node --experimental-strip-types …`） | exit | 结果 | stdout log / SHA-256 |
| --- | --- | --- | --- | --- |
| 1 | `--import ./.opencode/tests/register-hooks.mjs .opencode/tests/plan12-default-identity-chain.mjs` | 0 | PASS | `01.plan12-default-identity-chain.stdout.log`（35B）`32115149…578b` |
| 2 | `…workflow-team-worker-sessions.mjs` | 0 | PASS | `02.workflow-team-worker-sessions.stdout.log`（40B）`ad2fe331…0f0a` |
| 3 | `…session-context-envelope.mjs` | 0 | PASS | `03.session-context-envelope.stdout.log`（30B）`133da178…e5de` |
| 4 | `…plan12-runtime-fixture-contract.mjs` | 0 | PASS（6/6） | `04.plan12-runtime-fixture-contract.stdout.log`（819B）`cffc0dbb…98df` |
| 5 | `…plan12-5-runtime-evidence-adapter.mjs` | 0 | PASS（6 markers） | `05.plan12-5-runtime-evidence-adapter.stdout.log`（192B）`18128905…6c74` |
| 6 | `…plan12-6-completion-guard-evidence.mjs` | 0 | PASS | `06.plan12-6-completion-guard-evidence.stdout.log`（38B）`ac13e0cb…93ed` |
| 7 | `…plan12-5-r2-contract.mjs` | 0 | PASS（5/5） | `07.plan12-5-r2-contract.stdout.log`（788B）`edb4253a…b06a` |

- 7 条 stderr 均为 0B（`e3b0c442…b855`）；结构化记录见同目录 `index.json` 与
  `run-records.json`（argv/cwd/UTC/exit/bytes/SHA-256）；test 文件与 hooks 哈希：
  `plan12-default-identity-chain.mjs b878edbf…100b`、`register-hooks.mjs c895a2a2…5a39`、
  `bun-sqlite-shim.mjs 4d9b5020…4383`、`manifest.mjs b8e837a6…addc`、`run.mjs 42501229…f8f5a`。

full30（task `9a1c66d0-…`，node `full30-rawlog`，命令 `node tools/regression/run.mjs`，
cwd `D:/ai-dev`，UTC `08:25:26.848Z → 08:25:45.156Z`，18307 ms，exit 0）：

- stdout `full30.stdout.log` sha256 `579d9a747da995ca4fcca6d97665d3decbdfbe0fb9bedeef6aa825f2a6cebd8a`
  （7843B）；stderr 0B。结构化记录 `full30.index.json`。
- 30 项 `PASS` / exit 0，summary `{"schema_version":1,"status":"PASS","release_gate":"RELEASE_READY"}`；
  release gate 项 `production-acceptance-gate`：`framework_v1=RELEASE_READY`，`missing=[]`。
- 负例 `regression-failure-semantics`（sha256 `6063cbc3…a807`）**本轮实际运行** PASS，
  覆盖 run.mjs 失败必需检查 → CLI **exit 1** / `status=FAIL` / `release_gate=NOT_READY`
  （fail-fast）与 release gate 阻塞 → CLI **exit 2** / `status=BLOCKED` / `release_gate=NOT_READY`。
- targeted 与 full30 共享同一轮代码哈希（`manifest.mjs` / `run.mjs` 一致），构成同一轮
  targeted→full30 关联。
- （历史）probe-init `38983736-…` 真实产物：
  - `probe.json` sha256 `5F685CD8C7F284E7A998F649001E2557DD0E8BF888FF322A4FB9F2423C96E7C5`
  - `probe-summary.json` sha256 `03AC5EBFEF290752C5E8DBE80C1AA1842A9520424BB41B5C79E48F363E988DEE`
  - `architecture-fingerprints.json` sha256 `212ED9AA87EEF603626FA0AA19FD75B5A1972B06DACEFFA24EC960BF25D193FC`

### correlation 消息边界与 rawmissing FAILED（已实际通过）

- 边界：`runtime-registry-core.ts` 在 prompt 前记录目标 session 的 message ID
  边界，wait 后只接受**本次新增且非空**的 assistant message；desktop `{info,parts}`
  与 legacy flattened messages 归一化且不做 identity fallback；显式跨 session 响应被拒。
- raw 身份：`task-bus-core.ts` persistent Result Envelope 保留实际
  `raw_model_runtime_id`（含 `#default`）；缺失 raw 身份保持 `null`。
- 失败语义：persistent 响应缺失 raw identity 时 `executePersistent` fail-closed，
  结果为 `MODEL_RUNTIME_ID_MISSING`，任务与 Result Envelope 均 `FAILED`，
  `model_runtime_id=null`。
- 以上由本轮注册回归 `plan12-default-identity-chain`（`PLAN12_DEFAULT_IDENTITY_CHAIN_PASS`，
  targeted task `6418b041-…`）与本轮 full30（task `9a1c66d0-…`，30/30 PASS）覆盖；
  上一轮独立 static Reviewer `4c37812d`（历史）曾逐项确认 closed。

## Completion Guard（只读复现，未调用 `completion_finalize`）

正例：`completion_final_report_permission(workflow_id=44940f00-…,
run_id=aa97bf7f-…, control_plane_db=<live v2 isolated>)`

```text
ok=false, status=FINAL_REPORT_BLOCKED, code=COMPLETION_GUARD_BLOCKED,
permission=false
evidence={ ok=true, status=COMPLETE, verification=PASS, evidence_level=L3,
           workflow_id=44940f00-…, run_id=aa97bf7f-…,
           config_revision=plan12-final-v2-20261006-4c37812d,
           evidence_ref="control-plane:aa97bf7f-…",
           wave_count=1, node_count=2, execution_event_count=2 }
delivery={ ok=false, status=DELIVERY_PENDING, phase=DELIVERY,
           reviewer_pass=false, workflow_status=REVIEW_PASSED,
           execution={ ok=true, status=EXECUTION_COMPLETE, missing=[] },
           missing=[ <workflow-review-pass> REVIEW_PASS_REQUIRED,
                     documentation_update REQUIRED_DELIVERY_ROUTE,
                     long_term_memory_write REQUIRED_DELIVERY_ROUTE,
                     DELIVERY_EVIDENCE_CONTRACT_MISSING ] }
```

- 真实 L3 证据 `verification=PASS` 成立（live v2）。
- 因 `delivery=none`，整体保持 `FINAL_REPORT_BLOCKED` / `DELIVERY_PENDING`，
  **非 L4、非 COMPLETED**。

负例（不存在的 run_id `00000000-0000-0000-0000-000000000000`）：`ok=false`，
`code=EVIDENCE_RUN_NOT_FOUND`，`verification=BLOCKED`，`permission=false`，未放行，
未篡改 good DB。

其他 static negative：`route_bindings.xxl-job-unassigned = MODEL_UNASSIGNED` +
`ROUTE_REJECTED`；不存在 workflow → `WORKFLOW_NOT_FOUND`；
`PLAN12_SYNTHETIC_FIXTURE_REJECTED_PASS`；path-envelope lexical/symlink 逃逸阻断；
append-only revision mismatch 拒绝与 `EVIDENCE_WRITE_FAILURE` 可观测门。

## 历史（不掩盖、不伪造终态）

- **上一版 live v1（历史，非当前）**：workflow `2d304a17-5df5-4240-81f0-c9e848f11064` /
  run `4bbda1c3-a807-4d58-9323-8046cd2817de` / revision `plan12-final-20261006-8abc6b7c` /
  DB `…/plan12-final-20261006-8abc6b7c/control-plane.db`。已由本轮 live v2 取代为当前证据，
  本轮不再复算该 v1 DB。
- **上一轮测试证据（历史，非当前）**：targeted `c65b5ae2-e682-403a-96ff-468d3d02a6db`
  （7 文件 / 16 test）、full30 `b9287486-b6ee-42b6-aa04-653cd1c0ebc2`（30/30）。已由本轮
  targeted `6418b041-…`（7/7 命令、11 `node:test` 用例）与 full30 `9a1c66d0-…`（30/30，
  `RELEASE_READY`）的原始日志（`runtime/plan12-final-logs-20261006/`）取代为当前测试证据。
- **legacy workflow `dd8f4242-…`**：`delivery=none`。本轮只读实测 `runtime/tasks.db`
  状态为 `FAILED`（`finished_at=2026-10-06T06:38:13.900Z`）；此前收口记录为
  `RUNNING`/`FINAL_REPORT_BLOCKED`。如实记录当前观测，不伪造、不改写终态。
- **恢复验证 workflow** `2bc1e041-…`（`REVIEW_PASSED`）与 **REWORK_LIMIT**
  `e57efd6a-…` / `984dcb86-…` 均为历史。
- **correlation/raw-identity 修复 workflow `53879b48-…`**：历史行仍为 `BLOCKED`；
  其修复已由 identity-chain 回归与 Reviewer `4c37812d` 确认 closed，但历史 workflow 行不被改写。
- **提前 commit**：`91ec968a85454820f6db93891c9a5b3bc547d91e`
  `fix: 修复 Plan12 运行时探针适配与门禁`（2026-10-06T13:23:05+08:00 / 05:23:05Z），
  **仅本地、未 push**。该提交发生在最终文档/独立验收/统一提交门禁之前，如实记录。
- **历史证据（非当前）**：`docs/plan12-6-existing-live-readback.json`（baseline
  `1dfa0991`，workflow `f1b88887`，run `7971ac41`）；`runtime/regression-run-51216fe3.log`
  （旧 29 项 run）；早期阻断链 tasks `397dcfec` / `9e038f1e` / `1cf6fb2a`（BLOCKED），
  reviewers `e2bcd1ce` / `11ad084c` / `de3c0f2c`（REWORK）。
- **旧条件规则**：`plan12-5-r2` 与本目录中标注的 `LIVE_BLOCKED` 文字是历史条件性
  fail-closed 规则或早期尝试，不是当前状态。

## Git 边界与用户文件保护

- 根路径 `D:/ai-dev`，分支 `master`，HEAD `91ec968`（本地领先本地
  `origin/master` `deb4889` 1 个提交）。**未 fetch / 未 pull / 未 push**。
- 暂存区为空（本收口节点不执行 `git add` / `git commit`）。
- 当前差异：**34** tracked 修改，**13** untracked 顶层（`git status --porcelain`），
  暂存区 0。

| 状态 | tracked 修改 | untracked 顶层 | 说明 |
| --- | --- | --- | --- |
| 文档完成后**当前差异** | **34** | **13** | 本轮独立回读实测 |
| **最终提交候选** | — | — | **39 条逐路径**：28 实现/plugins/tests + 3 tools/template + 3 docs + 5 新增 |

- **39 条 allowlist 保持完整**：28 个已修改实现/plugin/tests + 3 个已修改
  `tools/regression/{manifest,run}.mjs` 与 `templates/result-envelope.schema.json`
  + 3 个已修改 docs（`plan12-5-workflow-runtime-evidence-adapter.md`、
  `plan12-5-r2-workflow-evidence.md`、`plan12-6-completion-guard-evidence.md`）
  + 5 个 untracked 候选（`.opencode/tests/plan12-default-identity-chain.mjs`、
  `.opencode/tests/regression-failure-semantics.mjs`、`tools/regression/status.mjs`、
  `docs/plan12-5-6-final-closeout.md`、`docs/plan12-5-6-final-readback.json`）。
  correlation 修复新近修改的 `runtime-registry-core.ts` / `task-bus-core.ts` /
  `plan12-default-identity-chain.mjs` 已在此 allowlist 内，计数仍为 39。
- **保护/排除**：业务仓库（`ruoyi-vue-pro/`、`yudao-ui-admin-vue3/`、`xxl-job/`、
  `nyamtn/` 等）、`.ruoyi-vue-pro-package/`、根 `control-plane.db` / `.db-shm` /
  `.db-wal` / `.sqlite*`、用户补丁 `u4-completion-guard.patch`、`runtime/**` 一律
  **不提交、不删除、不修改**。

## 明确未做事项

- 未启动 Plan 12.7 / 12.8。
- 未调用 `completion_finalize`，未写 Mem0。
- 本收口节点只更新本文件、`docs/plan12-5-6-final-readback.json` 与
  `runtime/plan12-final-20261006-readback.json`（Plan 12.5/12.6 三份证据文档本轮不含
  test task 引用，故未改动）；不修改实现、tests、Drawio、业务仓库或用户文件，也未执行
  任何 Git 写操作。
- 无 push；统一提交与最终独立验收由后续节点承担。

## 来源

- 本轮文档节点 task `70372e0b-3b9b-4cc4-8168-f9ecae2eef36`（documentation-agent，
  workflow `e357ef66-9b1f-491c-9763-79f7923121b9`）
- 只读证据：live v2 Control Plane DB `…/plan12-final-v2-20261006-4c37812d/control-plane.db`、
  `runtime/tasks.db`、`runtime/plan12-final-logs-20261006/`
- 本轮验证任务：targeted `6418b041-c963-47f2-ac1d-1e27271d7f91`、full30
  `9a1c66d0-a27a-4ab4-8dce-cd0a8b311f3d`
- 历史验证任务：`c65b5ae2-…`（targeted）、`b9287486-…`（full 30）、
  `4c37812d-…`（static Reviewer PASS）、`38983736-…`（probe-init success）
- 当前 live workflow `44940f00-6ea5-41e8-95b3-e6d3eb9e80e1`
