// Deterministic Completion Guard (Plan 9 Part A + U4).
// It never invokes an Agent. Read-only checks return evidence; the explicit
// finalize operation is the sole guarded workflow-closing mutation.

const NODE_SUCCESS = new Set(["COMPLETED", "REVIEW_PASSED"])
const ACTIVE_TASK = new Set(["READY", "RUNNING", "BLOCKED"])
const EXECUTION_ALLOWED_WORKFLOW_STATES = new Set(["REVIEW_PASSED", "DELIVERY_PENDING", "DELIVERY_COMPLETE", "COMPLETED"])
const DELIVERY_FINALIZABLE_WORKFLOW_STATES = new Set(["REVIEW_PASSED", "DELIVERY_PENDING", "DELIVERY_COMPLETE"])
const TERMINAL_TASK = new Set(["COMPLETED"])

function parse(value: any): any {
  if (typeof value !== "string" || !value) return null
  try { return JSON.parse(value) } catch { return null }
}

function failure(code: string, detail: string, extra: any = {}) {
  return { ok: false, status: "ERROR", code, detail, ...extra }
}

function requiredPlanNodes(plan: any): any[] {
  return Array.isArray(plan?.nodes) ? plan.nodes.filter((n: any) => n?.metadata?.required !== false) : []
}

export function createCompletionCore(runtimeCore: any) {
  const db = runtimeCore?.db
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
    const activeChildren: any[] = db.query("SELECT task_id,status FROM tasks WHERE parent_task_id IN (SELECT current_task_id FROM workflow_nodes WHERE workflow_id = ?)").all(id)
    for (const task of activeChildren) if (!TERMINAL_TASK.has(task.status)) missing.push({ task_id: task.task_id, status: task.status, reason: "ACTIVE_CHILD_TASK" })
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

  function deliveryCheck(input: any = {}) {
    const g = guard(); if (g) return g
    const exec: any = executionCheck(input)
    const id = input.workflow_id
    if (!exec || exec.ok !== true) return { ...exec, status: exec?.status === "EXECUTION_BLOCKED" ? "DELIVERY_BLOCKED" : "DELIVERY_PENDING", phase: "DELIVERY", execution: exec }
    const wf: any = db.query("SELECT * FROM workflows WHERE workflow_id = ?").get(id)
    const plan = parse(wf.plan_json) ?? {}
    const rows: any[] = db.query("SELECT * FROM workflow_nodes WHERE workflow_id = ? ORDER BY node_id").all(id)
    const requiredReviews = requiredPlanNodes(plan).filter((n: any) => n?.review?.required === true)
    const passNodes = rows.filter((r: any) => r.last_verdict === "PASS")
    const reviewMissing = requiredReviews.filter((n: any) => rows.find((r: any) => r.node_id === n.node_id)?.last_verdict !== "PASS").map((n: any) => n.node_id)
    for (const row of rows) {
      const history = parse(row.review_history_json)
      const last = Array.isArray(history) && history.length ? history.at(-1) : null
      if (last?.verdict === "FIX" || last?.verdict === "REWORK") reviewMissing.push(row.node_id)
    }
    const reviewerRequired = plan?.metadata?.delivery?.reviewer_pass_required !== false
    if (reviewerRequired && passNodes.length === 0) reviewMissing.push("<workflow-review-pass>")
    const requiredRoutes = Array.isArray(plan?.metadata?.delivery?.required_routes) ? plan.metadata.delivery.required_routes : []
    const routeMissing = requiredRoutes.filter((route: string) => !requiredPlanNodes(plan).some((n: any) => n.route === route && NODE_SUCCESS.has(rows.find((r: any) => r.node_id === n.node_id)?.status)))
    const pending = [...reviewMissing.map((node_id: string) => ({ node_id, reason: "REVIEW_PASS_REQUIRED" })), ...routeMissing.map((route: string) => ({ route, reason: "REQUIRED_DELIVERY_ROUTE" }))]
    const complete = pending.length === 0 && ["REVIEW_PASSED", "DELIVERY_PENDING", "DELIVERY_COMPLETE", "COMPLETED"].includes(String(wf.status))
    return { ok: complete, status: complete ? "DELIVERY_COMPLETE" : "DELIVERY_PENDING", phase: "DELIVERY", workflow_id: id, execution: exec, missing: pending, reviewer_pass: reviewMissing.length === 0 }
  }

  function finalReportPermission(input: any = {}) {
    const g = guard(); if (g) return g
    const id = typeof input.workflow_id === "string" ? input.workflow_id : ""
    if (!id) return failure("INVALID_INPUT", "workflow_id is required")
    const wf: any = db.query("SELECT * FROM workflows WHERE workflow_id = ?").get(id)
    if (!wf) return failure("WORKFLOW_NOT_FOUND", `workflow '${id}' does not exist`)
    const delivery: any = deliveryCheck({ workflow_id: id })
    if (wf.status === "COMPLETED" && !wf.finished_at) {
      return {
        ok: false,
        status: "FINAL_REPORT_BLOCKED",
        code: "COMPLETION_GUARD_BLOCKED",
        detail: "workflow is COMPLETED without a Completion Guard finalization timestamp; failing closed",
        workflow_id: id,
        permission: false,
        delivery,
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
      }
    }
    return {
      ok: true,
      status: "FINAL_REPORT_ALLOWED",
      workflow_id: id,
      permission: true,
      already_finalized: wf.status === "COMPLETED",
      delivery,
    }
  }

  function finalize(input: any = {}) {
    const g = guard(); if (g) return g
    const id = typeof input.workflow_id === "string" ? input.workflow_id : ""
    if (!id) return failure("INVALID_INPUT", "workflow_id is required")
    const permission: any = finalReportPermission({ workflow_id: id })
    if (permission.ok !== true) return permission
    const wf: any = db.query("SELECT * FROM workflows WHERE workflow_id = ?").get(id)
    if (wf.status === "COMPLETED") return { ...permission, status: "COMPLETED", final_report_permission: true }
    if (!DELIVERY_FINALIZABLE_WORKFLOW_STATES.has(String(wf.status))) {
      return {
        ok: false,
        status: "FINAL_REPORT_BLOCKED",
        code: "WORKFLOW_STATE_INVALID",
        detail: `workflow status '${wf.status}' is not finalizable by the Completion Guard`,
        workflow_id: id,
        permission: false,
      }
    }
    const now = new Date().toISOString()
    const updated: any = db.query(
      "UPDATE workflows SET status = 'COMPLETED', updated_at = ?, finished_at = ? " +
        "WHERE workflow_id = ? AND status IN ('REVIEW_PASSED', 'DELIVERY_PENDING', 'DELIVERY_COMPLETE')",
    ).run(now, now, id)
    if (!updated || Number(updated.changes ?? 0) !== 1) {
      return {
        ok: false,
        status: "FINAL_REPORT_BLOCKED",
        code: "WORKFLOW_STATE_CHANGED",
        detail: "workflow state changed before guarded finalization; re-read completion status",
        workflow_id: id,
        permission: false,
      }
    }
    return {
      ok: true,
      status: "COMPLETED",
      workflow_id: id,
      final_report_permission: true,
      delivery_status: "DELIVERY_COMPLETE",
      finalized_at: now,
    }
  }

  function status(input: any = {}) {
    const exec = executionCheck(input)
    const delivery = exec?.ok ? deliveryCheck(input) : { ok: false, status: "DELIVERY_PENDING", phase: "DELIVERY", execution: exec }
    return { ok: exec?.ok === true && delivery?.ok === true, workflow_id: input.workflow_id, execution: exec, delivery }
  }

  return { executionCheck, deliveryCheck, finalReportPermission, finalize, status }
}
