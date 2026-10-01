import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"

const root = path.resolve(".")
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "ai-dev-control-plane-"))
fs.cpSync(path.join(root, "diagrams"), path.join(fixture, "diagrams"), { recursive: true })
fs.cpSync(path.join(root, "framework-config"), path.join(fixture, "framework-config"), { recursive: true })
fs.cpSync(path.join(root, ".opencode", "agents"), path.join(fixture, ".opencode", "agents"), { recursive: true })
fs.mkdirSync(path.join(fixture, "runtime"), { recursive: true })
const fixtureDb = new DatabaseSync(path.join(fixture, "runtime", "tasks.db"))
fixtureDb.exec(`
  CREATE TABLE workflows (workflow_id TEXT PRIMARY KEY, primary_project_id TEXT, objective TEXT, status TEXT, planner_task_id TEXT, planner_session_id TEXT, plan_json TEXT, rework_cycle INTEGER, created_at TEXT, updated_at TEXT, finished_at TEXT, completion_guard_finalized_at TEXT);
  CREATE TABLE workflow_nodes (workflow_id TEXT, node_id TEXT, current_task_id TEXT, attempt INTEGER, status TEXT, review_task_id TEXT, last_verdict TEXT, task_history_json TEXT, review_history_json TEXT, updated_at TEXT);
  CREATE TABLE tasks (task_id TEXT PRIMARY KEY, parent_task_id TEXT, project_id TEXT, target_role TEXT, target_session_key TEXT, status TEXT, input_json TEXT, result_json TEXT, created_at TEXT, updated_at TEXT);
  CREATE TABLE sessions (session_key TEXT, project_id TEXT, role TEXT, opencode_session_id TEXT, generation INTEGER, agent_id TEXT, model_runtime_id TEXT, project_path TEXT, status TEXT, checkpoint_path TEXT, created_at TEXT, last_used_at TEXT, replaced_by TEXT, context_window_tokens INTEGER, context_used_tokens INTEGER, context_pct REAL, context_checked_at TEXT, lifecycle_state TEXT, lifecycle_updated_at TEXT, context_tokens INTEGER, context_limit INTEGER, telemetry_source TEXT, telemetry_at TEXT);
  CREATE TABLE lifecycle_events (event_id TEXT PRIMARY KEY, session_key TEXT, generation INTEGER, opencode_session_id TEXT, event_type TEXT, context_pct REAL, checkpoint_path TEXT, details_json TEXT, created_at TEXT);
  CREATE TABLE lifecycle_rotations (rotation_id TEXT PRIMARY KEY, session_key TEXT, from_generation INTEGER, from_session_id TEXT, to_generation INTEGER, checkpoint_path TEXT, successor_session_id TEXT, status TEXT, error TEXT, created_at TEXT, updated_at TEXT);
`)
const now = "2026-10-01T00:00:00.000Z"
const plan = { nodes: [{ node_id: "work", route: "code_change", project_id: "demo", depends_on: [], review: { required: true }, metadata: { required: true } }], metadata: { delivery: { required_evidence: [] } } }
fixtureDb.prepare("INSERT INTO workflows VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run("wf-legacy", "demo", "legacy completion", "COMPLETED", null, null, JSON.stringify(plan), 0, now, now, now, now)
fixtureDb.prepare("INSERT INTO workflow_nodes VALUES (?,?,?,?,?,?,?,?,?,?)").run("wf-legacy", "work", "task-work", 1, "COMPLETED", "review-task", "PASS", "[]", JSON.stringify([{ task_id: "review-task", verdict: "PASS" }]), now)
fixtureDb.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?)").run("task-work", null, "demo", "feature-executor", "worker-session", "COMPLETED", JSON.stringify({ route: "code_change", metadata: { workflow_id: "wf-legacy", workflow_node_id: "work", lane: "coding", resources: { write: ["src/demo.ts"], mode: "write" } } }), JSON.stringify({ output_text: "done", started_at: "2026-09-30T23:50:00.000Z", finished_at: now }), now, now)
fixtureDb.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?)").run("review-task", "task-work", "demo", "reviewer", "review-session", "COMPLETED", JSON.stringify({ route: "independent_review" }), JSON.stringify({ output_text: JSON.stringify({ schema_version: 1, verdict: "PASS" }) }), now, now)
fixtureDb.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?)").run("task-live", null, "demo", "feature-executor", "worker-session", "RUNNING", JSON.stringify({ route: "code_change", metadata: { workflow_id: "wf-live", workflow_node_id: "live-node", lane: "coding", resources: { write: ["src/live.ts"], mode: "write" } } }), null, "2026-10-01T00:01:00.000Z", "2026-10-01T00:01:00.000Z")
fixtureDb.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("worker-session", "demo", "feature-executor", "ses_fixture", 2, "feature-executor", "openai/gpt-fixture", "D:/fixture/demo", "ACTIVE", "runtime/checkpoints/worker.json", now, now, null, 1000, 420, 42, now, "CONTINUE", now, 420, 1000, "fixture", now)
fixtureDb.close()

const child = spawn(process.execPath, ["--experimental-strip-types", "tools/control-plane/server.mjs"], {
  cwd: root,
  env: { ...process.env, AI_DEV_ROOT: fixture, CONTROL_PLANE_PORT: "0" },
  stdio: ["ignore", "pipe", "pipe"],
})
let output = ""
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`control plane did not start: ${output}`)), 10000)
  child.stdout.on("data", (chunk) => {
    output += chunk.toString()
    const match = output.match(/CONTROL_PLANE_READY (\d+)/)
    if (match) { clearTimeout(timer); resolve(Number(match[1])) }
  })
  child.on("error", reject)
})

try {
  const port = await ready
  const base = `http://127.0.0.1:${port}`
  const health = await (await fetch(`${base}/api/health`)).json()
  assert.equal(health.status, "OK")
  assert.equal(health.architecture.status, "IN_SYNC")
  const dashboard = await (await fetch(`${base}/api/dashboard`)).json()
  assert.equal(dashboard.lifecycle.automatic_rotation, "LOCKED")
  assert.ok(Array.isArray(dashboard.agents))
  assert.ok(Array.isArray(dashboard.lane_usage), "dashboard exposes lane usage")
  assert.ok(dashboard.lane_usage.some((lane) => lane.lane === "coding" && lane.max_parallel === 6), "dashboard exposes lane limits")
  assert.ok(dashboard.blocked_failed && typeof dashboard.blocked_failed === "object", "dashboard exposes blocked/failed counts")
  assert.ok(Array.isArray(dashboard.ready_queue), "dashboard exposes ready queue")
  const legacyCompletion = dashboard.completion.find((item) => item.workflow_id === "wf-legacy")
  assert.equal(legacyCompletion.final_report_permission, "DENIED", "UI must use Completion Guard delivery evidence, not matching timestamps")
  assert.ok(legacyCompletion.missing_reasons.some((reason) => reason.includes("REQUIRED_DELIVERY_ROUTE") || reason.includes("DELIVERY_EVIDENCE")))
  const worker = dashboard.live_team.find((item) => item.session_key === "worker-session")
  assert.deepEqual({ lane: worker.lane, role: worker.role, model: worker.model_runtime_id, project: worker.project_id, task: worker.task_id, node: worker.node_id, session: worker.session_id, context: worker.context_pct }, { lane: "coding", role: "feature-executor", model: "openai/gpt-fixture", project: "demo", task: "task-live", node: "live-node", session: "ses_fixture", context: 42 })
  assert.deepEqual(worker.resource_contract.paths, ["src/live.ts"])
  assert.ok(Number.isFinite(worker.elapsed_ms))
  const workflows = await (await fetch(`${base}/api/workflows`)).json()
  assert.ok(Array.isArray(workflows.workflows))
  assert.ok(Array.isArray(workflows.ready_queue), "workflow projection exposes ready queue")
  const sessions = await (await fetch(`${base}/api/sessions`)).json()
  assert.ok(Array.isArray(sessions.sessions))
  assert.ok(Array.isArray(sessions.lifecycle_events))
  assert.ok(Array.isArray(sessions.rotations))
  const missingSession = await fetch(`${base}/api/sessions/missing-session`)
  assert.equal(missingSession.status, 404)
  assert.equal((await missingSession.json()).code, "SESSION_NOT_FOUND")
  const evidence = await (await fetch(`${base}/api/evidence`)).json()
  assert.equal(evidence.architecture.status, "IN_SYNC")
  assert.ok(Array.isArray(evidence.waves), "evidence includes wave records")
  const evidenceMarkdown = await (await fetch(`${base}/api/evidence?format=markdown`)).text()
  assert.match(evidenceMarkdown, /# AI-Dev Control Plane Evidence/)
  const page = await (await fetch(base)).text()
  assert.match(page, /AI-Dev Control Plane/)
  const app = await (await fetch(`${base}/app.js`)).text()
  assert.match(app, /resource_contract/)
  assert.match(app, /elapsed_ms/)
  const denied = await fetch(`${base}/api/control/workflows/unknown`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "resume" }) })
  assert.equal(denied.status, 409)
  assert.equal((await denied.json()).code, "CONTROL_RUNTIME_REQUIRED")
  const control = await (await fetch(`${base}/api/workflows/unknown/control`)).json()
  assert.equal(control.status, "NOT_FOUND")
  const applyDenied = await fetch(`${base}/api/control/architecture/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: "config" }) })
  assert.equal(applyDenied.status, 400)
  assert.equal((await applyDenied.json()).code, "EXPLICIT_CONFIRMATION_REQUIRED")
  const locked = await fetch(`${base}/api/control/lifecycle/automatic-rotation`, { method: "POST" })
  assert.equal(locked.status, 423)
  assert.equal((await locked.json()).code, "LIFECYCLE_LOCKED")
  const checkpoint = await fetch(`${base}/api/control/sessions/project%3Afixture%3Amain/checkpoint`, { method: "POST" })
  assert.equal(checkpoint.status, 409)
  assert.equal((await checkpoint.json()).code, "CONTROL_RUNTIME_REQUIRED")
  const rotate = await fetch(`${base}/api/control/sessions/project%3Afixture%3Amain/rotate`, { method: "POST" })
  assert.equal(rotate.status, 423)
  assert.equal((await rotate.json()).code, "LIFECYCLE_LOCKED")
  console.log("PLAN10_CONTROL_PLANE_PASS", JSON.stringify({ health: health.status, architecture: health.architecture.status, rotation: dashboard.lifecycle.automatic_rotation, workflows: workflows.workflows.length }))
} finally {
  child.kill()
  fs.rmSync(fixture, { recursive: true, force: true })
}
