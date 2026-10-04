import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { parseYaml } from "./yaml-lite.mjs"

globalThis.Bun = { YAML: { parse: parseYaml }, spawnSync: () => ({ exitCode: 0, stdout: "", stderr: "" }) }

const REPO = "D:/ai-dev"
const FIX = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-probe-"))
fs.mkdirSync(path.join(FIX, "framework-config"), { recursive: true })
fs.mkdirSync(path.join(FIX, "runtime"), { recursive: true })
for (const f of ["lifecycle.yaml", "projects.yaml", "agents.yaml"]) {
  fs.copyFileSync(path.join(REPO, "framework-config", f), path.join(FIX, "framework-config", f))
}

const { createRuntimeRegistryCore } = await import("../lib/runtime-registry-core.ts")
const { createLifecycleCore } = await import("../lib/lifecycle-core.ts")

const ctx = {
  location: { directory: FIX },
  session: {
    async create({ title }) { return { id: "ses-" + title } },
    async get() { return {} },
    async context() { return [] },
    async switchAgent() {}, async switchModel() {}, async synthetic() {},
    async generate() { return "x" },
  },
  model: { async list() { return [{ providerID: "openai", id: "gpt-5.6-sol-fast", limit: { context: 200000 } }] } },
}

const core = createRuntimeRegistryCore(ctx, {
  schemaFile: path.join(REPO, ".opencode/plugins/runtime-registry/schema.sql"),
  lifecycleSchemaFile: path.join(REPO, ".opencode/plugins/lifecycle-engine/schema.sql"),
})
console.log("dbError", core.dbError)
console.log("configReady", core.configReady)
console.log("migration", core.schemaMigration.lifecycle_schema_applied, core.schemaMigration.sessions_columns_added)
const lifecycle = createLifecycleCore(ctx, core)
console.log("diagnostics", JSON.stringify(lifecycle.diagnostics))
const t = lifecycle.loadThresholds()
console.log("thresholds", JSON.stringify(t))
core.db.query("INSERT INTO sessions (session_key, project_id, role, opencode_session_id, generation, agent_id, model_runtime_id, project_path, status, checkpoint_path, created_at, last_used_at, replaced_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .run("project:ruoyi-vue-pro:main", "ruoyi-vue-pro", "project-main", "ses-1", 1, "project-main", "openai/gpt-5.6-sol-fast#high", FIX, "ACTIVE", null, new Date().toISOString(), new Date().toISOString(), null)
console.log("rows", core.db.query("SELECT session_key, generation, status FROM sessions").all())
core.close()
fs.rmSync(FIX, { recursive: true, force: true })
console.log("PROBE OK")
