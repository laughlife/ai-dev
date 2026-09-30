// Task Bus — OpenCode V2 local plugin (Plan 6 Phase 3, refactored by Plan 7 Phase 3)
//
// Purpose: route-based task dispatch for the multi-agent framework. Callers
// submit a Task Envelope (project_id + route + objective); the Task Bus
// resolves the target role from framework-config/routing.yaml, persists the
// task in runtime/tasks.db, dispatches it to either
//
//   - a persistent Runtime Registry session (project-main / project-reader,
//     via the shared core send()), or
//   - a fresh ephemeral OpenCode session (planner / feature-executor / ...
//     per framework-config/task-bus.yaml ephemeral_roles),
//
// and wraps the agent output into a Result Envelope (plan §36). The agent is
// never required to emit JSON itself.
//
// Plan 7 Phase 3 (§25-§27): all core logic (tasks-table access, Task Envelope
// build + validation, the full dispatch gate chain, persistent/ephemeral
// execution, Result Envelope wrapping, per-task lock, route -> role
// resolution, project-level task-role model resolution, config loading) now
// lives in the shared core at ../../lib/task-bus-core.ts so the future
// Workflow Engine plugin can reuse it. This file ONLY creates the runtime
// core + task bus core and registers the five `task` tools as thin wrappers.
// Tool names, descriptions, input schemas, namespace and returned JSON string
// structures are unchanged from Plan 6 (§27).
//
// Authority boundaries:
// - Architecture source of truth: diagrams/multi_agent_framework_v3_workspace.drawio
// - Runtime data sources (read fresh on every call, nothing hardcoded — §22):
//   framework-config/projects.yaml / agents.yaml / routing.yaml / task-bus.yaml
// - Envelope contracts: templates/task-envelope.schema.json +
//   templates/result-envelope.schema.json (schema_version 1)
//
// Shares ONE SQLite database (runtime/tasks.db) and ONE runtime core
// implementation (.opencode/lib/runtime-registry-core.ts) with the
// runtime-registry plugin. The `tasks` table already exists (created by
// runtime-registry/schema.sql); neither this plugin nor the task bus core
// ships its own schema file or ALTERs the table (§20/§21).
//
// Explicitly NOT implemented in Plan 6 (§63) — do not claim otherwise:
// automatic DAG scheduler, parallel batch dispatch, automatic retry,
// automatic reviewer dispatch / PASS-FIX-REWORK loop, automatic lifecycle
// rotation, automatic checkpointing, cancel tool (CANCELLED is protocol-
// reserved only). Plan 7 Phase 1 (§8-§13) project-level Feature Executor
// model routing IS implemented (in the shared task bus core).
//
// Runtime facts verified on this machine (desktop 2.0.19): Bun 1.4.2,
// bun:sqlite (SQLite 3.53.2, json_extract available), Bun.YAML.parse.
// Plain-object default export (V2 reads `id` + `setup()`; no SDK import).

import * as path from "node:path"
import { createRuntimeRegistryCore } from "../../lib/runtime-registry-core.ts"
import { createTaskBusCore, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from "../../lib/task-bus-core.ts"
import { createLifecycleCore } from "../../lib/lifecycle-core.ts"
import { wireLifecyclePreflight } from "../../lib/lifecycle-preflight.ts"

export default {
  id: "task-bus",
  async setup(ctx: any) {
    // No schemaFile option: the core falls back to the canonical
    // .opencode/plugins/runtime-registry/schema.sql under the resolved
    // framework root, which CREATE TABLE IF NOT EXISTS-initializes (or
    // reuses) the shared runtime/tasks.db — exactly the Plan 5 schema (§20/§21).
    const core = createRuntimeRegistryCore(ctx, {
      lifecycleSchemaFile: path.join(import.meta.dir, "..", "lifecycle-engine", "schema.sql"),
    })
    const lifecycle = createLifecycleCore(ctx, core)
    wireLifecyclePreflight(core, lifecycle)
    // Shared task bus core (Plan 7 Phase 3): all task logic lives there;
    // bus.db === core.db (one shared runtime/tasks.db handle, one lifecycle).
    const bus = createTaskBusCore(ctx, core)

    // =====================================================================
    // §30: exactly five tools, namespace `task` — no more, no less
    // =====================================================================
    await ctx.tool.transform((editor: any) => {
      editor.namespace({
        name: "task",
        description:
          "Runtime Task Bus (Plan 6): route-based task dispatch to persistent project sessions and ephemeral " +
          "agents, backed by the shared runtime/tasks.db. Callers provide project_id + route + objective; the " +
          "Task Bus resolves the target role from framework-config/routing.yaml and wraps output in Result Envelopes.",
      })

      const envelopeInputProperties = {
        project_id: {
          type: "string",
          description: "Project id from framework-config/projects.yaml, e.g. ruoyi-vue-pro",
        },
        route: {
          type: "string",
          description:
            "Route name from framework-config/routing.yaml (e.g. code_read, project_analysis, " +
            "project_coordination, code_change, database_read, build_and_test, independent_review). " +
            "The Task Bus resolves the target role from the route; never specify a target agent directly.",
        },
        objective: { type: "string", description: "The final goal of the task (non-empty string)" },
        parent_task_id: {
          type: "string",
          description: "Optional parent task_id for main-task -> sub-task relationships (recorded only in Plan 6)",
        },
        constraints: {
          type: "array",
          items: { type: "string" },
          description: "Constraints the executor must respect (scope limits, forbidden operations)",
        },
        dependencies: {
          type: "array",
          items: { type: "string" },
          description:
            "task_ids that must all be COMPLETED before dispatch succeeds (readiness guard only; " +
            "no automatic DAG scheduler — dispatch again after they complete)",
        },
        expected_output: {
          type: "array",
          items: { type: "string" },
          description: "What the caller expects to receive back",
        },
        acceptance_criteria: {
          type: "array",
          items: { type: "string" },
          description: "Conditions that define when the task is done",
        },
        context_refs: {
          type: "array",
          items: { type: "string" },
          description:
            "Lightweight references only (mem0:<id>, git:current-diff, task:<id>, doc:<path>); " +
            "never embed bulk source code or credentials",
        },
        metadata: {
          type: "object",
          description: "Reserved extension object; must not contain credentials (passwords, keys, tokens)",
        },
      }

      editor.add({
        name: "task_create",
        description:
          "Create a task (Task Envelope v1) in the Task Bus with status READY. Validates project_id against " +
          "framework-config/projects.yaml and route against framework-config/routing.yaml, resolves the target " +
          "role from the route and persists the complete envelope. Does NOT execute anything and never triggers " +
          "a model. Use task_dispatch afterwards (or task_execute for the create+dispatch combo).",
        input: {
          type: "object",
          properties: envelopeInputProperties,
          required: ["project_id", "route", "objective"],
          additionalProperties: false,
        },
        options: { namespace: "task" },
        execute: async (input: any) => ({ content: JSON.stringify(bus.createTask(input)) }),
      })

      editor.add({
        name: "task_dispatch",
        description:
          "Dispatch an existing task by task_id: status gate (COMPLETED tasks are never re-executed), dependency " +
          "readiness guard, route prerequisite check, persistent/ephemeral role resolution, model gate " +
          "(MODEL_UNASSIGNED -> BLOCKED, never guessed), then execution and Result Envelope wrapping. BLOCKED " +
          "tasks may be dispatched again after the blocking condition is cleared. Serialized per task_id.",
        input: {
          type: "object",
          properties: { task_id: { type: "string", description: "task_id returned by task_create" } },
          required: ["task_id"],
          additionalProperties: false,
        },
        options: { namespace: "task" },
        execute: async (input: any) => ({ content: JSON.stringify(await bus.dispatchTask(input?.task_id)) }),
      })

      editor.add({
        name: "task_execute",
        description:
          "Convenience combination of task_create + task_dispatch and the preferred entry point for formal " +
          "tasks: creates the Task Envelope (status READY), then immediately dispatches it through the full " +
          "gate chain and returns { task, envelope, result } where result is the Result Envelope.",
        input: {
          type: "object",
          properties: envelopeInputProperties,
          required: ["project_id", "route", "objective"],
          additionalProperties: false,
        },
        options: { namespace: "task" },
        execute: async (input: any) => ({ content: JSON.stringify(await bus.executeTask(input)) }),
      })

      editor.add({
        name: "task_get",
        description:
          "Read one task by task_id: full Task Envelope, Result Envelope (if dispatched), status, target_role, " +
          "target_session_key and timestamps. Pure database read; never triggers a model request.",
        input: {
          type: "object",
          properties: { task_id: { type: "string", description: "task_id returned by task_create" } },
          required: ["task_id"],
          additionalProperties: false,
        },
        options: { namespace: "task" },
        execute: async (input: any) => ({ content: JSON.stringify(bus.getTask(input?.task_id)) }),
      })

      editor.add({
        name: "task_list",
        description:
          "List tasks (newest first) with optional filters project_id / status / route / parent_task_id / limit. " +
          "Defaults to the most recent 50 rows and is capped at 200; never returns unbounded results. Pure " +
          "database read; never triggers a model request.",
        input: {
          type: "object",
          properties: {
            project_id: { type: "string", description: "Filter by project id" },
            status: {
              type: "string",
              description: "Filter by task status (READY, BLOCKED, RUNNING, COMPLETED, FAILED, CANCELLED)",
            },
            route: { type: "string", description: "Filter by envelope route name" },
            parent_task_id: { type: "string", description: "Filter by parent task id" },
            limit: {
              type: "integer",
              description: `Maximum rows to return (default ${DEFAULT_LIST_LIMIT}, max ${MAX_LIST_LIMIT})`,
            },
          },
          additionalProperties: false,
        },
        options: { namespace: "task" },
        execute: async (input: any) => ({ content: JSON.stringify(bus.listTasks(input)) }),
      })
    })

    console.log(
      `[task-bus] loaded root=${core.root} db=${core.db ? "ok" : "unavailable:" + core.dbError} config=${core.configReady}`,
    )

    return () => {
      core.close()
    }
  },
}
