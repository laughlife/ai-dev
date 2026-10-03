// Deterministic Completion Guard (Plan 9 Part A + U4).
// It never invokes an Agent. Read-only checks return evidence; the explicit
// finalize operation is the sole guarded workflow-closing mutation.

import { evaluateRuntimeEvidence } from "./plan12-completion-evidence.ts"
import fs from "node:fs"
import path from "node:path"

const NODE_SUCCESS = new Set(["COMPLETED", "REVIEW_PASSED"])
const ACTIVE_TASK = new Set(["READY", "RUNNING", "BLOCKED"])
const EXECUTION_ALLOWED_WORKFLOW_STATES = new Set(["REVIEW_PASSED", "DELIVERY_PENDING", "DELIVERY_COMPLETE", "COMPLETED"])
const DELIVERY_FINALIZABLE_WORKFLOW_STATES = new Set(["REVIEW_PASSED", "DELIVERY_PENDING", "DELIVERY_COMPLETE"])
const TERMINAL_TASK = new Set(["COMPLETED"])

function parse(value: any): any {
  if (typeof value !== "string" || !value) return null
  try { return JSON.parse(value) } catch { return null }
}

function parseJsonCandidate(value: any): any {
  const direct = parse(value)
  if (direct) return direct
  if (typeof value !== "string") return null
  const start = value.indexOf("{")
  const end = value.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  return parse(value.slice(start, end + 1))
}

function failure(code: string, detail: string, extra: any = {}) {
  return { ok: false, status: "ERROR", code, detail, ...extra }
}

function requiredPlanNodes(plan: any): any[] {
  return Array.isArray(plan?.nodes) ? plan.nodes.filter((n: any) => n?.metadata?.required !== false) : []
}

export function createCompletionCore(runtimeCore: any, options: any = {}) {
  const db = runtimeCore?.db
  const evidenceResolver = options?.evidenceResolver
  const defaultEvidenceResolver = options?.runtimeEvidenceEvaluator ?? evaluateRuntimeEvidence
  function runtimeEvidence(input: any, wf: any, plan: any) {
    const policy = plan?.metadata?.execution_policy ?? {}
    const required = policy?.mode === "isolated_fixture" || plan?.metadata?.runtime_evidence_required === true
    if (!required) return { ok: true, status: "NOT_REQUIRED", verification: "UNVERIFIED", evidence_level: "UNVERIFIED", missing: [] }
    const resolver = evidenceResolver ?? defaultEvidenceResolver
    if (typeof resolver === "function") {
      try {
        return resolver({
          workflowId: wf.workflow_id,
          runId: typeof input?.run_id === "string" ? input.run_id : undefined,
          dbPath: typeof input?.control_plane_db === "string" ? input.control_plane_db : policy.control_plane_db,
          root: runtimeCore?.root ?? process.cwd(),
          productionRoot: process.env.AI_DEV_ROOT ?? (runtimeCore?.root && fs.existsSync(path.join(runtimeCore.root, ".git")) ? runtimeCore.root : null),
          configRevision: policy.config_revision,
          allowed_roots: policy.allowed_roots,
          runtimeNodes: db.query("SELECT * FROM workflow_nodes WHERE workflow_id = ?").all(wf.workflow_id),
          plan,
        })
      } catch (error: any) {
        return { ok: false, status: "BLOCKED", verification: "BLOCKED", evidence_level: "L3", code: "EVIDENCE_CHECK_FAILED", detail: error?.message ?? String(error), missing: [{ code: "EVIDENCE_CHECK_FAILED" }] }
      }
    }
    return { ok: false, status: "BLOCKED", verification: "BLOCKED", evidence_level: "L3", code: "EVIDENCE_STORE_UNAVAILABLE", detail: "Plan 12.6 evidence resolver is unavailable", missing: [{ code: "EVIDENCE_STORE_UNAVAILABLE" }] }
  }

  function guard() {
    if (!db) return failure("SQLITE_RUNTIME_UNAVAILABLE", runtimeCore?.dbError ?? "runtime database unavailable")
    return null
  }

  function executionCheck(input: any = {}) {
    const g = guard(); if (g) return g
    const id = typeof input.workflow_id === "string" ? input.workflow_id : ""
    if (!id) return failure("INVALID_INPUT", "workflow_id is required")
    const wf: any = db.query("SELECT * FROM workflows WHERE workflow_id = ?").get(id)
    if (!wf) return failure("WORKFLOW_NOT_FOUND", `workflow '${id}' does not exist`)
    const plan = parse(wf.plan_json) ?? {}
    const planNodes = Array.isArray(plan?.nodes) ? plan.nodes : []
    const planById = new Map(planNodes.map((n: any) => [n.node_id, n]))
    const rows: any[] = db.query("SELECT * FROM workflow_nodes WHERE workflow_id = ? ORDER BY node_id").all(id)
    const byId = new Map(rows.map((r: any) => [r.node_id, r]))
    const missing: any[] = []
    const checked: any[] = []
    if (!EXECUTION_ALLOWED_WORKFLOW_STATES.has(String(wf.status))) {
      missing.push({ reason: "WORKFLOW_STATUS_NOT_FINALIZABLE", workflow_status: wf.status })
    }
    for (const [nodeId, planNode] of planById) {
      const row: any = byId.get(nodeId)
      const status = row?.status ?? "MISSING"
      checked.push({ node_id: nodeId, status })
      if (!row || !NODE_SUCCESS.has(status)) missing.push({ node_id: nodeId, status, reason: "NODE_NOT_TERMINAL_SUCCESS" })
      for (const dep of (Array.isArray(planNode.depends_on) ? planNode.depends_on : [])) {
        const depRow: any = byId.get(dep)
        if (!depRow || !NODE_SUCCESS.has(depRow.status)) missing.push({ node_id: nodeId, dependency: dep, reason: "DEPENDENCY_NOT_COMPLETE" })
      }
      if (!row?.current_task_id) {
        missing.push({ node_id: nodeId, reason: "NODE_TASK_MISSING" })
      } else {
        const task: any = db.query("SELECT task_id,status FROM tasks WHERE task_id = ?").get(row.current_task_id)
        if (!task) missing.push({ node_id: nodeId, task_id: row.current_task_id, reason: "NODE_TASK_MISSING" })
        else if (!TERMINAL_TASK.has(task.status)) missing.push({ node_id: nodeId, task_id: task.task_id, status: task.status, reason: ACTIVE_TASK.has(task.status) ? "ACTIVE_CHILD_TASK" : "CHILD_TASK_NOT_SUCCESS" })
      }
    }
    for (const row of rows) if (!planById.has(row.node_id)) missing.push({ node_id: row.node_id, reason: "UNPLANNED_WORKFLOW_NODE" })
    const descendants: any[] = db.query(
      "WITH RECURSIVE descendants(task_id, status, path) AS (" +
        "SELECT t.task_id, t.status, '|' || t.task_id || '|' " +
        "FROM tasks t WHERE t.parent_task_id IN (SELECT current_task_id FROM workflow_nodes WHERE workflow_id = ? AND current_task_id IS NOT NULL) " +
        "UNION ALL " +
        "SELECT t.task_id, t.status, d.path || t.task_id || '|' FROM tasks t " +
        "JOIN descendants d ON t.parent_task_id = d.task_id " +
        "WHERE instr(d.path, '|' || t.task_id || '|') = 0" +
      ") SELECT task_id,status FROM descendants",
    ).all(id)
    for (const task of descendants) {
      if (!TERMINAL_TASK.has(task.status)) {
        missing.push({ task_id: task.task_id, status: task.status, reason: ACTIVE_TASK.has(task.status) ? "ACTIVE_CHILD_TASK" : "CHILD_TASK_NOT_SUCCESS" })
      }
    }
    const complete = missing.length === 0 && rows.length === planById.size && planById.size > 0
    return {
      ok: complete,
      status: complete ? "EXECUTION_COMPLETE" : (missing.some((x) => ["WORKFLOW_STATUS_NOT_FINALIZABLE", "CHILD_TASK_NOT_SUCCESS", "ACTIVE_CHILD_TASK"].includes(x.reason)) ? "EXECUTION_BLOCKED" : "EXECUTION_INCOMPLETE"),
      workflow_id: id,
      checked,
      missing,
      workflow_status: wf.status,
    }
  }

  function reviewerPassEvidence(row: any): { ok: boolean; reason?: string } {
    if (row?.last_verdict !== "PASS") return { ok: false, reason: "LAST_VERDICT_NOT_PASS" }
    const history = parse(row.review_history_json)
    const last = Array.isArray(history) && history.length ? history.at(-1) : null
    if (!last || last.verdict !== "PASS" || !row.review_task_id || last.task_id !== row.review_task_id) {
      return { ok: false, reason: "REVIEW_HISTORY_PASS_EVIDENCE_MISSING" }
    }
    const task: any = db.query("SELECT task_id,status,target_role,input_json,result_json FROM tasks WHERE task_id = ?").get(row.review_task_id)
    const taskInput = parse(task?.input_json)
    if (!task || task.status !== "COMPLETED" || taskInput?.route !== "independent_review" || task.target_role !== "reviewer") {
      return { ok: false, reason: "REVIEW_TASK_NOT_COMPLETED" }
    }
    const envelope = parse(task.result_json)
    const reviewerResult = parseJsonCandidate(envelope?.output_text)
    if (reviewerResult?.schema_version !== 1 || reviewerResult?.verdict !== "PASS") {
      return { ok: false, reason: "REVIEW_RESULT_PASS_EVIDENCE_MISSING" }
    }
    return { ok: true }
  }

  function deliveryCheck(input: any = {}) {
    const g = guard(); if (g) return g
    const exec: any = executionCheck(input)
    const id = input.workflow_id
    if (!exec || exec.ok !== true) return { ...exec, status: exec?.status === "EXECUTION_BLOCKED" ? "DELIVERY_BLOCKED" : "DELIVERY_PENDING", phase: "DELIVERY", execution: exec }
    const wf: any = db.query("SELECT * FROM workflows WHERE workflow_id = ?").get(id)
    const plan = parse(wf.plan_json) ?? {}
    const rows: any[] = db.query("SELECT * FROM workflow_nodes WHERE workflow_id = ? ORDER BY node_id").all(id)
    const requiredReviews = requiredPlanNodes(plan).filter((n: any) => n?.review?.required === true)
    const reviewerEvidence = new Map(rows.map((row: any) => [row.node_id, reviewerPassEvidence(row)]))
    const passNodes = rows.filter((r: any) => reviewerEvidence.get(r.node_id)?.ok === true)
    const reviewMissing = requiredReviews.filter((n: any) => reviewerEvidence.get(n.node_id)?.ok !== true).map((n: any) => n.node_id)
    for (const row of rows) {
      const history = parse(row.review_history_json)
      const last = Array.isArray(history) && history.length ? history.at(-1) : null
      if (row.last_verdict === "FIX" || row.last_verdict === "REWORK" || last?.verdict === "FIX" || last?.verdict === "REWORK") reviewMissing.push(row.node_id)
    }
    // The architecture contract requires an independent Reviewer PASS for
    // final delivery. Planner metadata cannot disable this safety gate.
    if (passNodes.length === 0) reviewMissing.push("<workflow-review-pass>")
    const deliverySpec = plan?.metadata?.delivery ?? {}
    const requiredRoutes = [...new Set([
      "documentation_update",
      "long_term_memory_write",
      ...(Array.isArray(deliverySpec.required_routes) ? deliverySpec.required_routes : []),
    ])]
    const requiredEvidence = Array.isArray(deliverySpec.required_evidence)
      ? deliverySpec.required_evidence.filter((item: any) => typeof item === "string" && item.trim()).map((item: string) => item.trim())
      : []
    const routeMissing = requiredRoutes.filter((route: string) => !requiredPlanNodes(plan).some((n: any) => n.route === route && NODE_SUCCESS.has(rows.find((r: any) => r.node_id === n.node_id)?.status)))
    const deliveryArtifacts: string[] = []
    const evidenceMissing: any[] = []
    for (const route of requiredRoutes) {
      const planNode = requiredPlanNodes(plan).find((node: any) => node.route === route)
      const row = planNode ? rows.find((candidate: any) => candidate.node_id === planNode.node_id) : null
      if (!row || !NODE_SUCCESS.has(row.status) || !row.current_task_id) continue
      const task: any = db.query("SELECT result_json FROM tasks WHERE task_id = ?").get(row.current_task_id)
      const result = parse(task?.result_json) ?? {}
      const artifacts = Array.isArray(result.artifacts) ? result.artifacts.filter((item: any) => typeof item === "string" && item.trim()) : []
      deliveryArtifacts.push(...artifacts)
      if (artifacts.length === 0 || typeof result.output_text !== "string" || !result.output_text.trim()) {
        evidenceMissing.push({ node_id: planNode.node_id, route, reason: "DELIVERY_ARTIFACT_EVIDENCE_MISSING" })
      }
    }
    const evidenceContractMissing = requiredEvidence.length === 0
      ? [{ reason: "DELIVERY_EVIDENCE_CONTRACT_MISSING" }]
      : requiredEvidence.filter((item: string) => !deliveryArtifacts.includes(item)).map((item: string) => ({ evidence: item, reason: "DELIVERY_EVIDENCE_MISSING" }))
    const pending = [
      ...reviewMissing.map((node_id: string) => ({ node_id, reason: "REVIEW_PASS_REQUIRED" })),
      ...routeMissing.map((route: string) => ({ route, reason: "REQUIRED_DELIVERY_ROUTE" })),
      ...evidenceMissing,
      ...evidenceContractMissing,
    ]
    const complete = pending.length === 0 && ["REVIEW_PASSED", "DELIVERY_PENDING", "DELIVERY_COMPLETE", "COMPLETED"].includes(String(wf.status))
    return { ok: complete, status: complete ? "DELIVERY_COMPLETE" : "DELIVERY_PENDING", phase: "DELIVERY", workflow_id: id, execution: exec, missing: pending, reviewer_pass: reviewMissing.length === 0 }
  }

  function finalReportPermission(input: any = {}) {
    const g = guard(); if (g) return g
    const id = typeof input.workflow_id === "string" ? input.workflow_id : ""
    if (!id) return failure("INVALID_INPUT", "workflow_id is required")
    const wf: any = db.query("SELECT * FROM workflows WHERE workflow_id = ?").get(id)
    if (!wf) return failure("WORKFLOW_NOT_FOUND", `workflow '${id}' does not exist`)
    const plan = parse(wf.plan_json) ?? {}
    const evidenceRequired = plan?.metadata?.execution_policy?.mode === "isolated_fixture" || plan?.metadata?.runtime_evidence_required === true
    const evidence: any = runtimeEvidence(input, wf, plan)
    const evidenceBlocked = evidenceRequired
      ? evidence?.ok !== true || evidence?.status === "NOT_REQUIRED"
      : evidence?.ok !== true && evidence?.status !== "NOT_REQUIRED"
    if (evidenceBlocked) {
      return {
        ok: false,
        status: "FINAL_REPORT_BLOCKED",
        code: "COMPLETION_GUARD_BLOCKED",
        detail: "runtime L3 evidence has not passed the Completion Guard",
        workflow_id: id,
        permission: false,
        evidence,
      }
    }
    const delivery: any = deliveryCheck({ workflow_id: id })
    if (wf.status === "COMPLETED" && (!wf.completion_guard_finalized_at || !wf.finished_at || wf.completion_guard_finalized_at !== wf.finished_at)) {
      return {
        ok: false,
        status: "FINAL_REPORT_BLOCKED",
        code: "COMPLETION_GUARD_BLOCKED",
        detail: "workflow is COMPLETED without matching Completion Guard provenance; failing closed",
        workflow_id: id,
        permission: false,
        delivery,
        evidence,
      }
    }
    if (delivery.ok !== true) {
      return {
        ok: false,
        status: "FINAL_REPORT_BLOCKED",
        code: "COMPLETION_GUARD_BLOCKED",
        detail: "delivery completion guard has not passed",
        workflow_id: id,
        permission: false,
        delivery,
        evidence,
      }
    }
    return {
      ok: true,
      // Plan 12 evidence is only a pre-authorization read.  L4 and the
      // FINAL_REPORT_ALLOWED claim are reserved for the successful finalize
      // transaction below.  Legacy workflows retain their historical status
      // for compatibility because they have no L3 evidence contract.
      status: evidenceRequired ? "FINAL_REPORT_PREAUTHORIZED" : "FINAL_REPORT_ALLOWED",
      workflow_id: id,
      permission: true,
      already_finalized: wf.status === "COMPLETED",
      delivery,
      evidence,
      evidence_level: evidenceRequired ? "L3" : "UNVERIFIED",
      verification: evidenceRequired ? "PASS" : "UNVERIFIED",
    }
  }

  function finalize(input: any = {}) {
    const g = guard(); if (g) return g
    const id = typeof input.workflow_id === "string" ? input.workflow_id : ""
    if (!id) return failure("INVALID_INPUT", "workflow_id is required")
    if (typeof db.transaction !== "function") return failure("SQLITE_TRANSACTION_UNAVAILABLE", "Completion Guard finalization requires an atomic SQLite transaction")
    let result: any
    try {
      db.transaction(() => {
        const permission: any = finalReportPermission({ ...input, workflow_id: id })
        if (permission.ok !== true) {
          result = permission
          return
        }
        const wf: any = db.query("SELECT * FROM workflows WHERE workflow_id = ?").get(id)
        if (wf.status === "COMPLETED") {
          result = {
            ...permission,
            status: "COMPLETED",
            final_report_permission: true,
            evidence_level: permission.evidence?.status === "NOT_REQUIRED" ? "UNVERIFIED" : "L4",
            verification: permission.evidence?.status === "NOT_REQUIRED" ? "UNVERIFIED" : "PASS",
          }
          return
        }
        if (!DELIVERY_FINALIZABLE_WORKFLOW_STATES.has(String(wf.status))) {
          result = {
            ok: false,
            status: "FINAL_REPORT_BLOCKED",
            code: "WORKFLOW_STATE_INVALID",
            detail: `workflow status '${wf.status}' is not finalizable by the Completion Guard`,
            workflow_id: id,
            permission: false,
          }
          return
        }
        const now = new Date().toISOString()
        const updated: any = db.query(
          "UPDATE workflows SET status = 'COMPLETED', updated_at = ?, finished_at = ?, completion_guard_finalized_at = ? " +
            "WHERE workflow_id = ? AND status IN ('REVIEW_PASSED', 'DELIVERY_PENDING', 'DELIVERY_COMPLETE')",
        ).run(now, now, now, id)
        if (!updated || Number(updated.changes ?? 0) !== 1) {
          result = {
            ok: false,
            status: "FINAL_REPORT_BLOCKED",
            code: "WORKFLOW_STATE_CHANGED",
            detail: "workflow state changed before guarded finalization; re-read completion status",
            workflow_id: id,
            permission: false,
          }
          return
        }
        result = {
          ok: true,
          status: "COMPLETED",
          workflow_id: id,
          final_report_permission: true,
          delivery_status: "DELIVERY_COMPLETE",
          finalized_at: now,
          evidence: permission.evidence,
          evidence_level: permission.evidence?.status === "NOT_REQUIRED" ? "UNVERIFIED" : "L4",
          verification: permission.evidence?.status === "NOT_REQUIRED" ? "UNVERIFIED" : "PASS",
        }
      })()
    } catch (error: any) {
      return failure("COMPLETION_GUARD_TRANSACTION_FAILED", error?.message ?? String(error), { workflow_id: id })
    }
    return result ?? failure("COMPLETION_GUARD_BLOCKED", "Completion Guard produced no finalization result", { workflow_id: id })
  }

  function status(input: any = {}) {
    const exec = executionCheck(input)
    const delivery = exec?.ok ? deliveryCheck(input) : { ok: false, status: "DELIVERY_PENDING", phase: "DELIVERY", execution: exec }
    return { ok: exec?.ok === true && delivery?.ok === true, workflow_id: input.workflow_id, execution: exec, delivery }
  }

  return { executionCheck, deliveryCheck, finalReportPermission, finalize, status }
}
