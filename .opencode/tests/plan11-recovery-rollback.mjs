import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { execFileSync } from "node:child_process"
import assert from "node:assert/strict"

const root = path.resolve(".")
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "ai-dev-production-drill-"))
fs.cpSync(path.join(root, "diagrams"), path.join(fixture, "diagrams"), { recursive: true })
fs.cpSync(path.join(root, "framework-config"), path.join(fixture, "framework-config"), { recursive: true })
fs.cpSync(path.join(root, ".opencode", "agents"), path.join(fixture, ".opencode", "agents"), { recursive: true })
fs.mkdirSync(path.join(fixture, "runtime"), { recursive: true })
fs.copyFileSync(path.join(root, "runtime", "tasks.db"), path.join(fixture, "runtime", "tasks.db"))

function startServer() {
  const child = spawn(process.execPath, ["--experimental-strip-types", "tools/control-plane/server.mjs"], { cwd: root, env: { ...process.env, AI_DEV_ROOT: fixture, CONTROL_PLANE_PORT: "0" }, stdio: ["ignore", "pipe", "ignore"] })
  let output = ""
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server start timeout: ${output}`)), 10000)
    child.stdout.on("data", (chunk) => { output += chunk.toString(); const match = output.match(/CONTROL_PLANE_READY (\d+)/); if (match) { clearTimeout(timer); resolve(Number(match[1])) } })
    child.on("error", reject)
  })
  return { child, ready }
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === "win32") {
    try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }) } catch {}
  } else child.kill("SIGTERM")
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 1000))])
}

let first
let second
try {
  first = startServer()
  const port = await first.ready
  const firstHealth = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()
  assert.equal(firstHealth.status, "OK")
  assert.equal(firstHealth.architecture.status, "IN_SYNC")
  await stopServer(first.child)
  second = startServer()
  const secondPort = await second.ready
  const secondHealth = await (await fetch(`http://127.0.0.1:${secondPort}/api/health`)).json()
  assert.equal(secondHealth.status, "OK")
  assert.equal(secondHealth.architecture.status, "IN_SYNC")
  const rollback = execFileSync(process.execPath, ["--experimental-strip-types", ".opencode/tests/architecture-compiler-hardening.mjs"], { cwd: root, encoding: "utf8" })
  assert.match(rollback, /ARCHITECTURE_COMPILER_HARDENING_EXPECTED_PASS/)
  console.log("PLAN11_RECOVERY_ROLLBACK_PASS", JSON.stringify({ restart: "IN_SYNC", rollback: "PASS" }))
} finally {
  await stopServer(first?.child)
  await stopServer(second?.child)
  fs.rmSync(fixture, { recursive: true, force: true })
}
