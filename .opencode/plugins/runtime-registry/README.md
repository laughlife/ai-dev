# runtime-registry — OpenCode V2 本地插件（Plan 5）

Runtime Session Registry：把 project-main / project-reader 从“只有 Profile”升级为
“有稳定 Session ID、可重复调用、可跨多次任务复用”的运行时会话。

## 文件

- `index.ts` — 插件本体（plain-object default export；OpenCode V2 直接读取默认导出的 `id` + `setup()`，本环境未安装 `@opencode/plugin`，也无需安装）
- `schema.sql` — SQLite schema（registry_meta / sessions / tasks）
- `README.md` — 本说明

## 运行数据库

- 路径：`D:\ai-dev\runtime\tasks.db`（`runtime/` 整目录被根 Git 忽略，不得入库）
- 引擎：Bun 内置 `bun:sqlite`（desktop 2.0.19 实测：Bun 1.4.2 / SQLite 3.53.2），未安装任何第三方 sqlite 包
- WAL 模式：`tasks.db-wal` / `tasks.db-shm` 属正常运行时文件
- `sessions` 主键为 `(session_key, generation)` 复合键（Plan §15 为“最少包含”，此扩展用于保留换代历史与 `replaced_by` 链）
- `tasks` 表在 Plan 5 只建 schema；Task Bus 未实现，不得因该表存在而声称已实现

## 数据来源（禁止硬编码）

- `framework-config/projects.yaml` — 项目注册（id / path）
- `framework-config/agents.yaml` — project-reader 的 `model.runtime_id`；`project_sessions.<project>.model.runtime_id`（project-main 模型）
- YAML 解析：`Bun.YAML.parse`（运行时内置，无第三方依赖）
- `runtime_id` 解析：`provider/model#variant`（如 `openai/gpt-5.6-sol-fast#high`）；只解析已验证值，从不猜模型
- 每次工具调用重新读取配置文件，避免过期缓存

## 工具（namespace: runtime，共 5 个）

| 工具 | 说明 |
| --- | --- |
| `runtime_session_ensure` | 确保 project_id + role（project-main / project-reader）的持久会话；重复调用复用同一 OpenCode Session；配置缺模型时返回 MODEL_UNASSIGNED 且不创建会话；不发送任何 prompt |
| `runtime_session_send` | ensure → durable prompt → wait → 提取本轮最后 Assistant 文本并返回（session_id / generation / result） |
| `runtime_session_list` | 列出 Registry 当前（每 key 最新 generation）会话；不返回对话正文 |
| `runtime_session_get` | 按 project_id + role 读取单条 Registry 记录；纯查询，不触发模型请求 |
| `runtime_session_archive` | 标记 ARCHIVED；不删除 OpenCode 原始会话（保留人工检查）；下一次 ensure 创建 generation + 1 |

## 会话规则

- Session key：`project:<project-id>:main` / `project:<project-id>:reader`
- Session Location 保持在框架根 `D:\ai-dev`（保证 `.opencode/agents` 与本插件可加载）；项目范围由 registry 字段 + synthetic 初始 Scope Context 约束
- 新会话流程：`session.create` → `switchAgent(role)` → `switchModel(配置的 runtime_id)` → `synthetic(初始上下文)`
- Registry 记录 ACTIVE 但 OpenCode Session 已丢失 → 旧记录标 STALE → 创建 generation + 1
- 同一 session_key 的操作经内部锁串行化，避免并发 ensure 竞争
- 未实现自动 lifecycle rotation（60/70/80 规则仍在 `lifecycle.yaml`，自动执行延后）

## 错误语义（结构化 JSON 返回）

- `MODEL_UNASSIGNED` — 配置中无 runtime_id（如 xxl-job 的 project-main）；拒绝创建、不猜测、不继承父模型
- `PROJECT_NOT_FOUND` / `ROLE_NOT_SUPPORTED` / `INVALID_INPUT` — 输入校验
- `CONFIG_LOAD_FAILED` / `CONFIG_ROOT_NOT_FOUND` / `YAML_PARSER_UNAVAILABLE` — 配置读取失败
- `SQLITE_RUNTIME_UNAVAILABLE` — 内置 SQLite 不可用（按 Plan §14 不得退化为 JSON 文件 Registry）
- `SESSION_CREATE_FAILED` / `SESSION_INIT_FAILED` / `SEND_FAILED` / `WAIT_TIMEOUT` — 会话操作失败

## Plan 5 边界（明确不实现）

完整 Task Bus、Task Envelope、DAG 调度、并行派发、自动重试、Reviewer 自动闭环、
自动 context% 遥测、自动换代 / checkpoint、drawio parser、自动配置生成。
