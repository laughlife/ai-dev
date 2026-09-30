import { normalizeLanePolicies } from "../../lib/lane-scheduler.ts"
import { resolveResourceContract } from "../../lib/lane-resource-contract.ts"
import { dispatchTeamWaves, normalizeTeamExecutionPolicy, isTeamExecutionRequired, shouldMustParallelize } from "../../lib/team-execution-coordinator.ts"

// Workflow Engine — automatic DAG scheduler (Plan 7 Phase 4+, T7b; §39-§44,
// §60-§62, §68)
//
// runWorkflow(workflow_id) is the §39 loop: load workflow + nodes → find
// dependency-ready nodes → group them into parallel waves by the
// workflow.yaml parallel policy → dispatch (Promise.allSettled, real
// concurrency capped at scheduler.max_parallel) → persist node states →
// repeat until a terminal state (REVIEW_PASSED / FAILED / BLOCKED /
// REWORK_LIMIT). Reviewer rounds and FIX/REWORK subgraph replays are
// delegated to ./review.ts; every scheduling decision here is deterministic
// (status/lock/route/retry arithmetic) — an LLM never decides scheduling.
//
// Parallel safety (§40-§44), all lists read fresh from workflow.yaml:
// - safe_routes            → no extra lock, truly concurrent
// - project_serial_routes  → executor wrapped in core.withLock(`project:<pid>:write`)
//                            (same project serialized, different projects parallel)
// - global_serial_routes   → core.withLock(`global:<route-family>`); family map:
//                            database_write/database_ddl/database_backup → global:database,
//                            long_term_memory_write → global:memory
// - any route in NO list   → conservative project_serial treatment
// - mixed waves still respect max_parallel (chunk size).
//
// Execution paths:
// - route code_change / api_code_change → workflow-scoped feature-executor
//   sessions. In Team Mode each node owns a stable independent key
//   (`workflow:<wf>:project:<pid>:feature-executor:node:<node_id>`), reused
//   across retry/FIX/REWORK. Outside Team Mode the legacy project key
//   (`workflow:<wf>:project:<pid>:feature-executor`) remains unchanged. Model strictly from
//   resolveTaskRoleModel — null ⇒ task BLOCKED / MODEL_UNASSIGNED, never
//   guessed). Task RUNNING transition + sendScopedSession happen inside
//   bus.withTaskLock(task_id); results are persisted with the shared
//   bus.buildResult/persistResult/persistBlocked so tasks.db semantics are
//   identical to the Task Bus.
// - route code_read → in Team Mode a scoped project-reader worker with a
//   stable node key; outside Team Mode it stays on bus.dispatchTask and the
//   persistent project-reader session. Model strictly from the existing
//   project-reader configuration; null ⇒ BLOCKED / MODEL_UNASSIGNED.
// - every other route → bus.dispatchTask (existing persistent/ephemeral
//   paths reused verbatim; reviewer rounds are naturally fresh sessions).
//
// Safe retry (§60-§62): only execution-class error codes
// (WAIT_TIMEOUT / SESSION_CREATE_FAILED / SESSION_INIT_FAILED /
// EXECUTION_FAILED / NO_ASSISTANT_RESULT / NO_ASSISTANT_TEXT — including
// hook-forced ones) on retry.safe_routes with retry.enabled and per-attempt
// retries used < retry.max_retries. BLOCKED-class codes (MODEL_UNASSIGNED /
// DEPENDENCY_NOT_READY / ROUTE_PRECONDITION_UNSATISFIED) are NEVER retried;
// never_retry_routes are NEVER retried. A retry creates a NEW task (same
// envelope, parent = failed task), node stays at the same attempt, status
// READY, history appended.
//
// Test hooks (§84/§85): before any dispatch, a forceFailure quota for
// (workflow, node) short-circuits the node to FAILED with the forced code —
// zero model consumption.
//
// Plan 8 T7 (lifecycle preflight): before each scoped worker send,
// executeScopedWorkerNode runs the injected deps.lifecyclePreflight (built
// in index.ts on the createLifecycleCore facade) OUTSIDE the task/session
// locks. It refreshes verified telemetry, evaluates the lifecycle.yaml bands
// and rotates ONLY when the evaluated lifecycle_state is ROTATE_PENDING /
// HARD_ROTATE AND framework.yaml workflow_engine.automatic_lifecycle_rotation
// is strictly true (it currently stays false). A committed rotation keeps the
// SAME session_key and the SAME task ids — the send below simply resolves the
// successor generation, so this scheduler, the reviewer loop and rework
// replays stay generation-transparent (no code here ever branches on a
// generation value). Preflight blocks mandatory rotation failures and keeps
// the existing response shapes unchanged in the common case; bus.dispatchTask
// routes (including every reviewer round) get NO lifecycle logic. When
// deps.lifecyclePreflight is absent, behavior is IDENTICAL to Plan 7.

export const NODE_DONE_STATUSES = ["COMPLETED", "REVIEW_PASSED"]
export const WORKFLOW_TERMINAL_STATUSES = ["COMPLETED", "FAILED", "REWORK_LIMIT"]
export const WORKFLOW_RESUMABLE_STATUSES = ["READY", "RUNNING", "BLOCKED", "REVIEWING", "REWORKING"]

// §61: execution-class (retryable in principle) error codes
export const EXECUTION_ERROR_CODES = [
  "WAIT_TIMEOUT",
  "SESSION_CREATE_FAILED",
  "SESSION_INIT_FAILED",
  "EXECUTION_FAILED",
  "NO_ASSISTANT_RESULT",
  "NO_ASSISTANT_TEXT",
]

// §60: BLOCKED-class codes — never retried, the blocking cause must be fixed
export const BLOCKED_CLASS_ERROR_CODES = ["MODEL_UNASSIGNED", "DEPENDENCY_NOT_READY", "ROUTE_PRECONDITION_UNSATISFIED"]

// §43 route-family grouping for `global:<route-family>` lock keys. The
// family GROUPING is structural (defined by Plan 7 §43); which routes are
// global-serial at all comes from workflow.yaml parallel_policy.
export const GLOBAL_ROUTE_FAMILIES: Record<string, string> = {
  database_write: "database",
  database_ddl: "database",
  database_backup: "database",
  long_term_memory_write: "memory",
}

// Routes executed in workflow-scoped worker sessions (§48 plus Team Mode read)
export const SCOPED_FEATURE_ROUTES = ["code_change", "api_code_change"]
export const SCOPED_TEAM_READ_ROUTES = ["code_read"]

/** Pure stable worker-key policy used by Team Mode and its retry/rework paths. */
export function featureExecutorSessionKey(
  workflowId: string,
  projectId: string,
  nodeId: string,
  teamMode = false,
): string {
  const base = `workflow:${workflowId}:project:${projectId}:feature-executor`
  return teamMode ? `${base}:node:${nodeId}` : base
}

export function projectReaderWorkerSessionKey(workflowId: string, projectId: string, nodeId: string): string {
  return `workflow:${workflowId}:project:${projectId}:project-reader:node:${nodeId}`
}

export function workerSessionKeyForRoute(
  workflowId: string,
  projectId: string,
  nodeId: string,
  route: string,
  teamMode = false,
): string | null {
  if (SCOPED_FEATURE_ROUTES.includes(route)) return featureExecutorSessionKey(workflowId, projectId, nodeId, teamMode)
  if (teamMode && SCOPED_TEAM_READ_ROUTES.includes(route)) return projectReaderWorkerSessionKey(workflowId, projectId, nodeId)
  return null
}

export function workerRoleForRoute(route: string, teamMode = false): "feature-executor" | "project-reader" | null {
  if (SCOPED_FEATURE_ROUTES.includes(route)) return "feature-executor"
  // code_read always resolves to the existing project-reader role; only the
  // Team Mode execution scope changes from persistent to a worker key.
  if (SCOPED_TEAM_READ_ROUTES.includes(route)) return "project-reader"
  return null
}

/** Return exact registry keys for all scoped workers belonging to a workflow. */
export function collectWorkflowWorkerSessionKeys(
  workflowId: string,
  planNodes: any[],
  teamMode: boolean,
  registryRows: any[] = [],
): string[] {
  const keys = new Set<string>()
  for (const node of Array.isArray(planNodes) ? planNodes : []) {
    const projectId = typeof node?.project_id === "string" ? node.project_id : ""
    const nodeId = typeof node?.node_id === "string" ? node.node_id : ""
    const route = typeof node?.route === "string" ? node.route : ""
    const key = projectId && nodeId ? workerSessionKeyForRoute(workflowId, projectId, nodeId, route, teamMode) : null
    if (key) keys.add(key)
  }
  const prefix = `workflow:${workflowId}:project:`
  for (const row of Array.isArray(registryRows) ? registryRows : []) {
    const key = typeof row?.session_key === "string" ? row.session_key : ""
    if (key.startsWith(prefix) && (row?.role === "feature-executor" || row?.role === "project-reader")) keys.add(key)
  }
  return [...keys].sort()
}

const MAX_LOOP_ITERATIONS = 1000 // defensive guard; retry/rework budgets are the real bounds

function nowIso(): string {
  return new Date().toISOString()
}

function errMsg(e: any): string {
  return e?.message ?? String(e)
}

function safeParse(json: any): any {
  if (typeof json !== "string" || !json) return null
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

function failure(code: string, detail: string, extra?: Record<string, unknown>) {
  return { ok: false, status: "ERROR", code, detail, ...(extra ?? {}) }
}

// =====================================================================
// Pure policy normalization (workflow.yaml → typed shape). Missing or
// malformed values degrade CONSERVATIVELY (serial, no retry, no rework).
// =====================================================================
export function normalizeStringList(v: any): string[] {
  return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x) : []
}

export interface NormalizedPolicy {
  maxParallel: number
  lanePolicies: any
  safeRoutes: string[]
  projectSerialRoutes: string[]
  globalSerialRoutes: string[]
  retry: {
    enabled: boolean
    maxRetries: number
    safeRoutes: string[]
    neverRetryRoutes: string[]
  }
  maxReworkCycles: number
  teamExecution: ReturnType<typeof normalizeTeamExecutionPolicy>
}

export function normalizePolicy(wfCfg: any): NormalizedPolicy {
  const rawMax = wfCfg?.scheduler?.max_parallel
  const pp = wfCfg?.parallel_policy ?? {}
  const rt = wfCfg?.retry ?? {}
  const rawRework = wfCfg?.review?.max_rework_cycles
  const rawRetries = rt?.max_retries
  return {
    maxParallel: Number.isInteger(rawMax) && (rawMax as number) >= 1 ? (rawMax as number) : 1,
    lanePolicies: normalizeLanePolicies(wfCfg),
    safeRoutes: normalizeStringList(pp?.safe_routes),
    projectSerialRoutes: normalizeStringList(pp?.project_serial_routes),
    globalSerialRoutes: normalizeStringList(pp?.global_serial_routes),
    retry: {
      enabled: rt?.enabled === true,
      maxRetries: Number.isInteger(rawRetries) && (rawRetries as number) >= 0 ? (rawRetries as number) : 0,
      safeRoutes: normalizeStringList(rt?.safe_routes),
      neverRetryRoutes: normalizeStringList(rt?.never_retry_routes),
    },
    maxReworkCycles: Number.isInteger(rawRework) && (rawRework as number) >= 0 ? (rawRework as number) : 0,
    teamExecution: normalizeTeamExecutionPolicy(wfCfg?.team_execution),
  }
}

// =====================================================================
// Pure route classification (§41-§44). Unknown routes are treated as
// project_serial (conservative default).
// =====================================================================
export function classifyNodeLock(
  route: string,
  projectId: string,
  policy: NormalizedPolicy,
): { routeClass: "safe" | "project_serial" | "global_serial"; lockKey: string | null } {
  if (policy.safeRoutes.includes(route)) return { routeClass: "safe", lockKey: null }
  if (policy.globalSerialRoutes.includes(route)) {
    const family = GLOBAL_ROUTE_FAMILIES[route] ?? route // unknown global route → its own family (serial)
    return { routeClass: "global_serial", lockKey: `global:${family}` }
  }
  // explicit project_serial_routes AND everything unknown → project serial
  return { routeClass: "project_serial", lockKey: `project:${projectId}:write` }
}

export interface WaveItem {
  node_id: string
  route: string
  project_id: string
  route_class: "safe" | "project_serial" | "global_serial"
  lock_key: string | null
  lane: string
  resources: any
}

// =====================================================================
// Pure wave planning (§40): deterministic chunking of the ready list
// (topological/rowid order) into waves of at most maxParallel items.
// Serial-route items inside a wave are launched together but serialize on
// their lock key at execution time; the concurrency CAP always applies.
// =====================================================================
export function planWaves(
  items: Array<{ node_id: string; route: string; project_id: string; resources?: any }>,
  policy: NormalizedPolicy,
): WaveItem[][] {
  const classified: WaveItem[] = (Array.isArray(items) ? items : []).map((it) => {
    const c = classifyNodeLock(String(it?.route ?? ""), String(it?.project_id ?? ""), policy)
    const contract = resolveResourceContract({ route: String(it?.route ?? ""), project_id: String(it?.project_id ?? ""), resources: it?.resources })
    // Explicit file/module ownership is the coordinator's opt-in to parallel
    // code execution. Missing ownership remains conservatively project-wide.
    const explicitWrite = Array.isArray(it?.resources?.write) && it.resources.write.length > 0
    const ownedCodeChange = SCOPED_FEATURE_ROUTES.includes(String(it?.route ?? "")) && explicitWrite
    if (ownedCodeChange) { c.routeClass = "safe"; c.lockKey = null }
    if (c.lockKey && !contract.exclusive.includes(c.lockKey)) contract.exclusive.push(c.lockKey)
    return {
      node_id: String(it?.node_id ?? ""),
      route: String(it?.route ?? ""),
      project_id: String(it?.project_id ?? ""),
      route_class: c.routeClass,
      lock_key: c.lockKey,
      lane: contract.lane,
      resources: contract,
    }
  })
  return dispatchTeamWaves(
    classified.map((x) => ({ ...x, resources: x.resources, lane: x.lane })),
    policy?.lanePolicies ?? {},
    policy?.teamExecution,
  ) as any
}

// =====================================================================
// Pure retry decision (§60-§62). ALL conditions must hold:
// retry.enabled, execution-class code, route in retry.safe_routes, route
// NOT in never_retry_routes (defense in depth), retriesUsed < max_retries.
// =====================================================================
export function shouldRetry(args: {
  code: string | null | undefined
  route: string
  retryPolicy: NormalizedPolicy["retry"]
  retriesUsed: number
}): boolean {
  const rp = args?.retryPolicy
  if (!rp || rp.enabled !== true) return false
  const code = typeof args.code === "string" ? args.code : ""
  if (!EXECUTION_ERROR_CODES.includes(code)) return false // §60/§61: BLOCKED-class & unknown codes never retry
  if (rp.neverRetryRoutes.includes(args.route)) return false // §62: never-retry list wins over everything
  if (!rp.safeRoutes.includes(args.route)) return false // §61: safe routes only
  const max = Number.isInteger(rp.maxRetries) && rp.maxRetries >= 0 ? rp.maxRetries : 0
  const used = Number.isInteger(args.retriesUsed) && args.retriesUsed >= 0 ? args.retriesUsed : 0
  return used < max
}

// Retries already used for the node's CURRENT attempt, derived from the
// persisted task_history (entries sharing the attempt; the first is the
// original task). Persistent across workflow_run resumptions.
export function countAttemptRetries(history: any, attempt: number): number {
  if (!Array.isArray(history)) return 0
  const n = history.filter((e: any) => e && typeof e === "object" && e.attempt === attempt).length
  return Math.max(0, n - 1)
}

// =====================================================================
// Plan 8 T7: lifecycle preflight report helpers (pure). The preflight
// itself lives in index.ts (createLifecycleCore facade + framework.yaml
// flag); these shape its report for outcomes/responses. "Notable" =
// rotated, rotation due (enabled or not) or skipped/failed — routine
// CONTINUE_REUSE / UNKNOWN measurements stay in the lifecycle_events
// ledger only, so existing response shapes are unchanged in the common
// case (no lifecycle field at all).
// =====================================================================
export function isNotableLifecycleReport(rep: any): boolean {
  if (!rep || typeof rep !== "object") return false
  return rep.rotated === true || rep.rotation_due === true || typeof rep.skipped === "string"
}

export function compactLifecycleReport(rep: any): any | null {
  if (!rep || typeof rep !== "object") return null
  const out: any = {}
  if (typeof rep.stage === "string" && rep.stage) out.stage = rep.stage
  if (typeof rep.band === "string") out.band = rep.band
  if (rep.context_pct != null) out.context_pct = rep.context_pct
  if (typeof rep.lifecycle_state === "string") out.lifecycle_state = rep.lifecycle_state
  if (typeof rep.recommended_action === "string") out.recommended_action = rep.recommended_action
  if (rep.rotation_due === true) out.rotation_due = true
  if (rep.rotation_enabled === true) out.rotation_enabled = true
  if (rep.rotated === true) out.rotated = true
  if (rep.rotation && typeof rep.rotation === "object") out.rotation = rep.rotation
  if (typeof rep.skipped === "string") out.skipped = rep.skipped
  if (typeof rep.detail === "string" && rep.detail) out.detail = rep.detail
  return out
}

export function notableLifecycleReports(list: any[]): any[] {
  if (!Array.isArray(list)) return []
  const out: any[] = []
  for (const rep of list) {
    if (!isNotableLifecycleReport(rep)) continue
    const c = compactLifecycleReport(rep)
    if (c) out.push(c)
  }
  return out
}

// =====================================================================
// Pure readiness (§39): node.status READY and every depends_on node in a
// done state (COMPLETED / REVIEW_PASSED).
// =====================================================================
export function findReadyNodes(nodeRows: any[], depsOf: Map<string, string[]>): any[] {
  const byId = new Map<string, any>()
  for (const r of nodeRows) byId.set(r.node_id, r)
  return nodeRows.filter((r) => {
    if (r.status !== "READY") return false
    for (const d of depsOf.get(r.node_id) ?? []) {
      const dep = byId.get(d)
      if (!dep || !NODE_DONE_STATUSES.includes(dep.status)) return false
    }
    return true
  })
}

function rowToWorkflow(row: any) {
  return {
    workflow_id: row.workflow_id,
    primary_project_id: row.primary_project_id,
    objective: row.objective,
    status: row.status,
    planner_task_id: row.planner_task_id,
    planner_session_id: row.planner_session_id,
    plan: safeParse(row.plan_json),
    rework_cycle: row.rework_cycle,
    created_at: row.created_at,
    updated_at: row.updated_at,
    finished_at: row.finished_at,
    completion_guard_finalized_at: row.completion_guard_finalized_at,
  }
}

// =====================================================================
// Scheduler factory. deps: shared cores, marker-gated hooks (null in
// production), the reviewer loop (./review.ts) and the workflow.yaml
// loader from index.ts. Plan 8 T7 adds the OPTIONAL lifecyclePreflight
// callback (built in index.ts on the createLifecycleCore facade); when
// absent, scheduling behavior is IDENTICAL to Plan 7.
// =====================================================================
export interface SchedulerDeps {
  core: any
  bus: any
  hooks: any | null
  reviewer: any
  loadWorkflowConfig: () => any
  // Plan 8 T7: (session_key, info?) -> preflight report; NEVER throws,
  // checkpoint failures are non-blocking; mandatory rotation failures block
  // the send. Called before scoped
  // scoped worker sends only — never for bus.dispatchTask routes and
  // never for reviewer ephemeral sessions.
  lifecyclePreflight?: ((sessionKey: string, info?: any) => Promise<any>) | null
}

export function createScheduler(deps: SchedulerDeps) {
  const { core, bus, hooks, reviewer, loadWorkflowConfig } = deps
  const lifecyclePreflight = typeof deps?.lifecyclePreflight === "function" ? deps.lifecyclePreflight : null
  const db = core?.db
  const q = db
    ? {
        wfGet: db.query("SELECT * FROM workflows WHERE workflow_id = ?"),
        wfSetStatus: db.query("UPDATE workflows SET status = ?, updated_at = ? WHERE workflow_id = ?"),
        wfFinish: db.query("UPDATE workflows SET status = ?, updated_at = ?, finished_at = ? WHERE workflow_id = ?"),
        nodesGet: db.query("SELECT * FROM workflow_nodes WHERE workflow_id = ? ORDER BY rowid"),
        nodeGet: db.query("SELECT * FROM workflow_nodes WHERE workflow_id = ? AND node_id = ?"),
        nodeSetStatus: db.query("UPDATE workflow_nodes SET status = ?, updated_at = ? WHERE workflow_id = ? AND node_id = ?"),
        nodeSetTask: db.query(
          "UPDATE workflow_nodes SET current_task_id = ?, status = ?, task_history_json = ?, updated_at = ? " +
            "WHERE workflow_id = ? AND node_id = ?",
        ),
        taskGet: db.query("SELECT * FROM tasks WHERE task_id = ?"),
        // Latest registry generation for every scoped worker under this
        // workflow. The scheduler still archives by each exact key; this
        // query prevents a project-only key assumption from losing workers.
        scopedWorkerSessions: db.query(
          "SELECT s.session_key, s.project_id, s.role, s.generation, s.status " +
            "FROM sessions s JOIN (SELECT session_key, MAX(generation) AS generation FROM sessions GROUP BY session_key) latest " +
            "ON latest.session_key = s.session_key AND latest.generation = s.generation " +
            "WHERE s.role IN ('feature-executor', 'project-reader') AND s.session_key LIKE ? ORDER BY s.session_key",
        ),
        // READY/BLOCKED → RUNNING is the legal §29 transition; guarded in SQL
        taskSetRunning: db.query("UPDATE tasks SET status = 'RUNNING', updated_at = ? WHERE task_id = ? AND status IN ('READY', 'BLOCKED')"),
      }
    : null

  // active-run registry for the fail-fast WORKFLOW_ALREADY_RUNNING answer
  const runningWorkflows = new Set<string>()

  function guard() {
    if (!db || !q) return failure("SQLITE_RUNTIME_UNAVAILABLE", core?.dbError ?? "workflow database unavailable")
    if (!core?.configReady) return failure("CONFIG_ROOT_NOT_FOUND", `framework-config not found from root '${core?.root}'`)
    return null
  }

  // -------------------------------------------------------------------
  // Node execution (one node, inside its wave + lock). Never throws.
  // -------------------------------------------------------------------
  async function executeNode(wfId: string, nodeRow: any, planNode: any, base: any, teamMode: boolean): Promise<any> {
    const taskId = nodeRow.current_task_id
    const startedAt = nowIso()
    try {
      const taskRow: any = q!.taskGet.get(taskId)
      if (!taskRow) {
        return { ...base, task_id: taskId, started_at: startedAt, ended_at: nowIso(), kind: "failed", code: "TASK_NOT_FOUND", detail: `node task '${taskId}' does not exist in runtime/tasks.db` }
      }
      const envelope = safeParse(taskRow.input_json)
      const route = typeof envelope?.route === "string" && envelope.route ? envelope.route : String(planNode?.route ?? "")
      q!.nodeSetStatus.run("RUNNING", nowIso(), wfId, nodeRow.node_id)

      // §84/§85 test hook: forced failure quota → persist FAILED directly
      const forced: string | null = hooks ? hooks.consumeFailure(wfId, nodeRow.node_id) : null
      if (forced) {
        const finishedAt = nowIso()
        const result = bus.buildResult({
          taskId,
          projectId: String(taskRow.project_id ?? planNode?.project_id ?? ""),
          route,
          targetRole: taskRow.target_role ?? null,
          status: "FAILED",
          sessionId: null,
          sessionGeneration: null,
          outputText: "",
          error: `${forced}: forced by test hook`,
          startedAt,
          finishedAt,
        })
        bus.persistResult(taskId, "FAILED", null, result)
        return {
          ...base, task_id: taskId, started_at: startedAt, ended_at: finishedAt,
          kind: "failed", code: forced, detail: "forced by test hook (workflow_test_hook force_failure)", forced_by_hook: true,
        }
      }

      // §46/§48: code_change / api_code_change → workflow-scoped feature-executor worker
      if (SCOPED_FEATURE_ROUTES.includes(route)) {
        return await executeScopedWorkerNode(wfId, nodeRow, taskRow, envelope, route, base, startedAt, teamMode, "feature-executor")
      }

      // Team Mode gives code_read its own scoped worker. Simple task_execute
      // and non-Team workflow behavior intentionally remain on the Task Bus'
      // persistent project-reader path below.
      if (teamMode && SCOPED_TEAM_READ_ROUTES.includes(route)) {
        return await executeScopedWorkerNode(wfId, nodeRow, taskRow, envelope, route, base, startedAt, true, "project-reader")
      }

      // all other routes → existing Task Bus dispatch (persistent/ephemeral)
      const dispatched: any = await bus.dispatchTask(taskId)
      return mapDispatchOutcome(base, taskId, startedAt, dispatched)
    } catch (e: any) {
      const endedAt = nowIso()
      // best-effort: leave a truthful FAILED result when the task is still open
      try {
        const taskRow: any = q!.taskGet.get(taskId)
        if (taskRow && taskRow.status !== "COMPLETED" && taskRow.status !== "FAILED" && taskRow.status !== "BLOCKED") {
          const envelope = safeParse(taskRow.input_json)
          const result = bus.buildResult({
            taskId,
            projectId: String(taskRow.project_id ?? ""),
            route: String(envelope?.route ?? ""),
            targetRole: taskRow.target_role ?? null,
            status: "FAILED",
            sessionId: null,
            sessionGeneration: null,
            outputText: "",
            error: `EXECUTION_FAILED: scheduler exception: ${errMsg(e)}`,
            startedAt,
            finishedAt: endedAt,
          })
          bus.persistResult(taskId, "FAILED", taskRow.target_session_key ?? null, result)
        }
      } catch {}
      return { ...base, task_id: taskId, started_at: startedAt, ended_at: endedAt, kind: "failed", code: "EXECUTION_FAILED", detail: `scheduler exception: ${errMsg(e)}` }
    }
  }

  async function executeScopedWorkerNode(
    wfId: string,
    nodeRow: any,
    taskRow: any,
    envelope: any,
    route: string,
    base: any,
    startedAt: string,
    teamMode: boolean,
    workerRole: "feature-executor" | "project-reader",
  ): Promise<any> {
    const taskId = nodeRow.current_task_id
    const pid = String(envelope?.project_id ?? taskRow.project_id ?? "")
    let cfg: any
    try {
      cfg = bus.loadBusConfig()
    } catch (e: any) {
      return { ...base, task_id: taskId, started_at: startedAt, ended_at: nowIso(), kind: "infra", code: "CONFIG_LOAD_FAILED", detail: errMsg(e) }
    }

    // §47: explicit model from the existing role configuration only — null
    // ⇒ BLOCKED, never guess. project-reader resolves from agents[id] while
    // feature-executor resolves from project_sessions.<project>, exactly as
    // the Task Bus/runtime registry do.
    const runtimeId: string | null = bus.resolveTaskRoleModel(cfg, pid, workerRole)
    if (!runtimeId) {
      bus.persistBlocked(
        taskRow,
        envelope,
        workerRole,
        "MODEL_UNASSIGNED",
        `${bus.taskRoleModelSource(pid, workerRole)} is null/missing for role '${workerRole}' of project '${pid}'; ` +
          "refusing to create a scoped session, inherit, guess or default a model (§47)",
      )
      return { ...base, task_id: taskId, started_at: startedAt, ended_at: nowIso(), kind: "blocked", code: "MODEL_UNASSIGNED", detail: `${workerRole} model unassigned` }
    }

    const sessionKey = workerRole === "feature-executor"
      ? featureExecutorSessionKey(wfId, pid, nodeRow.node_id, teamMode)
      : projectReaderWorkerSessionKey(wfId, pid, nodeRow.node_id)
    const project = core.findProject(cfg, pid)
    const ensured: any = await core.ensureScopedSession({
      session_key: sessionKey,
      project_id: pid,
      role: workerRole,
      runtime_id: runtimeId,
      scope_context: [
        `PROJECT_ID: ${pid}`,
        `PROJECT_PATH: ${typeof project?.path === "string" ? project.path : ""}`,
        `WORKFLOW_ID: ${wfId}`,
        `TASK_ID: ${taskId}`,
        `TARGET_ROLE: ${workerRole}`,
        `WORKFLOW_WORKER_NODE_ID: ${nodeRow.node_id}`,
        "",
        "Rules:",
        `- workflow-scoped ${workerRole} worker created by the workflow-engine plugin`,
        `- session location stays at the framework root (${core.root}); project scope comes from this context`,
        `- obey ${core.root}\\AGENTS.md`,
        "- no git pull",
        "- no git push",
        ...(workerRole === "project-reader"
          ? ["- read-only: no source changes, no DB writes/DDL, no Mem0 writes; stay within this project"]
          : []),
        "- this worker is reused across retry/FIX/REWORK for this node and ARCHIVED (not deleted) after workflow execution (§49)",
        "",
        "(Synthetic scope context written by the workflow-engine plugin, Plan 7.)",
      ].join("\n"),
      title: `[workflow] ${workerRole} ${wfId.slice(0, 8)} ${pid} ${nodeRow.node_id}`,
    })
    if (!ensured?.ok) {
      const code = String(ensured?.code ?? ensured?.status ?? "SESSION_ENSURE_FAILED")
      const detail = String(ensured?.detail ?? "scoped session ensure failed")
      if (code === "MODEL_UNASSIGNED" || code === "RUNTIME_ID_UNPARSEABLE") {
        bus.persistBlocked(taskRow, envelope, workerRole, code, detail)
        return { ...base, task_id: taskId, started_at: startedAt, ended_at: nowIso(), kind: "blocked", code, detail }
      }
      persistTaskFailed(taskRow, envelope, route, code, detail, startedAt, nowIso(), sessionKey, ensured)
      return { ...base, task_id: taskId, started_at: startedAt, ended_at: nowIso(), kind: "failed", code, detail }
    }

    // --- Plan 8 T7: lifecycle preflight for the scoped worker
    // send. Runs AFTER ensureScopedSession (the sessions row must exist)
    // and BEFORE the task lock + send — never inside the session_key lock
    // (the public lifecycle wrappers acquire it themselves; the lock is
    // NON-REENTRANT). Generation-transparent: a COMMITTED rotation keeps
    // the SAME session_key and the SAME task id — sendScopedSession below
    // simply resolves the new latest ACTIVE generation. Rotation failures are
    // fail-closed; checkpoint preparation failures are non-blocking. ---
    let lifecycleField: any = {}
    if (lifecyclePreflight) {
      let rep: any = null
      try {
        rep = await lifecyclePreflight(sessionKey, {
          stage: workerRole,
          workflow_id: wfId,
          node_id: nodeRow.node_id,
          task_id: taskId,
          project_id: pid,
          worker_role: workerRole,
          team_mode: teamMode,
          reused: ensured.reused === true,
        })
      } catch (e: any) {
        // contract says never throws — belt and braces for injected callbacks
        rep = { ok: false, code: "PREFLIGHT_EXCEPTION", session_key: sessionKey, stage: workerRole, skipped: "PREFLIGHT_EXCEPTION", detail: errMsg(e) }
      }
      if (isNotableLifecycleReport(rep)) lifecycleField = { lifecycle: compactLifecycleReport(rep) }
      if (rep?.ok === false) {
        const code = String(rep.code ?? "LIFECYCLE_ROTATION_FAILED")
        const detail = String(rep.detail ?? "lifecycle admission blocked this scoped task")
        persistScopedBlocked(taskRow, envelope, workerRole, code, detail, sessionKey, ensured)
        return {
          ...base,
          task_id: taskId,
          started_at: startedAt,
          ended_at: nowIso(),
          kind: "blocked",
          code,
          detail,
          session_key: sessionKey,
          ...lifecycleField,
        }
      }
    }

    // task RUNNING + send inside the per-task lock (same serialization as
    // bus.dispatchTask; READY/BLOCKED → RUNNING is the legal transition)
    const sent: any = await bus.withTaskLock(taskId, async () => {
      q!.taskSetRunning.run(nowIso(), taskId)
      return await core.sendScopedSession({ session_key: sessionKey, text: bus.buildPrompt(envelope) })
    })
    const endedAt = nowIso()
    if (sent?.ok) {
      const result = bus.buildResult({
        taskId,
        projectId: pid,
        route,
        targetRole: workerRole,
        status: "COMPLETED",
        sessionId: sent.session_id ?? null,
        sessionGeneration: typeof sent.generation === "number" ? sent.generation : null,
        outputText: String(sent.output_text ?? ""),
        error: null,
        startedAt,
        finishedAt: endedAt,
      })
      bus.persistResult(taskId, "COMPLETED", sessionKey, result)
      return { ...base, task_id: taskId, started_at: startedAt, ended_at: endedAt, kind: "completed", session_id: sent.session_id ?? null, session_key: sessionKey, ...lifecycleField }
    }
    const code = String(sent?.code ?? sent?.status ?? "SEND_FAILED")
    const detail = String(sent?.detail ?? "scoped session send failed")
    if (code === "MODEL_UNASSIGNED") {
      persistScopedBlocked(taskRow, envelope, workerRole, code, detail, sessionKey, sent)
      return { ...base, task_id: taskId, started_at: startedAt, ended_at: endedAt, kind: "blocked", code, detail, ...lifecycleField }
    }
    persistTaskFailed(taskRow, envelope, route, code, detail, startedAt, endedAt, sessionKey, sent)
    return { ...base, task_id: taskId, started_at: startedAt, ended_at: endedAt, kind: "failed", code, detail, session_id: sent?.session_id ?? null, ...lifecycleField }
  }

  function persistScopedBlocked(
    taskRow: any,
    envelope: any,
    targetRole: string,
    code: string,
    detail: string,
    sessionKey: string,
    session: any,
  ) {
    const ts = nowIso()
    const result = bus.buildResult({
      taskId: taskRow.task_id,
      projectId: String(taskRow.project_id ?? envelope?.project_id ?? ""),
      route: String(envelope?.route ?? ""),
      targetRole,
      status: "BLOCKED",
      sessionId: session?.session_id ?? null,
      sessionGeneration: typeof session?.generation === "number" ? session.generation : null,
      outputText: "",
      error: `${code}: ${detail}`,
      startedAt: ts,
      finishedAt: ts,
    })
    bus.persistResult(taskRow.task_id, "BLOCKED", sessionKey, result)
  }

  function persistTaskFailed(
    taskRow: any,
    envelope: any,
    route: string,
    code: string,
    detail: string,
    startedAt: string,
    finishedAt: string,
    sessionKey: string | null = null,
    session: any = null,
  ) {
    const result = bus.buildResult({
      taskId: taskRow.task_id,
      projectId: String(taskRow.project_id ?? envelope?.project_id ?? ""),
      route: String(envelope?.route ?? route ?? ""),
      targetRole: taskRow.target_role ?? null,
      status: "FAILED",
      sessionId: session?.session_id ?? null,
      sessionGeneration: typeof session?.generation === "number" ? session.generation : null,
      outputText: "",
      error: `${code}: ${detail}`,
      startedAt,
      finishedAt,
    })
    bus.persistResult(taskRow.task_id, "FAILED", sessionKey ?? taskRow.target_session_key ?? null, result)
  }

  // Map a bus.dispatchTask response onto the node-outcome kinds.
  function mapDispatchOutcome(base: any, taskId: string, startedAt: string, dispatched: any): any {
    const endedAt = nowIso()
    const status = dispatched?.status
    const code = dispatched?.code ?? null
    const detail = dispatched?.detail ?? null
    if (status === "COMPLETED" || code === "TASK_ALREADY_COMPLETED") {
      return { ...base, task_id: taskId, started_at: startedAt, ended_at: endedAt, kind: "completed", session_id: dispatched?.result?.session_id ?? null }
    }
    if (status === "FAILED" || code === "TASK_ALREADY_FAILED" || code === "TASK_CANCELLED" || code === "TASK_ENVELOPE_INVALID") {
      const errorCode = code && code !== "TASK_ALREADY_FAILED" ? code : extractResultErrorCode(dispatched?.result) ?? code ?? "EXECUTION_FAILED"
      return { ...base, task_id: taskId, started_at: startedAt, ended_at: endedAt, kind: "failed", code: errorCode, detail: detail ?? dispatched?.result?.error ?? null }
    }
    if (status === "BLOCKED") {
      return { ...base, task_id: taskId, started_at: startedAt, ended_at: endedAt, kind: "blocked", code: code ?? "BLOCKED", detail }
    }
    if (code === "TASK_ALREADY_RUNNING") {
      return { ...base, task_id: taskId, started_at: startedAt, ended_at: endedAt, kind: "stale_running", code, detail }
    }
    // guard/infra errors (CONFIG_LOAD_FAILED, SQLITE_RUNTIME_UNAVAILABLE, ...)
    return { ...base, task_id: taskId, started_at: startedAt, ended_at: endedAt, kind: "infra", code: code ?? "DISPATCH_INFRA_FAILED", detail }
  }

  function extractResultErrorCode(result: any): string | null {
    const err = typeof result?.error === "string" ? result.error : ""
    const m = err.match(/^([A-Z][A-Z0-9_]+):/)
    return m ? m[1] : null
  }

  // Apply one node outcome to workflow_nodes (sequential, deterministic).
  // Returns { stop?, stopCode?, stopDetail? } for run-loop-level halts.
  function applyNodeOutcome(wfId: string, plan: any, nodeRow: any, planNode: any, outcome: any, policy: NormalizedPolicy, runState: any): any {
    const nodeId = nodeRow.node_id
    if (outcome.kind === "completed") {
      const isGate = planNode?.review?.required === true
      q!.nodeSetStatus.run(isGate ? "REVIEWING" : "COMPLETED", nowIso(), wfId, nodeId)
      return null
    }
    if (outcome.kind === "blocked") {
      q!.nodeSetStatus.run("BLOCKED", nowIso(), wfId, nodeId)
      runState.notes.push(`node '${nodeId}' BLOCKED: ${outcome.code ?? ""} ${outcome.detail ?? ""}`.trim())
      return null
    }
    if (outcome.kind === "stale_running") {
      runState.notes.push(`node '${nodeId}' task '${outcome.task_id}' is RUNNING from a previous dispatch; not re-executed`)
      return { stop: true, stopCode: "STALE_RUNNING_NODE", stopDetail: `node '${nodeId}' task '${outcome.task_id}' is still RUNNING (stale dispatch); resolve it then call workflow_run again` }
    }
    if (outcome.kind === "infra") {
      // node back to READY (nothing executed); workflow parks in BLOCKED — resumable
      q!.nodeSetStatus.run("READY", nowIso(), wfId, nodeId)
      return { stop: true, stopCode: outcome.code ?? "INFRA_FAILURE", stopDetail: outcome.detail ?? "infrastructure failure; node left READY, workflow BLOCKED (resumable)" }
    }
    // kind === "failed" → §60-§62 safe retry decision
    const history: any[] = Array.isArray(safeParse(nodeRow.task_history_json)) ? safeParse(nodeRow.task_history_json) : []
    const retriesUsed = countAttemptRetries(history, nodeRow.attempt)
    const route = String(planNode?.route ?? "")
    if (shouldRetry({ code: outcome.code, route, retryPolicy: policy.retry, retriesUsed })) {
      const oldRow: any = q!.taskGet.get(outcome.task_id)
      const oldEnv = safeParse(oldRow?.input_json)
      if (oldEnv) {
        const created: any = bus.createTask({
          project_id: oldEnv.project_id,
          route: oldEnv.route,
          objective: oldEnv.objective,
          parent_task_id: outcome.task_id, // §61: retry = NEW task, parent = failed task
          constraints: oldEnv.constraints ?? [],
          dependencies: oldEnv.dependencies ?? [],
          expected_output: oldEnv.expected_output ?? [],
          acceptance_criteria: oldEnv.acceptance_criteria ?? [],
          context_refs: oldEnv.context_refs ?? [],
          metadata: { ...(oldEnv.metadata ?? {}), retry_of_task_id: outcome.task_id },
        })
        if (created?.ok) {
          const ts = nowIso()
          const newId: string = created.envelope.task_id
          history.push({ task_id: newId, attempt: nodeRow.attempt, created_at: ts, retry: true, retry_of: outcome.task_id })
          // attempt unchanged (§ retry semantics): same attempt, new task
          q!.nodeSetTask.run(newId, "READY", JSON.stringify(history), ts, wfId, nodeId)
          runState.retries.push({ node_id: nodeId, retried_task_id: outcome.task_id, new_task_id: newId, code: outcome.code, attempt: nodeRow.attempt })
          return null
        }
        runState.notes.push(`retry task creation failed for node '${nodeId}': ${created?.code ?? ""} ${created?.detail ?? ""}`.trim())
      } else {
        runState.notes.push(`retry skipped for node '${nodeId}': failed task envelope is unreadable`)
      }
    }
    q!.nodeSetStatus.run("FAILED", nowIso(), wfId, nodeId)
    return null
  }

  // -------------------------------------------------------------------
  // Resume reconciliation: BLOCKED/RUNNING nodes are re-derived from their
  // task rows so a fixed-and-redispatched task lets workflow_run resume
  // ("再次 workflow_run 可重查恢复").
  // -------------------------------------------------------------------
  function reconcileResumableNodes(wfId: string, plan: any, nodeRows: any[]): string[] {
    const notes: string[] = []
    for (const nr of nodeRows) {
      if (nr.status !== "BLOCKED" && nr.status !== "RUNNING") continue
      const t: any = nr.current_task_id ? q!.taskGet.get(nr.current_task_id) : null
      if (!t) continue
      const planNode = plan.nodes.find((n: any) => n?.node_id === nr.node_id)
      const isGate = planNode?.review?.required === true
      let mapped: string | null = null
      if (t.status === "COMPLETED") mapped = isGate ? "REVIEWING" : "COMPLETED"
      else if (t.status === "FAILED") mapped = "FAILED"
      else if (t.status === "BLOCKED" && nr.status === "RUNNING") mapped = "BLOCKED"
      else if (t.status === "READY") mapped = "READY"
      if (mapped && mapped !== nr.status) {
        q!.nodeSetStatus.run(mapped, nowIso(), wfId, nr.node_id)
        notes.push(`node '${nr.node_id}' reconciled ${nr.status} → ${mapped} from task status '${t.status}'`)
      }
    }
    return notes
  }

  // -------------------------------------------------------------------
  // The §39 loop.
  // -------------------------------------------------------------------
  async function runLoop(wfId: string): Promise<any> {
    let wfCfg: any
    try {
      wfCfg = loadWorkflowConfig()
    } catch (e: any) {
      return failure("WORKFLOW_CONFIG_LOAD_FAILED", errMsg(e))
    }
    const policy = normalizePolicy(wfCfg)

    const row0: any = q!.wfGet.get(wfId)
    const plan = safeParse(row0?.plan_json)
    const baseRunState: any = { waves: [], verdicts: [], retries: [], reworks: [], notes: [], archived_sessions: [] }
    if (!plan || !Array.isArray(plan.nodes) || plan.nodes.length === 0) {
      const ts = nowIso()
      q!.wfFinish.run("FAILED", ts, ts, wfId)
      return buildResponse(wfId, baseRunState, "PLAN_MISSING", "workflows.plan_json is missing or has no nodes (materialization never succeeded)")
    }
    // The plan must be read and validated before Team Execution policy is
    // evaluated; otherwise a malformed/missing plan could trigger a TDZ
    // access and mask the deterministic PLAN_MISSING result.
    const teamMode = isTeamExecutionRequired({ nodes: plan.nodes }, policy.teamExecution)
    const runState: any = {
      ...baseRunState,
      team_execution_mode: teamMode ? "TEAM_EXECUTION" : "SINGLE_TASK",
      team_execution_required: teamMode,
      parallel_wave_policy: {
        must_parallelize_min_ready_non_conflicting: policy.teamExecution.must_parallelize.min_ready_non_conflicting,
        scheduler: "workflow-engine-team-scheduler",
      },
    }
    let stopCode: string | null = null
    let stopDetail: string | null = null

    const depsOf = new Map<string, string[]>()
    const nodeIds = new Set<string>(plan.nodes.map((n: any) => n?.node_id).filter((x: any) => typeof x === "string"))
    for (const n of plan.nodes) {
      if (typeof n?.node_id !== "string") continue
      depsOf.set(n.node_id, (Array.isArray(n.depends_on) ? n.depends_on : []).filter((d: any) => typeof d === "string" && nodeIds.has(d) && d !== n.node_id))
    }
    runState.notes.push(...reconcileResumableNodes(wfId, plan, q!.nodesGet.all(wfId)))

    let waveIndex = 0
    for (let iter = 0; iter < MAX_LOOP_ITERATIONS; iter++) {
      const wfRow: any = q!.wfGet.get(wfId)
      let nodeRows: any[] = q!.nodesGet.all(wfId)
      if (WORKFLOW_TERMINAL_STATUSES.includes(wfRow.status)) break // defensive

      // --- FAILED node → workflow FAILED (§39 terminal) ---
      const failedNode = nodeRows.find((r) => r.status === "FAILED")
      if (failedNode) {
        const t: any = failedNode.current_task_id ? q!.taskGet.get(failedNode.current_task_id) : null
        const res = safeParse(t?.result_json)
        stopCode = "NODE_FAILED"
        stopDetail = `node '${failedNode.node_id}' failed (task ${failedNode.current_task_id}): ${res?.error ?? "see task result"}`
        const ts = nowIso()
        q!.wfFinish.run("FAILED", ts, ts, wfId)
        break
      }

      // --- BLOCKED node → workflow BLOCKED (resumable, no finished_at) ---
      const blockedNode = nodeRows.find((r) => r.status === "BLOCKED")
      if (blockedNode) {
        const t: any = blockedNode.current_task_id ? q!.taskGet.get(blockedNode.current_task_id) : null
        const res = safeParse(t?.result_json)
        stopCode = "WORKFLOW_BLOCKED"
        stopDetail = `node '${blockedNode.node_id}' is BLOCKED (task ${blockedNode.current_task_id}): ${res?.error ?? "see task result"}; ` +
          "resolve the blocking cause, then call workflow_run again to resume"
        q!.wfSetStatus.run("BLOCKED", nowIso(), wfId)
        break
      }

      // --- pending review gates (§50-§58) ---
      const reviewing = nodeRows.filter((r) => r.status === "REVIEWING")
      if (reviewing.length > 0) {
        if (wfRow.status !== "REVIEWING") q!.wfSetStatus.run("REVIEWING", nowIso(), wfId)
        let stop = false
        for (const nr of reviewing) {
          const fresh: any = q!.nodeGet.get(wfId, nr.node_id)
          if (!fresh || fresh.status !== "REVIEWING") continue // reset by an earlier rework in this pass
          const outcome: any = await reviewer.runReview({ workflow_id: wfId, node_id: nr.node_id })
          for (const e of outcome?.history_entries ?? []) runState.verdicts.push({ node_id: nr.node_id, ...e })
          if (outcome?.type === "PASS") continue
          if (outcome?.type === "FIX" || outcome?.type === "REWORK") {
            const rw: any = await reviewer.applyRework({
              workflow_id: wfId,
              node_id: nr.node_id,
              verdict: outcome.type,
              reviewer_result: outcome.reviewer_result,
              review_task_id: outcome.review_task_id,
            })
            if (rw?.status === "REWORKING") {
              runState.reworks.push({ gate_node_id: nr.node_id, verdict: outcome.type, rework_cycle: rw.rework_cycle, target_node_id: rw.target_node_id, affected: rw.affected, new_tasks: rw.new_tasks })
              continue
            }
            stopCode = rw?.code ?? (rw?.status === "REWORK_LIMIT" ? "REWORK_LIMIT" : "REWORK_FAILED")
            stopDetail = rw?.detail ?? `rework failed with status ${rw?.status}`
            stop = true
            break
          }
          if (outcome?.type === "INVALID") {
            stopCode = "REVIEW_RESULT_INVALID"
            stopDetail = outcome?.detail ?? "reviewer result invalid twice (§54)"
            const ts = nowIso()
            q!.wfFinish.run("FAILED", ts, ts, wfId)
            stop = true
            break
          }
          if (outcome?.type === "FAILED") {
            stopCode = outcome?.code ?? "REVIEW_DISPATCH_FAILED"
            stopDetail = outcome?.detail ?? "reviewer task failed"
            const ts = nowIso()
            q!.wfFinish.run("FAILED", ts, ts, wfId)
            stop = true
            break
          }
          // BLOCKED / INFRA → park the workflow in BLOCKED (resumable; the
          // gate node stays REVIEWING and gets a fresh reviewer round later)
          stopCode = outcome?.code ?? "WORKFLOW_BLOCKED"
          stopDetail = outcome?.detail ?? "review round could not complete"
          q!.wfSetStatus.run("BLOCKED", nowIso(), wfId)
          stop = true
          break
        }
        if (stop) break
        continue // re-read states after review pass
      }

      // --- find ready nodes (§39) ---
      nodeRows = q!.nodesGet.all(wfId)
      const ready = findReadyNodes(nodeRows, depsOf)
      if (ready.length === 0) {
        const allDone = nodeRows.every((r) => NODE_DONE_STATUSES.includes(r.status))
        if (allDone) {
          // Reviewer PASS is an execution milestone, not delivery. The
          // Completion Guard owns the later delivery decision; never mark the
          // workflow COMPLETED at this point.
          q!.wfSetStatus.run("REVIEW_PASSED", nowIso(), wfId)
          stopCode = "DELIVERY_PENDING"
          stopDetail = "execution complete; completion_delivery_check must pass before delivery is closed"
          break
        }
        const runningNodes = nodeRows.filter((r) => r.status === "RUNNING")
        if (runningNodes.length > 0) {
          // stale RUNNING (crashed earlier run): reconcile from task rows
          const notes = reconcileResumableNodes(wfId, plan, runningNodes)
          runState.notes.push(...notes)
          const stillRunning = runningNodes.some((r) => {
            const fresh: any = q!.nodeGet.get(wfId, r.node_id)
            return fresh?.status === "RUNNING"
          })
          if (stillRunning) {
            stopCode = "STALE_RUNNING_NODE"
            stopDetail = "node(s) stuck in RUNNING with a non-terminal task from a previous dispatch; resolve them then call workflow_run again"
            q!.wfSetStatus.run("BLOCKED", nowIso(), wfId)
            break
          }
          if (notes.length > 0) continue
        }
        // defensive: nothing ready, nothing running, not all done
        stopCode = "SCHEDULER_STALLED"
        stopDetail = "no ready node, no running node and not all nodes done (defensive halt; inspect node states)"
        q!.wfSetStatus.run("BLOCKED", nowIso(), wfId)
        break
      }

      // --- wave dispatch (§40-§44) ---
      if (wfRow.status !== "RUNNING") q!.wfSetStatus.run("RUNNING", nowIso(), wfId)
      const planById = new Map<string, any>()
      for (const n of plan.nodes) if (typeof n?.node_id === "string") planById.set(n.node_id, n)
      const waves = planWaves(
          ready.map((r) => ({
            node_id: r.node_id,
            route: String(planById.get(r.node_id)?.route ?? ""),
            project_id: String(planById.get(r.node_id)?.project_id ?? ""),
            resources: planById.get(r.node_id)?.resources ?? {},
          })),
        policy,
      )
      const mustParallelize = shouldMustParallelize(ready.map((r) => ({
        node_id: r.node_id,
        route: String(planById.get(r.node_id)?.route ?? ""),
        project_id: String(planById.get(r.node_id)?.project_id ?? ""),
        resources: planById.get(r.node_id)?.resources ?? {},
      })), { policy: policy.teamExecution })
      if (mustParallelize && waves.some((wave) => wave.length >= policy.teamExecution.must_parallelize.min_ready_non_conflicting)) {
        runState.notes.push("MUST_PARALLELIZE satisfied by ready non-conflicting nodes; wave scheduler retained resource-safe lanes")
      }

      let stop = false
      for (const wave of waves) {
        const waveStarted = nowIso()
        const settled = await Promise.allSettled(
          wave.map((item) => {
            const body = async () => {
              const nodeRow: any = q!.nodeGet.get(wfId, item.node_id)
              const base = { node_id: item.node_id, route: item.route, project_id: item.project_id, route_class: item.route_class, lock_key: item.lock_key }
              if (!nodeRow || nodeRow.status !== "READY") {
                return { ...base, task_id: nodeRow?.current_task_id ?? null, started_at: nowIso(), ended_at: nowIso(), kind: "skipped", code: "NODE_NOT_READY", detail: `node state changed before dispatch (${nodeRow?.status ?? "missing"})` }
              }
              return executeNode(wfId, nodeRow, planById.get(item.node_id), base, teamMode)
            }
            // §42/§43: serial-route executors run inside their lock; safe
            // routes run without any extra lock (true concurrency).
            return item.lock_key ? core.withLock(item.lock_key, body) : body()
          }),
        )
        const waveEnded = nowIso()
        const results: any[] = []
        for (let i = 0; i < wave.length; i++) {
          const s = settled[i]
          const outcome: any =
            s.status === "fulfilled"
              ? s.value
              : { node_id: wave[i].node_id, task_id: null, started_at: waveStarted, ended_at: waveEnded, kind: "failed", code: "EXECUTION_FAILED", detail: `wave promise rejected: ${s.reason?.message ?? s.reason}` }
          results.push({
            node_id: outcome.node_id,
            task_id: outcome.task_id ?? null,
            kind: outcome.kind,
            ...(outcome.code ? { code: outcome.code } : {}),
            ...(outcome.detail ? { detail: outcome.detail } : {}),
            ...(outcome.forced_by_hook ? { forced_by_hook: true } : {}),
            ...(outcome.lifecycle ? { lifecycle: outcome.lifecycle } : {}),
            started_at: outcome.started_at ?? waveStarted,
            ended_at: outcome.ended_at ?? waveEnded,
          })
          // Plan 8 T7: surface notable lifecycle preflight outcomes as run
          // notes (rotation committed / due-but-disabled / failed / skipped).
          if (outcome.lifecycle) {
            const lc = outcome.lifecycle
            if (lc.rotated) {
              runState.notes.push(
                `node '${outcome.node_id}' lifecycle preflight: scoped session rotated ` +
                  `(generation ${lc.rotation?.from_generation ?? "?"} → ${lc.rotation?.to_generation ?? "?"}, same session_key and task ids); ` +
                  "the send ran on the successor generation",
              )
            } else if (lc.rotation_due && lc.rotation_enabled && lc.skipped) {
              runState.notes.push(
                `node '${outcome.node_id}' lifecycle preflight: rotation due (${lc.lifecycle_state} @ ${lc.context_pct ?? "?"}%) and enabled, ` +
                  `but the rotation failed (${lc.skipped}): ${lc.detail ?? "no detail"}; the send proceeded on the current generation`,
              )
            } else if (lc.rotation_due) {
              runState.notes.push(
                `node '${outcome.node_id}' lifecycle preflight: rotation due (${lc.lifecycle_state} @ ${lc.context_pct ?? "?"}%) but ` +
                  "framework.yaml workflow_engine.automatic_lifecycle_rotation is not true; the send proceeded on the current generation",
              )
            } else if (lc.skipped) {
              runState.notes.push(
                `node '${outcome.node_id}' lifecycle preflight skipped (${lc.skipped}): ${lc.detail ?? "no detail"}; the send proceeded unchanged`,
              )
            }
          }
          if (outcome.kind === "skipped") {
            runState.notes.push(`node '${outcome.node_id}' skipped in wave: ${outcome.detail}`)
            continue
          }
          const freshNode: any = q!.nodeGet.get(wfId, outcome.node_id)
          if (!freshNode) continue
          const ctrl = applyNodeOutcome(wfId, plan, freshNode, planById.get(outcome.node_id), outcome, policy, runState)
          if (ctrl?.stop) {
            stopCode = ctrl.stopCode
            stopDetail = ctrl.stopDetail
            // resumable halt: workflow parks in BLOCKED (no finished_at)
            q!.wfSetStatus.run("BLOCKED", nowIso(), wfId)
            stop = true
          }
        }
        runState.waves.push({
          wave_index: waveIndex++,
          node_ids: wave.map((w) => w.node_id),
          parallelism: wave.length,
          locks: wave.map((w) => ({ node_id: w.node_id, route_class: w.route_class, lock_key: w.lock_key })),
          started_at: waveStarted,
          ended_at: waveEnded,
          results,
        })
        if (stop) break
      }
      if (stop) break
      continue
    }

    if (stopCode === null) {
      const wfRow: any = q!.wfGet.get(wfId)
      if (!WORKFLOW_TERMINAL_STATUSES.includes(wfRow.status)) {
        // iteration guard hit (should be unreachable: retry/rework are bounded)
        stopCode = "SCHEDULER_ITERATION_LIMIT"
        stopDetail = `scheduler exceeded ${MAX_LOOP_ITERATIONS} iterations (defensive guard)`
        const ts = nowIso()
        q!.wfFinish.run("FAILED", ts, ts, wfId)
      }
    }
    const finalStatus = q!.wfGet.get(wfId)?.status
    if (finalStatus === "REVIEW_PASSED" || WORKFLOW_TERMINAL_STATUSES.includes(finalStatus)) {
      // Archive exact scoped keys for every worker at execution end,
      // including failures/rework limits, retry generations and legacy keys.
      // BLOCKED remains resumable, so its workers stay ACTIVE for reuse.
      const registryRows: any[] = q!.scopedWorkerSessions.all(`workflow:${wfId}:project:%`)
      const active = new Map(registryRows.filter((r) => r.status === "ACTIVE").map((r) => [r.session_key, r]))
      for (const key of collectWorkflowWorkerSessionKeys(wfId, plan.nodes, teamMode, registryRows)) {
        const row: any = active.get(key)
        if (!row) continue
        let res: any = null
        try {
          res = await core.withLock(key, () => core.archiveScopedSession({ session_key: key }))
        } catch (e: any) {
          res = { ok: false, code: "ARCHIVE_EXCEPTION", detail: errMsg(e) }
        }
        runState.archived_sessions.push({ project_id: row.project_id, session_key: key, archived: !!res?.ok, code: res?.code ?? null })
      }
    }
    return buildResponse(wfId, runState, stopCode, stopDetail)
  }

  function buildResponse(wfId: string, runState: any, stopCode: string | null, stopDetail: string | null) {
    const row: any = q!.wfGet.get(wfId)
    const nodeRows: any[] = q!.nodesGet.all(wfId)
    const nodes = nodeRows.map((n) => {
      const t: any = n.current_task_id ? q!.taskGet.get(n.current_task_id) : null
      return {
        node_id: n.node_id,
        status: n.status,
        attempt: n.attempt,
        current_task_id: n.current_task_id,
        current_task_status: t ? t.status : null,
        review_task_id: n.review_task_id,
        last_verdict: n.last_verdict,
        task_history: safeParse(n.task_history_json) ?? [],
        review_history: safeParse(n.review_history_json) ?? [],
      }
    })
    return {
      ok: row.status === "COMPLETED",
      status: row.status,
      ...(stopCode ? { code: stopCode } : {}),
      ...(stopDetail ? { detail: stopDetail } : {}),
      workflow: rowToWorkflow(row),
      nodes,
      waves: runState.waves,
      team_execution_mode: runState.team_execution_mode,
      team_execution_required: runState.team_execution_required,
      parallel_wave_policy: runState.parallel_wave_policy,
      rework_cycle: row.rework_cycle,
      verdicts: runState.verdicts,
      retries: runState.retries,
      reworks: runState.reworks,
      archived_sessions: runState.archived_sessions,
      notes: runState.notes,
    }
  }

  // -------------------------------------------------------------------
  // Public entry (§68): status gate + WORKFLOW_ALREADY_RUNNING fail-fast +
  // workflow-level lock around the loop.
  // -------------------------------------------------------------------
  async function runWorkflow(workflowId: any): Promise<any> {
    const g = guard()
    if (g) return g
    if (typeof workflowId !== "string" || !workflowId) return failure("INVALID_INPUT", "workflow_id is required")
    const row: any = q!.wfGet.get(workflowId)
    if (!row) return failure("WORKFLOW_NOT_FOUND", `workflow '${workflowId}' does not exist in runtime/tasks.db`)
    if (row.status === "PLANNING") {
      return failure("WORKFLOW_NOT_READY", `workflow '${workflowId}' is still PLANNING (workflow_plan has not materialized it yet)`)
    }
    if (WORKFLOW_TERMINAL_STATUSES.includes(row.status)) {
      // terminal → return the current state, never re-run
      const nodeRows: any[] = q!.nodesGet.all(workflowId)
      return {
        ok: row.status === "COMPLETED",
        status: row.status,
        already_terminal: true,
        code: row.status === "COMPLETED" ? undefined : `WORKFLOW_${row.status}`,
        detail: `workflow is terminal (${row.status}); workflow_run does not re-run terminal workflows`,
        workflow: rowToWorkflow(row),
        nodes: nodeRows.map((n) => ({
          node_id: n.node_id,
          status: n.status,
          attempt: n.attempt,
          current_task_id: n.current_task_id,
          review_task_id: n.review_task_id,
          last_verdict: n.last_verdict,
        })),
        rework_cycle: row.rework_cycle,
        note: "read-only response; no task was dispatched",
      }
    }
    if (!WORKFLOW_RESUMABLE_STATUSES.includes(row.status)) {
      return failure("WORKFLOW_STATE_INVALID", `workflow status '${row.status}' is not resumable by workflow_run`)
    }
    // fail-fast concurrency guard: an ACTIVE loop in this process means the
    // caller gets WORKFLOW_ALREADY_RUNNING instead of queueing on the lock
    if (runningWorkflows.has(workflowId)) {
      return failure(
        "WORKFLOW_ALREADY_RUNNING",
        `workflow '${workflowId}' already has an active scheduler loop in this OpenCode process; wait for it to finish or inspect it with workflow_get`,
      )
    }
    return await core.withLock(`workflow:${workflowId}`, async () => {
      if (runningWorkflows.has(workflowId)) {
        return failure("WORKFLOW_ALREADY_RUNNING", `workflow '${workflowId}' already has an active scheduler loop`)
      }
      runningWorkflows.add(workflowId)
      try {
        return await runLoop(workflowId)
      } finally {
        runningWorkflows.delete(workflowId)
      }
    })
  }

  return { runWorkflow }
}

export type WorkflowScheduler = ReturnType<typeof createScheduler>
