# Plan 12.4 Desktop V2 Runtime Probe

本文件记录一次只读的 Desktop-managed OpenCode V2 Runtime 探测。它是
runtime 事实记录，不是 fixture，也不把模型目录的 `active` 标记解释为
模型调用成功。

## 探测记录

- 探测时间：2026-10-02T23:21:24+08:00
- Runtime：Desktop-managed OpenCode V2
- 进程：`C:\Users\Administrator\AppData\Roaming\ai.opencode.desktop\cli\2.0.20\opencode-cli.exe serve --service`
- 进程号：`33048`
- 版本：`2.0.20`
- Endpoint：`http://127.0.0.1:49374`
- 查询目录 header：`x-opencode-directory: D:\ai-dev`
- 证据来源：真实 Desktop CLI `opencode-cli.exe`，未使用 PATH 中的 npm 1.1.53 shim

`GET /api/info` 的原始结果为：

```json
{
  "version": "2.0.20",
  "pid": 33048,
  "urls": ["http://127.0.0.1:49374"],
  "paths": {
    "tmp": "C:\\Users\\Administrator\\AppData\\Local\\Temp\\opencode"
  }
}
```

## Plugin 与工具

`GET /api/plugin` 在 `x-opencode-directory: D:\ai-dev` 上返回以下本地插件为
`active`：

- `completion-engine`
- `lifecycle-engine`
- `runtime-registry`
- `task-bus`
- `workflow-engine`

当前对公共 HTTP RPC 路由进行只读可达性检查时，下面五个路径均未得到工具
调用结果：

```text
POST /api/rpc/workflow-engine/workflow_plan
POST /api/rpc/workflow-engine/workflow_run
POST /api/rpc/workflow-engine/workflow_execute
POST /api/rpc/workflow-engine/workflow_get
POST /api/rpc/workflow-engine/workflow_list
```

响应为：

```json
{
  "_tag": "RpcError",
  "type": "rpc.unavailable",
  "message": "RPC is unavailable: workflow-engine"
}
```

因此本次新鲜公共 RPC 探测结果为：

```text
PLAN12_RUNTIME_MODEL_PROBE_BLOCKED
reason=workflow-engine public RPC route unavailable
```

这不否认历史同一 Desktop V2 Runtime 会话中存在已完成的
`workflow.workflow_execute` / `workflow.workflow_get` 工具调用记录；那些
记录来自只读检查的 `opencode.db`，不能替代本次 endpoint 的新鲜 RPC 可达性
结果。

## Runtime model catalog（精确 ID）

`GET /api/model` 返回的下列条目为 `status=active, enabled=true`。这只是
Runtime 广告的目录状态；本次没有发送模型推理请求，所以不记录
`AVAILABLE` 结论。

本次 API 返回共 572 个 model 条目，按 provider 计数为：

```text
alibaba=59
alibaba-cn=91
bailian-token-plan=4
deepseek=2
openai=18
opencode=9
openrouter=389
```

provider 列表为：`deepseek`、`openrouter`、`alibaba`、`opencode`、`openai`、
`alibaba-cn`、`bailian-token-plan`。

| provider_id | model_id | catalog 状态 |
| --- | --- | --- |
| `bailian-token-plan` | `auto` | active / enabled |
| `bailian-token-plan` | `glm-5.3` | active / enabled |
| `bailian-token-plan` | `qwen3.8-flash` | active / enabled |
| `bailian-token-plan` | `qwen3.8-max` | active / enabled |
| `openai` | `gpt-5.6-sol` | active / enabled |
| `openai` | `gpt-6-sol` | active / enabled |
| `openai` | `gpt-6.1-sol` | active / enabled |
| `opencode` | `big-pickle` | active / enabled |
| `opencode` | `fledge-alpha-free` | active / enabled |

Qwen 精确 ID 被记录为候选目录条目；没有自动替换、没有可用性推断。`xxl-job`
没有被此探测绑定到任何模型，继续遵守 `MODEL_UNASSIGNED` fail-closed 规则。

## 边界

本次探测只读取本机 Runtime API、进程元数据和既有运行时记录。没有创建或
修改 `runtime/control-plane.db`、`runtime/tasks.db`、业务仓库、Drawio、Mem0
或 `u4-completion-guard.patch`，也没有执行 pull、fetch、push。
