# Task Bus Plugin (Plan 6 Phase 3)

Route-based task dispatch for the multi-agent framework. Callers submit a
**Task Envelope** (`project_id` + `route` + `objective`); the Task Bus resolves
the target role from `framework-config/routing.yaml`, persists the task in
`runtime/tasks.db`, dispatches it to a persistent Runtime Registry session or a
fresh ephemeral OpenCode session, and wraps the agent output into a **Result
Envelope**. Agents are never required to emit JSON themselves.

- Plugin id: `task-bus`
- Tool namespace: `task` (exactly 5 tools — plan §30)
- Architecture source of truth: `diagrams/multi_agent_framework_v4_completion_guard.drawio`
- Envelope contracts: `templates/task-envelope.schema.json`,
  `templates/result-envelope.schema.json` (schema_version 1)
- Config sources (read fresh on every call, nothing hardcoded — §22):
  `framework-config/projects.yaml`, `agents.yaml`, `routing.yaml`, `task-bus.yaml`

## Implemented (Plan 6)

- **Task Envelope** — complete envelope built at create time and persisted in
  `input_json` (schema_version 1, `task_id` via `crypto.randomUUID()`, §8/§9)
- **Result Envelope** — every dispatch outcome (COMPLETED / FAILED / BLOCKED)
  is wrapped and persisted in `result_json` (§10/§36); `CANCELLED` is
  protocol-reserved only
- **task_create** — validate project → validate route → generate task_id →
  resolve target role → persist envelope with status `READY`; never executes
  anything (§31)
- **task_dispatch** — full gate chain (§32), see below; serialized per
  `task_id` via the shared core lock (§39)
- **task_execute** — convenience `create + dispatch` combo returning
  `{ task, envelope, result }`; the preferred orchestrator entry point (§33)
- **task_get** — pure read of envelope + result + status + target_role +
  target_session_key + timestamps; never triggers a model (§34)
- **task_list** — filters `project_id` / `status` / `route` /
  `parent_task_id` / `limit`; default 50 newest rows, hard cap 200 (§35)
- **Route dispatch** — target role always resolved from `routing.yaml`
  routes; callers can never specify a target agent directly (§23)
- **Persistent session integration** — `project-main` / `project-reader` run
  through the shared Runtime Core `send()` on the registered persistent
  session (reused across tasks, generation tracked); `target_session_key` is
  `project:<project-id>:main|reader` (§24/§21)
- **Ephemeral agent dispatch** — every other role (per `task-bus.yaml`
  `ephemeral_roles`) gets a NEW OpenCode session per task: `create` →
  `switchAgent(target_role)` → `switchModel(agents.yaml runtime_id)` →
  synthetic scope context (`PROJECT_ID` / `PROJECT_PATH` / `TASK_ID` /
  `TARGET_ROLE`, §38) → prompt (§37) → wait → extract last assistant text.
  The session is **not** registered in the `sessions` table and **not**
  deleted afterwards (kept for manual audit). `target_session_key` is
  `session:<opencode-session-id>` (§21)
- **Dependency readiness guard** — all `dependencies` must exist and be
  `COMPLETED`, otherwise the task becomes `BLOCKED` with
  `DEPENDENCY_NOT_READY` + `blocking_task_ids`. No automatic watching: the
  caller dispatches again later (§27)
- **Route prerequisites** — a route with `requires` (e.g.
  `long_term_memory_write` → `reviewer-pass`) can never be strictly verified
  in Plan 6, so dispatch returns `BLOCKED` /
  `ROUTE_PRECONDITION_UNSATISFIED`. Caller claims alone never unlock a route;
  real unlocking is deferred to the Plan 7 Reviewer Loop (§28)
- **Model gate** — an ephemeral role whose `agents.yaml` `model.runtime_id`
  is null (currently `feature-executor`) is never dispatched: `BLOCKED` /
  `MODEL_UNASSIGNED`, no session created, no model inherited / guessed /
  defaulted (§25). The same applies to a persistent role without a
  configured model (e.g. `project-main` of a project whose
  `project_sessions` entry has `runtime_id: null`)
- **Task persistence** — all task state lives in `runtime/tasks.db`
  (`tasks` table) and survives plugin reloads

## Not implemented (deferred, §63 — do not assume otherwise)

- automatic DAG scheduler
- parallel batch dispatch
- automatic retry
- Reviewer loop (automatic reviewer dispatch, PASS/FIX/REWORK verdicts)
- FIX/REWORK loop
- automatic lifecycle rotation (and automatic checkpointing)
- a real cancel tool (`CANCELLED` exists in the protocol/state list only)
- Feature Executor model inference

## State machine (§29)

```text
READY   → RUNNING → COMPLETED          (normal path)
READY   → RUNNING → FAILED             (execution exception; terminal in Plan 6)
READY   → BLOCKED                      (dependency / model / precondition / config problem)
BLOCKED → READY/RUNNING semantics:     a BLOCKED task may be dispatched again;
                                       if the gates now pass it runs (BLOCKED → RUNNING)
```

Dispatch decisions per current status:

| Current status | task_dispatch behavior |
| --- | --- |
| `READY` | run the full gate chain, then execute |
| `BLOCKED` | re-run the full gate chain (retry allowed, §29); no automatic retry — the caller must dispatch again |
| `RUNNING` | refused with `TASK_ALREADY_RUNNING` (the per-task lock rules out in-process races, so this means a stale run, e.g. a desktop restart mid-dispatch; never double-executed) |
| `COMPLETED` | refused with `TASK_ALREADY_COMPLETED`; the persisted Result Envelope is returned; never re-executed (§32) |
| `FAILED` | refused with `TASK_ALREADY_FAILED`; FAILED is terminal in Plan 6 (no automatic retry, §63) — create a new task instead |
| `CANCELLED` | refused with `TASK_CANCELLED` (protocol-reserved; Plan 6 has no cancel tool) |

## Dispatch gate chain (§32)

```text
load task row                      → TASK_NOT_FOUND
status gate                        → TASK_ALREADY_COMPLETED / TASK_ALREADY_FAILED /
                                      TASK_CANCELLED / TASK_ALREADY_RUNNING
parse Task Envelope (input_json)   → TASK_ENVELOPE_INVALID (row → FAILED)
re-resolve route → target role     → ROUTE_NOT_FOUND / ROUTE_TARGET_MISSING (→ BLOCKED)
dependency readiness guard         → DEPENDENCY_NOT_READY + blocking_task_ids (→ BLOCKED)
route prerequisites (requires)     → ROUTE_PRECONDITION_UNSATISFIED (→ BLOCKED)
project still registered           → PROJECT_NOT_FOUND (→ BLOCKED)
persistent/ephemeral resolution    → TARGET_ROLE_DISPATCH_UNDEFINED (→ BLOCKED)
model gate (runtime_id)            → MODEL_UNASSIGNED / RUNTIME_ID_UNPARSEABLE (→ BLOCKED)
status = RUNNING → execute → wrap Result Envelope → COMPLETED / FAILED / BLOCKED
                                  → persist result_json → return Result Envelope
```

All `BLOCKED` outcomes are persisted as Result Envelopes with
`error = "<CODE>: <detail>"`, so `task_get` shows why a task is blocked.

## Error codes

| Code | Meaning |
| --- | --- |
| `PROJECT_NOT_FOUND` | `project_id` not in `framework-config/projects.yaml` (checked before insert — §26) |
| `ROUTE_NOT_FOUND` | `route` not in `framework-config/routing.yaml` routes |
| `ROUTE_TARGET_MISSING` / `ROUTING_CONFIG_INVALID` | route entry exists but has no usable `target` / routes section malformed |
| `TASK_NOT_FOUND` | `task_id` not in `runtime/tasks.db` |
| `TASK_ALREADY_COMPLETED` | re-dispatch of a COMPLETED task refused (no re-execution) |
| `TASK_ALREADY_FAILED` | re-dispatch of a FAILED task refused (terminal in Plan 6) |
| `TASK_ALREADY_RUNNING` | re-dispatch of a RUNNING (stale) task refused |
| `TASK_CANCELLED` | dispatch of a CANCELLED task refused (protocol-reserved status) |
| `TASK_ENVELOPE_INVALID` | persisted `input_json` missing/unparseable → task FAILED |
| `DEPENDENCY_NOT_READY` | one or more dependencies missing or not COMPLETED → BLOCKED, response includes `blocking_task_ids` |
| `ROUTE_PRECONDITION_UNSATISFIED` | route has `requires` that Plan 6 cannot strictly verify → BLOCKED |
| `TARGET_ROLE_DISPATCH_UNDEFINED` | target role in neither `persistent_roles` nor `ephemeral_roles` of `task-bus.yaml` → BLOCKED |
| `MODEL_UNASSIGNED` | no `runtime_id` configured for the target role → BLOCKED, no session created, no model guessed (§25) |
| `RUNTIME_ID_UNPARSEABLE` | configured `runtime_id` cannot be parsed into provider/model → BLOCKED |
| `INVALID_INPUT` | missing/mistyped tool arguments |
| `CONFIG_LOAD_FAILED` | a framework-config YAML could not be read/parsed (task row left untouched) |
| `SQLITE_RUNTIME_UNAVAILABLE` / `CONFIG_ROOT_NOT_FOUND` | infrastructure unavailable |
| `SESSION_INIT_FAILED` / `NO_ASSISTANT_TEXT` / `NO_ASSISTANT_RESULT` / `EXECUTION_FAILED` / `EXECUTION_EXCEPTION` / `SEND_FAILED` / `WAIT_TIMEOUT` | execution-phase failures → task FAILED (details in the Result Envelope `error`) |
| `UUID_UNAVAILABLE` | runtime lacks `crypto.randomUUID()` (create refused, nothing inserted) |

## Relationship with runtime-registry

- **Shared database**: both plugins use `runtime/tasks.db`. The `tasks` table
  was created by `runtime-registry/schema.sql` (Plan 5, schema-only back
  then); this plugin ships **no** schema file and performs **no**
  `ALTER TABLE` (§20/§21). Structured data lives in `input_json` /
  `result_json`; `target_session_key` encodes the executor
  (`project:<id>:main|reader` for persistent, `session:<opencode-session-id>`
  for ephemeral).
- **Shared core**: `.opencode/lib/runtime-registry-core.ts` provides root
  resolution, SQLite open (WAL), schema init, YAML config loading, project /
  model resolution, persistent session `ensure`/`send`, and `withLock`. The
  Task Bus creates its own core instance (same file, same schema) and reuses
  `send()` for persistent roles — so a `code_read` task runs on the very same
  registered Project Reader session as `runtime_session_send`.
  `runtime_session_*` tools remain the low-level session control interface.
- **Locking (§39)**: dispatch is serialized per `task_id`
  (`task:<task_id>`); persistent sends additionally take the core
  `session_key` lock. Ephemeral sessions are per-task, so they need no lock.
- **Sessions**: ephemeral task sessions stay at the framework root location
  (`D:\ai-dev`, §38) and are kept after completion for manual audit.

## Security

- Task/Result Envelopes and prompts never contain database passwords, API
  tokens or other credentials (§37, §9); `context_refs` must stay lightweight
  references instead of bulk payloads.
