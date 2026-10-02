import assert from "node:assert/strict"

// This is deliberately a read-only probe.  It never opens runtime/control-plane.db
// and never turns an advertised model into an AVAILABLE catalog entry.
const endpoint = process.env.OPENCODE_RUNTIME_ENDPOINT ?? "http://127.0.0.1:49374"
const directory = process.env.OPENCODE_DIRECTORY ?? process.cwd()
const headers = { "x-opencode-directory": directory }
const observedAt = new Date().toISOString()
const read = async (path) => {
  try {
    const response = await fetch(`${endpoint}${path}`, { headers })
    const text = await response.text()
    let body = null
    try { body = JSON.parse(text) } catch { body = { raw: text.slice(0, 400) } }
    return { ok: response.ok, status: response.status, body }
  } catch (error) {
    return { ok: false, status: 0, body: { error: error?.message ?? String(error) } }
  }
}

const info = await read("/api/info")
const plugins = await read("/api/plugin")
const providers = await read("/api/provider")
const models = await read("/api/model")
const requiredTools = ["workflow_plan", "workflow_run", "workflow_execute", "workflow_get", "workflow_list"]
const rpc = {}
for (const tool of requiredTools) {
  try {
    const response = await fetch(`${endpoint}/api/rpc/workflow-engine/${tool}`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}",
    })
    rpc[tool] = { status: response.status, ok: response.ok, body: (await response.text()).slice(0, 400) }
  } catch (error) {
    rpc[tool] = { status: 0, ok: false, body: error?.message ?? String(error) }
  }
}

const pluginText = JSON.stringify(plugins.body ?? {})
const pluginLoaded = /workflow-engine/.test(pluginText)
const rpcReachable = requiredTools.every((tool) => rpc[tool]?.ok)
const version = info.body?.version ?? "unknown"
const providerCount = Array.isArray(providers.body) ? providers.body.length : null
const modelCount = Array.isArray(models.body) ? models.body.length : null

assert.equal(typeof endpoint, "string")
console.log(JSON.stringify({ observed_at: observedAt, endpoint, runtime_version: version, plugin_loaded: pluginLoaded, provider_count: providerCount, model_count: modelCount, rpc }, null, 2))
if (info.ok && pluginLoaded && rpcReachable) {
  console.log("PLAN12_RUNTIME_MODEL_PROBE_PASS")
} else {
  console.log("PLAN12_RUNTIME_MODEL_PROBE_BLOCKED")
  console.log(`reason=${info.ok ? (pluginLoaded ? "workflow-engine RPC unavailable" : "workflow-engine plugin not observed") : `runtime endpoint unavailable (HTTP ${info.status})`}`)
}
