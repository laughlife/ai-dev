import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"

const root = process.cwd()
const endpoint = process.env.OPENCODE_RUNTIME_ENDPOINT ?? "http://127.0.0.1:49374"
const directory = process.env.OPENCODE_DIRECTORY ?? root
const headers = { "x-opencode-directory": directory }
const controlPlane = path.join(root, "runtime", "control-plane.db")
const trackedFiles = [controlPlane, path.join(root, "runtime", "tasks.db"), path.join(root, "runtime", "tasks.db-wal"), path.join(root, "runtime", "tasks.db-shm")]
function fileState(file) {
  try {
    const bytes = fs.readFileSync(file)
    return { exists: true, size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") }
  } catch {
    return { exists: false }
  }
}
const before = Object.fromEntries(trackedFiles.map((file) => [file, fileState(file)]))

async function read(url, options = {}) {
  try {
    const response = await fetch(url, { headers: { ...headers, ...(options.headers ?? {}) }, ...options })
    return { status: response.status, ok: response.ok, body: (await response.text()).slice(0, 400) }
  } catch (error) {
    return { status: 0, ok: false, body: error?.message ?? String(error) }
  }
}

const info = await read(`${endpoint}/api/info`)
const plugin = await read(`${endpoint}/api/plugin`)
const rpc = {}
for (const tool of ["workflow_plan", "workflow_run", "workflow_execute", "workflow_get", "workflow_list"]) {
  rpc[tool] = await read(`${endpoint}/api/rpc/workflow-engine/${tool}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  })
}

const rpcAvailable = Object.values(rpc).every((result) => result.ok)
const pluginLoaded = /workflow-engine/.test(plugin.body)
const after = Object.fromEntries(trackedFiles.map((file) => [file, fileState(file)]))
console.log(JSON.stringify({ endpoint, info, plugin, rpc, control_plane_before: before, control_plane_after: after }, null, 2))

if (info.ok && pluginLoaded && rpcAvailable) {
  // Plan 12.5 deliberately does not invent a workflow invocation shape. A live
  // smoke is only admitted once the Runtime response contract is explicit.
  console.log("PLAN12_RUNTIME_ADAPTER_LIVE_BLOCKED")
  console.log("reason=runtime workflow smoke contract is not yet safely discoverable")
} else {
  console.log("PLAN12_RUNTIME_ADAPTER_LIVE_BLOCKED")
  console.log(`reason=runtime endpoint or workflow RPC unavailable (HTTP ${info.status})`)
}

if (JSON.stringify(before) !== JSON.stringify(after)) process.exitCode = 1
