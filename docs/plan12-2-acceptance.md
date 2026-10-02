# Plan 12.2 Acceptance Evidence

本文件记录 Plan 12.2 的隔离 fixture 验收，不把 fixture 数据当作生产 runtime
evidence。

```text
PLAN12_CONTROL_PLANE_MIGRATION_PASS
PLAN12_EVIDENCE_WRITER_PASS
PLAN12_RESTART_RECOVERY_PASS
PLAN12_BOUNDARY_CONTRACT_PASS
```

覆盖范围包括：首次初始化、重复迁移、六张事实表和字段、外键、schema/revision
拒绝、append-only UPDATE/DELETE trigger、跨表幂等接受与 digest 冲突、事务回滚、
查询过滤、进程重启后的读取与继续写入。

验收 fixture 使用操作系统临时目录，并在测试结束后关闭数据库和删除 fixture。
生产 `runtime/control-plane.db` 不由这些测试创建；`runtime/tasks.db`、其 WAL、
Drawio、业务仓库、Mem0 和 `u4-completion-guard.patch` 均保持不变。
