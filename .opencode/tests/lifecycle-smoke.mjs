import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { parseYaml } from "./yaml-lite.mjs"

globalThis.Bun = {
  YAML: { parse: parseYaml },
  spawnSync: (value) => {
    const args = Array.isArray(value) ? value : value?.cmd ?? []
    const rest = args.slice(1)
    let stdout = ""
    if (rest[0] === "rev-parse" && rest[1] === "--abbrev-ref") stdout = "smoke-branch\n"
    if (rest[0] === "rev-parse" && rest[1] === "HEAD") stdout = "deadbeef\n"
    if (rest[0] === "status") stdout = " M framework-config/lifecycle.yaml\n"
    return { exitCode: 0, stdout, stderr: "" }
  },
}

const repo = path.resolve(".")
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-lifecycle-smoke-"))
const configDir = path.join(tempRoot, "framework-config")
fs.mkdirSync(configDir, { recursive: true })
fs.mkdirSync(path.join(tempRoot, "runtime"), { recursive: true })
for (const file of ["lifecycle.yaml", "projects.yaml", "agents.yaml"]) {
  fs.copyFileSync(path.join(repo, "framework-config", file), path.join(configDir, file))
}

const { createRuntimeRegistryCore } = await import("../lib/runtime-registry-core.ts")
const { createLifecycleCore } = await import("../lib/lifecycle-core.ts")
const { registerLifecycleObservationHooks } = await import("../lib/lifecycle-hooks.ts")

const sessions = new Map()
let sequence = 0
const generated = []
let catalogLimit = 200000
const ctx = {
  location: { directory: tempRoot },
  session: {
    async create({ title }) {
      const id = `smoke-${++sequence}`
      sessions.set(id, { messages: [], synthetics: [], title, alive: true })
      return { id }
    },
    async get({ sessionID }) {
      if (!sessions.get(sessionID)?.alive) throw new Error("session unavailable")
      return { id: sessionID }
    },
    async context({ sessionID }) { return sessions.get(sessionID)?.messages ?? [] },
    async switchAgent() {},
    async switchModel() {},
    async synthetic({ sessionID, text }) { sessions.get(sessionID)?.synthetics.push(text) },
    async generate(input) { generated.push(input); return "bounded smoke summary" },
  },
  model: {
    async list() {
      return { location: tempRoot, data: [{ providerID: "openai", id: "gpt-5.6-sol-fast", limit: catalogLimit == null ? {} : { context: catalogLimit } }] }
    },
  },
}

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT: ${message}`)
}
function now() { return new Date().toISOString() }
function insertSession(db, row) {
  db.query(
    "INSERT INTO sessions (session_key, project_id, role, opencode_session_id, generation, agent_id, model_runtime_id, project_path, status, checkpoint_path, created_at, last_used_at, replaced_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(row.key, row.project, row.role, row.id, row.generation, row.agent, row.runtime, tempRoot, row.status ?? "ACTIVE", null, now(), now(), null)
}

const core = createRuntimeRegistryCore(ctx, {
  schemaFile: path.join(repo, ".opencode/plugins/runtime-registry/schema.sql"),
  lifecycleSchemaFile: path.join(repo, ".opencode/plugins/lifecycle-engine/schema.sql"),
})
const lifecycle = createLifecycleCore(ctx, core)
const predecessor = await ctx.session.create({ title: "predecessor" })
const key = "project:ruoyi-vue-pro:main"
insertSession(core.db, {
  key, project: "ruoyi-vue-pro", role: "project-main", id: predecessor.id, generation: 1,
  agent: "project-main", runtime: "openai/gpt-5.6-sol-fast#high",
})
sessions.get(predecessor.id).messages = [{ info: {
  type: "assistant", model: { providerID: "openai", id: "gpt-5.6-sol-fast" },
  tokens: { input: 150000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
} }]

const telemetry = await lifecycle.refreshTelemetry({ session_key: key, observation_source: "smoke" })
assert(telemetry.ok && telemetry.context_pct === 75, "verified telemetry computes 75 percent")
assert(core.db.query("SELECT COUNT(*) AS n FROM lifecycle_events WHERE event_type='TELEMETRY_SAMPLE'").get().n === 1, "telemetry event persisted")
assert(JSON.parse(core.db.query("SELECT details_json FROM lifecycle_events LIMIT 1").get().details_json).observation_source === "smoke", "observation source is audited")
catalogLimit = null
const partial = await lifecycle.refreshTelemetry({ session_key: key, observation_source: "partial-catalog" })
const preserved = core.db.query("SELECT context_limit, context_pct FROM sessions WHERE session_key=? AND generation=1").get(key)
assert(partial.status === "TELEMETRY_PARTIAL" && partial.stored === false && preserved.context_limit === 200000 && preserved.context_pct === 75, "partial catalog sample preserves last verified columns")
catalogLimit = 200000

const evaluation = await lifecycle.evaluateThreshold({ session_key: key, refresh: false })
assert(evaluation.lifecycle_state === "ROTATE_PENDING", "threshold state is dynamic and correct")
const checkpoint = await lifecycle.ensureCheckpoint({ session_key: key, force: true })
assert(checkpoint.ok && fs.existsSync(path.join(tempRoot, checkpoint.checkpoint_path)), "checkpoint is atomically written")
assert(generated.length > 0 && generated.at(-1).sessionID === undefined, "summary generation does not pollute predecessor")
const checkpointJson = JSON.parse(fs.readFileSync(path.join(tempRoot, checkpoint.checkpoint_path), "utf8"))
assert(checkpointJson.schema_version === 1 && checkpointJson.session_key === key, "checkpoint matches v1 contract")

const rowsBeforeForceRestore = core.db.query("SELECT COUNT(*) AS n FROM sessions WHERE session_key=?").get(key).n
const forcedLiveRestore = await lifecycle.restoreSession({ session_key: key, force: true, checkpoint_path: checkpoint.checkpoint_path })
assert(!forcedLiveRestore.ok && forcedLiveRestore.code === "RESTORE_NOT_NEEDED", "force restore never replaces a live active session")
assert(core.db.query("SELECT COUNT(*) AS n FROM sessions WHERE session_key=?").get(key).n === rowsBeforeForceRestore, "live force restore creates no successor row or orphan registry record")

const rotated = await lifecycle.rotateSession({ session_key: key, force: true, reason: "smoke" })
assert(rotated.ok && rotated.to_generation === 2, "rotation creates generation plus one")
assert(core.db.query("SELECT COUNT(*) AS n FROM sessions WHERE session_key=? AND status='ACTIVE'").get(key).n === 1, "rotation leaves one active generation")
assert(core.db.query("SELECT status FROM lifecycle_rotations ORDER BY created_at DESC LIMIT 1").get().status === "COMMITTED", "rotation ledger commits")
assert(core.db.query("SELECT lifecycle_state FROM sessions WHERE session_key=? AND generation=2").get(key).lifecycle_state === "HANDOFF_READY", "successor is handoff ready")
assert((await lifecycle.reconcileRotations({ session_key: key })).ok, "reconcile is idempotent")

const downgraded = await lifecycle.evaluateThreshold({ session_key: key, refresh: true })
assert(downgraded.status === "TELEMETRY_UNAVAILABLE" && downgraded.context_pct === null && downgraded.band === "UNKNOWN", "missing post-compaction sample downgrades to unknown")

const failedKey = "project:ruoyi-vue-pro:reader"
const failedSession = await ctx.session.create({ title: "failure predecessor" })
insertSession(core.db, {
  key: failedKey, project: "ruoyi-vue-pro", role: "project-reader", id: failedSession.id, generation: 1,
  agent: "project-reader", runtime: "openai/gpt-5.6-sol-fast#high",
})
sessions.get(failedSession.id).messages = sessions.get(predecessor.id).messages
const testHooks = { consumePhaseFailure: (sessionKey, phase) => sessionKey === failedKey && phase === "CREATE" }
const hookedLifecycle = createLifecycleCore(ctx, core, { testHooks })
const failed = await hookedLifecycle.rotateSession({ session_key: failedKey, force: true })
assert(!failed.ok && failed.code === "SESSION_CREATE_FAILED" && failed.detail.includes("marker-gated test injection"), `marker-gated create failure is surfaced: ${JSON.stringify(failed)}`)
assert(core.db.query("SELECT status FROM sessions WHERE session_key=? AND generation=1").get(failedKey).status === "ACTIVE", "failed rotation preserves old generation")
assert(core.db.query("SELECT COUNT(*) AS n FROM sessions WHERE session_key=?").get(failedKey).n === 1, "create failure leaves no successor registry row")

const oldRoot = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-lifecycle-legacy-"))
fs.mkdirSync(path.join(oldRoot, "framework-config"), { recursive: true })
fs.mkdirSync(path.join(oldRoot, "runtime"), { recursive: true })
for (const file of ["lifecycle.yaml", "projects.yaml", "agents.yaml"]) fs.copyFileSync(path.join(repo, "framework-config", file), path.join(oldRoot, "framework-config", file))
const legacyDb = new DatabaseSync(path.join(oldRoot, "runtime", "tasks.db"))
legacyDb.exec(fs.readFileSync(path.join(repo, ".opencode/plugins/runtime-registry/schema.sql"), "utf8"))
legacyDb.exec(fs.readFileSync(path.join(repo, ".opencode/plugins/lifecycle-engine/schema.sql"), "utf8"))
legacyDb.exec("DROP TABLE lifecycle_events; DROP TABLE lifecycle_rotations;")
legacyDb.exec("CREATE TABLE lifecycle_events (event_id TEXT PRIMARY KEY, session_key TEXT NOT NULL, generation INTEGER NOT NULL, project_id TEXT, role TEXT, event_type TEXT NOT NULL, context_pct INTEGER, context_used_tokens INTEGER, context_window_tokens INTEGER, checkpoint_path TEXT, detail_json TEXT, created_at TEXT NOT NULL);")
legacyDb.exec("CREATE TABLE lifecycle_rotations (rotation_id TEXT PRIMARY KEY, session_key TEXT NOT NULL, project_id TEXT, role TEXT, from_generation INTEGER NOT NULL, to_generation INTEGER, trigger_reason TEXT NOT NULL, context_pct_at_rotation INTEGER, checkpoint_path TEXT, restore_context_json TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, finished_at TEXT);")
legacyDb.close()
const legacyCtx = { ...ctx, location: { directory: oldRoot } }
const legacyCore = createRuntimeRegistryCore(legacyCtx, {
  schemaFile: path.join(repo, ".opencode/plugins/runtime-registry/schema.sql"),
  lifecycleSchemaFile: path.join(repo, ".opencode/plugins/lifecycle-engine/schema.sql"),
})
assert(legacyCore.schemaMigration.lifecycle_schema_repaired === true, "empty legacy lifecycle tables are repaired")
assert(legacyCore.db.query("PRAGMA table_info(lifecycle_events)").all().some((c) => c.name === "details_json"), "repaired event shape is current")
legacyCore.close()

let hookCalls = 0
await registerLifecycleObservationHooks({ session: { async hook() { hookCalls++; throw new Error("unsupported") } } }, lifecycle, core)
assert(hookCalls === 2, "unsupported observation hooks are isolated from production setup")

core.close()
fs.rmSync(tempRoot, { recursive: true, force: true })
fs.rmSync(oldRoot, { recursive: true, force: true })
console.log("PLAN8_LIFECYCLE_SMOKE_PASS", JSON.stringify({ telemetry: 75, rotation: "COMMITTED", reconcile: "IDEMPOTENT", legacy_schema: "REPAIRED", hook_failures: "ISOLATED" }))
