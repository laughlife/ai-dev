import assert from "node:assert/strict"
import fs from "node:fs"
import { DatabaseSync } from "node:sqlite"

const { createCompletionCore } = await import("../lib/completion-core.ts")

const plugin = fs.readFileSync(new URL("../plugins/completion-engine/index.ts", import.meta.url), "utf8")
assert.match(plugin, /completion_final_report_permission/)
assert.match(plugin, /completion_finalize/)

function setup({ workflowStatus = "REVIEW_PASSED", childStatus = null } = {}) {
  const db = new DatabaseSync(":memory:")
  db.exec(`
    CREATE TABLE workflows (
      workflow_id TEXT PRIMARY KEY,
      status TEXT,
      plan_json TEXT,
      updated_at TEXT,
      finished_at TEXT
    );
    CREATE TABLE workflow_nodes (
      workflow_id TEXT,
      node_id TEXT,
      status TEXT,
      current_task_id TEXT,
      last_verdict TEXT,
      task_history_json TEXT,
      review_history_json TEXT
    );
    CREATE TABLE tasks (task_id TEXT PRIMARY KEY, parent_task_id TEXT, status TEXT);
  `)
  const plan = {
    nodes: [{
      node_id: "gate",
      route: "code_change",
      depends_on: [],
      review: { required: true },
      metadata: { required: true },
    }],
    metadata: { delivery: { reviewer_pass_required: true } },
  }
  db.prepare("INSERT INTO workflows VALUES (?,?,?,?,?)").run("wf", workflowStatus, JSON.stringify(plan), "", null)
  db.prepare("INSERT INTO workflow_nodes VALUES (?,?,?,?,?,?,?)").run("wf", "gate", "REVIEW_PASSED", "task-gate", "PASS", "[]", JSON.stringify([{ verdict: "PASS" }]))
  db.prepare("INSERT INTO tasks VALUES (?,?,?)").run("task-gate", null, "COMPLETED")
  if (childStatus) db.prepare("INSERT INTO tasks VALUES (?,?,?)").run("child", "task-gate", childStatus)
  const adapter = {
    query(sql) {
      const statement = db.prepare(sql)
      return {
        get: (...args) => statement.get(...args),
        all: (...args) => statement.all(...args),
        run: (...args) => statement.run(...args),
      }
    },
  }
  return { db, guard: createCompletionCore({ db: adapter }) }
}

{
  const { db, guard } = setup({ childStatus: "RUNNING" })
  const before = guard.finalReportPermission({ workflow_id: "wf" })
  assert.equal(before.ok, false)
  assert.equal(before.status, "FINAL_REPORT_BLOCKED")
  assert.equal(guard.finalize({ workflow_id: "wf" }).code, "COMPLETION_GUARD_BLOCKED")
  assert.equal(db.prepare("SELECT status, finished_at FROM workflows WHERE workflow_id='wf'").get().status, "REVIEW_PASSED")
  db.close()
}

{
  const { db, guard } = setup()
  const permission = guard.finalReportPermission({ workflow_id: "wf" })
  assert.equal(permission.ok, true)
  assert.equal(permission.status, "FINAL_REPORT_ALLOWED")
  const finalized = guard.finalize({ workflow_id: "wf" })
  assert.equal(finalized.ok, true)
  assert.equal(finalized.status, "COMPLETED")
  assert.equal(finalized.final_report_permission, true)
  const row = db.prepare("SELECT status, finished_at FROM workflows WHERE workflow_id='wf'").get()
  assert.equal(row.status, "COMPLETED")
  assert.ok(row.finished_at)
  assert.equal(guard.finalize({ workflow_id: "wf" }).status, "COMPLETED")
  db.close()
}

{
  const { db, guard } = setup({ workflowStatus: "COMPLETED" })
  assert.equal(guard.finalReportPermission({ workflow_id: "wf" }).ok, false, "COMPLETED without guard timestamp fails closed")
  db.close()
}

console.log("COMPLETION_GUARD_HARD_GATE_TEST_PASS")
