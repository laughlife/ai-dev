import fs from "node:fs"
import path from "node:path"
import http from "node:http"
import { execFileSync } from "node:child_process"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"

const root = path.resolve(process.env.AI_DEV_ROOT ?? process.cwd())
const port = Number(process.env.CONTROL_PLANE_PORT ?? 4310)
const dbPath = path.join(root, "runtime", "tasks.db")
const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const compiler = path.resolve(moduleDir, "..", "architecture-sync", "cli.ts")
const publicDir = path.join(moduleDir, "public")

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
    const workflows = hasTable(db, "workflows") ? rows(db, "SELECT workflow_id, primary_project_id, objective, status, rework_cycle, created_at, updated_at, finished_at, completion_guard_finalized_at FROM workflows ORDER BY updated_at DESC") : []
    const nodes = hasTable(db, "workflow_nodes") ? rows(db, "SELECT workflow_id, node_id, current_task_id, attempt, status, review_task_id, last_verdict, updated_at FROM workflow_nodes ORDER BY workflow_id, node_id") : []
    const tasks = hasTable(db, "tasks") ? rows(db, "SELECT task_id, parent_task_id, project_id, target_role, target_session_key, status, created_at, updated_at FROM tasks ORDER BY updated_at DESC LIMIT 200") : []
    const sessions = hasTable(db, "sessions") ? rows(db, "SELECT session_key, project_id, role, opencode_session_id, generation, agent_id, model_runtime_id, status, context_tokens, context_limit, context_pct, telemetry_source, telemetry_at, lifecycle_state, last_used_at FROM sessions ORDER BY last_used_at DESC LIMIT 200") : []
    return { available: Boolean(db), error: error?.message ?? null, workflows, nodes, tasks, sessions }
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
    lanes: mapKeys(path.join(config, "workflow.yaml"), "lanes"),
  }
}

function completionSnapshot(snapshot) {
  return snapshot.workflows.map((workflow) => {
    const finalized = workflow.status === "COMPLETED" && workflow.finished_at && workflow.finished_at === workflow.completion_guard_finalized_at
    const reviewPass = snapshot.nodes.some((node) => node.workflow_id === workflow.workflow_id && node.last_verdict === "PASS")
    return { workflow_id: workflow.workflow_id, status: finalized ? "FINAL_REPORT_ALLOWED" : (reviewPass ? "DELIVERY_PENDING" : "REVIEW_PENDING"), reviewer_pass: reviewPass, finalized }
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
  const liveTeam = snapshot.sessions.map((session) => ({ agent_id: session.agent_id, role: session.role, project_id: session.project_id, model_runtime_id: session.model_runtime_id, session_key: session.session_key, generation: session.generation, context_pct: session.context_pct, lifecycle_state: session.lifecycle_state, status: session.status }))
  return {
    ...healthData,
    agents: config.agents,
    projects: config.projects,
    lanes: config.lanes,
    counts: { workflows: snapshot.workflows.length, tasks: snapshot.tasks.length, sessions: snapshot.sessions.length, workflow_status: workflowStatuses },
    workflow_status: workflowStatuses,
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
    return json(response, 200, { workflows: snapshot.workflows.map((workflow) => ({ ...workflow, nodes: snapshot.nodes.filter((node) => node.workflow_id === workflow.workflow_id) })) })
  }
  const workflowMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)$/)
  if (request.method === "GET" && workflowMatch) {
    const id = decodeURIComponent(workflowMatch[1]); const snapshot = runtimeSnapshot(); const workflow = snapshot.workflows.find((item) => item.workflow_id === id)
    if (!workflow) return json(response, 404, { status: "NOT_FOUND", code: "WORKFLOW_NOT_FOUND", workflow_id: id })
    return json(response, 200, { workflow, nodes: snapshot.nodes.filter((node) => node.workflow_id === id), tasks: snapshot.tasks.filter((task) => snapshot.nodes.some((node) => node.workflow_id === id && node.current_task_id === task.task_id)) })
  }
  if (request.method === "GET" && url.pathname === "/api/sessions") return json(response, 200, { sessions: runtimeSnapshot().sessions })
  if (request.method === "GET" && url.pathname === "/api/evidence") return json(response, 200, { generated_at: new Date().toISOString(), architecture: architecture(), git: { head: run("git", ["rev-parse", "--short", "HEAD"]), status_short: run("git", ["status", "--short"]) }, runtime: runtimeSnapshot() })
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
  if (request.method === "POST" && controlWorkflow) return json(response, 409, { status: "REJECTED", code: "CONTROL_RUNTIME_REQUIRED", workflow_id: decodeURIComponent(controlWorkflow[1]), detail: "Workflow actions must be dispatched through the Workflow Engine runtime" })
  if (request.method === "POST" && url.pathname === "/api/control/lifecycle/automatic-rotation") return json(response, 423, { status: "LOCKED", code: "LIFECYCLE_LOCKED", detail: "Plan 8 final acceptance evidence is still required" })
  return json(response, 404, { status: "NOT_FOUND", code: "ROUTE_NOT_FOUND" })
}

const server = http.createServer((request, response) => { handle(request, response).catch((error) => json(response, 500, { status: "ERROR", code: error?.message ?? String(error) })) })
server.listen(port, "127.0.0.1", () => { console.log(`CONTROL_PLANE_READY ${server.address().port}`) })
