// Task Bus Core — shared task bus core (Plan 7 Phase 3)
//
// Extracted verbatim (behavior 100% compatible) from the Plan 6 plugin
// .opencode/plugins/task-bus/index.ts so that the task-bus plugin and the
// future Workflow Engine plugin share ONE implementation of:
//
//   tasks-table prepared statements / Task Envelope build + validation /
//   route -> target role resolution (routing.yaml) / the full dispatch gate
//   chain (status / envelope / route re-resolution / dependency guard /
//   route prerequisites / project existence / persistent-ephemeral decision /
//   model gate) / persistent execution (runtime core send + session_key
//   lock) / ephemeral execution (session create -> switchAgent -> switchModel
//   -> synthetic -> prompt -> wait -> context -> last assistant text) /
//   Result Envelope wrapping / per-task lock / project-level task-role model
//   resolution (Plan 7 Phase 1)
//
// Style follows the Plan 5/6 shared core at ./runtime-registry-core.ts:
// createTaskBusCore(ctx, runtimeCore) returns an object; all heavy state is
// created synchronously; no SDK import; YAML via Bun.YAML.parse; SQLite via
// the runtime core db handle. This core shares ONE SQLite database
// (runtime/tasks.db) with the runtime core — it NEVER opens its own database,
// NEVER ships a schema file and NEVER ALTERs the `tasks` table (§20/§21).
// Core functions return structured objects; JSON serialization is left to the
// caller (thin tool wrappers / future Workflow Engine).
//
// Authority boundaries (unchanged from Plan 6):
// - Architecture source of truth: diagrams/multi_agent_framework_v3_workspace.drawio
// - Runtime data sources (read fresh on every call, nothing hardcoded — §22):
//   framework-config/projects.yaml / agents.yaml / routing.yaml / task-bus.yaml
// - Envelope contracts: templates/task-envelope.schema.json +
//   templates/result-envelope.schema.json (schema_version 1)
//
// Explicitly NOT implemented in Plan 6 (§63) — do not claim otherwise:
// automatic DAG scheduler, parallel batch dispatch, automatic retry,
// automatic reviewer dispatch / PASS-FIX-REWORK loop, automatic lifecycle
// rotation, automatic checkpointing, cancel tool (CANCELLED is protocol-
// reserved only). Plan 7 Phases 4-9 (Workflow Engine, reviewer-pass strict
// verification, retry policy) are NOT implemented here either.
//
// Plan 7 Phase 1 (§8-§13) IS implemented here: project-level Feature Executor
// model routing. The feature-executor model is resolved per project from
// agents.yaml project_sessions.<project>.model.runtime_id — never inherited
// from the Orchestrator, never guessed; a project without a configured model
// (e.g. xxl-job) stays MODEL_UNASSIGNED -> BLOCKED with no fallback.
//
// Runtime facts verified on this machine (desktop 2.0.19): Bun 1.4.2,
// bun:sqlite (SQLite 3.53.2, json_extract available), Bun.YAML.parse.

import * as fs from "node:fs"
import * as path from "node:path"

export const SCHEMA_VERSION = 1
export const DEFAULT_LIST_LIMIT = 50 // §35: default to the most recent 50 rows
export const MAX_LIST_LIMIT = 200 // §35: never return unbounded results
const WAIT_TIMEOUT_MS = 15 * 60 * 1000 // same wait budget as the runtime core

function nowIso(): string {
  return new Date().toISOString()
}

function errMsg(e: any): string {
  return e?.message ?? String(e)
}

function failure(code: string, detail: string, extra?: Record<string, unknown>) {
  return { ok: false, status: "ERROR", code, detail, ...(extra ?? {}) }
}

function safeParse(json: any): any {
  if (typeof json !== "string" || !json) return null
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

// Create the shared task bus core on top of an existing runtime registry core
// (createRuntimeRegistryCore from ./runtime-registry-core.ts). All heavy state
// (prepared statements for the existing `tasks` table) is created
// synchronously here — the same initialization timing as the Plan 6 plugin
// setup(). The `tasks` table already exists (created by
// runtime-registry/schema.sql); no schema file, no ALTER TABLE (§20/§21).
// The db lifecycle belongs to the runtime core (its close() closes the shared
// handle); this core does not expose its own close().
export function createTaskBusCore(ctx: any, runtimeCore: any) {
  const db = runtimeCore.db

  // --- prepared statements for the existing `tasks` table (no ALTER TABLE) ---
  const tq = db
    ? {
        get: db.query("SELECT * FROM tasks WHERE task_id = ?"),
        insert: db.query(
          "INSERT INTO tasks (task_id, parent_task_id, project_id, target_role, target_session_key, " +
            "status, input_json, result_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ),
        // status / target_session_key / result_json / updated_at by task_id
        update: db.query(
          "UPDATE tasks SET status = ?, target_session_key = ?, result_json = ?, updated_at = ? WHERE task_id = ?",
        ),
      }
    : null

  // --- infrastructure guard (mirrors the core guard) ---
  function guardBus() {
    if (!db || !tq) return failure("SQLITE_RUNTIME_UNAVAILABLE", runtimeCore.dbError ?? "task database unavailable")
    if (!runtimeCore.configReady) {
      return failure("CONFIG_ROOT_NOT_FOUND", `framework-config not found from root '${runtimeCore.root}'`)
    }
    return null
  }

  // --- §22: read ALL four config files fresh on every call (no hardcoding) ---
  function loadBusConfig() {
    const B = (globalThis as any).Bun
    if (typeof B?.YAML?.parse !== "function") {
      throw new Error("YAML_PARSER_UNAVAILABLE: Bun.YAML.parse is not present in this runtime")
    }
    const cfgDir = path.join(runtimeCore.root, "framework-config")
    // projects + agents come from the shared core loader
    const base = runtimeCore.loadConfig()
    const routing = B.YAML.parse(fs.readFileSync(path.join(cfgDir, "routing.yaml"), "utf8"))
    const taskBus = B.YAML.parse(fs.readFileSync(path.join(cfgDir, "task-bus.yaml"), "utf8"))
    return { projects: base.projects, agents: base.agents, routing, taskBus }
  }

  // --- §23: route -> target role resolution from routing.yaml only ---
  function resolveRoute(routing: any, route: string) {
    const routes = routing?.routes
    if (!routes || typeof routes !== "object") {
      return { error: "ROUTING_CONFIG_INVALID", target: null as string | null, requires: [] as string[] }
    }
    const entry = (routes as any)[route]
    if (!entry || typeof entry !== "object") {
      return { error: "ROUTE_NOT_FOUND", target: null as string | null, requires: [] as string[] }
    }
    const target = entry.target
    if (typeof target !== "string" || !target) {
      return { error: "ROUTE_TARGET_MISSING", target: null as string | null, requires: [] as string[] }
    }
    const requires = Array.isArray(entry.requires)
      ? entry.requires.filter((r: any) => typeof r === "string" && r)
      : []
    return { error: null, target, requires }
  }

  // --- §25: agents.yaml role model lookup (agents[id=role].model.runtime_id);
  // used by resolveTaskRoleModel for every role without a special source ---
  function findAgentModel(agentsCfg: any, role: string): string | null {
    const list = agentsCfg?.agents
    if (!Array.isArray(list)) return null
    const agent = list.find((a: any) => a?.id === role)
    const rid = agent?.model?.runtime_id
    return typeof rid === "string" && rid ? rid : null
  }

  // --- Plan 7 Phase 1 (§10): unified task-role model resolution. Rules
  // (all values come from framework-config; nothing is hardcoded here):
  //   project-main      -> agents.yaml project_sessions.<project>.model.runtime_id
  //   project-reader    -> agents.yaml agents[id='project-reader'].model.runtime_id
  //   feature-executor  -> agents.yaml project_sessions.<project>.model.runtime_id
  //   any other role    -> agents.yaml agents[id=role].model.runtime_id
  // project-main / project-reader delegate to core.resolveRoleModel so the
  // semantics are EXACTLY the ones used by the runtime core ensure(); the
  // feature-executor branch reads project_sessions with the same accessor as
  // the core (drawio: per-project model + Feature Child Session). Returns
  // null when nothing is configured — callers must BLOCK, never inherit /
  // guess / default. ---
  function resolveTaskRoleModel(cfg: any, projectId: string, role: string): string | null {
    if (role === "project-main" || role === "project-reader") {
      return runtimeCore.resolveRoleModel(cfg, projectId, role)
    }
    if (role === "feature-executor") {
      const rid = cfg?.agents?.project_sessions?.[projectId]?.model?.runtime_id
      return typeof rid === "string" && rid ? rid : null
    }
    return findAgentModel(cfg.agents, role)
  }

  // --- Plan 7 §10: where a role's runtime_id is configured; used in
  // MODEL_UNASSIGNED details so the caller sees the resolution source ---
  function taskRoleModelSource(projectId: string, role: string): string {
    if (role === "project-main" || role === "feature-executor") {
      return `framework-config/agents.yaml project_sessions.${projectId}.model.runtime_id`
    }
    return `framework-config/agents.yaml agents[id='${role}'].model.runtime_id`
  }

  function rowToTask(row: any) {
    if (!row) return null
    return {
      task_id: row.task_id,
      parent_task_id: row.parent_task_id,
      project_id: row.project_id,
      target_role: row.target_role,
      target_session_key: row.target_session_key,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }
  }

  // --- §37: fixed prompt format; the full envelope JSON + execution rules.
  // Never add DB passwords / API tokens / bulk source code here.
  function buildPrompt(envelope: any): string {
    return [
      "TASK ENVELOPE",
      JSON.stringify(envelope, null, 2),
      "",
      "执行规则：",
      "- 只执行 objective",
      "- 遵守 constraints",
      "- 返回 expected_output 所要求内容",
      "- 不扩大任务范围",
      "- 遵守自己的 Agent Profile",
    ].join("\n")
  }

  // --- §38: ephemeral scope injection (session location stays at the
  // framework root; project scope arrives via this synthetic message) ---
  function ephemeralContext(envelope: any, role: string, project: any): string {
    return [
      `PROJECT_ID: ${envelope.project_id}`,
      `PROJECT_PATH: ${typeof project?.path === "string" ? project.path : ""}`,
      `TASK_ID: ${envelope.task_id}`,
      `TARGET_ROLE: ${role}`,
      "",
      "Rules:",
      "- ephemeral task session created by the task-bus plugin (Plan 6)",
      `- session location stays at the framework root (${runtimeCore.root}); project scope comes from this context`,
      `- obey ${path.join(runtimeCore.root, "AGENTS.md")}`,
      "- no git pull",
      "- no git push",
      "- this session is kept (not deleted) after the task for manual audit",
      "",
      "(Synthetic scope context written by the task-bus plugin, Plan 6.)",
    ].join("\n")
  }

  // --- §36: Result Envelope builder (fields exactly per
  // templates/result-envelope.schema.json, additionalProperties: false) ---
  function buildResult(args: {
    taskId: string
    projectId: string
    route: string
    targetRole: string | null
    status: "COMPLETED" | "FAILED" | "BLOCKED" | "CANCELLED"
    sessionId: string | null
    sessionGeneration: number | null
    outputText: string
    error: string | null
    startedAt: string
    finishedAt: string
  }) {
    return {
      schema_version: SCHEMA_VERSION,
      task_id: args.taskId,
      project_id: args.projectId,
      route: args.route,
      target_role: args.targetRole,
      status: args.status,
      session_id: args.sessionId,
      session_generation: args.sessionGeneration,
      output_text: args.outputText,
      artifacts: [] as string[],
      risks: [] as string[],
      error: args.error,
      started_at: args.startedAt,
      finished_at: args.finishedAt,
    }
  }

  function persistResult(taskId: string, status: string, targetSessionKey: string | null, result: any) {
    tq.update.run(status, targetSessionKey, JSON.stringify(result), nowIso(), taskId)
  }

  // --- pre-execution BLOCKED path: persist a BLOCKED Result Envelope and
  // move the task row to BLOCKED (§27/§28/§25/§29). Never touches a model.
  function persistBlocked(
    row: any,
    envelope: any,
    targetRole: string | null,
    code: string,
    detail: string,
    extra?: Record<string, unknown>,
  ) {
    const ts = nowIso()
    const result = buildResult({
      taskId: row.task_id,
      projectId: envelope?.project_id ?? row.project_id,
      route: envelope?.route ?? "",
      targetRole,
      status: "BLOCKED",
      sessionId: null,
      sessionGeneration: null,
      outputText: "",
      error: `${code}: ${detail}`,
      startedAt: ts,
      finishedAt: ts,
    })
    persistResult(row.task_id, "BLOCKED", row.target_session_key ?? null, result)
    return {
      ok: false,
      status: "BLOCKED",
      code,
      detail,
      task: rowToTask(tq.get.get(row.task_id)),
      result,
      ...(extra ?? {}),
    }
  }

  // =====================================================================
  // §31: task_create — validate, resolve role, persist READY, no execution
  // =====================================================================
  function createTask(input: any) {
    const g = guardBus()
    if (g) return g
    if (typeof input?.project_id !== "string" || !input.project_id) {
      return failure("INVALID_INPUT", "project_id is required (string)")
    }
    if (typeof input?.route !== "string" || !input.route) {
      return failure("INVALID_INPUT", "route is required (string)")
    }
    if (typeof input?.objective !== "string" || !input.objective.trim()) {
      return failure("INVALID_INPUT", "objective is required (non-empty string)")
    }
    if (
      input.parent_task_id !== undefined &&
      input.parent_task_id !== null &&
      typeof input.parent_task_id !== "string"
    ) {
      return failure("INVALID_INPUT", "parent_task_id must be a string or null")
    }
    const arrayFields = ["constraints", "dependencies", "expected_output", "acceptance_criteria", "context_refs"]
    const arrays: Record<string, string[]> = {}
    for (const f of arrayFields) {
      const v = (input as any)[f]
      if (v === undefined || v === null) {
        arrays[f] = []
        continue
      }
      if (!Array.isArray(v) || v.some((x: any) => typeof x !== "string")) {
        return failure("INVALID_INPUT", `${f} must be an array of strings`)
      }
      arrays[f] = v as string[]
    }
    if (
      input.metadata !== undefined &&
      input.metadata !== null &&
      (typeof input.metadata !== "object" || Array.isArray(input.metadata))
    ) {
      return failure("INVALID_INPUT", "metadata must be an object")
    }

    let cfg: any
    try {
      cfg = loadBusConfig()
    } catch (e: any) {
      return failure("CONFIG_LOAD_FAILED", errMsg(e))
    }

    // §26: validate the project BEFORE inserting anything (failure atomicity)
    const project = runtimeCore.findProject(cfg, input.project_id)
    if (!project) {
      return failure(
        "PROJECT_NOT_FOUND",
        `project '${input.project_id}' is not registered in framework-config/projects.yaml`,
      )
    }
    // §23: validate the route and resolve the target role from routing.yaml;
    // callers may never specify the target role directly.
    const routeInfo = resolveRoute(cfg.routing, input.route)
    if (routeInfo.error || !routeInfo.target) {
      return failure(
        routeInfo.error ?? "ROUTE_NOT_FOUND",
        `route '${input.route}' is not usable in framework-config/routing.yaml routes`,
      )
    }

    // §9: collision-resistant id; timestamp-only ids are forbidden
    const c: any = (globalThis as any).crypto
    if (typeof c?.randomUUID !== "function") {
      return failure("UUID_UNAVAILABLE", "crypto.randomUUID is not available in this runtime")
    }
    const taskId: string = c.randomUUID()

    // §8: the persisted input_json is always a COMPLETE Task Envelope
    const envelope = {
      schema_version: SCHEMA_VERSION,
      task_id: taskId,
      parent_task_id: input.parent_task_id ?? null,
      project_id: input.project_id,
      route: input.route,
      objective: input.objective,
      constraints: arrays.constraints,
      dependencies: arrays.dependencies,
      expected_output: arrays.expected_output,
      acceptance_criteria: arrays.acceptance_criteria,
      context_refs: arrays.context_refs,
      metadata: input.metadata ?? {},
    }
    const ts = nowIso()
    tq.insert.run(
      taskId,
      envelope.parent_task_id,
      envelope.project_id,
      routeInfo.target,
      null, // target_session_key is resolved at dispatch time (§21)
      "READY", // §31 recommended initial state
      JSON.stringify(envelope),
      null,
      ts,
      ts,
    )

    // informational (§31): dependencies are NOT checked at create time;
    // the readiness guard runs at dispatch. Pending deps are surfaced so
    // the caller knows a first dispatch may return DEPENDENCY_NOT_READY.
    const pendingDeps: string[] = []
    for (const dep of envelope.dependencies) {
      const depRow: any = tq.get.get(dep)
      if (!depRow || depRow.status !== "COMPLETED") pendingDeps.push(dep)
    }
    return {
      ok: true,
      status: "READY",
      task: rowToTask(tq.get.get(taskId)),
      envelope,
      dependencies_pending: pendingDeps,
      note: "task created with status READY; dispatch it via task_dispatch (or use task_execute)",
    }
  }

  // =====================================================================
  // §24: persistent execution — reuse the Runtime Registry session via
  // core.send() under the core session_key lock (§39)
  // =====================================================================
  async function executePersistent(projectId: string, role: string, prompt: string) {
    const res: any = await runtimeCore.withLock(runtimeCore.sessionKey(projectId, role), () =>
      runtimeCore.send(projectId, role, prompt),
    )
    if (res?.ok) {
      return {
        kind: "completed" as const,
        outputText: String(res.result ?? ""),
        sessionId: (res.session_id as string) ?? null,
        sessionGeneration: typeof res.generation === "number" ? res.generation : null,
        targetSessionKey: (res.session_key as string) ?? runtimeCore.sessionKey(projectId, role),
        code: null as string | null,
        detail: null as string | null,
      }
    }
    const code = String(res?.code ?? res?.status ?? "SEND_FAILED")
    const detail = String(res?.detail ?? "persistent session send failed")
    // config-level problems keep the task retryable => BLOCKED, not FAILED
    if (code === "MODEL_UNASSIGNED" || code === "PROJECT_NOT_FOUND" || code === "ROLE_NOT_SUPPORTED") {
      return {
        kind: "blocked" as const,
        outputText: "",
        sessionId: (res?.session_id as string) ?? null,
        sessionGeneration: null,
        targetSessionKey: (res?.session_key as string) ?? runtimeCore.sessionKey(projectId, role),
        code,
        detail,
      }
    }
    return {
      kind: "failed" as const,
      outputText: "",
      sessionId: (res?.session_id as string) ?? null,
      sessionGeneration: typeof res?.generation === "number" ? res.generation : null,
      targetSessionKey: (res?.session_key as string) ?? runtimeCore.sessionKey(projectId, role),
      code,
      detail: `${code}: ${detail}`,
    }
  }

  // =====================================================================
  // §24/§38: ephemeral execution — NEW OpenCode session per task, same V2
  // API sequence as the runtime core (create -> switchAgent -> switchModel
  // -> synthetic -> prompt -> wait -> context -> extract last assistant
  // text). The session is NOT written to the registry `sessions` table and
  // is NOT deleted afterwards (kept for manual audit).
  // =====================================================================
  async function executeEphemeral(
    envelope: any,
    role: string,
    project: any,
    model: { providerID: string; id: string; variant?: string },
    prompt: string,
  ) {
    const title = `[task] ${envelope.project_id} ${role} ${String(envelope.task_id).slice(0, 8)}`
    const info: any = await ctx.session.create({ title })
    const sessionID: string | undefined = info?.id ?? info?.sessionID
    if (!sessionID) throw new Error("session create returned no id")
    const sessionKey = `session:${sessionID}` // §21 ephemeral target_session_key
    try {
      await ctx.session.switchAgent({ sessionID, agent: role })
      const modelRef: any = { providerID: model.providerID, id: model.id }
      if (model.variant) modelRef.variant = model.variant
      await ctx.session.switchModel({ sessionID, model: modelRef })
      await ctx.session.synthetic({ sessionID, text: ephemeralContext(envelope, role, project) })
    } catch (e: any) {
      return {
        kind: "failed" as const,
        outputText: "",
        sessionId: sessionID,
        sessionGeneration: null,
        targetSessionKey: sessionKey,
        code: "SESSION_INIT_FAILED",
        detail: `SESSION_INIT_FAILED: ${errMsg(e)} (session ${sessionID} was created but initialization failed; kept for audit)`,
      }
    }
    try {
      await ctx.session.prompt({ sessionID, text: prompt })
      let timer: any
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`WAIT_TIMEOUT after ${WAIT_TIMEOUT_MS}ms`)), WAIT_TIMEOUT_MS)
      })
      try {
        await Promise.race([ctx.session.wait({ sessionID }), timeout])
      } finally {
        clearTimeout(timer)
      }
      const contextRes: any = await ctx.session.context({ sessionID })
      const messages: any[] = Array.isArray(contextRes) ? contextRes : (contextRes?.messages ?? [])
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]
        if (m?.type !== "assistant") continue
        const parts: any[] = Array.isArray(m.content) ? m.content : []
        const text = parts
          .filter((p: any) => p?.type === "text" && typeof p.text === "string")
          .map((p: any) => p.text)
          .join("\n")
          .trim()
        if (text) {
          return {
            kind: "completed" as const,
            outputText: text,
            sessionId: sessionID,
            sessionGeneration: null, // no registry generation for ephemeral sessions
            targetSessionKey: sessionKey,
            code: null as string | null,
            detail: null as string | null,
          }
        }
        return {
          kind: "failed" as const,
          outputText: "",
          sessionId: sessionID,
          sessionGeneration: null,
          targetSessionKey: sessionKey,
          code: "NO_ASSISTANT_TEXT",
          detail: "NO_ASSISTANT_TEXT: the last assistant message contained no text part",
        }
      }
      return {
        kind: "failed" as const,
        outputText: "",
        sessionId: sessionID,
        sessionGeneration: null,
        targetSessionKey: sessionKey,
        code: "NO_ASSISTANT_RESULT",
        detail: "NO_ASSISTANT_RESULT: no assistant message found after wait",
      }
    } catch (e: any) {
      return {
        kind: "failed" as const,
        outputText: "",
        sessionId: sessionID,
        sessionGeneration: null,
        targetSessionKey: sessionKey,
        code: "EXECUTION_FAILED",
        detail: `EXECUTION_FAILED: ${errMsg(e)}`,
      }
    }
    // NOTE: the ephemeral session is intentionally never deleted (§24).
  }

  // --- §39: per-task serial lock (shared runtime core lock chain, key
  // `task:<task_id>`); prevents double dispatch of the same task. Exposed
  // for callers (thin wrappers / future Workflow Engine) that need the same
  // serialization around their own task-scoped critical sections. ---
  function withTaskLock<T>(taskId: string, fn: () => Promise<T> | T): Promise<T> {
    return runtimeCore.withLock(`task:${taskId}`, fn)
  }

  // =====================================================================
  // §32: task_dispatch — the full gate chain, serialized per task_id (§39)
  // =====================================================================
  async function dispatchTask(taskId: any) {
    const g = guardBus()
    if (g) return g
    if (typeof taskId !== "string" || !taskId) return failure("INVALID_INPUT", "task_id is required")
    // §39: per-task serial lock prevents double dispatch of the same task.
    // Persistent sessions keep their own core session_key lock underneath.
    return withTaskLock(taskId, () => dispatchLocked(taskId))
  }

  async function dispatchLocked(taskId: string) {
    const row: any = tq.get.get(taskId)
    if (!row) return failure("TASK_NOT_FOUND", `task '${taskId}' does not exist in runtime/tasks.db`)

    // --- gate 1: status validation (§29/§32 state machine) ---
    if (row.status === "COMPLETED") {
      // §32: re-dispatching a COMPLETED task must NOT re-execute it
      return {
        ok: false,
        status: "COMPLETED",
        code: "TASK_ALREADY_COMPLETED",
        detail: "task is already COMPLETED; refusing to execute it again (no automatic retry in Plan 6)",
        task: rowToTask(row),
        result: safeParse(row.result_json),
      }
    }
    if (row.status === "FAILED") {
      // §29 defines no exit transition out of FAILED and §63 forbids
      // automatic retry => FAILED is terminal in Plan 6; create a new task.
      return {
        ok: false,
        status: "FAILED",
        code: "TASK_ALREADY_FAILED",
        detail: "task is FAILED (terminal in Plan 6, no automatic retry); create a new task instead",
        task: rowToTask(row),
        result: safeParse(row.result_json),
      }
    }
    if (row.status === "CANCELLED") {
      // protocol-reserved only; Plan 6 has no cancel tool, so this row can
      // only come from manual intervention — still refuse to dispatch it.
      return {
        ok: false,
        status: "CANCELLED",
        code: "TASK_CANCELLED",
        detail: "CANCELLED is protocol-reserved in Plan 6 (no cancel tool); dispatch not allowed",
        task: rowToTask(row),
        result: safeParse(row.result_json),
      }
    }
    if (row.status === "RUNNING") {
      // the per-task lock rules out in-process races, so RUNNING here means
      // a stale run (e.g. desktop restart mid-dispatch). Never double-run.
      return {
        ok: false,
        status: "RUNNING",
        code: "TASK_ALREADY_RUNNING",
        detail:
          "task is marked RUNNING (a previous dispatch did not finish, e.g. process restart); " +
          "refusing to execute it a second time",
        task: rowToTask(row),
        result: safeParse(row.result_json),
      }
    }
    // READY or BLOCKED => dispatch allowed (§29: BLOCKED -> RUNNING retry)

    // --- gate 2: parse the persisted Task Envelope ---
    const envelope = safeParse(row.input_json)
    if (!envelope || typeof envelope !== "object") {
      const ts = nowIso()
      const result = buildResult({
        taskId: row.task_id,
        projectId: row.project_id ?? "",
        route: "",
        targetRole: row.target_role ?? null,
        status: "FAILED",
        sessionId: null,
        sessionGeneration: null,
        outputText: "",
        error: "TASK_ENVELOPE_INVALID: input_json is missing or not parseable; the task cannot be executed",
        startedAt: ts,
        finishedAt: ts,
      })
      persistResult(row.task_id, "FAILED", row.target_session_key ?? null, result)
      return {
        ok: false,
        status: "FAILED",
        code: "TASK_ENVELOPE_INVALID",
        detail: result.error,
        task: rowToTask(tq.get.get(taskId)),
        result,
      }
    }

    let cfg: any
    try {
      cfg = loadBusConfig()
    } catch (e: any) {
      // infrastructure failure: leave the task row untouched (READY/BLOCKED)
      return failure("CONFIG_LOAD_FAILED", errMsg(e), { task_id: taskId })
    }

    // --- gate 3: re-resolve route -> target role (config may have changed) ---
    const routeInfo = resolveRoute(cfg.routing, envelope.route)
    if (routeInfo.error || !routeInfo.target) {
      return persistBlocked(
        row,
        envelope,
        row.target_role ?? null,
        routeInfo.error ?? "ROUTE_NOT_FOUND",
        `route '${envelope.route}' is no longer usable in framework-config/routing.yaml routes`,
      )
    }
    const targetRole: string = routeInfo.target

    // --- gate 4: dependency readiness guard (§27). All dependencies must
    // exist AND be COMPLETED; otherwise BLOCKED. No automatic watching —
    // the caller simply dispatches again later. NOT a DAG scheduler. ---
    const deps: string[] = Array.isArray(envelope.dependencies)
      ? envelope.dependencies.filter((d: any) => typeof d === "string" && d)
      : []
    const blockingTaskIds: string[] = []
    const blockingDetail: Array<{ task_id: string; status: string }> = []
    for (const dep of deps) {
      const depRow: any = tq.get.get(dep)
      if (!depRow) {
        blockingTaskIds.push(dep)
        blockingDetail.push({ task_id: dep, status: "NOT_FOUND" })
      } else if (depRow.status !== "COMPLETED") {
        blockingTaskIds.push(dep)
        blockingDetail.push({ task_id: dep, status: String(depRow.status) })
      }
    }
    if (blockingTaskIds.length > 0) {
      return persistBlocked(
        row,
        envelope,
        targetRole,
        "DEPENDENCY_NOT_READY",
        `dependencies not COMPLETED: ${blockingDetail.map((b) => `${b.task_id} (${b.status})`).join(", ")}; ` +
          "dispatch again after they complete (no automatic watching in Plan 6)",
        { blocking_task_ids: blockingTaskIds, blocking_dependencies: blockingDetail },
      )
    }

    // --- gate 5: route prerequisites (§28). Plan 6 has no verified
    // Reviewer PASS chain, so a route with `requires` can NEVER be strictly
    // satisfied here; caller claims alone must not unlock it. Real
    // unlocking is deferred to the Plan 7 Reviewer Loop. ---
    if (routeInfo.requires.length > 0) {
      return persistBlocked(
        row,
        envelope,
        targetRole,
        "ROUTE_PRECONDITION_UNSATISFIED",
        `route '${envelope.route}' requires [${routeInfo.requires.join(", ")}]; Plan 6 cannot strictly verify ` +
          "prerequisites (automatic Reviewer loop is deferred to Plan 7), and caller claims alone never unlock a route",
        { requires: routeInfo.requires },
      )
    }

    // --- gate 6: project must still exist (needed for ephemeral scope) ---
    const project = runtimeCore.findProject(cfg, envelope.project_id)
    if (!project) {
      return persistBlocked(
        row,
        envelope,
        targetRole,
        "PROJECT_NOT_FOUND",
        `project '${envelope.project_id}' is not registered in framework-config/projects.yaml`,
      )
    }

    // --- gate 7: persistent vs ephemeral per task-bus.yaml (§24) ---
    const persistentRoles: any[] = Array.isArray(cfg.taskBus?.persistent_roles) ? cfg.taskBus.persistent_roles : []
    const ephemeralRoles: any[] = Array.isArray(cfg.taskBus?.ephemeral_roles) ? cfg.taskBus.ephemeral_roles : []
    const isPersistent = persistentRoles.includes(targetRole)
    const isEphemeral = ephemeralRoles.includes(targetRole)
    if (!isPersistent && !isEphemeral) {
      return persistBlocked(
        row,
        envelope,
        targetRole,
        "TARGET_ROLE_DISPATCH_UNDEFINED",
        `target role '${targetRole}' is listed in neither persistent_roles nor ephemeral_roles of ` +
          "framework-config/task-bus.yaml",
      )
    }

    // --- gate 8: model gate BEFORE any session work (§25/§29: model
    // problems => BLOCKED, never inherit / guess / default).
    // Plan 7 §10: ephemeral AND persistent roles resolve uniformly via
    // resolveTaskRoleModel(project_id, target_role). For project-main /
    // project-reader this yields exactly the previous core.resolveRoleModel
    // result, for the other ephemeral roles exactly the previous agents.yaml
    // lookup — only feature-executor changes (per-project source). ---
    const runtimeId: string | null = resolveTaskRoleModel(cfg, envelope.project_id, targetRole)
    if (!runtimeId) {
      return persistBlocked(
        row,
        envelope,
        targetRole,
        "MODEL_UNASSIGNED",
        `${taskRoleModelSource(envelope.project_id, targetRole)} is null/missing for role '${targetRole}' ` +
          `of project '${envelope.project_id}'; refusing to create a session, inherit the orchestrator ` +
          "model, guess a model or use a default model",
      )
    }
    let model: { providerID: string; id: string; variant?: string } | null = null
    if (isEphemeral) {
      // ephemeral sessions switch the model themselves -> parse it here;
      // persistent sessions keep delegating the parse to core.ensure()
      // (existing RUNTIME_ID_UNPARSEABLE behavior unchanged)
      model = runtimeCore.parseRuntimeId(runtimeId)
      if (!model) {
        return persistBlocked(
          row,
          envelope,
          targetRole,
          "RUNTIME_ID_UNPARSEABLE",
          `cannot parse runtime_id '${runtimeId}' of role '${targetRole}'`,
        )
      }
    }

    // --- all gates passed: READY/BLOCKED -> RUNNING (§29), then execute ---
    const startedAt = nowIso()
    tq.update.run("RUNNING", row.target_session_key ?? null, row.result_json ?? null, startedAt, taskId)
    const prompt = buildPrompt(envelope)

    let exec: any
    try {
      exec = isPersistent
        ? await executePersistent(envelope.project_id, targetRole, prompt)
        : await executeEphemeral(envelope, targetRole, project, model!, prompt)
    } catch (e: any) {
      exec = {
        kind: "failed",
        outputText: "",
        sessionId: null,
        sessionGeneration: null,
        targetSessionKey: row.target_session_key ?? null,
        code: "EXECUTION_EXCEPTION",
        detail: `EXECUTION_EXCEPTION: ${errMsg(e)}`,
      }
    }

    // --- wrap into the Result Envelope (§36) and persist the final state ---
    const finishedAt = nowIso()
    const finalStatus: "COMPLETED" | "FAILED" | "BLOCKED" =
      exec.kind === "completed" ? "COMPLETED" : exec.kind === "blocked" ? "BLOCKED" : "FAILED"
    const errorCode = finalStatus === "COMPLETED" ? null : String(exec.code ?? finalStatus)
    const result = buildResult({
      taskId,
      projectId: envelope.project_id,
      route: envelope.route,
      targetRole,
      status: finalStatus,
      sessionId: exec.sessionId ?? null,
      sessionGeneration: exec.sessionGeneration ?? null,
      outputText: typeof exec.outputText === "string" ? exec.outputText : "",
      error:
        finalStatus === "COMPLETED"
          ? null
          : exec.kind === "blocked"
            ? `${errorCode}: ${exec.detail ?? ""}`.trim()
            : String(exec.detail ?? errorCode),
      startedAt,
      finishedAt,
    })
    persistResult(taskId, finalStatus, exec.targetSessionKey ?? row.target_session_key ?? null, result)

    const resp: any = {
      ok: finalStatus === "COMPLETED",
      status: finalStatus,
      task: rowToTask(tq.get.get(taskId)),
      result,
    }
    if (finalStatus !== "COMPLETED") {
      resp.code = errorCode
      resp.detail = exec.detail ?? result.error
    }
    return resp
  }

  // =====================================================================
  // §33: task_execute — convenience create + dispatch combo
  // =====================================================================
  async function executeTask(input: any) {
    const created: any = createTask(input)
    if (!created.ok) return created
    const dispatched: any = await dispatchTask(created.envelope.task_id)
    return {
      ok: dispatched.ok,
      status: dispatched.status,
      ...(dispatched.code ? { code: dispatched.code } : {}),
      ...(dispatched.detail ? { detail: dispatched.detail } : {}),
      ...(dispatched.blocking_task_ids ? { blocking_task_ids: dispatched.blocking_task_ids } : {}),
      task: dispatched.task ?? created.task,
      envelope: created.envelope,
      result: dispatched.result ?? null,
    }
  }

  // =====================================================================
  // §34: task_get — pure read, never triggers a model
  // =====================================================================
  function getTask(taskId: any) {
    const g = guardBus()
    if (g) return g
    if (typeof taskId !== "string" || !taskId) return failure("INVALID_INPUT", "task_id is required")
    const row: any = tq.get.get(taskId)
    if (!row) return failure("TASK_NOT_FOUND", `task '${taskId}' does not exist in runtime/tasks.db`)
    const envelope = safeParse(row.input_json)
    return {
      ok: true,
      status: row.status,
      task_id: row.task_id,
      parent_task_id: row.parent_task_id,
      project_id: row.project_id,
      route: envelope?.route ?? null,
      target_role: row.target_role,
      target_session_key: row.target_session_key,
      envelope, // full Task Envelope (input_json)
      result: safeParse(row.result_json), // Result Envelope or null
      created_at: row.created_at,
      updated_at: row.updated_at,
    }
  }

  // =====================================================================
  // §35: task_list — bounded, filterable, newest first
  // =====================================================================
  function listTasks(input: any) {
    const g = guardBus()
    if (g) return g
    const where: string[] = []
    const params: any[] = []
    if (typeof input?.project_id === "string" && input.project_id) {
      where.push("project_id = ?")
      params.push(input.project_id)
    }
    if (typeof input?.status === "string" && input.status) {
      where.push("status = ?")
      params.push(input.status)
    }
    if (typeof input?.route === "string" && input.route) {
      // route lives inside the envelope JSON (no extra column, §21)
      where.push("json_extract(input_json, '$.route') = ?")
      params.push(input.route)
    }
    if (typeof input?.parent_task_id === "string" && input.parent_task_id) {
      where.push("parent_task_id = ?")
      params.push(input.parent_task_id)
    }
    let limit = DEFAULT_LIST_LIMIT
    if (input?.limit !== undefined && input?.limit !== null) {
      const n = Number(input.limit)
      if (!Number.isInteger(n) || n < 1) return failure("INVALID_INPUT", "limit must be a positive integer")
      limit = Math.min(n, MAX_LIST_LIMIT)
    }
    const sql =
      "SELECT task_id, parent_task_id, project_id, json_extract(input_json, '$.route') AS route, " +
      "target_role, target_session_key, status, created_at, updated_at FROM tasks " +
      (where.length ? `WHERE ${where.join(" AND ")} ` : "") +
      "ORDER BY created_at DESC, task_id DESC LIMIT ?"
    const rows: any[] = db.query(sql).all(...params, limit)
    return { ok: true, status: "OK", count: rows.length, limit, tasks: rows }
  }

  return {
    // --- §26: required shared core surface (structured objects; callers do
    // their own JSON serialization) ---
    createTask,
    dispatchTask,
    executeTask,
    getTask,
    listTasks,
    resolveRoute,
    resolveTaskRoleModel,
    buildResult,
    db,
    loadBusConfig,
    withTaskLock,
    // --- additional existing internals exposed for the thin wrapper and the
    // future Workflow Engine (Plan 7 Phase 4+); no new logic, all verbatim
    // from the Plan 6 plugin ---
    guardBus,
    findAgentModel,
    taskRoleModelSource,
    rowToTask,
    buildPrompt,
    ephemeralContext,
    persistResult,
    persistBlocked,
    executePersistent,
    executeEphemeral,
    dispatchLocked,
  }
}
