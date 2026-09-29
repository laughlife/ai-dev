// Workflow DAG validation — pure deterministic functions (Plan 7 Phase 4, T7a)
//
// §37: the Workflow Engine validates Planner output with deterministic
// algorithms only (schema checks, unique node_id, registered project/route,
// depends_on existence, no self-dependency, Kahn cycle detection, §17 review
// gate ancestor rule). An LLM NEVER judges whether a DAG is valid.
//
// This module is pure: no ctx, no db, no fs, no config access. The caller
// injects config lookups via ctxInfo so the module stays offline-testable.
// Also exports computeDescendantSubgraph (consumed by the T7b scheduler for
// FIX/REWORK impact scoping) and extractJsonObject (§36 deterministic JSON
// extraction, same strategy as task-bus-core parseReviewerResultText).

export interface WorkflowPlanError {
  code: string
  message: string
  node_id?: string
}

export interface DagCtxInfo {
  isProjectRegistered(projectId: string): boolean
  isRouteRegistered(route: string): boolean
}

export type ValidateWorkflowPlanResult =
  | { ok: true; order: string[] }
  | { ok: false; errors: WorkflowPlanError[] }

function isNonEmptyString(v: any): v is string {
  return typeof v === "string" && v.trim().length > 0
}

function isStringArray(v: any): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string")
}

// --- reachability along depends_on edges (iterative DFS, visited set =>
// cycle-safe and fully deterministic). Returns true when `to` is reachable
// from `from` via ONE OR MORE dependency edges. ---
function reachesViaDeps(depsOf: Map<string, string[]>, from: string, to: string): boolean {
  const visited = new Set<string>()
  const stack: string[] = [...(depsOf.get(from) ?? [])]
  while (stack.length > 0) {
    const cur = stack.pop() as string
    if (cur === to) return true
    if (visited.has(cur)) continue
    visited.add(cur)
    for (const dep of depsOf.get(cur) ?? []) stack.push(dep)
  }
  return false
}

// --- "is targetId an ancestor of nodeId?" via the node map's depends_on
// chains (iterative DFS; deterministic; cycle-safe). ---
function isAncestor(byId: Map<string, any>, nodeId: string, targetId: string): boolean {
  const visited = new Set<string>()
  const stack: string[] = []
  const start = byId.get(nodeId)
  if (start && isStringArray(start.depends_on)) stack.push(...start.depends_on)
  while (stack.length > 0) {
    const cur = stack.pop() as string
    if (cur === targetId) return true
    if (visited.has(cur)) continue
    visited.add(cur)
    const n = byId.get(cur)
    if (n && isStringArray(n.depends_on)) stack.push(...n.depends_on)
  }
  return false
}

// --- Kahn topological sort (§37). Deterministic: initial zero-indegree queue
// and dependent lists both follow plan node order; FIFO queue. Invalid /
// unknown / self dependency edges are ignored here (they are reported as
// structural errors by validateWorkflowPlan). `remaining` holds nodes that
// are part of, or downstream of, at least one cycle. ---
function kahn(byId: Map<string, any>, nodeIds: string[]): {
  order: string[]
  remaining: string[]
  depsOf: Map<string, string[]>
} {
  const depsOf = new Map<string, string[]>()
  const indegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const nid of nodeIds) {
    depsOf.set(nid, [])
    indegree.set(nid, 0)
    dependents.set(nid, [])
  }
  for (const nid of nodeIds) {
    const node = byId.get(nid)
    const uniq = new Set<string>()
    if (node && isStringArray(node.depends_on)) {
      for (const dep of node.depends_on) {
        if (dep === nid || !byId.has(dep) || uniq.has(dep)) continue
        uniq.add(dep)
      }
    }
    depsOf.set(nid, [...uniq])
    indegree.set(nid, uniq.size)
    for (const dep of uniq) (dependents.get(dep) as string[]).push(nid)
  }
  const queue: string[] = nodeIds.filter((nid) => indegree.get(nid) === 0)
  const order: string[] = []
  const done = new Set<string>()
  let head = 0
  while (head < queue.length) {
    const nid = queue[head++]
    order.push(nid)
    done.add(nid)
    for (const next of dependents.get(nid) as string[]) {
      const d = (indegree.get(next) as number) - 1
      indegree.set(next, d)
      if (d === 0) queue.push(next)
    }
  }
  return { order, remaining: nodeIds.filter((nid) => !done.has(nid)), depsOf }
}

// =====================================================================
// §37 + §17: deterministic workflow-plan validation.
// Returns { ok:true, order } (order = Kahn topological order of node_id,
// materialization order) or { ok:false, errors } with stable error codes:
//   PLAN_NOT_OBJECT / SCHEMA_VERSION_INVALID / WORKFLOW_OBJECTIVE_INVALID /
//   NODES_INVALID / NODE_NOT_OBJECT / NODE_ID_INVALID / NODE_ID_DUPLICATE /
//   PROJECT_ID_INVALID / PROJECT_NOT_REGISTERED / ROUTE_INVALID /
//   ROUTE_NOT_REGISTERED / NODE_OBJECTIVE_INVALID / DEPENDS_ON_INVALID /
//   SELF_DEPENDENCY / DEPENDENCY_NODE_NOT_FOUND / NODE_FIELD_INVALID /
//   REVIEW_INVALID / DAG_CYCLE / REVIEW_TARGET_INVALID
// =====================================================================
export function validateWorkflowPlan(plan: any, ctxInfo: DagCtxInfo): ValidateWorkflowPlanResult {
  const errors: WorkflowPlanError[] = []
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return { ok: false, errors: [{ code: "PLAN_NOT_OBJECT", message: "workflow plan must be a JSON object" }] }
  }
  if (plan.schema_version !== 1) {
    errors.push({
      code: "SCHEMA_VERSION_INVALID",
      message: `schema_version must be 1 (got ${JSON.stringify(plan.schema_version ?? null)})`,
    })
  }
  if (!isNonEmptyString(plan.workflow_objective)) {
    errors.push({ code: "WORKFLOW_OBJECTIVE_INVALID", message: "workflow_objective must be a non-empty string" })
  }
  if (!Array.isArray(plan.nodes) || plan.nodes.length === 0) {
    errors.push({ code: "NODES_INVALID", message: "nodes must be a non-empty array" })
    return { ok: false, errors }
  }

  // --- pass 1: per-node structure (plan order) ---
  const nodeIds: string[] = []
  const byId = new Map<string, any>() // first occurrence wins for graph checks
  for (let i = 0; i < plan.nodes.length; i++) {
    const node = plan.nodes[i]
    const at = `nodes[${i}]`
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      errors.push({ code: "NODE_NOT_OBJECT", message: `${at} must be a JSON object` })
      continue
    }
    const nid = node.node_id
    if (!isNonEmptyString(nid)) {
      errors.push({ code: "NODE_ID_INVALID", message: `${at}.node_id must be a non-empty string` })
      continue
    }
    if (byId.has(nid)) {
      errors.push({ code: "NODE_ID_DUPLICATE", message: `node_id '${nid}' is duplicated (${at})`, node_id: nid })
      continue
    }
    nodeIds.push(nid)
    byId.set(nid, node)

    if (!isNonEmptyString(node.project_id)) {
      errors.push({ code: "PROJECT_ID_INVALID", message: `${at}.project_id must be a non-empty string`, node_id: nid })
    } else if (!ctxInfo.isProjectRegistered(node.project_id)) {
      errors.push({
        code: "PROJECT_NOT_REGISTERED",
        message: `node '${nid}' project_id '${node.project_id}' is not registered in framework-config/projects.yaml`,
        node_id: nid,
      })
    }
    if (!isNonEmptyString(node.route)) {
      errors.push({ code: "ROUTE_INVALID", message: `${at}.route must be a non-empty string`, node_id: nid })
    } else if (!ctxInfo.isRouteRegistered(node.route)) {
      errors.push({
        code: "ROUTE_NOT_REGISTERED",
        message: `node '${nid}' route '${node.route}' is not registered in framework-config/routing.yaml routes`,
        node_id: nid,
      })
    }
    if (!isNonEmptyString(node.objective)) {
      errors.push({ code: "NODE_OBJECTIVE_INVALID", message: `${at}.objective must be a non-empty string`, node_id: nid })
    }
    if (!isStringArray(node.depends_on)) {
      errors.push({
        code: "DEPENDS_ON_INVALID",
        message: `${at}.depends_on must be an array of node_id strings (use [] when the node has no dependencies)`,
        node_id: nid,
      })
    } else {
      for (const dep of node.depends_on) {
        if (dep === nid) {
          errors.push({ code: "SELF_DEPENDENCY", message: `node '${nid}' depends on itself`, node_id: nid })
        }
      }
    }
    for (const f of ["constraints", "expected_output", "acceptance_criteria"]) {
      const v = (node as any)[f]
      if (v !== undefined && v !== null && !isStringArray(v)) {
        errors.push({ code: "NODE_FIELD_INVALID", message: `${at}.${f} must be an array of strings when present`, node_id: nid })
      }
    }
    if (node.metadata !== undefined && node.metadata !== null && (typeof node.metadata !== "object" || Array.isArray(node.metadata))) {
      errors.push({ code: "NODE_FIELD_INVALID", message: `${at}.metadata must be an object when present`, node_id: nid })
    }
    if (node.review !== undefined && node.review !== null) {
      const r = node.review
      if (!r || typeof r !== "object" || Array.isArray(r)) {
        errors.push({
          code: "REVIEW_INVALID",
          message: `${at}.review must be an object { required?, target_node_id? } when present`,
          node_id: nid,
        })
      } else {
        if (r.required !== undefined && typeof r.required !== "boolean") {
          errors.push({ code: "REVIEW_INVALID", message: `${at}.review.required must be a boolean when present`, node_id: nid })
        }
        if (r.target_node_id !== undefined && r.target_node_id !== null && !isNonEmptyString(r.target_node_id)) {
          errors.push({ code: "REVIEW_INVALID", message: `${at}.review.target_node_id must be a string or null`, node_id: nid })
        }
      }
    }
  }

  // --- pass 2: depends_on existence (needs the complete node_id set) ---
  for (const nid of nodeIds) {
    const node = byId.get(nid)
    if (!node || !isStringArray(node.depends_on)) continue // already reported
    const reported = new Set<string>()
    for (const dep of node.depends_on) {
      if (dep === nid || byId.has(dep) || reported.has(dep)) continue
      reported.add(dep)
      errors.push({
        code: "DEPENDENCY_NODE_NOT_FOUND",
        message: `node '${nid}' depends_on '${dep}' which is not a node_id of this plan`,
        node_id: nid,
      })
    }
  }

  // --- pass 3: Kahn topological sort + deterministic cycle detection (§37) ---
  const { order, remaining, depsOf } = kahn(byId, nodeIds)
  if (remaining.length > 0) {
    // true cycle members are exactly the self-reachable remaining nodes;
    // remaining non-cycle nodes are merely downstream of a cycle
    let cycleNodes = remaining.filter((nid) => reachesViaDeps(depsOf, nid, nid))
    if (cycleNodes.length === 0) cycleNodes = remaining // defensive fallback
    for (const nid of cycleNodes) {
      errors.push({
        code: "DAG_CYCLE",
        message: `node '${nid}' is part of a dependency cycle: [${cycleNodes.join(" -> ")}]`,
        node_id: nid,
      })
    }
  }

  // --- pass 4: review gate validation (§17). review.required=true demands:
  // target_node_id exists, != current node, and is an ANCESTOR of the gate
  // node (deterministic DFS reachability) so a Reviewer can never be pointed
  // at an unrelated node. ---
  for (const nid of nodeIds) {
    const node = byId.get(nid)
    const r = node?.review
    if (!r || typeof r !== "object" || Array.isArray(r)) continue
    if (r.required !== true) continue
    const target = r.target_node_id
    if (!isNonEmptyString(target)) {
      errors.push({
        code: "REVIEW_TARGET_INVALID",
        message: `node '${nid}' has review.required=true but review.target_node_id is missing or not a non-empty string`,
        node_id: nid,
      })
      continue
    }
    if (!byId.has(target)) {
      errors.push({
        code: "REVIEW_TARGET_INVALID",
        message: `node '${nid}' review.target_node_id '${target}' is not a node_id of this plan`,
        node_id: nid,
      })
      continue
    }
    if (target === nid) {
      errors.push({
        code: "REVIEW_TARGET_INVALID",
        message: `node '${nid}' review.target_node_id must not equal the review gate node itself`,
        node_id: nid,
      })
      continue
    }
    if (!isAncestor(byId, nid, target)) {
      errors.push({
        code: "REVIEW_TARGET_INVALID",
        message: `node '${nid}' review.target_node_id '${target}' is not an ancestor of the review gate node (a reviewer may only rework upstream nodes)`,
        node_id: nid,
      })
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, order }
}

// =====================================================================
// FIX/REWORK impact scope (T7b consumer; exported in T7a).
// Given a review gate node (gateNodeId) and its review target (targetNodeId,
// an ancestor of the gate), returns the affected node set between them:
// every node X with (X === target OR target is an ancestor of X) AND
// (X === gate OR X is an ancestor of gate) — i.e. target, gate and exactly
// the nodes on dependency paths between them. Unrelated parallel branches
// are never included. Result is ordered by the deterministic Kahn topological
// order (plan order for any cycle leftovers — a validated plan has none).
// Invalid/unknown ids yield [].
// =====================================================================
export function computeDescendantSubgraph(plan: any, targetNodeId: string, gateNodeId: string): string[] {
  if (!plan || typeof plan !== "object" || Array.isArray(plan) || !Array.isArray(plan.nodes)) return []
  const byId = new Map<string, any>()
  const nodeIds: string[] = []
  for (const node of plan.nodes) {
    if (!node || typeof node !== "object" || Array.isArray(node)) continue
    if (!isNonEmptyString(node.node_id) || byId.has(node.node_id)) continue
    byId.set(node.node_id, node)
    nodeIds.push(node.node_id)
  }
  if (!isNonEmptyString(targetNodeId) || !isNonEmptyString(gateNodeId)) return []
  if (!byId.has(targetNodeId) || !byId.has(gateNodeId)) return []
  const affected = new Set<string>()
  for (const nid of nodeIds) {
    const downstreamOfTarget = nid === targetNodeId || isAncestor(byId, nid, targetNodeId)
    const upstreamOfGate = nid === gateNodeId || isAncestor(byId, gateNodeId, nid)
    if (downstreamOfTarget && upstreamOfGate) affected.add(nid)
  }
  const { order, remaining } = kahn(byId, nodeIds)
  const full = [...order, ...remaining] // deterministic; remaining is empty for validated plans
  return full.filter((nid) => affected.has(nid))
}

// =====================================================================
// §36 deterministic JSON extraction (same strategy as the task bus core's
// parseReviewerResultText): JSON.parse the whole trimmed text first; on
// failure cut the candidate substring from the FIRST '{' to the LAST '}'
// and parse that. The result must be a plain JSON object. Never an LLM.
// =====================================================================
export function extractJsonObject(text: any): { ok: true; value: any } | { ok: false; error: string } {
  if (typeof text !== "string" || !text.trim()) {
    return { ok: false, error: "planner output is missing or empty" }
  }
  const trimmed = text.trim()
  let parsed: any = null
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf("{")
    const end = trimmed.lastIndexOf("}")
    if (start < 0 || end <= start) {
      return { ok: false, error: "planner output is not JSON (no '{...}' substring found)" }
    }
    try {
      parsed = JSON.parse(trimmed.slice(start, end + 1))
    } catch {
      return {
        ok: false,
        error: "planner output is not valid JSON (whole-text and first-'{'..last-'}' parses both failed)",
      }
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "extracted JSON value is not a plain object" }
  }
  return { ok: true, value: parsed }
}
