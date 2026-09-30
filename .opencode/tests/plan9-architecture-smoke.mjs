import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"

const { scheduleLaneWaves, normalizeLanePolicies } = await import("../lib/lane-scheduler.ts")
const { createCompletionCore } = await import("../lib/completion-core.ts")

const policies = normalizeLanePolicies({ scheduler: { lanes: {
  controller: { default_parallel: 1, max_parallel: 1 }, read_probe: { default_parallel: 3, max_parallel: 6 }, coding: { default_parallel: 3, max_parallel: 6 },
} } })
const burst = scheduleLaneWaves([
  ...Array.from({ length: 6 }, (_, i) => ({ node_id: `read-${i}`, route: "code_read", project_id: "p" })),
  ...Array.from({ length: 3 }, (_, i) => ({ node_id: `code-${i}`, route: "code_change", project_id: "p", resources: { write: [`project:p:file:${i}`] } })),
], policies)
assert.ok(burst[0].length > 6, "independent lanes can exceed a fixed global six-worker cap")
const serialized = scheduleLaneWaves([
  { node_id: "a", route: "code_change", project_id: "p", resources: { write: ["same"] } },
  { node_id: "b", route: "code_change", project_id: "p", resources: { write: ["same"] } },
], policies)
assert.equal(serialized.length, 2, "same resource writes serialize")

const db = new DatabaseSync(":memory:")
db.exec(`CREATE TABLE workflows (workflow_id TEXT PRIMARY KEY, status TEXT, plan_json TEXT); CREATE TABLE workflow_nodes (workflow_id TEXT, node_id TEXT, status TEXT, current_task_id TEXT, last_verdict TEXT, task_history_json TEXT, review_history_json TEXT); CREATE TABLE tasks (task_id TEXT PRIMARY KEY, parent_task_id TEXT, status TEXT);`)
const plan = { nodes: [{ node_id: "t1", route: "code_read", depends_on: [] }, { node_id: "t2", route: "code_read", depends_on: [] }, { node_id: "t3", route: "code_read", depends_on: [] }] }
db.prepare("INSERT INTO workflows VALUES (?,?,?)").run("wf", "RUNNING", JSON.stringify(plan))
for (const [id, status, task] of [["t1", "COMPLETED", "q1"], ["t2", "RUNNING", "q2"], ["t3", "READY", "q3"]]) {
  db.prepare("INSERT INTO workflow_nodes VALUES (?,?,?,?,?,?,?)").run("wf", id, status, task, null, "[]", "[]")
  db.prepare("INSERT INTO tasks VALUES (?,?,?)").run(task, null, status === "RUNNING" ? "RUNNING" : "COMPLETED")
}
const dbAdapter = { query(sql) { const statement = db.prepare(sql); return { get: (...args) => statement.get(...args), all: (...args) => statement.all(...args) } } }
const guard = createCompletionCore({ db: dbAdapter })
assert.notEqual(guard.executionCheck({ workflow_id: "wf" }).status, "EXECUTION_COMPLETE")
db.prepare("UPDATE workflows SET status='REVIEW_PASSED' WHERE workflow_id='wf'").run()
db.prepare("UPDATE workflow_nodes SET status='REVIEW_PASSED', last_verdict='PASS' WHERE workflow_id='wf'").run()
db.prepare("UPDATE tasks SET status='COMPLETED'").run()
assert.equal(guard.executionCheck({ workflow_id: "wf" }).status, "EXECUTION_COMPLETE")
assert.equal(guard.deliveryCheck({ workflow_id: "wf" }).status, "DELIVERY_COMPLETE")
db.close()
console.log("PLAN9_ARCHITECTURE_SMOKE_PASS", JSON.stringify({ lane_burst: burst[0].length, resource_serial: serialized.length, completion_guard: true }))
