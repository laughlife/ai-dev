// Deterministic Completion Guard (Plan 9 Part A).
// It reads runtime state and returns evidence; it never invokes an Agent and
// never mutates the workflow/task database.

const NODE_SUCCESS = new Set(["COMPLETED", "REVIEW_PASSED"])
const ACTIVE_TASK = new Set(["READY", "RUNNING"])

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
    const planById = new Map(requiredPlanNodes(plan).map((n: any) => [n.node_id, n]))
    const rows: any[] = db.query("SELECT * FROM workflow_nodes WHERE workflow_id = ? ORDER BY node_id").all(id)
    const byId = new Map(rows.map((r: any) => [r.node_id, r]))
    const missing: any[] = []
    const checked: any[] = []
    for (const [nodeId, planNode] of planById) {
      const row: any = byId.get(nodeId)
      const status = row?.status ?? "MISSING"
      checked.push({ node_id: nodeId, status })
      if (!row || !NODE_SUCCESS.has(status)) missing.push({ node_id: nodeId, status, reason: "NODE_NOT_TERMINAL_SUCCESS" })
      for (const dep of (Array.isArray(planNode.depends_on) ? planNode.depends_on : [])) {
        const depRow: any = byId.get(dep)
        if (!depRow || !NODE_SUCCESS.has(depRow.status)) missing.push({ node_id: nodeId, dependency: dep, reason: "DEPENDENCY_NOT_COMPLETE" })
      }
      if (row?.current_task_id) {
        const task: any = db.query("SELECT task_id,status FROM tasks WHERE task_id = ?").get(row.current_task_id)
        if (task && ACTIVE_TASK.has(task.status)) missing.push({ node_id: nodeId, task_id: task.task_id, reason: "ACTIVE_CHILD_TASK" })
      }
    }
    const schedulerActive = ["READY", "RUNNING", "REVIEWING", "REWORKING", "BLOCKED"].includes(String(wf.status))
    if (schedulerActive) missing.push({ reason: "SCHEDULER_OR_WORKFLOW_ACTIVE", workflow_status: wf.status })
    const complete = missing.length === 0 && rows.length >= planById.size && planById.size > 0
    return {
      ok: complete,
      status: complete ? "EXECUTION_COMPLETE" : (missing.some((x) => String(x.reason).includes("BLOCKED")) ? "EXECUTION_BLOCKED" : "EXECUTION_INCOMPLETE"),
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
    if (!exec || exec.ok !== true) return { ...exec, status: "DELIVERY_PENDING", phase: "DELIVERY", execution: exec }
    const wf: any = db.query("SELECT * FROM workflows WHERE workflow_id = ?").get(id)
    const plan = parse(wf.plan_json) ?? {}
    const rows: any[] = db.query("SELECT * FROM workflow_nodes WHERE workflow_id = ? ORDER BY node_id").all(id)
    const requiredReviews = requiredPlanNodes(plan).filter((n: any) => n?.review?.required === true)
    const passNodes = rows.filter((r: any) => r.last_verdict === "PASS")
    const reviewMissing = requiredReviews.filter((n: any) => rows.find((r: any) => r.node_id === n.node_id)?.last_verdict !== "PASS").map((n: any) => n.node_id)
    const reviewerRequired = plan?.metadata?.delivery?.reviewer_pass_required !== false
    if (reviewerRequired && passNodes.length === 0) reviewMissing.push("<workflow-review-pass>")
    const requiredRoutes = Array.isArray(plan?.metadata?.delivery?.required_routes) ? plan.metadata.delivery.required_routes : []
    const routeMissing = requiredRoutes.filter((route: string) => !requiredPlanNodes(plan).some((n: any) => n.route === route && NODE_SUCCESS.has(rows.find((r: any) => r.node_id === n.node_id)?.status)))
    const pending = [...reviewMissing.map((node_id: string) => ({ node_id, reason: "REVIEW_PASS_REQUIRED" })), ...routeMissing.map((route: string) => ({ route, reason: "REQUIRED_DELIVERY_ROUTE" }))]
    const complete = pending.length === 0 && ["REVIEW_PASSED", "DELIVERY_PENDING", "DELIVERY_COMPLETE", "COMPLETED"].includes(String(wf.status))
    return { ok: complete, status: complete ? "DELIVERY_COMPLETE" : "DELIVERY_PENDING", phase: "DELIVERY", workflow_id: id, execution: exec, missing: pending, reviewer_pass: reviewMissing.length === 0 }
  }

  function status(input: any = {}) {
    const exec = executionCheck(input)
    const delivery = exec?.ok ? deliveryCheck(input) : { ok: false, status: "DELIVERY_PENDING", phase: "DELIVERY", execution: exec }
    return { ok: exec?.ok === true && delivery?.ok === true, workflow_id: input.workflow_id, execution: exec, delivery }
  }

  return { executionCheck, deliveryCheck, status }
}
