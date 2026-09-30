import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import assert from "node:assert/strict"

const root = path.resolve(".")
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "ai-dev-control-plane-"))
fs.cpSync(path.join(root, "diagrams"), path.join(fixture, "diagrams"), { recursive: true })
fs.cpSync(path.join(root, "framework-config"), path.join(fixture, "framework-config"), { recursive: true })
fs.cpSync(path.join(root, ".opencode", "agents"), path.join(fixture, ".opencode", "agents"), { recursive: true })
fs.mkdirSync(path.join(fixture, "runtime"), { recursive: true })
fs.copyFileSync(path.join(root, "runtime", "tasks.db"), path.join(fixture, "runtime", "tasks.db"))

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
  const workflows = await (await fetch(`${base}/api/workflows`)).json()
  assert.ok(Array.isArray(workflows.workflows))
  const sessions = await (await fetch(`${base}/api/sessions`)).json()
  assert.ok(Array.isArray(sessions.sessions))
  const evidence = await (await fetch(`${base}/api/evidence`)).json()
  assert.equal(evidence.architecture.status, "IN_SYNC")
  const page = await (await fetch(base)).text()
  assert.match(page, /AI-Dev Control Plane/)
  const denied = await fetch(`${base}/api/control/workflows/unknown`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "resume" }) })
  assert.equal(denied.status, 409)
  assert.equal((await denied.json()).code, "CONTROL_RUNTIME_REQUIRED")
  const applyDenied = await fetch(`${base}/api/control/architecture/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: "config" }) })
  assert.equal(applyDenied.status, 400)
  assert.equal((await applyDenied.json()).code, "EXPLICIT_CONFIRMATION_REQUIRED")
  const locked = await fetch(`${base}/api/control/lifecycle/automatic-rotation`, { method: "POST" })
  assert.equal(locked.status, 423)
  assert.equal((await locked.json()).code, "LIFECYCLE_LOCKED")
  console.log("PLAN10_CONTROL_PLANE_PASS", JSON.stringify({ health: health.status, architecture: health.architecture.status, rotation: dashboard.lifecycle.automatic_rotation, workflows: workflows.workflows.length }))
} finally {
  child.kill()
  fs.rmSync(fixture, { recursive: true, force: true })
}
