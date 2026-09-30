import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import {
  createScheduler, featureExecutorSessionKey, projectReaderWorkerSessionKey,
  workerRoleForRoute, workerSessionKeyForRoute, collectWorkflowWorkerSessionKeys, planWaves, normalizePolicy,
} from "../plugins/workflow-engine/scheduler.ts"

const wf = "wf", pid = "p"
const codeKey = (node, team = true) => featureExecutorSessionKey(wf, pid, node, team)
const readKey = (node) => projectReaderWorkerSessionKey(wf, pid, node)
assert.equal(codeKey("a"), "workflow:wf:project:p:feature-executor:node:a")
assert.equal(codeKey("a"), codeKey("a"), "retry and FIX/REWORK reuse the node key")
assert.notEqual(codeKey("a"), codeKey("b"))
assert.equal(codeKey("a", false), "workflow:wf:project:p:feature-executor")
assert.equal(readKey("r"), "workflow:wf:project:p:project-reader:node:r")
assert.equal(workerRoleForRoute("code_read", true), "project-reader")
assert.equal(workerRoleForRoute("code_read", false), "project-reader")
assert.equal(workerSessionKeyForRoute(wf, pid, "r", "code_read", false), null)
const nodes = [{ node_id: "a", route: "code_change", project_id: pid }, { node_id: "b", route: "api_code_change", project_id: pid }, { node_id: "r", route: "code_read", project_id: pid }]
assert.deepEqual(collectWorkflowWorkerSessionKeys(wf, nodes, true, [
  { session_key: codeKey("historical"), role: "feature-executor" },
  { session_key: "project:p:reader", role: "project-reader" },
  { session_key: "workflow:other:project:p:feature-executor:node:a", role: "feature-executor" },
]), [codeKey("a"), codeKey("b"), codeKey("historical"), readKey("r")].sort())

const policy = normalizePolicy({ scheduler: { lanes: { coding: { default_parallel: 3, max_parallel: 6 }, read_probe: { default_parallel: 3, max_parallel: 6 } } }, parallel_policy: { safe_routes: ["code_read"], project_serial_routes: ["code_change", "api_code_change"] } })
const work = (id, file) => ({ node_id: id, route: "code_change", project_id: pid, resources: { write: [file] } })
assert.equal(planWaves([work("a", "same"), work("b", "same")], policy).length, 2, "resource conflict still serializes")
assert.equal(planWaves([work("a", "a"), work("b", "b")], policy)[0].length, 2, "disjoint files still parallelize")

async function runScenario({ team, routes, missingModel = false, missingModelRole = null, archiveResults = {} }) {
  const db = new DatabaseSync(":memory:")
  db.exec(`CREATE TABLE workflows (workflow_id TEXT PRIMARY KEY, primary_project_id TEXT, objective TEXT, status TEXT, planner_task_id TEXT, planner_session_id TEXT, plan_json TEXT, rework_cycle INTEGER, created_at TEXT, updated_at TEXT, finished_at TEXT);
    CREATE TABLE workflow_nodes (workflow_id TEXT, node_id TEXT, current_task_id TEXT, attempt INTEGER, status TEXT, review_task_id TEXT, last_verdict TEXT, task_history_json TEXT, review_history_json TEXT, updated_at TEXT);
    CREATE TABLE tasks (task_id TEXT PRIMARY KEY, parent_task_id TEXT, project_id TEXT, target_role TEXT, target_session_key TEXT, status TEXT, input_json TEXT, result_json TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE sessions (session_key TEXT, project_id TEXT, role TEXT, generation INTEGER, status TEXT, PRIMARY KEY(session_key,generation));`)
  const plan = routes.map((route, i) => ({ node_id: `n${i}`, route, project_id: pid, depends_on: team ? [] : i ? [`n${i - 1}`] : [], resources: { write: [`file${i}`] } }))
  // Team Mode: >=3 implementation nodes, or independent code/read packages.
  if (team && routes.length === 1) plan.push({ node_id: "helper", route: "project_analysis", project_id: "other", depends_on: [] })
  db.prepare("INSERT INTO workflows VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(wf, pid, "test", "READY", null, null, JSON.stringify({ nodes: plan }), 0, "", "", null)
  for (const n of plan) {
    const taskId = `task-${n.node_id}`
    const role = n.route === "code_read" ? "project-reader" : "feature-executor"
    db.prepare("INSERT INTO workflow_nodes VALUES (?,?,?,?,?,?,?,?,?,?)").run(wf, n.node_id, taskId, 1, "READY", null, null, JSON.stringify([{ task_id: taskId, attempt: 1 }]), "[]", "")
    db.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?)").run(taskId, null, n.project_id, role, null, "READY", JSON.stringify({ task_id: taskId, project_id: n.project_id, route: n.route, objective: "test" }), null, "", "")
  }
  const adapter = { query(sql) { const s = db.prepare(sql); return { get: (...a) => s.get(...a), all: (...a) => s.all(...a), run: (...a) => s.run(...a) } } }
  const ensures = [], sends = [], preflights = [], archives = [], persistentDispatch = [], locks = []
  const core = {
    db: adapter, configReady: true, root: "D:\\ai-dev", findProject: () => ({ path: "D:\\project" }),
    withLock: async (key, fn) => { locks.push(key); return fn() },
    ensureScopedSession: async (input) => {
      ensures.push(input)
      const existing = db.prepare("SELECT * FROM sessions WHERE session_key=? AND status='ACTIVE'").get(input.session_key)
      if (!existing) db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?)").run(input.session_key, input.project_id, input.role, 1, "ACTIVE")
      return { ok: true, reused: !!existing, session_id: `session:${input.session_key}`, generation: 1 }
    },
    sendScopedSession: async ({ session_key }) => {
      sends.push(session_key)
      return { ok: true, session_id: `session:${session_key}`, generation: 1, output_text: "done" }
    },
    archiveScopedSession: ({ session_key }) => {
      archives.push(session_key)
      const configured = archiveResults[session_key]
      if (configured?.throw) throw new Error(configured.throw)
      db.prepare("UPDATE sessions SET status='ARCHIVED' WHERE session_key=? AND status='ACTIVE'").run(session_key)
      return configured?.result ?? { ok: true }
    },
  }
  const bus = {
    loadBusConfig: () => ({}),
    resolveTaskRoleModel: (_cfg, _pid, role) => (missingModel && role === "feature-executor") || missingModelRole === role ? null : role === "project-reader" ? "deepseek/deepseek-flash" : "project/model",
    taskRoleModelSource: () => "agents.yaml", buildPrompt: (env) => env.objective,
    buildResult: (args) => ({ target_role: args.targetRole, session_id: args.sessionId, session_generation: args.sessionGeneration, error: args.error, output_text: args.outputText, status: args.status }),
    persistResult: (taskId, status, sessionKey, result) => db.prepare("UPDATE tasks SET status=?, target_session_key=?, result_json=? WHERE task_id=?").run(status, sessionKey, JSON.stringify(result), taskId),
    persistBlocked(row, env, role, code) { this.persistResult(row.task_id, "BLOCKED", null, this.buildResult({ targetRole: role, sessionId: null, sessionGeneration: null, error: code })) },
    withTaskLock: async (_id, fn) => fn(),
    dispatchTask: async (id) => {
      persistentDispatch.push(id)
      const row = db.prepare("SELECT * FROM tasks WHERE task_id=?").get(id)
      const key = `project:${row.project_id}:reader`
      bus.persistResult(id, "COMPLETED", key, bus.buildResult({ targetRole: row.target_role, sessionId: "persistent", sessionGeneration: 1, error: null }))
      return { status: "COMPLETED", result: { session_id: "persistent" } }
    },
  }
  const scheduler = createScheduler({ core, bus, hooks: null, reviewer: { runReview: async () => ({ type: "PASS" }) }, loadWorkflowConfig: () => ({ scheduler: { lanes: { coding: { default_parallel: 3, max_parallel: 6 }, read_probe: { default_parallel: 3, max_parallel: 6 } } }, parallel_policy: { safe_routes: ["code_read", "project_analysis"], project_serial_routes: ["code_change", "api_code_change"] } }), lifecyclePreflight: async (key, info) => { preflights.push({ key, info }); return { ok: true } } })
  const output = await scheduler.runWorkflow(wf)
  return { db, output, ensures, sends, preflights, archives, persistentDispatch, locks }
}

const team = await runScenario({ team: true, routes: ["code_change", "api_code_change", "code_read"] })
assert.equal(team.output.status, "REVIEW_PASSED")
assert.equal(team.output.team_execution_mode, "TEAM_EXECUTION")
assert.deepEqual(team.ensures.map((x) => x.session_key).sort(), [codeKey("n0"), codeKey("n1"), readKey("n2")].sort())
assert.equal(team.ensures.find((x) => x.role === "project-reader").runtime_id, "deepseek/deepseek-flash")
assert.ok(team.ensures.every((x) => team.preflights.some((p) => p.key === x.session_key && p.info.node_id)))
assert.deepEqual(team.archives.sort(), team.sends.sort(), "all workers archived by exact key")
assert.ok(team.locks.includes(codeKey("n0")) && team.locks.includes(codeKey("n1")) && team.locks.includes(readKey("n2")))
assert.equal(team.persistentDispatch.length, 0)
for (const n of ["n0", "n1", "n2"]) {
  const task = team.db.prepare("SELECT * FROM tasks WHERE task_id=?").get(`task-${n}`)
  const expected = n === "n2" ? readKey(n) : codeKey(n)
  assert.equal(task.target_session_key, expected)
  assert.equal(JSON.parse(task.result_json).session_id, `session:${expected}`)
}
team.db.close()

const simple = await runScenario({ team: false, routes: ["code_change", "code_read"] })
assert.equal(simple.output.team_execution_mode, "SINGLE_TASK")
assert.deepEqual(simple.ensures.map((x) => x.session_key), [codeKey("n0", false)])
assert.deepEqual(simple.persistentDispatch, ["task-n1"], "simple code_read stays persistent")
assert.deepEqual(simple.archives, [codeKey("n0", false)])
simple.db.close()

const unassigned = await runScenario({ team: true, routes: ["code_change"], missingModel: true })
assert.equal(unassigned.output.status, "BLOCKED")
assert.equal(unassigned.output.nodes.find((n) => n.node_id === "n0").current_task_status, "BLOCKED")
assert.equal(unassigned.ensures.length, 0, "MODEL_UNASSIGNED never creates a worker")
unassigned.db.close()

const readerUnassigned = await runScenario({ team: true, routes: ["code_change", "code_read"], missingModelRole: "project-reader" })
assert.equal(readerUnassigned.output.status, "BLOCKED")
assert.deepEqual(readerUnassigned.ensures.map((x) => x.session_key), [codeKey("n0")], "reader MODEL_UNASSIGNED does not create a worker session")
assert.equal(readerUnassigned.db.prepare("SELECT * FROM sessions WHERE session_key=?").get(readKey("n1")), undefined)
const readerTask = readerUnassigned.db.prepare("SELECT * FROM tasks WHERE task_id=?").get("task-n1")
assert.equal(readerTask.status, "BLOCKED")
assert.equal(JSON.parse(readerTask.result_json).error, "MODEL_UNASSIGNED")
readerUnassigned.db.close()

const archivePartial = await runScenario({
  team: true,
  routes: ["code_change", "api_code_change", "code_read"],
  archiveResults: {
    [codeKey("n0")]: { throw: "archive worker failure" },
    [codeKey("n1")]: { result: { ok: false, code: "ARCHIVE_PARTIAL" } },
  },
})
assert.equal(archivePartial.output.status, "REVIEW_PASSED", "archive failure does not deadlock workflow completion")
assert.deepEqual(archivePartial.archives.sort(), archivePartial.sends.sort(), "other workers are still attempted after an archive failure")
const archivedByKey = new Map(archivePartial.output.archived_sessions.map((x) => [x.session_key, x]))
assert.equal(archivedByKey.get(codeKey("n0")).archived, false)
assert.equal(archivedByKey.get(codeKey("n0")).code, "ARCHIVE_EXCEPTION")
assert.equal(archivedByKey.get(codeKey("n1")).archived, false)
assert.equal(archivedByKey.get(codeKey("n1")).code, "ARCHIVE_PARTIAL")
assert.equal(archivedByKey.get(readKey("n2")).archived, true)
archivePartial.db.close()
console.log("WORKFLOW_TEAM_WORKER_SESSIONS_TEST_PASS")
