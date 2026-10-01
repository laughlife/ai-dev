import fs from "node:fs"
import path from "node:path"
import http from "node:http"
import { execFileSync } from "node:child_process"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { createCompletionCore } from "../../.opencode/lib/completion-core.ts"

const root = path.resolve(process.env.AI_DEV_ROOT ?? process.cwd())
const port = Number(process.env.CONTROL_PLANE_PORT ?? 4310)
const dbPath = path.join(root, "runtime", "tasks.db")
const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const compiler = path.resolve(moduleDir, "..", "architecture-sync", "cli.ts")
const publicDir = path.join(moduleDir, "public")

const LANE_BY_ROUTE = {
  project_analysis: "controller",
  project_coordination: "controller",
  code_read: "read_probe",
  code_change: "coding",
  api_code_change: "coding",
  build_and_test: "test_validation",
  api_runtime_call: "api_integration",
  api_regression: "api_integration",
  independent_review: "reviewer",
  documentation_update: "documentation",
}
const ACTIVE_TASK_STATES = new Set(["READY", "RUNNING", "BLOCKED", "REVIEWING", "REWORKING"])
const SUCCESS_NODE_STATES = new Set(["COMPLETED", "PASS", "SUCCEEDED"])

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
  res.end(body)
}

function text(res, status, value, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": contentType, "cache-control": "no-store" })
  res.end(value)
}

function safeJson(value, fallback = null) {
  try { return value ? JSON.parse(value) : fallback } catch { return fallback }
}

function routeLane(route) { return LANE_BY_ROUTE[route] ?? "controller" }

function taskEnvelope(task) {
  const input = safeJson(task?.input_json, {}) ?? {}
  const result = safeJson(task?.result_json, {}) ?? {}
  return { input, result }
}

function embeddedJson(text) {
  if (typeof text !== "string") return null
  const direct = safeJson(text, null)
  if (direct && typeof direct === "object") return direct
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  return fenced ? safeJson(fenced[1], null) : null
}

function resourceContract(task, node = {}) {
  const { input } = taskEnvelope(task)
  const metadata = input?.metadata && typeof input.metadata === "object" ? input.metadata : {}
  const resources = metadata.resources ?? input.resources ?? node.resources ?? {}
  return {
    lane: metadata.lane ?? input.lane ?? node.lane ?? routeLane(input.route ?? node.route),
    project: resources.project ?? resources.project_id ?? input.project_id ?? node.project_id ?? null,
    paths: Array.isArray(resources.paths) ? resources.paths : (Array.isArray(resources.read) ? resources.read : (Array.isArray(resources.write) ? resources.write : [])),
    locks: Array.isArray(resources.locks) ? resources.locks : [],
    mode: resources.mode ?? "read",
  }
}

function dependencyReason(node, nodeMap) {
  const deps = Array.isArray(node.depends_on) ? node.depends_on : []
  const missing = deps.filter((id) => !nodeMap.has(id))
  if (missing.length) return { ready: false, code: "DEPENDENCY", detail: `unknown dependency: ${missing.join(", ")}` }
  const pending = deps.filter((id) => !SUCCESS_NODE_STATES.has(String(nodeMap.get(id)?.status ?? "").toUpperCase()))
  if (pending.length) return { ready: false, code: "DEPENDENCY", detail: `waiting for: ${pending.join(", ")}` }
  return { ready: true, code: null, detail: null }
}

function yamlIds(file, section) {
  if (!fs.existsSync(file)) return []
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === `${section}:`)
  if (start < 0) return []
  const out = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^\S/.test(line) && line.trim() !== "-") break
    const match = line.match(/^\s+id:\s*([^\s#]+)/)
    if (match) out.push(match[1].replace(/^['"]|['"]$/g, ""))
  }
  return [...new Set(out)]
}

function mapKeys(file, section) {
  if (!fs.existsSync(file)) return []
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === `${section}:`)
  if (start < 0) return []
  const out = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^\S/.test(line)) break
    const match = line.match(/^\s{2}([A-Za-z0-9_.-]+):\s*$/)
    if (match) out.push(match[1])
  }
  return out
}

function lanePolicies(file) {
  if (!fs.existsSync(file)) return {}
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === "lanes:")
  if (start < 0) return {}
  const baseIndent = lines[start].match(/^\s*/)?.[0].length ?? 0
  const out = {}
  let current = null
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    const indent = line.match(/^\s*/)?.[0].length ?? 0
    if (indent <= baseIndent) break
    const lane = line.match(new RegExp(`^\\s{${baseIndent + 2}}([A-Za-z0-9_.-]+):\\s*$`))
    if (lane) { current = lane[1]; out[current] = { default_parallel: null, max_parallel: null }; continue }
    const value = line.match(new RegExp(`^\\s{${baseIndent + 4}}(default_parallel|max_parallel):\\s*([0-9]+)`))
    if (value && current) out[current][value[1]] = Number(value[2])
  }
  return out
}

function run(command, args) {
  try { return execFileSync(command, args, { cwd: root, encoding: "utf8", timeout: 30000 }).trim() } catch { return "" }
}

function architecture() {
  try {
    const raw = execFileSync(process.execPath, ["--experimental-strip-types", compiler, "check", "--format=json"], { cwd: root, encoding: "utf8", timeout: 30000 })
    return JSON.parse(raw)
  } catch (error) {
    return { status: "ERROR", errors: [error?.message ?? String(error)], changes: [] }
  }
}

function withDb(read) {
  if (!fs.existsSync(dbPath)) return read(null)
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    return read(db)
  } catch (error) {
    return read(null, error)
  } finally { try { db?.close() } catch {} }
}

function hasTable(db, name) {
  return Boolean(db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))
}

function rows(db, sql, params = []) {
  try { return db?.prepare(sql).all(...params) ?? [] } catch { return [] }
}

function runtimeSnapshot() {
  return withDb((db, error) => {
    const workflows = hasTable(db, "workflows") ? rows(db, "SELECT workflow_id, primary_project_id, objective, status, rework_cycle, planner_task_id, planner_session_id, plan_json, created_at, updated_at, finished_at, completion_guard_finalized_at FROM workflows ORDER BY updated_at DESC") : []
    const nodes = hasTable(db, "workflow_nodes") ? rows(db, "SELECT workflow_id, node_id, current_task_id, attempt, status, review_task_id, last_verdict, task_history_json, review_history_json, updated_at FROM workflow_nodes ORDER BY workflow_id, node_id") : []
    const tasks = hasTable(db, "tasks") ? rows(db, "SELECT task_id, parent_task_id, project_id, target_role, target_session_key, status, input_json, result_json, created_at, updated_at FROM tasks ORDER BY updated_at DESC LIMIT 500") : []
    const sessions = hasTable(db, "sessions") ? rows(db, "SELECT session_key, project_id, role, opencode_session_id, generation, agent_id, model_runtime_id, status, checkpoint_path, replaced_by, context_tokens, context_limit, context_pct, telemetry_source, telemetry_at, lifecycle_state, lifecycle_updated_at, last_used_at FROM sessions ORDER BY last_used_at DESC LIMIT 200") : []
    const lifecycle_events = hasTable(db, "lifecycle_events") ? rows(db, "SELECT event_id, session_key, generation, opencode_session_id, event_type, context_pct, checkpoint_path, details_json, created_at FROM lifecycle_events ORDER BY created_at DESC LIMIT 200") : []
    const rotations = hasTable(db, "lifecycle_rotations") ? rows(db, "SELECT rotation_id, session_key, from_generation, from_session_id, to_generation, checkpoint_path, successor_session_id, status, error, created_at, updated_at FROM lifecycle_rotations ORDER BY updated_at DESC LIMIT 100") : []
    return { available: Boolean(db), error: error?.message ?? null, workflows, nodes, tasks, sessions, lifecycle_events, rotations }
  })
}

async function runtimeService() {
  try {
    const response = await fetch("http://127.0.0.1:49374/api/info", { signal: AbortSignal.timeout(800) })
    if (!response.ok) return { status: "UNAVAILABLE" }
    return { status: "AVAILABLE", info: await response.json() }
  } catch { return { status: "UNAVAILABLE" } }
}

function configSnapshot() {
  const config = path.join(root, "framework-config")
  return {
    agents: yamlIds(path.join(config, "agents.yaml"), "agents").map((id) => ({ id })),
    projects: yamlIds(path.join(config, "projects.yaml"), "projects").map((id) => ({ id })),
    routes: mapKeys(path.join(config, "routing.yaml"), "routes"),
    lanes: lanePolicies(path.join(config, "workflow.yaml")),
  }
}

function workflowProjection(snapshot, workflow) {
  const plan = safeJson(workflow.plan_json, {}) ?? {}
  const planNodes = Array.isArray(plan.nodes) ? plan.nodes : []
  const rowsById = new Map(snapshot.nodes.filter((node) => node.workflow_id === workflow.workflow_id).map((node) => [node.node_id, node]))
  const taskById = new Map(snapshot.tasks.map((task) => [task.task_id, task]))
  const nodes = planNodes.map((planNode) => {
    const row = rowsById.get(planNode.node_id) ?? {}
    const task = taskById.get(row.current_task_id)
    const dependencies = dependencyReason({ ...planNode, status: row.status }, rowsById)
    const contract = resourceContract(task, planNode)
    const { input } = taskEnvelope(task)
    const metadata = input?.metadata && typeof input.metadata === "object" ? input.metadata : {}
    const status = row.status ?? "PENDING"
    let reason = null
    if (!dependencies.ready) reason = dependencies
    else if (status === "BLOCKED") reason = { ready: false, code: metadata.block_reason_code ?? "LIFECYCLE_GATE", detail: metadata.block_reason ?? "node is blocked by the runtime" }
    else if (metadata.model_available === false) reason = { ready: false, code: "MODEL_UNAVAILABLE", detail: "required model is unavailable" }
    else if (metadata.lane_capacity === 0) reason = { ready: false, code: "LANE_CAPACITY", detail: "lane capacity is exhausted" }
    else if (metadata.resource_conflict_with) reason = { ready: false, code: "RESOURCE_CONFLICT", detail: `conflicts with ${metadata.resource_conflict_with}` }
    else if (status === "FAILED") reason = { ready: false, code: "FAILED", detail: "node execution failed" }
    return {
      ...planNode,
      status,
      task_id: row.current_task_id ?? null,
      attempt: row.attempt ?? 0,
      review_task_id: row.review_task_id ?? null,
      last_verdict: row.last_verdict ?? null,
      resource_contract: contract,
      resources: contract,
      ready: Boolean(dependencies.ready && !reason && ["READY", "PENDING"].includes(status)),
      scheduling_reason: reason?.code ?? null,
      scheduling_detail: reason?.detail ?? null,
      task_history: safeJson(row.task_history_json, []),
      review_history: safeJson(row.review_history_json, []),
      updated_at: row.updated_at ?? null,
    }
  })
  const ready_queue = nodes.filter((node) => node.ready).map((node) => ({ workflow_id: workflow.workflow_id, node_id: node.node_id, lane: node.resource_contract.lane, resource_contract: node.resource_contract }))
  return { ...workflow, plan: planNodes.length ? plan : null, nodes, ready_queue }
}

function readyQueue(snapshot) {
  return snapshot.workflows.flatMap((workflow) => workflowProjection(snapshot, workflow).ready_queue)
}

function laneUsage(snapshot, config) {
  const counts = new Map(Object.keys(config.lanes ?? {}).map((lane) => [lane, { lane, active: 0, running: 0, ready: 0, max_parallel: config.lanes[lane].max_parallel, default_parallel: config.lanes[lane].default_parallel }]))
  for (const task of snapshot.tasks) {
    if (!ACTIVE_TASK_STATES.has(task.status)) continue
    const { input } = taskEnvelope(task)
    const lane = input?.metadata?.lane ?? input?.lane ?? routeLane(input?.route)
    if (!counts.has(lane)) counts.set(lane, { lane, active: 0, running: 0, ready: 0, max_parallel: null, default_parallel: null })
    const value = counts.get(lane); value.active += 1
    if (task.status === "RUNNING") value.running += 1
    if (task.status === "READY") value.ready += 1
  }
  return [...counts.values()].map((value) => ({ ...value, over_capacity: Boolean(value.max_parallel && value.active > value.max_parallel), utilization_pct: value.max_parallel ? Math.min(100, Math.round((value.active / value.max_parallel) * 100)) : null }))
}

function waveEvidence(snapshot) {
  const waves = []
  for (const task of snapshot.tasks) {
    const { result, input } = taskEnvelope(task)
    const nested = embeddedJson(result?.output_text)
    const records = Array.isArray(result?.waves) ? result.waves : (Array.isArray(result?.run?.waves) ? result.run.waves : (Array.isArray(nested?.waves) ? nested.waves : (Array.isArray(nested?.run?.waves) ? nested.run.waves : (nested?.wave && typeof nested.wave === "object" ? [nested.wave] : []))))
    for (const wave of records) waves.push({ workflow_id: input?.metadata?.workflow_id ?? null, ...wave })
  }
  return waves
}

function blockedFailed(snapshot) {
  return snapshot.workflows.reduce((out, workflow) => {
    if (workflow.status === "BLOCKED") out.blocked += 1
    if (workflow.status === "FAILED" || workflow.status === "REWORK_LIMIT") out.failed += 1
    return out
  }, { blocked: 0, failed: 0 })
}

function liveTeamSnapshot(snapshot) {
  const bySession = new Map()
  for (const task of snapshot.tasks) {
    if (!ACTIVE_TASK_STATES.has(task.status)) continue
    const current = bySession.get(task.target_session_key)
    if (!current || String(task.updated_at ?? "") > String(current.updated_at ?? "")) bySession.set(task.target_session_key, task)
  }
  return snapshot.sessions.map((session) => {
    const task = bySession.get(session.session_key)
    const { input } = taskEnvelope(task)
    const started = Date.parse(task?.created_at ?? session.last_used_at ?? "")
    const ended = Date.parse(task?.updated_at ?? "")
    const elapsed_ms = Number.isFinite(started) ? Math.max(0, (Number.isFinite(ended) && task?.status !== "RUNNING" ? ended : Date.now()) - started) : null
    const contract = resourceContract(task)
    return {
      lane: input?.metadata?.lane ?? input?.lane ?? routeLane(input?.route),
      role: session.role,
      model_runtime_id: session.model_runtime_id,
      project_id: session.project_id,
      task_id: task?.task_id ?? null,
      node_id: input?.metadata?.workflow_node_id ?? null,
      workflow_id: input?.metadata?.workflow_id ?? null,
      session_key: session.session_key,
      session_id: session.opencode_session_id,
      generation: session.generation,
      context_pct: session.context_pct,
      resource_contract: contract,
      resources: contract,
      elapsed_ms,
      status: task?.status ?? session.status,
      updated_at: task?.updated_at ?? session.last_used_at,
    }
  })
}

function completionSnapshot(snapshot) {
  return withDb((db) => {
    if (!db) return snapshot.workflows.map((workflow) => ({ workflow_id: workflow.workflow_id, status: "REVIEW_PENDING", reviewer_pass: false, finalized: false, execution_gate: "PENDING", delivery_gate: "PENDING", final_report_permission: "DENIED", missing_reasons: ["SQLITE_RUNTIME_UNAVAILABLE"] }))
    const adapter = { query(sql) { const statement = db.prepare(sql); return { get: (...args) => statement.get(...args), all: (...args) => statement.all(...args) } } }
    const guard = createCompletionCore({ db: adapter })
    return snapshot.workflows.map((workflow) => {
      const permission = guard.finalReportPermission({ workflow_id: workflow.workflow_id })
      const delivery = permission?.delivery ?? {}
      const execution = delivery?.execution ?? {}
      const finalized = permission?.ok === true && permission?.permission === true
      const missing = Array.isArray(delivery?.missing) ? delivery.missing : (permission?.detail ? [{ reason: permission.detail }] : [])
      return {
        workflow_id: workflow.workflow_id,
        status: finalized ? "FINAL_REPORT_ALLOWED" : (delivery?.reviewer_pass ? "DELIVERY_PENDING" : "REVIEW_PENDING"),
        reviewer_pass: delivery?.reviewer_pass === true,
        finalized,
        execution_gate: execution?.ok === true ? "PASS" : "PENDING",
        delivery_gate: delivery?.ok === true ? "PASS" : "PENDING",
        final_report_permission: finalized ? "ALLOWED" : "DENIED",
        missing_reasons: missing.map((item) => typeof item === "string" ? item : [item.reason, item.route, item.node_id, item.evidence].filter(Boolean).join(":")),
        guard_code: permission?.code ?? null,
      }
    })
  })
}

async function health() {
  return {
    status: "OK",
    service: "ai-dev-control-plane",
    root,
    git: { head: run("git", ["rev-parse", "--short", "HEAD"]), status_short: run("git", ["status", "--short"]) },
    architecture: architecture(),
    runtime: await runtimeService(),
    lifecycle: { automatic_rotation: "LOCKED", reason: "Plan 8 final acceptance evidence is still required" },
  }
}

async function dashboard() {
  const snapshot = runtimeSnapshot()
  const config = configSnapshot()
  const healthData = await health()
  const workflowStatuses = snapshot.workflows.reduce((map, row) => { map[row.status] = (map[row.status] ?? 0) + 1; return map }, {})
  const liveTeam = liveTeamSnapshot(snapshot).map((item) => ({ ...item, agent_id: snapshot.sessions.find((session) => session.session_key === item.session_key)?.agent_id ?? null, lifecycle_state: snapshot.sessions.find((session) => session.session_key === item.session_key)?.lifecycle_state ?? null }))
  return {
    ...healthData,
    agents: config.agents,
    projects: config.projects,
    lanes: config.lanes,
    counts: { workflows: snapshot.workflows.length, tasks: snapshot.tasks.length, sessions: snapshot.sessions.length, workflow_status: workflowStatuses },
    workflow_status: workflowStatuses,
    blocked_failed: blockedFailed(snapshot),
    lane_usage: laneUsage(snapshot, config),
    ready_queue: readyQueue(snapshot),
    waves: waveEvidence(snapshot),
    completion: completionSnapshot(snapshot),
    live_team: liveTeam,
  }
}

function body(request) {
  return new Promise((resolve, reject) => {
    let data = ""
    request.on("data", (chunk) => { data += chunk })
    request.on("end", () => { try { resolve(data ? JSON.parse(data) : {}) } catch { reject(new Error("INVALID_JSON")) } })
    request.on("error", reject)
  })
}

async function handle(request, response) {
  const url = new URL(request.url, "http://127.0.0.1")
  if (request.method === "GET" && url.pathname === "/") return text(response, 200, fs.readFileSync(path.join(publicDir, "index.html"), "utf8"), "text/html; charset=utf-8")
  if (request.method === "GET" && url.pathname === "/app.js") return text(response, 200, fs.readFileSync(path.join(publicDir, "app.js"), "utf8"), "text/javascript; charset=utf-8")
  if (request.method === "GET" && url.pathname === "/styles.css") return text(response, 200, fs.readFileSync(path.join(publicDir, "styles.css"), "utf8"), "text/css; charset=utf-8")
  if (request.method === "GET" && url.pathname === "/api/health") return json(response, 200, await health())
  if (request.method === "GET" && url.pathname === "/api/dashboard") return json(response, 200, await dashboard())
  if (request.method === "GET" && url.pathname === "/api/architecture") return json(response, 200, architecture())
  if (request.method === "GET" && url.pathname === "/api/workflows") {
    const snapshot = runtimeSnapshot()
    return json(response, 200, { workflows: snapshot.workflows.map((workflow) => workflowProjection(snapshot, workflow)), ready_queue: readyQueue(snapshot), waves: waveEvidence(snapshot) })
  }
  const workflowMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)$/)
  if (request.method === "GET" && workflowMatch) {
    const id = decodeURIComponent(workflowMatch[1]); const snapshot = runtimeSnapshot(); const workflow = snapshot.workflows.find((item) => item.workflow_id === id)
    if (!workflow) return json(response, 404, { status: "NOT_FOUND", code: "WORKFLOW_NOT_FOUND", workflow_id: id })
    const projection = workflowProjection(snapshot, workflow)
    return json(response, 200, { workflow: projection, nodes: projection.nodes, ready_queue: projection.ready_queue, tasks: snapshot.tasks.filter((task) => snapshot.nodes.some((node) => node.workflow_id === id && node.current_task_id === task.task_id)), waves: waveEvidence(snapshot).filter((wave) => wave.workflow_id === id) })
  }
  if (request.method === "GET" && url.pathname === "/api/sessions") {
    const snapshot = runtimeSnapshot()
    return json(response, 200, { sessions: snapshot.sessions, lifecycle_events: snapshot.lifecycle_events, rotations: snapshot.rotations, automatic_rotation: "LOCKED", controls: { checkpoint: "CONTROL_RUNTIME_REQUIRED", reconcile: "CONTROL_RUNTIME_REQUIRED", rotate: "LIFECYCLE_LOCKED" } })
  }
  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/)
  if (request.method === "GET" && sessionMatch) {
    const sessionKey = decodeURIComponent(sessionMatch[1]); const snapshot = runtimeSnapshot(); const session = snapshot.sessions.find((item) => item.session_key === sessionKey)
    if (!session) return json(response, 404, { status: "NOT_FOUND", code: "SESSION_NOT_FOUND", session_key: sessionKey })
    return json(response, 200, { session, lifecycle_events: snapshot.lifecycle_events.filter((event) => event.session_key === sessionKey), rotations: snapshot.rotations.filter((rotation) => rotation.session_key === sessionKey), controls: { checkpoint: "CONTROL_RUNTIME_REQUIRED", reconcile: "CONTROL_RUNTIME_REQUIRED", rotate: "LIFECYCLE_LOCKED" }, automatic_rotation: "LOCKED" })
  }
  const sessionControl = url.pathname.match(/^\/api\/control\/sessions\/([^/]+)\/(checkpoint|reconcile|rotate)$/)
  if (request.method === "POST" && sessionControl) {
    const sessionKey = decodeURIComponent(sessionControl[1]); const action = sessionControl[2]
    if (action === "rotate") return json(response, 423, { status: "LOCKED", code: "LIFECYCLE_LOCKED", session_key: sessionKey, detail: "Automatic rotation remains locked until Plan 8 final acceptance evidence is complete" })
    return json(response, 409, { status: "REJECTED", code: "CONTROL_RUNTIME_REQUIRED", session_key: sessionKey, action, detail: "Lifecycle actions must be dispatched through the Lifecycle Agent runtime" })
  }
  const evidence = () => {
    const snapshot = runtimeSnapshot()
    return { generated_at: new Date().toISOString(), architecture: architecture(), git: { head: run("git", ["rev-parse", "--short", "HEAD"]), status_short: run("git", ["status", "--short"]) }, runtime: snapshot, waves: waveEvidence(snapshot), completion: completionSnapshot(snapshot), lifecycle: { automatic_rotation: "LOCKED", events: snapshot.lifecycle_events, rotations: snapshot.rotations } }
  }
  if (request.method === "GET" && url.pathname === "/api/evidence") {
    const value = evidence()
    if (url.searchParams.get("format") === "markdown") {
      const lines = ["# AI-Dev Control Plane Evidence", "", `Generated: ${value.generated_at}`, `Architecture: ${value.architecture.status ?? "UNKNOWN"}`, `Git HEAD: ${value.git.head || "unknown"}`, `Automatic rotation: LOCKED`, "", "## Waves", value.waves.length ? value.waves.map((wave) => `- ${wave.workflow_id ?? "unknown"}: ${JSON.stringify(wave)}`).join("\n") : "- none", "", "## Completion", value.completion.length ? value.completion.map((item) => `- ${item.workflow_id}: ${item.status} (${item.final_report_permission})`).join("\n") : "- none"]
      return text(response, 200, lines.join("\n"), "text/markdown; charset=utf-8")
    }
    return json(response, 200, value)
  }
  if (request.method === "GET" && url.pathname === "/api/evidence.md") {
    url.searchParams.set("format", "markdown")
    const value = evidence(); const lines = ["# AI-Dev Control Plane Evidence", "", `Generated: ${value.generated_at}`, `Architecture: ${value.architecture.status ?? "UNKNOWN"}`, `Git HEAD: ${value.git.head || "unknown"}`, "Automatic rotation: LOCKED"]
    return text(response, 200, lines.join("\n"), "text/markdown; charset=utf-8")
  }
  const workflowControl = url.pathname.match(/^\/api\/workflows\/([^/]+)\/control$/)
  if (request.method === "GET" && workflowControl) {
    const id = decodeURIComponent(workflowControl[1]); const snapshot = runtimeSnapshot(); const workflow = snapshot.workflows.find((item) => item.workflow_id === id)
    if (!workflow) return json(response, 404, { status: "NOT_FOUND", code: "WORKFLOW_NOT_FOUND", workflow_id: id })
    const terminal = ["COMPLETED", "FAILED", "REWORK_LIMIT"].includes(workflow.status)
    return json(response, 200, { workflow_id: id, status: workflow.status, actions: { run: !terminal && workflow.status === "READY" ? "RUNTIME_REQUIRED" : "DISABLED", resume: !terminal && ["BLOCKED", "RUNNING", "READY", "REVIEWING", "REWORKING"].includes(workflow.status) ? "RUNTIME_REQUIRED" : "DISABLED", retry: !terminal && ["BLOCKED", "FAILED"].includes(workflow.status) ? "RUNTIME_REQUIRED" : "DISABLED", cancel: "UNAVAILABLE" }, mutation_boundary: "Workflow Engine runtime" })
  }
  if (request.method === "POST" && url.pathname === "/api/control/architecture/apply") {
    let input
    try { input = await body(request) } catch { return json(response, 400, { status: "REJECTED", code: "INVALID_JSON" }) }
    if (input.confirm !== "APPLY_ARCHITECTURE") return json(response, 400, { status: "REJECTED", code: "EXPLICIT_CONFIRMATION_REQUIRED" })
    const target = ["all", "config", "profiles"].includes(input.target) ? input.target : "all"
    try {
      const output = execFileSync(process.execPath, ["--experimental-strip-types", compiler, "apply", `--target=${target}`, "--yes"], { cwd: root, encoding: "utf8", timeout: 30000 })
      return json(response, 200, JSON.parse(output))
    } catch (error) { return json(response, 409, { status: "REJECTED", code: "ARCHITECTURE_APPLY_FAILED", detail: error?.stderr?.toString() ?? error?.message ?? String(error) }) }
  }
  const controlWorkflow = url.pathname.match(/^\/api\/control\/workflows\/([^/]+)$/)
  if (request.method === "POST" && controlWorkflow) {
    let input = {}
    try { input = await body(request) } catch { return json(response, 400, { status: "REJECTED", code: "INVALID_JSON" }) }
    const action = ["run", "resume", "retry", "cancel"].includes(input.action) ? input.action : "unknown"
    return json(response, 409, { status: "REJECTED", code: "CONTROL_RUNTIME_REQUIRED", workflow_id: decodeURIComponent(controlWorkflow[1]), action, detail: "Workflow actions must be dispatched through the Workflow Engine runtime", mutation_boundary: "Workflow Engine runtime" })
  }
  if (request.method === "POST" && url.pathname === "/api/control/lifecycle/automatic-rotation") return json(response, 423, { status: "LOCKED", code: "LIFECYCLE_LOCKED", detail: "Plan 8 final acceptance evidence is still required" })
  return json(response, 404, { status: "NOT_FOUND", code: "ROUTE_NOT_FOUND" })
}

const server = http.createServer((request, response) => { handle(request, response).catch((error) => json(response, 500, { status: "ERROR", code: error?.message ?? String(error) })) })
server.listen(port, "127.0.0.1", () => { console.log(`CONTROL_PLANE_READY ${server.address().port}`) })
