import assert from "node:assert/strict"
import { test } from "node:test"
import {
  normalizeDeliveryPlan,
  validateDeliveryResult,
  withReviewerPassEvidence,
} from "../lib/delivery-chain.ts"

test("normalizes a reviewer-pass documentation then memory chain", () => {
  const plan = {
    schema_version: 1,
    workflow_objective: "demo",
    nodes: [
      { node_id: "build", project_id: "demo", route: "build_and_test", objective: "build", depends_on: [], review: { required: true, target_node_id: "impl" } },
      { node_id: "impl", project_id: "demo", route: "code_change", objective: "implement", depends_on: [] },
    ],
  }
  const result = normalizeDeliveryPlan(plan, { workflowId: "wf-1", primaryProjectId: "demo" })
  assert.equal(result.ok, true)
  assert.deepEqual(result.plan.metadata.delivery.required_routes, ["documentation_update", "long_term_memory_write"])
  const docs = result.plan.nodes.find((node) => node.route === "documentation_update")
  const memory = result.plan.nodes.find((node) => node.route === "long_term_memory_write")
  assert.ok(docs)
  assert.ok(memory)
  assert.deepEqual(docs.depends_on, ["build"])
  assert.deepEqual(memory.depends_on, [docs.node_id])
  assert.deepEqual(result.plan.metadata.delivery.required_evidence, [
    "docs/workflows/wf-1/delivery.md",
    "memory:workflow:wf-1",
  ])
})

test("rejects delivery completion when the agent did not emit explicit evidence", () => {
  const missing = validateDeliveryResult("documentation_update", {
    status: "COMPLETED",
    output_text: "文档已更新",
    artifacts: [],
  }, ["docs/workflows/wf-1/delivery.md"])
  assert.equal(missing.ok, false)
  assert.equal(missing.reason, "DELIVERY_ARTIFACT_EVIDENCE_MISSING")

  const valid = validateDeliveryResult("documentation_update", {
    status: "COMPLETED",
    output_text: JSON.stringify({ artifacts: ["docs/workflows/wf-1/delivery.md"] }),
    artifacts: [],
  }, ["docs/workflows/wf-1/delivery.md"])
  assert.equal(valid.ok, true)
  assert.deepEqual(valid.artifacts, ["docs/workflows/wf-1/delivery.md"])
})

test("fails closed when a plan has no independent review gate", () => {
  const result = normalizeDeliveryPlan({
    schema_version: 1,
    workflow_objective: "unsafe",
    nodes: [{ node_id: "work", project_id: "demo", route: "code_change", objective: "work", depends_on: [] }],
  }, { workflowId: "wf-2", primaryProjectId: "demo" })
  assert.equal(result.ok, false)
  assert.equal(result.reason, "REVIEW_GATE_REQUIRED_FOR_DELIVERY_CHAIN")
})

test("attaches the real reviewer task reference before delivery dispatch", () => {
  const updated = withReviewerPassEvidence({ context_refs: ["workflow:wf-1"] }, "review-task-1")
  assert.deepEqual(updated.context_refs, ["workflow:wf-1", "task:review-task-1"])
  assert.deepEqual(withReviewerPassEvidence(updated, "review-task-1").context_refs, updated.context_refs)
})
