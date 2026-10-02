# Plan 12.3 Acceptance Evidence

本文件记录 Plan 12.3 控制面生命周期的隔离 fixture 验收范围，不把 fixture 数据
当作生产 runtime evidence，不声明真实业务 Workflow 或 Scheduler 已切换配置。
执行基线为 `2fddefc9850e222a67cd3a351f931c5eb1bf8984`；该基线包含已通过的
Plan 12.1 契约与 Plan 12.2 SQLite evidence writer。

## 专用命令与成功标记

| 命令 | 必须出现的原始成功标记 |
| --- | --- |
| `node --experimental-strip-types .opencode/tests/plan12-config-revision.mjs` | `PLAN12_CONFIG_REVISION_PASS` |
| `node --experimental-strip-types .opencode/tests/plan12-apply-cas.mjs` | `PLAN12_APPLY_CAS_PASS` |
| `node --experimental-strip-types .opencode/tests/plan12-rollback-journal.mjs` | `PLAN12_ROLLBACK_JOURNAL_PASS` |

专用验收覆盖 DRAFT 创建与 parent 关联、digest 重算、VALIDATED/STAGED/APPLIED
逐边推进、ACTIVE/SUPERSEDED/REJECTED/ROLLED_BACK 状态、非法转换拒绝、快照不可
修改、Apply/Rollback 成功与失败、幂等回执/冲突、跨进程并发 CAS、单 ACTIVE、
状态与 journal 原子提交、journal UPDATE/DELETE 拒绝、重启读取以及旧 Workflow
revision 隔离。新增 journal 和操作回执均为 append-only，生命周期投影及 global
head 的修改只用于 CAS 状态推进，不修改 snapshot 内容。

数据库路径使用 `os.tmpdir()` 下的独立 fixture。测试结束后关闭连接并清理 fixture；
重启和并发测试通过新进程打开同一个临时 SQLite 文件，验证持久化与数据库锁。
生产 `runtime/control-plane.db` 不由这些测试创建，`runtime/tasks.db`、WAL/SHM
不参与测试。

## 兼容性与 release gate

最终验收必须重新运行 Plan 12.1 boundary contract、Plan 12.2 migration/evidence/
restart recovery、Plan 12.3 专用测试以及以下现有 gate，不能依赖旧回执：

```text
PLAN12_BOUNDARY_CONTRACT_PASS
PLAN12_CONTROL_PLANE_MIGRATION_PASS
PLAN12_EVIDENCE_WRITER_PASS
PLAN12_RESTART_RECOVERY_PASS
PLAN12_CONFIG_REVISION_PASS
PLAN12_APPLY_CAS_PASS
PLAN12_ROLLBACK_JOURNAL_PASS
```

```text
node --experimental-strip-types tools/architecture-sync/cli.ts check --format=json
node --experimental-strip-types tools/production-acceptance/gate.mjs
node --experimental-strip-types tools/regression/run.mjs
git diff --check
```

architecture-sync 必须为 IN_SYNC；production gate 必须为 PASS 且
`framework_v1=RELEASE_READY`；全量 regression 必须为 PASS 且
`release_gate=RELEASE_READY`。Plan 11 文档状态不改回 BLOCKED。

独立 Reviewer 使用全新 GPT-5.6 Sol high 会话，审查状态机、CAS 与跨进程并发、
单 ACTIVE、Rollback 目标边界、snapshot 不可变、journal append-only、
MODEL_UNASSIGNED fail-closed、阶段范围和 fixture 证据属性。只有最新代码经过
完整验收且 Reviewer 原始结果为 `REVIEWER: PASS` 后才允许提交。

提交前后必须检查根仓库边界、业务目录追踪为空，并对照任务开始时的 hash 确认
tasks.db/WAL/SHM、Drawio 和用户 patch 未修改。用户 patch 保持未跟踪，不能 stage、
删除或 restore。未写 Mem0，未执行 pull/fetch/push/reset/restore/clean。验收不
包含 Plan 12.4+ 功能，也没有执行生产 Apply/Rollback。
