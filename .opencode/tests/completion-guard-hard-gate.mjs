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
      finished_at TEXT,
      completion_guard_finalized_at TEXT
    );
    CREATE TABLE workflow_nodes (
      workflow_id TEXT,
      node_id TEXT,
      status TEXT,
      current_task_id TEXT,
      review_task_id TEXT,
      last_verdict TEXT,
      task_history_json TEXT,
      review_history_json TEXT
    );
    CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY,
      parent_task_id TEXT,
      status TEXT,
      target_role TEXT,
      input_json TEXT,
      result_json TEXT
    );
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
  db.prepare("INSERT INTO workflows VALUES (?,?,?,?,?,?)").run("wf", workflowStatus, JSON.stringify(plan), "", null, null)
  db.prepare("INSERT INTO workflow_nodes VALUES (?,?,?,?,?,?,?,?)").run("wf", "gate", "REVIEW_PASSED", "task-gate", "review-task", "PASS", "[]", JSON.stringify([{ task_id: "review-task", verdict: "PASS" }]))
  db.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?)").run("task-gate", null, "COMPLETED", "test-runner", JSON.stringify({ route: "build_and_test" }), JSON.stringify({ output_text: "ok" }))
  db.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?)").run("review-task", "task-gate", "COMPLETED", "reviewer", JSON.stringify({ route: "independent_review" }), JSON.stringify({ output_text: JSON.stringify({ schema_version: 1, verdict: "PASS" }) }))
  if (childStatus) db.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?)").run("child", "task-gate", childStatus, "test-runner", JSON.stringify({ route: "build_and_test" }), null)
  const adapter = {
    query(sql) {
      const statement = db.prepare(sql)
      return {
        get: (...args) => statement.get(...args),
        all: (...args) => statement.all(...args),
        run: (...args) => statement.run(...args),
      }
    },
    transaction(fn) {
      return () => {
        db.exec("BEGIN IMMEDIATE")
        try {
          const result = fn()
          db.exec("COMMIT")
          return result
        } catch (error) {
          try { db.exec("ROLLBACK") } catch {}
          throw error
        }
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
  assert.equal(db.prepare("SELECT status, finished_at, completion_guard_finalized_at FROM workflows WHERE workflow_id='wf'").get().status, "REVIEW_PASSED")
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
  const row = db.prepare("SELECT status, finished_at, completion_guard_finalized_at FROM workflows WHERE workflow_id='wf'").get()
  assert.equal(row.status, "COMPLETED")
  assert.ok(row.finished_at)
  assert.equal(row.finished_at, row.completion_guard_finalized_at)
  assert.equal(guard.finalize({ workflow_id: "wf" }).status, "COMPLETED")
  db.close()
}

{
  const { db, guard } = setup({ workflowStatus: "COMPLETED" })
  assert.equal(guard.finalReportPermission({ workflow_id: "wf" }).ok, false, "COMPLETED without guard timestamp fails closed")
  db.close()
}

{
  const { db, guard } = setup({ workflowStatus: "COMPLETED" })
  db.prepare("UPDATE workflows SET finished_at='manual' WHERE workflow_id='wf'").run()
  assert.equal(guard.finalReportPermission({ workflow_id: "wf" }).ok, false, "arbitrary finished_at is not guard provenance")
  db.close()
}

{
  const { db, guard } = setup()
  db.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?)").run("child", "task-gate", "COMPLETED", "test-runner", JSON.stringify({ route: "build_and_test" }), JSON.stringify({ output_text: "ok" }))
  db.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?)").run("grandchild", "child", "RUNNING", "test-runner", JSON.stringify({ route: "build_and_test" }), null)
  assert.equal(guard.finalReportPermission({ workflow_id: "wf" }).ok, false, "active descendant task blocks final report")
  db.close()
}

{
  const { db, guard } = setup()
  db.prepare("UPDATE workflow_nodes SET review_history_json='[]' WHERE workflow_id='wf'").run()
  assert.equal(guard.finalReportPermission({ workflow_id: "wf" }).ok, false, "last_verdict without PASS history blocks final report")
  db.close()
}

{
  const { db, guard } = setup()
  db.prepare("UPDATE workflows SET plan_json=? WHERE workflow_id='wf'").run(JSON.stringify({
    nodes: [{ node_id: "gate", route: "code_change", depends_on: [], review: { required: true }, metadata: { required: true } }],
    metadata: { delivery: { reviewer_pass_required: false } },
  }))
  db.prepare("UPDATE workflow_nodes SET last_verdict=NULL, review_history_json='[]' WHERE workflow_id='wf'").run()
  assert.equal(guard.finalReportPermission({ workflow_id: "wf" }).ok, false, "planner metadata cannot disable reviewer gate")
  db.close()
}

console.log("COMPLETION_GUARD_HARD_GATE_TEST_PASS")
