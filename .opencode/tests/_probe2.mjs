import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { parseYaml } from "./yaml-lite.mjs"

globalThis.Bun = {
  YAML: { parse: parseYaml },
  spawnSync: (cmdOrArgs) => {
    const args = Array.isArray(cmdOrArgs) ? cmdOrArgs : cmdOrArgs?.cmd ?? []
    const rest = args.slice(1)
    let out = ""
    if (rest[0] === "rev-parse" && rest[1] === "--abbrev-ref") out = "test-branch\n"
    else if (rest[0] === "rev-parse" && rest[1] === "HEAD") out = "deadbeef\n"
    else if (rest[0] === "status") out = " M framework-config/lifecycle.yaml\n"
    return { exitCode: 0, stdout: out, stderr: "" }
  },
}

const REPO = "D:/ai-dev"
const FIX = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-probe2-"))
fs.mkdirSync(path.join(FIX, "framework-config"), { recursive: true })
fs.mkdirSync(path.join(FIX, "runtime"), { recursive: true })
for (const f of ["lifecycle.yaml", "projects.yaml", "agents.yaml"]) fs.copyFileSync(path.join(REPO, "framework-config", f), path.join(FIX, "framework-config", f))

const { createRuntimeRegistryCore } = await import("../lib/runtime-registry-core.ts")
const { createLifecycleCore } = await import("../lib/lifecycle-core.ts")

let seq = 0
const sess = new Map()
const ctx = {
  location: { directory: FIX },
  session: {
    async create({ title }) { const id = "ses-" + (++seq); sess.set(id, { messages: [], synthetics: [], alive: true, title }); return { id } },
    async get({ sessionID }) { const s = sess.get(sessionID); if (!s || !s.alive) throw new Error("gone"); return { id: sessionID } },
    async context({ sessionID }) { const s = sess.get(sessionID); return s ? s.messages : [] },
    async switchAgent() {}, async switchModel() {}, async synthetic({ sessionID, text }) { sess.get(sessionID)?.synthetics.push(text) },
    async generate() { return "GENERATED SUMMARY" },
  },
  model: { async list() { return [{ providerID: "openai", id: "gpt-5.6-sol-fast", limit: { context: 200000 } }, { providerID: "deepseek", id: "deepseek-flash", limit: { context: 100000 } }] } },
}

const core = createRuntimeRegistryCore(ctx, { schemaFile: path.join(REPO, ".opencode/plugins/runtime-registry/schema.sql"), lifecycleSchemaFile: path.join(REPO, ".opencode/plugins/lifecycle-engine/schema.sql") })
const lifecycle = createLifecycleCore(ctx, core)
const now = () => new Date().toISOString()
const ins = core.db.query("INSERT INTO sessions (session_key, project_id, role, opencode_session_id, generation, agent_id, model_runtime_id, project_path, status, checkpoint_path, created_at, last_used_at, replaced_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
const key = "project:ruoyi-vue-pro:main"
const predId = (await ctx.session.create({ title: "pred" })).id
ins.run(key, "ruoyi-vue-pro", "project-main", predId, 1, "project-main", "openai/gpt-5.6-sol-fast#high", FIX, "ACTIVE", null, now(), now(), null)
sess.get(predId).messages = [{ info: { type: "assistant", role: "assistant", model: { providerID: "openai", id: "gpt-5.6-sol-fast" }, tokens: { input: 150000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } }]

const r = await lifecycle.rotateSession({ session_key: key, force: true, reason: "probe" })
console.log("ROTATE:", JSON.stringify({ ok: r.ok, status: r.status, code: r.code, to: r.to_generation, succ: r.successor_session_id, detail: r.detail }))
console.log("rows:", core.db.query("SELECT session_key, generation, status, lifecycle_state, replaced_by, checkpoint_path FROM sessions ORDER BY generation").all())
console.log("rot:", core.db.query("SELECT status, to_generation, successor_session_id FROM lifecycle_rotations").all())
const succ = core.db.query("SELECT opencode_session_id FROM sessions WHERE session_key=? AND generation=2").get(key)
console.log("successor synthetics:", sess.get(succ.opencode_session_id).synthetics.map(s => s.split("\n")[0]))
core.close(); fs.rmSync(FIX, { recursive: true, force: true }); console.log("PROBE2 OK")
