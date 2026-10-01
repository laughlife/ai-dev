// Deterministic delivery-chain policy for Workflow Engine plans.
// Reviewer PASS is represented by the review gate node; documentation and
// memory nodes are ordinary DAG nodes which therefore run only after that
// gate and after one another. Evidence is emitted by the agents themselves;
// this module never invents a file or Mem0 write.

const DELIVERY_ROUTES = ["documentation_update", "long_term_memory_write"] as const

function nonEmpty(value: any): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function uniqueStrings(values: any): string[] {
  return [...new Set(Array.isArray(values) ? values.filter(nonEmpty).map((value) => value.trim()) : [])]
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

function parseCandidate(value: any): any {
  if (typeof value !== "string" || !value.trim()) return null
  try { return JSON.parse(value.trim()) } catch {}
  const start = value.indexOf("{")
  const end = value.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  try { return JSON.parse(value.slice(start, end + 1)) } catch { return null }
}

export function deliveryEvidenceFor(workflowId: string): string[] {
  return [
    `docs/workflows/${workflowId}/delivery.md`,
    `memory:workflow:${workflowId}`,
  ]
}

/** Add the persisted independent-review task as truthful route evidence. */
export function withReviewerPassEvidence(envelope: any, reviewTaskId: string): any {
  const updated = clone(envelope && typeof envelope === "object" ? envelope : {})
  const refs = uniqueStrings(updated.context_refs)
  if (nonEmpty(reviewTaskId)) refs.push(`task:${reviewTaskId}`)
  updated.context_refs = uniqueStrings(refs)
  return updated
}

/**
 * Make the architecture-mandated post-review chain explicit before DAG
 * validation/materialization. Existing delivery nodes are preserved; missing
 * nodes are added with deterministic ids and dependencies. The returned
 * object is a copy and the input is never mutated.
 */
export function normalizeDeliveryPlan(input: any, options: { workflowId: string; primaryProjectId: string }):
  | { ok: true; plan: any; added: string[] }
  | { ok: false; reason: string } {
  if (!input || typeof input !== "object" || Array.isArray(input) || !Array.isArray(input.nodes)) {
    return { ok: false, reason: "PLAN_NOT_OBJECT_OR_NODES_MISSING" }
  }
  if (!nonEmpty(options?.workflowId) || !nonEmpty(options?.primaryProjectId)) {
    return { ok: false, reason: "DELIVERY_CHAIN_CONTEXT_MISSING" }
  }
  const plan = clone(input)
  const nodes: any[] = plan.nodes
  const projectId = nonEmpty(plan.project_scope?.[0]) ? plan.project_scope[0] : options.primaryProjectId
  const reviewGateIds = nodes
    .filter((node) => node && node.review?.required === true)
    .map((node) => node.node_id)
    .filter(nonEmpty)
  if (reviewGateIds.length === 0) {
    return { ok: false, reason: "REVIEW_GATE_REQUIRED_FOR_DELIVERY_CHAIN" }
  }
  const added: string[] = []

  const byRoute = (route: string) => nodes.find((node) => node?.route === route)
  const docsId = byRoute("documentation_update")?.node_id ?? "delivery-documentation"
  const memoryId = byRoute("long_term_memory_write")?.node_id ?? "delivery-memory"
  const evidence = deliveryEvidenceFor(options.workflowId)

  let docs = byRoute("documentation_update")
  if (!docs) {
    docs = {
      node_id: docsId,
      project_id: projectId,
      route: "documentation_update",
      objective: `Reviewer PASS 后更新交付文档，并以 JSON artifacts 明确返回 ${evidence[0]}`,
      depends_on: [],
      constraints: ["仅在上游 Reviewer PASS 后执行", "不得伪造文档路径", "输出必须包含 artifacts 数组"],
      expected_output: [`JSON 对象，artifacts 必须包含 ${evidence[0]}`],
      acceptance_criteria: [`真实更新文档并返回 artifact: ${evidence[0]}`],
      metadata: { delivery_role: "documentation", required_evidence: [evidence[0]] },
    }
    nodes.push(docs)
    added.push(docsId)
  }
  docs.depends_on = uniqueStrings([...(docs.depends_on ?? []), ...reviewGateIds]).filter((id) => id !== docs.node_id)
  docs.metadata = { ...(docs.metadata ?? {}), delivery_role: "documentation", required_evidence: [evidence[0]] }

  let memory = byRoute("long_term_memory_write")
  if (!memory) {
    memory = {
      node_id: memoryId,
      project_id: projectId,
      route: "long_term_memory_write",
      objective: `Documentation 完成后仅写入长期有效知识，并以 JSON artifacts 明确返回 ${evidence[1]}`,
      depends_on: [],
      constraints: ["仅使用 Documentation 交付结果", "禁止保存临时任务状态", "不得伪造 Mem0 写入"],
      expected_output: [`JSON 对象，artifacts 必须包含 ${evidence[1]}`],
      acceptance_criteria: [`真实长期记忆写入并返回 artifact: ${evidence[1]}`],
      metadata: { delivery_role: "memory-governance", required_evidence: [evidence[1]] },
    }
    nodes.push(memory)
    added.push(memoryId)
  }
  memory.depends_on = uniqueStrings([...(memory.depends_on ?? []), docs.node_id]).filter((id) => id !== memory.node_id)
  memory.metadata = { ...(memory.metadata ?? {}), delivery_role: "memory-governance", required_evidence: [evidence[1]] }

  const current = plan.metadata?.delivery ?? {}
  plan.metadata = {
    ...(plan.metadata ?? {}),
    delivery: {
      ...current,
      required_routes: uniqueStrings([...(current.required_routes ?? []), ...DELIVERY_ROUTES]),
      required_evidence: uniqueStrings([...(current.required_evidence ?? []), ...evidence]),
      chain: "reviewer_pass -> documentation_update -> long_term_memory_write",
    },
  }
  return { ok: true, plan, added }
}

/** Validate agent-produced delivery evidence without manufacturing it. */
export function validateDeliveryResult(route: string, result: any, expectedEvidence: string[] = []) {
  if (!DELIVERY_ROUTES.includes(route as any)) return { ok: true, artifacts: Array.isArray(result?.artifacts) ? result.artifacts : [] }
  if (result?.status !== "COMPLETED" || !nonEmpty(result?.output_text)) {
    return { ok: false, reason: "DELIVERY_OUTPUT_MISSING" }
  }
  const parsed = parseCandidate(result.output_text)
  const artifacts = uniqueStrings([
    ...(Array.isArray(result?.artifacts) ? result.artifacts : []),
    ...(Array.isArray(parsed?.artifacts) ? parsed.artifacts : []),
  ])
  if (artifacts.length === 0) return { ok: false, reason: "DELIVERY_ARTIFACT_EVIDENCE_MISSING" }
  const missing = uniqueStrings(expectedEvidence).filter((item) => !artifacts.includes(item))
  if (missing.length > 0) return { ok: false, reason: "DELIVERY_EVIDENCE_MISSING", missing }
  return { ok: true, artifacts }
}

