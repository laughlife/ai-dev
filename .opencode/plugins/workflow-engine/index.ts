// Workflow Engine — OpenCode V2 local plugin (Plan 7 Phase 4, T7a + T7b)
//
// Purpose: Planner-driven Task DAG workflows on the shared runtime/tasks.db.
// T7a implements the planning half: workflow_plan (Planner scoped session →
// deterministic parse/validate → materialization into Task Bus tasks),
// workflow_get and workflow_list (pure DB reads). T7b adds the execution
// half: workflow_run (automatic DAG scheduler with parallel waves per
// workflow.yaml parallel_policy, safe retry per retry policy, and the
// Reviewer PASS/FIX/REWORK closed loop — ./scheduler.ts + ./review.ts) and
// workflow_execute (workflow_plan + workflow_run combo, §69). A 6th tool
// workflow_test_hook is registered ONLY when the marker file
// runtime/.workflow-test-hooks exists at plugin load (§84/§85, test-only;
// production surface stays at exactly five tools, §33).
//
// Plan 8 T7 adds lifecycle preflight for the two SCOPED session kinds this
// plugin owns (the workflow planner here + the workflow feature-executor in
// ./scheduler.ts): before every scoped send, the createLifecycleCore facade
// (.opencode/lib/lifecycle-core.ts) refreshes verified telemetry and
// evaluates the framework-config/lifecycle.yaml bands; a rotation happens
// ONLY when the evaluated lifecycle_state is ROTATE_PENDING/HARD_ROTATE AND
// framework.yaml workflow_engine.automatic_lifecycle_rotation is strictly
// true (it currently stays false — preflight then only measures, evaluates
// and records). A committed rotation keeps the SAME session_key and the
// SAME task ids (the successor is generation+1 of the same key), so the
// scheduler, the reviewer loop and rework replays stay generation-
// transparent. Reviewer rounds keep their ephemeral fresh sessions with NO
// lifecycle logic (./review.ts untouched); the runtime core's Plan 8 T6
// seam covers only the persistent project-main/project-reader send() path
// and is a separate wiring owned by the runtime plugins. Preflight is
// checkpoint preparation failures are non-blocking; mandatory rotation
// failures are fail-closed for scoped sends. Notable outcomes surface as
// additive response fields / run notes.
//
// §34/§67: workflow_plan ONLY does Planner → DAG → validate → materialize.
// It NEVER starts execution — a successfully planned workflow stays READY
// until workflow_run (T7b) is invoked.
//
// Determinism boundaries (§37/§36/§64-style):
// - DAG validity is judged ONLY by ./dag.ts (schema checks, unique node_id,
//   registered project/route, depends_on existence, no self-dependency, Kahn
//   cycle detection, §17 review-gate ancestor rule) — never by an LLM.
// - Planner output is extracted with the deterministic first-'{'..last-'}'
//   strategy; on failure the validator errors go back to the SAME planner
//   scoped session for at most workflow.yaml planner.json_repair_attempts
//   repair round(s); a second failure marks the workflow FAILED (PLAN_INVALID)
//   and materializes NOTHING.
// - The planner model comes explicitly from framework-config/agents.yaml via
//   bus.resolveTaskRoleModel; null → workflow FAILED / MODEL_UNASSIGNED —
//   never guessed, inherited or defaulted (§47).
//
// Authority boundaries:
// - Architecture source of truth: diagrams/multi_agent_framework_v3_workspace.drawio
// - Runtime data sources (read fresh on every call, nothing hardcoded — §22):
//   framework-config/workflow.yaml (planner.route, planner.json_repair_attempts)
//   + projects.yaml / agents.yaml / routing.yaml / task-bus.yaml via bus.loadBusConfig()
// - Contracts: templates/workflow-plan.schema.json (Planner output),
//   templates/task-envelope.schema.json (node materialization via bus.createTask),
//   templates/result-envelope.schema.json (Planner task result via bus.buildResult)
//
// Shares ONE SQLite database (runtime/tasks.db) and the two shared cores
// (.opencode/lib/runtime-registry-core.ts + task-bus-core.ts) with the
// runtime-registry and task-bus plugins. schema.sql (§31) adds ONLY the
// workflows / workflow_nodes tables + index (all IF NOT EXISTS, executed
// idempotently on the shared core db handle); the existing `sessions` and
// `tasks` tables are never modified or ALTERed.
//
// Runtime facts verified on this machine (desktop 2.0.19): Bun 1.4.2,
// bun:sqlite (SQLite 3.53.2, json_extract available), Bun.YAML.parse.
// Plain-object default export (V2 reads `id` + `setup()`; no SDK import).

import * as fs from "node:fs"
import * as path from "node:path"
import { createRuntimeRegistryCore } from "../../lib/runtime-registry-core.ts"
import { createTaskBusCore } from "../../lib/task-bus-core.ts"
import { wireLifecyclePreflight } from "../../lib/lifecycle-preflight.ts"
import { createLifecycleCore } from "../../lib/lifecycle-core.ts"
import { validateWorkflowPlan, extractJsonObject } from "./dag.ts"
import { buildPlannerPrompt, buildRepairPrompt } from "./planning.ts"
import { createScheduler, notableLifecycleReports } from "./scheduler.ts"
import { createReviewer } from "./review.ts"
import { createWorkflowTestHooks, testHooksEnabled, HOOK_VERDICTS } from "./hooks.ts"

const LIST_DEFAULT_LIMIT = 20 // §71: default 20
const LIST_MAX_LIMIT = 100 // §71: max 100 — never unbounded

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

export default {
  id: "workflow-engine",
  async setup(ctx: any) {
    // No schemaFile option: the core falls back to the canonical
    // runtime-registry/schema.sql (base tables registry_meta/sessions/tasks),
    // then THIS plugin idempotently adds its own §31 workflow tables on the
    // same shared handle below.
    const core = createRuntimeRegistryCore(ctx, {
      lifecycleSchemaFile: path.join(import.meta.dir, "..", "lifecycle-engine", "schema.sql"),
    })
    const bus = createTaskBusCore(ctx, core)
    // --- §31: workflow schema on the shared runtime/tasks.db (idempotent) ---
    let schemaError: string | null = null
    if (core.db) {
      try {
        core.db.exec(fs.readFileSync(path.join(import.meta.dir, "schema.sql"), "utf8"))
      } catch (e: any) {
        schemaError = errMsg(e)
      }
    } else {
      schemaError = core.dbError ?? "task database unavailable"
    }

    const wq =
      core.db && !schemaError
        ? {
            insertWorkflow: core.db.query(
              "INSERT INTO workflows (workflow_id, primary_project_id, objective, status, planner_task_id, " +
                "planner_session_id, plan_json, rework_cycle, created_at, updated_at, finished_at) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ),
            getWorkflow: core.db.query("SELECT * FROM workflows WHERE workflow_id = ?"),
            setPlannerTask: core.db.query("UPDATE workflows SET planner_task_id = ?, updated_at = ? WHERE workflow_id = ?"),
            setPlannerSession: core.db.query(
              "UPDATE workflows SET planner_session_id = ?, updated_at = ? WHERE workflow_id = ?",
            ),
            setPlanJson: core.db.query("UPDATE workflows SET plan_json = ?, updated_at = ? WHERE workflow_id = ?"),
            markReady: core.db.query("UPDATE workflows SET status = 'READY', updated_at = ? WHERE workflow_id = ?"),
            markFailed: core.db.query(
              "UPDATE workflows SET status = 'FAILED', updated_at = ?, finished_at = ? WHERE workflow_id = ?",
            ),
            insertNode: core.db.query(
              "INSERT INTO workflow_nodes (workflow_id, node_id, current_task_id, attempt, status, review_task_id, " +
                "last_verdict, task_history_json, review_history_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ),
            getNodes: core.db.query("SELECT * FROM workflow_nodes WHERE workflow_id = ? ORDER BY rowid"),
            getTaskRow: core.db.query(
              "SELECT task_id, status, target_role, input_json, updated_at FROM tasks WHERE task_id = ?",
            ),
          }
        : null

    // Create lifecycle after workflow tables are applied so checkpoint
    // collection can prepare its active-workflow statements on first load.
    // The callback is still wired to this plugin's runtime core before any
    // planner or scheduler call can dispatch a prompt.
    const lifecycle = createLifecycleCore(ctx, core)
    wireLifecyclePreflight(core, lifecycle)

    function guardWf() {
      if (!core.db || !wq) {
        return failure("SQLITE_RUNTIME_UNAVAILABLE", schemaError ?? core.dbError ?? "workflow database unavailable")
      }
      if (!core.configReady) {
        return failure("CONFIG_ROOT_NOT_FOUND", `framework-config not found from root '${core.root}'`)
      }
      return null
    }

    // --- §22: workflow.yaml read fresh on every call (no hardcoded policy) ---
    function loadWorkflowConfig() {
      const B = (globalThis as any).Bun
      if (typeof B?.YAML?.parse !== "function") {
        throw new Error("YAML_PARSER_UNAVAILABLE: Bun.YAML.parse is not present in this runtime")
      }
      return B.YAML.parse(fs.readFileSync(path.join(core.root, "framework-config", "workflow.yaml"), "utf8"))
    }

    // --- Plan 8 T7: automatic lifecycle admission flag. framework.yaml
    // workflow_engine.automatic_lifecycle_rotation, read FRESH on every
    // evaluation (§22 — nothing cached, nothing hardcoded). STRICT true
    // check: false / missing / unreadable all keep automatic rotation
    // DISABLED (it currently IS false; this code never enables it). ---
    function loadAutomaticLifecycleRotation(): { enabled: boolean; reason: string | null } {
      const file = path.join(core.root, "framework-config", "framework.yaml")
      try {
        const B = (globalThis as any).Bun
        if (typeof B?.YAML?.parse !== "function") {
          return { enabled: false, reason: "Bun.YAML.parse is not present in this runtime" }
        }
        const fw = B.YAML.parse(fs.readFileSync(file, "utf8"))
        const v = fw?.workflow_engine?.automatic_lifecycle_rotation
        if (v === true) return { enabled: true, reason: null }
        return {
          enabled: false,
          reason: `workflow_engine.automatic_lifecycle_rotation is ${v === undefined ? "missing" : JSON.stringify(v)}, not true (${file})`,
        }
      } catch (e: any) {
        return { enabled: false, reason: `framework.yaml could not be read: ${errMsg(e)} (${file})` }
      }
    }

    // --- Plan 8 T7: lifecycle preflight for SCOPED workflow sessions (the
    // planner below + the feature-executor in ./scheduler.ts via deps).
    // Runs BEFORE core.sendScopedSession and OUTSIDE the session_key lock
    // (sendScopedSession acquires that lock itself per send, and the lock is
    // NON-REENTRANT), so the lock-acquiring public lifecycle wrappers
    // (rotateSession) are the correct variants here. Policy mirrors the T6
    // seam reference in the runtime core header: refresh verified telemetry
    // → evaluate the lifecycle.yaml bands → rotate ONLY when the evaluated
    // lifecycle_state is ROTATE_PENDING/HARD_ROTATE AND the framework.yaml
    // flag above is strictly true. Checkpoint preparation is non-blocking;
    // rotation failure is fail-closed when automatic admission is enabled so
    // no new task can be sent to a generation that is due for rotation.
    // Storage/evaluation failures remain explicit admission failures. Every
    // outcome is reported for the additive response fields / run notes and
    // the lifecycle_events ledger. A committed rotation preserves the SAME
    // session_key and task ids — the following send resolves the successor
    // generation transparently. Reviewer rounds are NEVER preflighted.
    // This function NEVER throws. ---
    async function lifecyclePreflight(sessionKey: string, info?: any): Promise<any> {
      const report: any = {
        session_key: sessionKey,
        stage: typeof info?.stage === "string" ? info.stage : null,
        task_id: typeof info?.task_id === "string" ? info.task_id : null,
        at: nowIso(),
        ok: true,
        evaluated: false,
        band: null,
        lifecycle_state: null,
        context_pct: null,
        recommended_action: null,
        rotation_due: false,
        rotation_enabled: false,
        rotated: false,
      }
      try {
        const diag: any = lifecycle?.diagnostics
        if (!diag?.db_ready || !diag?.lifecycle_tables_ready || !diag?.telemetry_columns_ready) {
          report.ok = false
          report.code = "LIFECYCLE_STORAGE_UNAVAILABLE"
          report.skipped = "LIFECYCLE_STORAGE_UNAVAILABLE"
          report.detail = diag
            ? `db_ready=${diag.db_ready} lifecycle_tables_ready=${diag.lifecycle_tables_ready} ` +
              `telemetry_columns_ready=${diag.telemetry_columns_ready}`
            : "lifecycle core unavailable"
          return report
        }
        const ev: any = await lifecycle.evaluateThreshold({ session_key: sessionKey, refresh: true })
        if (!ev?.ok) {
          report.ok = false
          report.code = ev?.code ?? "LIFECYCLE_EVALUATE_FAILED"
          report.skipped = ev?.code ?? "LIFECYCLE_EVALUATE_FAILED"
          report.detail = ev?.detail ?? "evaluateThreshold returned no detail"
          return report
        }
        report.evaluated = true
        report.band = ev.band ?? null
        report.lifecycle_state = ev.lifecycle_state ?? null
        report.context_pct = typeof ev.context_pct === "number" ? ev.context_pct : null
        report.recommended_action = ev.recommended_action ?? null
        report.generation = typeof ev.generation === "number" ? ev.generation : null
        // admission by evaluated band STATE (never a raw pct comparison —
        // the 60/70/80 bands live only in lifecycle.yaml / lifecycle-core)
        report.rotation_due = ev.lifecycle_state === "ROTATE_PENDING" || ev.lifecycle_state === "HARD_ROTATE"
        const flag = loadAutomaticLifecycleRotation()
        report.rotation_enabled = flag.enabled
        if (flag.enabled && report.lifecycle_state === "CHECKPOINT_READY") {
          const checkpoint: any = await lifecycle.ensureCheckpoint({ session_key: sessionKey })
          if (checkpoint?.ok) {
            report.checkpoint_prepared = true
            report.checkpoint = {
              status: checkpoint.status ?? null,
              checkpoint_path: checkpoint.checkpoint_path ?? null,
            }
          } else {
            report.checkpoint_prepare_failed = true
            report.checkpoint_error = checkpoint?.code ?? "CHECKPOINT_PREPARE_FAILED"
            report.detail = checkpoint?.detail ?? "checkpoint preparation failed; admission continues"
            lifecycle.recordLifecycleEvent?.(
              sessionKey,
              ev.generation ?? null,
              null,
              "CHECKPOINT_PREPARE_FAILED",
              report.context_pct,
              null,
              { code: report.checkpoint_error, detail: report.detail },
            )
          }
        }
        if (!report.rotation_due) return report
        if (!flag.enabled) {
          report.detail =
            `rotation due (${ev.lifecycle_state} @ context_pct=${report.context_pct}) but automatic rotation is disabled: ${flag.reason}`
          return report
        }
        // non-forced: rotateSessionLocked re-verifies the stored telemetry
        // and the due band INSIDE the session_key lock (TOCTOU-safe)
        const rot: any = await lifecycle.rotateSession({
          session_key: sessionKey,
          reason: `workflow-preflight:${report.stage ?? "scoped"} ${ev.lifecycle_state} @ ${report.context_pct}%`,
          force: false,
        })
        if (!rot?.ok) {
          // fail-closed: the old generation remains serviceable, but a new
          // task must not be sent to it after rotation became mandatory.
          report.ok = false
          report.skipped = rot?.code ?? "ROTATION_FAILED"
          report.detail = rot?.detail ?? "rotation failed; new admission is blocked"
          return report
        }
        // COMMITTED: same session_key, generation+1, same task ids
        report.rotated = true
        report.rotation = {
          rotation_id: rot.rotation_id ?? null,
          from_generation: rot.from_generation ?? null,
          to_generation: rot.to_generation ?? null,
          successor_session_id: rot.successor_session_id ?? null,
          checkpoint_path: rot.checkpoint_path ?? null,
        }
        return report
      } catch (e: any) {
        report.ok = false
        report.code = "PREFLIGHT_EXCEPTION"
        report.skipped = "PREFLIGHT_EXCEPTION"
        report.detail = errMsg(e)
        return report
      }
    }

    // --- T7b (§84/§85): marker-gated test hooks + reviewer loop + scheduler.
    // The marker file runtime/.workflow-test-hooks is checked ONCE at plugin
    // load; without it, hooks stay null (scheduler/reviewer consume nothing)
    // and the workflow_test_hook tool is never registered. A marker file
    // appearing later requires a plugin reload to take effect. ---
    const hooksEnabled = testHooksEnabled(core.root)
    const hooks = hooksEnabled ? createWorkflowTestHooks() : null
    const reviewer = createReviewer({ core, bus, hooks, loadWorkflowConfig })
    const scheduler = createScheduler({ core, bus, hooks, reviewer, loadWorkflowConfig, lifecyclePreflight })

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
      }
    }

    // ===================================================================
    // §34/§36/§38/§67: workflow_plan — Planner → DAG → validate →
    // materialize. NEVER auto-runs; success leaves the workflow READY.
    // ===================================================================
    async function workflowPlan(input: any) {
      const g = guardWf()
      if (g) return g

      // --- input validation (before anything is persisted — failure atomicity) ---
      if (typeof input?.primary_project_id !== "string" || !input.primary_project_id) {
        return failure("INVALID_INPUT", "primary_project_id is required (string)")
      }
      if (typeof input?.objective !== "string" || !input.objective.trim()) {
        return failure("INVALID_INPUT", "objective is required (non-empty string)")
      }
      for (const f of ["constraints", "acceptance_criteria", "project_scope"]) {
        const v = (input as any)[f]
        if (v !== undefined && v !== null && (!Array.isArray(v) || v.some((x: any) => typeof x !== "string"))) {
          return failure("INVALID_INPUT", `${f} must be an array of strings`)
        }
      }

      // --- configs (all fresh reads) ---
      let cfg: any
      try {
        cfg = bus.loadBusConfig()
      } catch (e: any) {
        return failure("CONFIG_LOAD_FAILED", errMsg(e))
      }
      let wfCfg: any
      try {
        wfCfg = loadWorkflowConfig()
      } catch (e: any) {
        return failure("WORKFLOW_CONFIG_LOAD_FAILED", errMsg(e))
      }
      const plannerRoute = wfCfg?.planner?.route
      if (typeof plannerRoute !== "string" || !plannerRoute) {
        return failure("WORKFLOW_CONFIG_INVALID", "framework-config/workflow.yaml planner.route is missing")
      }
      // §36: repair budget comes from config only; missing/invalid → 0 repairs
      // (deterministic; infinite repair is forbidden).
      const rawRepair = wfCfg?.planner?.json_repair_attempts
      const repairAttempts: number = Number.isInteger(rawRepair) && rawRepair >= 0 ? rawRepair : 0

      const project = core.findProject(cfg, input.primary_project_id)
      if (!project) {
        return failure(
          "PROJECT_NOT_FOUND",
          `project '${input.primary_project_id}' is not registered in framework-config/projects.yaml`,
        )
      }
      const plannerRouteInfo = bus.resolveRoute(cfg.routing, plannerRoute)
      if (plannerRouteInfo.error || !plannerRouteInfo.target) {
        return failure(
          plannerRouteInfo.error ?? "ROUTE_NOT_FOUND",
          `workflow.yaml planner.route '${plannerRoute}' is not usable in framework-config/routing.yaml routes`,
        )
      }
      const plannerRole: string = plannerRouteInfo.target // routing.yaml decides the role — never hardcoded
      const projectScope: string[] = (input.project_scope ?? []) as string[]
      for (const pid of projectScope) {
        if (!core.findProject(cfg, pid)) {
          return failure("PROJECT_NOT_FOUND", `project_scope entry '${pid}' is not registered in framework-config/projects.yaml`)
        }
      }
      const c: any = (globalThis as any).crypto
      if (typeof c?.randomUUID !== "function") {
        return failure("UUID_UNAVAILABLE", "crypto.randomUUID is not available in this runtime")
      }

      // --- workflows row: PLANNING (§32) ---
      const workflowId: string = c.randomUUID()
      const ts0 = nowIso()
      try {
        wq!.insertWorkflow.run(workflowId, input.primary_project_id, input.objective, "PLANNING", null, null, null, 0, ts0, ts0, null)
      } catch (e: any) {
        return failure("WORKFLOW_INSERT_FAILED", errMsg(e), { workflow_id: workflowId })
      }
      const markFailed = (code: string, detail: string, extra?: Record<string, unknown>) => {
        const ts = nowIso()
        try {
          wq!.markFailed.run(ts, ts, workflowId)
        } catch {}
        return { ok: false, status: "FAILED", code, detail, workflow_id: workflowId, ...(extra ?? {}) }
      }
      const markBlocked = (code: string, detail: string, extra?: Record<string, unknown>) => {
        try { wq!.wfSetStatus.run("BLOCKED", nowIso(), workflowId) } catch {}
        return { ok: false, status: "BLOCKED", code, detail, workflow_id: workflowId, ...(extra ?? {}) }
      }

      // --- Planner task (Task Bus envelope; route from workflow.yaml) ---
      const created: any = bus.createTask({
        project_id: input.primary_project_id,
        route: plannerRoute,
        objective: `生成 Workflow Plan（workflow ${workflowId}）：${input.objective}`,
        parent_task_id: null,
        constraints: ["只规划，不执行任何任务", "严格返回 workflow-plan JSON（schema_version 1），禁止 Markdown fence"],
        expected_output: ["符合 templates/workflow-plan.schema.json 的完整 workflow-plan JSON"],
        acceptance_criteria: (input.acceptance_criteria ?? []) as string[],
        context_refs: [`workflow:${workflowId}`],
        metadata: { workflow_id: workflowId, workflow_role: "planner" },
      })
      if (!created?.ok) {
        return markFailed(
          created?.code ?? "PLANNER_TASK_CREATE_FAILED",
          `planner task creation failed: ${created?.detail ?? "bus.createTask returned no detail"}`,
          { planner_task_error: created ?? null },
        )
      }
      const plannerTaskId: string = created.envelope.task_id
      wq!.setPlannerTask.run(plannerTaskId, nowIso(), workflowId)

      // --- planner model: explicit config value only, never guessed (§47) ---
      const runtimeId: string | null = bus.resolveTaskRoleModel(cfg, input.primary_project_id, plannerRole)
      if (!runtimeId) {
        return markFailed(
          "MODEL_UNASSIGNED",
          `${bus.taskRoleModelSource(input.primary_project_id, plannerRole)} is null/missing for planner role ` +
            `'${plannerRole}'; refusing to create a planner session, inherit, guess or default a model`,
          { planner_task_id: plannerTaskId },
        )
      }

      // --- workflow-scoped planner session (§45-§47 key convention) ---
      const sessionKey = `workflow:${workflowId}:planner`
      const ensured: any = await core.ensureScopedSession({
        session_key: sessionKey,
        project_id: input.primary_project_id,
        role: plannerRole,
        runtime_id: runtimeId,
        scope_context: [
          `WORKFLOW_ID: ${workflowId}`,
          `PRIMARY_PROJECT_ID: ${input.primary_project_id}`,
          `PROJECT_PATH: ${typeof project.path === "string" ? project.path : ""}`,
          `TARGET_ROLE: ${plannerRole}`,
          "",
          "Rules:",
          "- workflow-scoped planner session created by the workflow-engine plugin (Plan 7)",
          `- session location stays at the framework root (${core.root}); project scope comes from this context`,
          `- obey ${path.join(core.root, "AGENTS.md")}`,
          "- no git pull",
          "- no git push",
          "- this session is kept (not deleted) after planning for manual audit",
          "",
          "(Synthetic scope context written by the workflow-engine plugin, Plan 7.)",
        ].join("\n"),
        title: `[workflow] planner ${workflowId.slice(0, 8)}`,
      })
      if (!ensured?.ok) {
        return markFailed(
          ensured?.code ?? ensured?.status ?? "SESSION_ENSURE_FAILED",
          `planner scoped session ensure failed: ${ensured?.detail ?? "no detail"}`,
          { planner_task_id: plannerTaskId },
        )
      }
      const plannerSessionId: string = ensured.session_id
      wq!.setPlannerSession.run(plannerSessionId, nowIso(), workflowId)

      // --- Plan 8 T7: lifecycle preflight reports for the scoped planner
      // sends below (initial prompt + each repair round). Only NOTABLE
      // reports (rotated / rotation due / skipped) reach the response, so
      // the common case keeps the exact pre-Plan-8 result shape. ---
      const lifecyclePreflights: any[] = []
      const lifecycleExtras = () => {
        const notable = notableLifecycleReports(lifecyclePreflights)
        return notable.length ? { lifecycle_preflights: notable } : {}
      }

      // --- planning prompt (§35) with live route/project lists ---
      const availableRoutes: string[] =
        cfg.routing?.routes && typeof cfg.routing.routes === "object" ? Object.keys(cfg.routing.routes).sort() : []
      const registeredProjects: string[] = Array.isArray(cfg.projects?.projects)
        ? cfg.projects.projects.map((p: any) => p?.id).filter((x: any) => typeof x === "string" && x)
        : []
      const prompt = buildPlannerPrompt({
        workflow_id: workflowId,
        primary_project_id: input.primary_project_id,
        objective: input.objective,
        constraints: (input.constraints ?? []) as string[],
        acceptance_criteria: (input.acceptance_criteria ?? []) as string[],
        project_scope: projectScope,
        available_routes: availableRoutes,
        registered_projects: registeredProjects,
      })
      // Plan 8 T7: lifecycle preflight before EVERY scoped planner send.
      // A mandatory rotation failure is resumably BLOCKED; it must never send
      // a new planning prompt to the old generation.
      const initialPreflight: any = await lifecyclePreflight(sessionKey, { stage: "planner", workflow_id: workflowId, task_id: plannerTaskId })
      lifecyclePreflights.push(initialPreflight)
      if (initialPreflight?.ok === false) return markBlocked(initialPreflight.code ?? "LIFECYCLE_PREFLIGHT_FAILED", initialPreflight.detail ?? "planner lifecycle admission failed", { planner_task_id: plannerTaskId, ...lifecycleExtras() })
      const startedAt = nowIso()
      const sent: any = await core.sendScopedSession({ session_key: sessionKey, text: prompt })
      if (!sent?.ok) {
        return markFailed(
          sent?.code ?? sent?.status ?? "PLANNER_SEND_FAILED",
          `planner session send failed: ${sent?.detail ?? sent?.status ?? "unknown"}`,
          { planner_task_id: plannerTaskId, planner_session_id: plannerSessionId, ...lifecycleExtras() },
        )
      }
      // the send that produced the plan text (replaced by a successful
      // repair send below) — its session_id/generation are the truthful
      // Result Envelope values even if a preflight rotation ever commits
      let lastSend: any = sent

      // --- deterministic parse + validate + bounded repair loop (§36) ---
      const ctxInfo = {
        isProjectRegistered: (pid: string) => !!core.findProject(cfg, pid),
        isRouteRegistered: (route: string) => bus.resolveRoute(cfg.routing, route).error === null,
      }
      let plan: any = null
      let order: string[] = []
      let errors: any[] = []
      let rawText: string = String(sent.output_text ?? "")
      let repairsUsed = 0
      for (let attempt = 0; ; attempt++) {
        const extracted = extractJsonObject(rawText)
        if (extracted.ok) {
          const validation: any = validateWorkflowPlan(extracted.value, ctxInfo)
          if (validation.ok) {
            plan = extracted.value
            order = validation.order
            errors = []
            break
          }
          errors = validation.errors
        } else {
          errors = [{ code: "JSON_PARSE_FAILED", message: extracted.error }]
        }
        if (attempt >= repairAttempts) break
        // §36: the errors go back to the SAME planner scoped session — one
        // repair round per budget, never a new session, never infinite.
        // Plan 8 T7: preflight again — the repair boundary is an atomic-step
        // boundary; with automatic rotation disabled (current config) this
        // only measures/evaluates and the SAME session answers the repair.
        const repairPreflight: any = await lifecyclePreflight(sessionKey, {
            stage: "planner-repair",
            round: attempt + 1,
            workflow_id: workflowId,
            task_id: plannerTaskId,
          })
        lifecyclePreflights.push(repairPreflight)
        if (repairPreflight?.ok === false) return markBlocked(repairPreflight.code ?? "LIFECYCLE_PREFLIGHT_FAILED", repairPreflight.detail ?? "planner repair lifecycle admission failed", { planner_task_id: plannerTaskId, errors, ...lifecycleExtras() })
        const repair: any = await core.sendScopedSession({
          session_key: sessionKey,
          text: buildRepairPrompt(errors, attempt + 1, repairAttempts),
        })
        repairsUsed = attempt + 1
        if (!repair?.ok) {
          return markFailed(
            repair?.code ?? repair?.status ?? "PLANNER_REPAIR_SEND_FAILED",
            `planner repair send failed: ${repair?.detail ?? repair?.status ?? "unknown"}`,
            { planner_task_id: plannerTaskId, planner_session_id: plannerSessionId, errors, repair_attempts_used: repairsUsed, ...lifecycleExtras() },
          )
        }
        lastSend = repair
        rawText = String(repair.output_text ?? "")
      }
      if (!plan) {
        // §36: second failure → workflow FAILED / PLAN_INVALID; NOTHING is
        // materialized. The planner task stays READY for audit; the row stays
        // FAILED for audit.
        return markFailed(
          "PLAN_INVALID",
          `workflow plan failed deterministic validation after ${repairsUsed} repair attempt(s) ` +
            `(budget planner.json_repair_attempts=${repairAttempts}); no tasks were materialized`,
          { planner_task_id: plannerTaskId, planner_session_id: plannerSessionId, errors, repair_attempts_used: repairsUsed, ...lifecycleExtras() },
        )
      }

      // --- persist the validated plan (audit value even if the next step fails) ---
      wq!.setPlanJson.run(JSON.stringify(plan), nowIso(), workflowId)

      // --- Planner task → COMPLETED (truthful: it produced a valid plan).
      // Result Envelope via the shared bus builders so result_json is written
      // exactly like every Task Bus result. ---
      const plannerFinishedAt = nowIso()
      const plannerResult = bus.buildResult({
        taskId: plannerTaskId,
        projectId: input.primary_project_id,
        route: plannerRoute,
        targetRole: plannerRole,
        status: "COMPLETED",
        // Plan 8 T7: the send that produced the plan text is authoritative
        // (identical to plannerSessionId/ensured.generation unless a
        // preflight rotation ever committed — generation-transparent).
        sessionId: lastSend?.session_id ?? plannerSessionId,
        sessionGeneration:
          typeof lastSend?.generation === "number"
            ? lastSend.generation
            : typeof ensured.generation === "number"
              ? ensured.generation
              : null,
        outputText: JSON.stringify(plan),
        error: null,
        startedAt,
        finishedAt: plannerFinishedAt,
      })
      bus.persistResult(plannerTaskId, "COMPLETED", sessionKey, plannerResult)

      // --- §38 materialization in ONE transaction: node tasks + node rows +
      // READY, all-or-nothing. Topological order guarantees that when a node
      // is created, every depends_on node's task_id already exists, so
      // dependencies can be passed to bus.createTask directly (single pass,
      // no envelope post-editing). ---
      const materialized: any[] = []
      try {
        core.db.transaction(() => {
          const nodeTaskMap: Record<string, string> = {}
          for (const nodeId of order) {
            const node = plan.nodes.find((n: any) => n?.node_id === nodeId)
            if (!node) throw new Error(`NODE_MISSING: node '${nodeId}' vanished from the validated plan`)
            const depsTaskIds: string[] = (Array.isArray(node.depends_on) ? node.depends_on : [])
              .map((d: string) => nodeTaskMap[d])
              .filter((x: any) => typeof x === "string")
            const nt: any = bus.createTask({
              project_id: node.project_id,
              route: node.route,
              objective: node.objective,
              parent_task_id: plannerTaskId,
              constraints: node.constraints ?? [],
              dependencies: depsTaskIds,
              expected_output: node.expected_output ?? [],
              acceptance_criteria: node.acceptance_criteria ?? [],
              context_refs: [`workflow:${workflowId}`],
              metadata: {
                workflow_id: workflowId,
                workflow_node_id: nodeId,
                attempt: 1,
                ...(node.review && typeof node.review === "object" ? { review: node.review } : {}),
              },
            })
            if (!nt?.ok) {
              throw new Error(`${nt?.code ?? "TASK_CREATE_FAILED"}: ${nt?.detail ?? "bus.createTask failed"} (node '${nodeId}')`)
            }
            const taskId: string = nt.envelope.task_id
            nodeTaskMap[nodeId] = taskId
            const ts = nowIso()
            wq!.insertNode.run(
              workflowId,
              nodeId,
              taskId,
              1, // attempt (§31 default)
              "READY",
              null, // review_task_id — T7b reviewer loop
              null, // last_verdict — T7b reviewer loop
              JSON.stringify([{ task_id: taskId, attempt: 1, created_at: ts }]),
              "[]",
              ts,
            )
            materialized.push({
              node_id: nodeId,
              task_id: taskId,
              route: node.route,
              project_id: node.project_id,
              depends_on: Array.isArray(node.depends_on) ? node.depends_on : [],
              dependency_task_ids: depsTaskIds,
              review: node.review ?? null,
            })
          }
          wq!.markReady.run(nowIso(), workflowId)
        })()
      } catch (e: any) {
        materialized.length = 0 // transaction rolled back — no partial output
        return markFailed(
          "MATERIALIZE_FAILED",
          `task materialization failed and was rolled back atomically: ${errMsg(e)}; ` +
            "the validated plan stays in workflows.plan_json for audit; no node tasks exist",
          { planner_task_id: plannerTaskId, planner_session_id: plannerSessionId, ...lifecycleExtras() },
        )
      }

      const row: any = wq!.getWorkflow.get(workflowId)
      return {
        ok: true,
        status: "READY",
        workflow: row ? rowToWorkflow(row) : null,
        nodes: materialized,
        planner_task_id: plannerTaskId,
        planner_session_id: plannerSessionId,
        repair_attempts_used: repairsUsed,
        ...lifecycleExtras(),
        note:
          "workflow planned, validated and materialized with status READY; workflow_plan never starts execution " +
          "(§67) — scheduling and the reviewer loop land in T7b (workflow_run)",
      }
    }

    // ===================================================================
    // §70: workflow_get — pure DB read; never triggers a model.
    // ===================================================================
    function workflowGet(workflowId: any) {
      const g = guardWf()
      if (g) return g
      if (typeof workflowId !== "string" || !workflowId) return failure("INVALID_INPUT", "workflow_id is required")
      const row: any = wq!.getWorkflow.get(workflowId)
      if (!row) {
        return failure("WORKFLOW_NOT_FOUND", `workflow '${workflowId}' does not exist in runtime/tasks.db`)
      }
      const nodeRows: any[] = wq!.getNodes.all(workflowId)
      const nodes = nodeRows.map((n) => {
        let currentTask: any = null
        if (n.current_task_id) {
          const t: any = wq!.getTaskRow.get(n.current_task_id)
          if (t) {
            currentTask = {
              task_id: t.task_id,
              status: t.status,
              route: safeParse(t.input_json)?.route ?? null,
              target_role: t.target_role,
              updated_at: t.updated_at,
            }
          }
        }
        return {
          node_id: n.node_id,
          current_task_id: n.current_task_id,
          current_task: currentTask,
          attempt: n.attempt,
          status: n.status,
          review_task_id: n.review_task_id,
          last_verdict: n.last_verdict,
          task_history: safeParse(n.task_history_json) ?? [],
          review_history: safeParse(n.review_history_json) ?? [],
          updated_at: n.updated_at,
        }
      })
      return {
        ok: true,
        status: row.status,
        workflow: rowToWorkflow(row),
        nodes,
        node_count: nodes.length,
      }
    }

    // ===================================================================
    // §71: workflow_list — bounded, filterable, newest first; pure DB read.
    // ===================================================================
    function workflowList(input: any) {
      const g = guardWf()
      if (g) return g
      const where: string[] = []
      const params: any[] = []
      if (typeof input?.project_id === "string" && input.project_id) {
        where.push("primary_project_id = ?") // project_id filter matches primary_project_id
        params.push(input.project_id)
      }
      if (typeof input?.status === "string" && input.status) {
        where.push("status = ?")
        params.push(input.status)
      }
      let limit = LIST_DEFAULT_LIMIT
      if (input?.limit !== undefined && input?.limit !== null) {
        const n = Number(input.limit)
        if (!Number.isInteger(n) || n < 1) return failure("INVALID_INPUT", "limit must be a positive integer")
        limit = Math.min(n, LIST_MAX_LIMIT)
      }
      const sql =
        "SELECT workflow_id, primary_project_id, objective, status, planner_task_id, planner_session_id, " +
        "rework_cycle, created_at, updated_at, finished_at, " +
        "(SELECT COUNT(*) FROM workflow_nodes n WHERE n.workflow_id = w.workflow_id) AS node_count " +
        "FROM workflows w " +
        (where.length ? `WHERE ${where.join(" AND ")} ` : "") +
        "ORDER BY created_at DESC, workflow_id DESC LIMIT ?"
      const rows: any[] = core.db.query(sql).all(...params, limit)
      return { ok: true, status: "OK", count: rows.length, limit, workflows: rows }
    }

    // ===================================================================
    // §69: workflow_execute — workflow_plan + workflow_run combined, the
    // Global Orchestrator standard entry point. If planning fails, nothing
    // runs; if planning succeeds (READY), the scheduler loop starts.
    // ===================================================================
    async function workflowExecute(input: any) {
      const planned: any = await workflowPlan(input)
      if (!planned?.ok) return { ...planned, stage: "plan" }
      const workflowId = planned?.workflow?.workflow_id
      const run: any = await scheduler.runWorkflow(workflowId)
      return {
        ok: !!run?.ok,
        status: run?.status ?? "ERROR",
        ...(run?.code ? { code: run.code } : {}),
        ...(run?.detail ? { detail: run.detail } : {}),
        stage: "execute",
        workflow: run?.workflow ?? planned.workflow,
        nodes: run?.nodes ?? [],
        waves: run?.waves ?? [],
        rework_cycle: run?.rework_cycle ?? 0,
        verdicts: run?.verdicts ?? [],
        retries: run?.retries ?? [],
        reworks: run?.reworks ?? [],
        archived_sessions: run?.archived_sessions ?? [],
        notes: run?.notes ?? [],
        plan: {
          workflow_id: workflowId,
          planner_task_id: planned.planner_task_id ?? null,
          planner_session_id: planned.planner_session_id ?? null,
          repair_attempts_used: planned.repair_attempts_used ?? 0,
          materialized_nodes: planned.nodes ?? [],
          ...(Array.isArray(planned.lifecycle_preflights) && planned.lifecycle_preflights.length
            ? { lifecycle_preflights: planned.lifecycle_preflights }
            : {}),
        },
        note: "workflow_execute = workflow_plan + workflow_run (§69)",
      }
    }

    // ===================================================================
    // §84/§85: workflow_test_hook handler — TEST-ONLY, marker-gated.
    // In-memory quotas consumed by scheduler.ts (forceFailure) and
    // review.ts (forceVerdict) before any real dispatch; zero model calls.
    // ===================================================================
    function handleTestHook(input: any) {
      if (!hooks) {
        return failure(
          "HOOK_NOT_ENABLED",
          "test hooks are disabled: the marker file runtime/.workflow-test-hooks was absent at plugin load",
        )
      }
      const action = input?.action
      if (action === "force_verdict") {
        if (typeof input?.workflow_id !== "string" || !input.workflow_id) {
          return failure("INVALID_INPUT", "workflow_id is required")
        }
        const verdicts = input?.verdicts
        if (!Array.isArray(verdicts) || verdicts.length === 0 || verdicts.some((v: any) => !HOOK_VERDICTS.includes(v))) {
          return failure("INVALID_INPUT", "verdicts must be a non-empty array of PASS/FIX/REWORK")
        }
        hooks.forceVerdict(input.workflow_id, verdicts)
        return {
          ok: true,
          status: "OK",
          action,
          workflow_id: input.workflow_id,
          verdicts,
          note: "each review round consumes one verdict (FIFO); hook state is in-memory only (cleared on plugin reload)",
        }
      }
      if (action === "force_failure") {
        if (typeof input?.workflow_id !== "string" || !input.workflow_id) return failure("INVALID_INPUT", "workflow_id is required")
        if (typeof input?.node_id !== "string" || !input.node_id) return failure("INVALID_INPUT", "node_id is required")
        if (typeof input?.code !== "string" || !input.code.trim()) {
          return failure("INVALID_INPUT", "code is required (an execution-class error code, e.g. EXECUTION_FAILED / WAIT_TIMEOUT)")
        }
        let times = 1
        if (input?.times !== undefined && input?.times !== null) {
          const n = Number(input.times)
          if (!Number.isInteger(n) || n < 1) return failure("INVALID_INPUT", "times must be an integer >= 1")
          times = n
        }
        hooks.forceFailure(input.workflow_id, input.node_id, input.code.trim(), times)
        return {
          ok: true,
          status: "OK",
          action,
          workflow_id: input.workflow_id,
          node_id: input.node_id,
          code: input.code.trim(),
          times,
          note: "the next N execution(s) of this node fail directly with this code (zero model calls); hook state is in-memory only",
        }
      }
      if (action === "dry_reviewer_pass") {
        // §86: dry-run the strict reviewer-pass precondition resolver
        // (bus.verifyReviewerPass) against the real tasks.db WITHOUT
        // dispatching anything — zero model calls, zero Mem0 writes, zero
        // task/workflow state changes. Purely a read-only verification of
        // whether a long_term_memory_write-style envelope carrying the given
        // context_refs would satisfy the reviewer-pass gate.
        if (typeof input?.project_id !== "string" || !input.project_id) {
          return failure("INVALID_INPUT", "project_id is required")
        }
        const contextRefs = Array.isArray(input?.context_refs) ? input.context_refs : []
        const route = typeof input?.route === "string" && input.route.trim() ? input.route.trim() : "long_term_memory_write"
        const review = bus.verifyReviewerPass({ project_id: input.project_id, route, context_refs: contextRefs })
        return { ok: true, status: "OK", action, project_id: input.project_id, route, context_refs: contextRefs, ...review }
      }
      if (action === "clear") {
        const res: any = hooks.clear(typeof input?.workflow_id === "string" && input.workflow_id ? input.workflow_id : null)
        return { ok: true, status: "OK", action, ...res }
      }
      if (action === "list") {
        return { ok: true, status: "OK", action, hooks: hooks.list() }
      }
      return failure(
        "INVALID_INPUT",
        `unknown action '${String(action ?? "")}' (expected force_verdict | force_failure | dry_reviewer_pass | clear | list)`,
      )
    }

    // ===================================================================
    // §33: exactly five tools, namespace `workflow` — plus the TEST-ONLY
    // workflow_test_hook as a 6th tool if and only if the marker file
    // runtime/.workflow-test-hooks existed at plugin load (§84/§85).
    // ===================================================================
    await ctx.tool.transform((editor: any) => {
      editor.namespace({
        name: "workflow",
        description:
          "Workflow Engine (Plan 7 Phase 4, T7a+T7b): Planner-driven Task DAG workflows on the shared runtime/tasks.db. " +
          "workflow_plan plans + deterministically validates + materializes node tasks (never auto-runs, §67); " +
          "workflow_run is the automatic DAG scheduler (parallel waves, reviewer PASS/FIX/REWORK loop, safe retry, " +
          "rework cycles until terminal); workflow_execute = plan + run (§69, Global Orchestrator standard entry); " +
          "workflow_get / workflow_list are pure DB reads.",
      })

      const planInputProperties = {
        primary_project_id: {
          type: "string",
          description: "Primary project id from framework-config/projects.yaml that owns this workflow",
        },
        objective: { type: "string", description: "Final goal of the whole workflow (non-empty string)" },
        constraints: {
          type: "array",
          items: { type: "string" },
          description: "Workflow-level constraints every node executor must respect (echoed into the plan)",
        },
        acceptance_criteria: {
          type: "array",
          items: { type: "string" },
          description: "Workflow-level conditions defining when the whole workflow is done (copied to every reviewer round)",
        },
        project_scope: {
          type: "array",
          items: { type: "string" },
          description: "Business projects involved in this workflow (must be registered project ids)",
        },
      }

      editor.add({
        name: "workflow_plan",
        description:
          "Plan a new workflow (§34/§67): validates primary_project_id, creates a Planner task (route from " +
          "framework-config/workflow.yaml planner.route), runs the Planner in a workflow-scoped session, then " +
          "deterministically parses + validates the workflow-plan JSON (schema, unique node_id, registered " +
          "project/route, depends_on existence, Kahn cycle detection, review-gate ancestor rule — never LLM " +
          "judgment), persists plan_json, records the Planner task COMPLETED and materializes every node into a " +
          "Runtime Task Bus task (parent = planner task, depends_on converted to task_id dependencies in one " +
          "atomic transaction). Does NOT start execution: the workflow stays READY until workflow_run (T7b). " +
          "On invalid output the validator errors go back to the SAME planner session for at most " +
          "planner.json_repair_attempts repair round(s); a second failure marks the workflow FAILED " +
          "(PLAN_INVALID) without materializing any task.",
        input: {
          type: "object",
          properties: planInputProperties,
          required: ["primary_project_id", "objective"],
          additionalProperties: false,
        },
        options: { namespace: "workflow" },
        execute: async (input: any) => ({ content: JSON.stringify(await workflowPlan(input)) }),
      })

      editor.add({
        name: "workflow_run",
        description:
          "Automatic DAG scheduler for an existing workflow (§39-§44/§50-§62/§68): repeatedly finds dependency-ready " +
          "nodes, groups them into parallel waves per framework-config/workflow.yaml (safe_routes concurrent, " +
          "project_serial_routes serialized per project via project:<pid>:write lock, global_serial_routes serialized " +
          "via global:<family> lock, unknown routes conservative; Promise.allSettled capped at scheduler.max_parallel), " +
          "executes code_change/api_code_change nodes in the workflow-scoped feature-executor session and all other " +
          "routes via the Task Bus, applies execution-class safe retry (retry.safe_routes, max_retries, never-retry " +
          "list wins), runs the Reviewer PASS/FIX/REWORK loop (fresh reviewer session per round, deterministic " +
          "subgraph replay, rework_cycle capped at review.max_rework_cycles) and stops at a terminal state " +
          "(COMPLETED/FAILED/REWORK_LIMIT) or resumable BLOCKED. Resumable states: READY/RUNNING/BLOCKED/REVIEWING/" +
          "REWORKING; PLANNING → WORKFLOW_NOT_READY; terminal → current state without re-running; an active loop for " +
          "the same workflow → WORKFLOW_ALREADY_RUNNING. Returns the final workflow, node overview, per-wave execution " +
          "summary (node ids, parallelism, per-node start/end timestamps), retries, reworks, verdict history and " +
          "archived scoped sessions.",
        input: {
          type: "object",
          properties: {
            workflow_id: { type: "string", description: "workflow_id returned by workflow_plan" },
          },
          required: ["workflow_id"],
          additionalProperties: false,
        },
        options: { namespace: "workflow" },
        execute: async (input: any) => ({ content: JSON.stringify(await scheduler.runWorkflow(input?.workflow_id)) }),
      })

      editor.add({
        name: "workflow_execute",
        description:
          "Global Orchestrator standard entry point (§69): workflow_plan + (on successful READY materialization) " +
          "workflow_run combined in one call. If planning fails (PLAN_INVALID / MODEL_UNASSIGNED / MATERIALIZE_FAILED " +
          "...) nothing is executed and the planning failure is returned with stage='plan'. Otherwise the scheduler " +
          "loop runs to a terminal state and the merged result carries both the planning summary (planner task/" +
          "session, materialized nodes) and the run summary (final status, waves, retries, reworks, verdicts).",
        input: {
          type: "object",
          properties: planInputProperties,
          required: ["primary_project_id", "objective"],
          additionalProperties: false,
        },
        options: { namespace: "workflow" },
        execute: async (input: any) => ({ content: JSON.stringify(await workflowExecute(input)) }),
      })

      editor.add({
        name: "workflow_get",
        description:
          "Read one workflow by workflow_id (§70): the workflow row (status, planner task/session, rework_cycle, " +
          "timestamps, parsed plan JSON) plus every node with current_task_id, current task status, attempt, node " +
          "status, last_verdict, task_history and review_history. Pure database read; never triggers a model " +
          "request. Unknown id → WORKFLOW_NOT_FOUND.",
        input: {
          type: "object",
          properties: {
            workflow_id: { type: "string", description: "workflow_id returned by workflow_plan" },
          },
          required: ["workflow_id"],
          additionalProperties: false,
        },
        options: { namespace: "workflow" },
        execute: async (input: any) => ({ content: JSON.stringify(workflowGet(input?.workflow_id)) }),
      })

      editor.add({
        name: "workflow_list",
        description:
          "List workflows (newest first) with optional filters project_id (matches primary_project_id) / status / " +
          `limit (default ${LIST_DEFAULT_LIMIT}, max ${LIST_MAX_LIMIT}); never returns unbounded results (§71). ` +
          "Pure database read; never triggers a model request.",
        input: {
          type: "object",
          properties: {
            project_id: { type: "string", description: "Filter by primary project id" },
            status: {
              type: "string",
              description:
                "Filter by workflow status (PLANNING, READY, RUNNING, BLOCKED, REVIEWING, REWORKING, COMPLETED, FAILED, REWORK_LIMIT)",
            },
            limit: {
              type: "integer",
              description: `Maximum rows to return (default ${LIST_DEFAULT_LIMIT}, max ${LIST_MAX_LIMIT})`,
            },
          },
          additionalProperties: false,
        },
        options: { namespace: "workflow" },
        execute: async (input: any) => ({ content: JSON.stringify(workflowList(input)) }),
      })

      // --- §84/§85: TEST-ONLY 6th tool, registered ONLY when the marker file
      // runtime/.workflow-test-hooks existed at plugin load. Production loads
      // expose exactly the five §33 tools; a marker file appearing later
      // requires a plugin reload (see README). ---
      if (hooks) {
        editor.add({
          name: "workflow_test_hook",
          description:
            "TEST-ONLY workflow hook (§84/§85) — registered ONLY because the marker file runtime/.workflow-test-hooks " +
            "existed at plugin load time; production loads never expose this tool. Actions: force_verdict (queue " +
            "synthetic reviewer verdicts PASS/FIX/REWORK for a workflow; each review round consumes one FIFO entry " +
            "and NO real reviewer is dispatched — zero model calls), force_failure (the node's next N executions are " +
            "persisted FAILED directly with the given execution-class error code — zero model calls; participates in " +
            "the normal safe-retry decision), dry_reviewer_pass (§86: dry-run the strict reviewer-pass precondition " +
            "resolver against real tasks.db rows for a hypothetical envelope — zero dispatch, zero model calls, zero " +
            "Mem0 writes), clear (drop one workflow's quotas or all), list (show current in-memory " +
            "state). Hook state lives in memory only and is cleared on plugin reload.",
          input: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: ["force_verdict", "force_failure", "dry_reviewer_pass", "clear", "list"],
                description: "Hook action to perform",
              },
              workflow_id: { type: "string", description: "Target workflow_id (required for force_verdict/force_failure)" },
              node_id: { type: "string", description: "Target node_id (required for force_failure)" },
              verdicts: {
                type: "array",
                items: { type: "string", enum: ["PASS", "FIX", "REWORK"] },
                description: "force_verdict: FIFO verdict queue, one entry consumed per review round",
              },
              code: {
                type: "string",
                description: "force_failure: execution-class error code (e.g. EXECUTION_FAILED, WAIT_TIMEOUT)",
              },
              times: { type: "integer", description: "force_failure: number of executions to fail (default 1)" },
              project_id: { type: "string", description: "dry_reviewer_pass: project_id of the hypothetical envelope (required)" },
              route: { type: "string", description: "dry_reviewer_pass: route of the hypothetical envelope (default long_term_memory_write)" },
              context_refs: {
                type: "array",
                items: { type: "string" },
                description: "dry_reviewer_pass: context_refs entries ('task:<id>') of the hypothetical envelope",
              },
            },
            required: ["action"],
            additionalProperties: false,
          },
          options: { namespace: "workflow" },
          execute: async (input: any) => ({ content: JSON.stringify(handleTestHook(input)) }),
        })
      }
    })

    console.log(
      `[workflow-engine] loaded root=${core.root} db=${core.db ? "ok" : "unavailable:" + core.dbError} ` +
        `schema=${schemaError ? "failed:" + schemaError : "ok"} config=${core.configReady} ` +
        `test-hooks=${hooksEnabled ? "ENABLED (marker runtime/.workflow-test-hooks present; workflow_test_hook registered)" : "disabled (5 tools)"} ` +
        `lifecycle-preflight=${
          lifecycle?.diagnostics?.db_ready && lifecycle?.diagnostics?.lifecycle_tables_ready && lifecycle?.diagnostics?.telemetry_columns_ready
            ? "ready (scoped planner + feature-executor sends; rotation only when framework.yaml workflow_engine.automatic_lifecycle_rotation is true)"
            : "storage unavailable (preflight reports the condition; mandatory scoped rotation remains fail-closed)"
        }`,
    )

    return () => {
      core.close()
    }
  },
}
