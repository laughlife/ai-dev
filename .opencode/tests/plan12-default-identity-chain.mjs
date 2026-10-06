import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseYaml } from "./yaml-lite.mjs"
import { createRuntimeRegistryCore } from "../lib/runtime-registry-core.ts"
import { createTaskBusCore } from "../lib/task-bus-core.ts"
import { initializeControlPlaneDatabase } from "../lib/plan12-control-plane.ts"
import { evaluateRuntimeEvidence } from "../lib/plan12-completion-evidence.ts"
import { appendModelCatalogEntry, appendRouteBinding, recordRuntimeProbe } from "../lib/plan12-model-routes.ts"
import { normalizePlan12RuntimeModelRef } from "../lib/plan12-runtime-fixture.ts"
import { createScheduler } from "../plugins/workflow-engine/scheduler.ts"
import { makeSnapshot, observedAt, withDigest } from "./plan12-3-fixtures.mjs"

globalThis.Bun ??= {}
globalThis.Bun.YAML = { parse: parseYaml }

const frameworkRoot = path.resolve(".")
const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan12-default-identity-chain-"))
const configDir = path.join(root, "framework-config")
fs.mkdirSync(configDir, { recursive: true })
for (const name of ["projects.yaml", "agents.yaml", "routing.yaml", "task-bus.yaml"]) {
  const target = path.join(configDir, name)
  fs.copyFileSync(path.join(frameworkRoot, "framework-config", name), target)
  // yaml-lite accepts ordinary "- key: value" sequences. Normalize the
  // compiler's equivalent standalone dash style only inside this temp copy.
  fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace(/^(\s*)-\s*\r?\n\1  ([^\r\n]+)/gm, "$1- $2"))
}
// Keep this isolated fixture focused on the implicit-default identity rule.
// The real Task Bus still resolves the value from agents.yaml; only its copied
// fixture value is changed, never the repository configuration.
const fixtureAgents = path.join(configDir, "agents.yaml")
fs.writeFileSync(fixtureAgents, fs.readFileSync(fixtureAgents, "utf8").replace(
  /(ruoyi-vue-pro:\s*[\s\S]*?runtime_id:)\s*'openai\/gpt-5\.6-sol-fast#high'/,
  "$1 'deepseek/deepseek-flash'",
))

const modelRef = "deepseek/deepseek-flash"
const configuredModelRef = `${modelRef}#default`
const revision = "plan12-default-identity-revision"
const projectId = "ruoyi-vue-pro"
const responseModel = { providerID: "deepseek", id: "deepseek-flash", variant: "default" }
let sessionSequence = 0
let responseSequence = 0
let registry
let store
const sessions = new Map()
let appendAssistantOnPrompt = true
let responseSessionIdOverride = null

const ctx = {
  location: { directory: root },
  session: {
    async create() {
      const id = `ses-default-identity-${++sessionSequence}`
      sessions.set(id, {
        messages: [{
          info: {
            id: `msg-stale-${id}`,
            sessionID: id,
            role: "assistant",
            providerID: "deepseek",
            modelID: "deepseek-flash",
            variant: "default",
          },
          parts: [{ type: "text", text: "stale response must never be reused" }],
        }],
      })
      return { id }
    },
    async get({ sessionID }) {
      if (!sessions.has(sessionID)) throw new Error("session unavailable")
      return { id: sessionID }
    },
    async switchAgent() {},
    async switchModel() {},
    async synthetic() {},
    async prompt({ sessionID, text }) {
      const session = sessions.get(sessionID)
      session.messages.push({ info: { id: `msg-user-${++responseSequence}`, sessionID, role: "user" }, parts: [{ type: "text", text }] })
      if (!appendAssistantOnPrompt) return
      session.messages.push({
        info: {
          id: `msg-default-identity-${++responseSequence}`,
          sessionID: responseSessionIdOverride ?? sessionID,
          role: "assistant",
          providerID: responseModel.providerID,
          modelID: responseModel.id,
          variant: responseModel.variant,
        },
        parts: [{ type: "text", text: "verified scheduler output" }],
      })
    },
    async wait() {},
    async context({ sessionID }) {
      return { data: sessions.get(sessionID)?.messages ?? [] }
    },
  },
}

try {
  registry = createRuntimeRegistryCore(ctx, {
    schemaFile: path.join(frameworkRoot, ".opencode", "plugins", "runtime-registry", "schema.sql"),
    lifecycleSchemaFile: path.join(frameworkRoot, ".opencode", "plugins", "lifecycle-engine", "schema.sql"),
  })
  assert.equal(registry.configReady, true)
  registry.db.exec(fs.readFileSync(path.join(frameworkRoot, ".opencode", "plugins", "workflow-engine", "schema.sql"), "utf8"))
  const bus = createTaskBusCore(ctx, registry)

  const dbPath = path.join(root, "control-plane.db")
  store = initializeControlPlaneDatabase({ dbPath, runtimeRoot: root, allowedRoots: [root] })
  const snapshotPayload = {
    revision,
    model_catalog: [{ exact_model_ref: modelRef, provider_id: "deepseek", model_id: "deepseek-flash", variant: null }],
    route_bindings: [{ route_binding_id: "code_change", exact_model_ref: modelRef }],
  }
  const snapshot = withDigest({ ...makeSnapshot(revision, null, "default-identity-snapshot", snapshotPayload), state: "ACTIVE", activated_at: observedAt })
  assert.equal(store.appendWorkflowConfigSnapshot(snapshot).ok, true)
  const tools = { workflow_plan: true, workflow_run: true, workflow_execute: true, workflow_get: true, workflow_list: true }
  assert.equal(recordRuntimeProbe(store, withDigest({
    probe_id: "default-identity-probe", endpoint: "fixture://runtime", runtime_version: "fixture-2.0", workflow_plugin_loaded: true,
    tools, provider: "deepseek", provider_id: "deepseek", model_id: "deepseek-flash", exact_model_ref: modelRef,
    probe_status: "AVAILABLE", availability_state: "AVAILABLE", probe_error: null, observed_at: observedAt,
    config_revision: revision, metadata: {}, idempotency_key: "default-identity-probe-key",
  })).ok, true)
  assert.equal(appendModelCatalogEntry(store, withDigest({
    catalog_entry_id: "default-identity-catalog", config_revision: revision, source: "runtime_probe", observed_at: observedAt,
    provider: "deepseek", provider_id: "deepseek", model_id: "deepseek-flash", variant: null, exact_model_ref: modelRef,
    display_name: modelRef, capability: { input: true, output: true }, runtime_source: "runtime_probe", runtime_version: "fixture-2.0",
    first_seen_at: observedAt, last_seen_at: observedAt, probe_status: "AVAILABLE", availability_state: "AVAILABLE",
    metadata_sha256: "d".repeat(64), probe_error: null, probe_id: "default-identity-probe", idempotency_key: "default-identity-catalog-key",
  })).ok, true)
  assert.equal(appendRouteBinding(store, withDigest({
    route_binding_id: "code_change", role: "Feature Executor", workflow_scope: "global", project_scope: projectId, lane: "coding",
    provider: "deepseek", provider_id: "deepseek", model_id: "deepseek-flash", variant: null, exact_model_ref: modelRef,
    binding_state: "BOUND", config_revision: revision, source: "runtime_probe", reason: "default identity fixture",
    created_at: observedAt, updated_at: observedAt, idempotency_key: "default-identity-route-key",
  })).ok, true)

  const scheduler = createScheduler({
    core: registry,
    bus,
    hooks: null,
    reviewer: { runReview: async () => ({ type: "PASS" }) },
    loadWorkflowConfig: () => ({
      scheduler: { lanes: { coding: { default_parallel: 1, max_parallel: 1 } } },
      parallel_policy: { project_serial_routes: ["code_change"] },
    }),
    evidenceStore: store,
    evidenceRoot: root,
    evidenceDbPath: dbPath,
  })

  const dispatchPersistentRead = async (objective) => {
    const created = bus.createTask({ project_id: projectId, route: "code_read", objective })
    assert.equal(created.ok, true, JSON.stringify(created))
    return await bus.dispatchTask(created.envelope.task_id)
  }

  // Real Task Bus -> executePersistent -> Runtime Registry bridge. The second
  // dispatch reuses the persistent project-reader session but receives no new
  // assistant message, so its old successful response must not be replayed.
  Object.assign(responseModel, { providerID: "deepseek", id: "deepseek-flash", variant: "default" })
  appendAssistantOnPrompt = true
  const persistentAccepted = await dispatchPersistentRead("accept a fresh persistent response")
  assert.equal(persistentAccepted.status, "COMPLETED", JSON.stringify(persistentAccepted))
  assert.equal(persistentAccepted.result.model_runtime_id, configuredModelRef, "persistent Result Envelope preserves raw #default")
  const persistentSessionId = persistentAccepted.result.session_id

  appendAssistantOnPrompt = false
  const persistentRejected = await dispatchPersistentRead("reject a reused persistent response")
  assert.equal(persistentRejected.status, "FAILED", JSON.stringify(persistentRejected))
  assert.equal(persistentRejected.code, "NO_ASSISTANT_RESULT")
  assert.equal(persistentRejected.result.session_id, persistentSessionId, "persistent test must reuse the same registry session")
  assert.equal(persistentRejected.result.model_runtime_id, null, "rejected old response cannot leak configured identity")

  appendAssistantOnPrompt = true
  Object.assign(responseModel, { providerID: "deepseek", id: "", variant: "default" })
  const persistentMissingIdentity = await dispatchPersistentRead("reject missing raw identity")
  assert.equal(persistentMissingIdentity.status, "FAILED", JSON.stringify(persistentMissingIdentity))
  assert.equal(persistentMissingIdentity.result.status, "FAILED")
  assert.equal(persistentMissingIdentity.code, "MODEL_RUNTIME_ID_MISSING")
  assert.match(persistentMissingIdentity.result.error, /^MODEL_RUNTIME_ID_MISSING:/)
  assert.equal(persistentMissingIdentity.result.model_runtime_id, null, "missing raw response identity must not fall back to configuration")

  // Exercise the same boundary through the real scoped registry bridge. Its
  // session starts with a stale desktop-shaped assistant message, then is
  // reused for both the fail-closed and fresh-response cases.
  const scopedKey = "workflow:identity-correlation:project:ruoyi-vue-pro:feature-executor:node:worker"
  const scoped = await registry.ensureScopedSession({
    session_key: scopedKey,
    project_id: projectId,
    role: "feature-executor",
    runtime_id: modelRef,
    scope_context: "identity correlation fixture",
  })
  assert.equal(scoped.ok, true, JSON.stringify(scoped))
  appendAssistantOnPrompt = false
  const scopedRejected = await registry.sendScopedSession({ session_key: scopedKey, text: "reject stale scoped response" })
  assert.equal(scopedRejected.ok, false, JSON.stringify(scopedRejected))
  assert.equal(scopedRejected.code, "NO_ASSISTANT_RESULT")

  appendAssistantOnPrompt = true
  responseSessionIdOverride = "ses-another-session"
  const scopedWrongSession = await registry.sendScopedSession({ session_key: scopedKey, text: "reject cross-session response" })
  assert.equal(scopedWrongSession.ok, false, JSON.stringify(scopedWrongSession))
  assert.equal(scopedWrongSession.code, "NO_ASSISTANT_RESULT")
  responseSessionIdOverride = null

  Object.assign(responseModel, { providerID: "deepseek", id: "deepseek-flash", variant: "default" })
  const scopedAccepted = await registry.sendScopedSession({ session_key: scopedKey, text: "accept fresh scoped response" })
  assert.equal(scopedAccepted.ok, true, JSON.stringify(scopedAccepted))
  assert.equal(scopedAccepted.session_id, scoped.session_id)
  assert.equal(scopedAccepted.raw_model_runtime_id, configuredModelRef)
  assert.equal(scopedAccepted.model_runtime_id, modelRef, "canonical identity is comparison-only")

  Object.assign(responseModel, { providerID: "deepseek", id: "", variant: "default" })
  const scopedMissingIdentity = await registry.sendScopedSession({ session_key: scopedKey, text: "preserve missing scoped identity" })
  assert.equal(scopedMissingIdentity.ok, true, JSON.stringify(scopedMissingIdentity))
  assert.equal(scopedMissingIdentity.raw_model_runtime_id, null)
  assert.equal(scopedMissingIdentity.model_runtime_id, null)

  const materialize = (workflowId) => {
    const taskId = `${workflowId}:task`
    const plan = {
      nodes: [{
        node_id: "worker", route: "code_change", project_id: projectId, depends_on: [], resources: { write: [`fixture/${workflowId}.txt`] },
        metadata: { execution_root: root },
      }],
      metadata: { runtime_evidence_required: true, execution_policy: {
        mode: "isolated_fixture", delivery: "none", allow_mem0_write: false, allow_production_db_write: false,
        allow_business_repo_write: true, allowed_project_ids: [projectId], allowed_roots: [root], config_revision: revision, control_plane_db: dbPath,
      } },
    }
    const now = new Date().toISOString()
    registry.db.query("INSERT INTO workflows (workflow_id,primary_project_id,objective,status,planner_task_id,planner_session_id,plan_json,rework_cycle,created_at,updated_at,finished_at,completion_guard_finalized_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(workflowId, projectId, "identity chain", "READY", null, null, JSON.stringify(plan), 0, now, now, null, null)
    registry.db.query("INSERT INTO workflow_nodes (workflow_id,node_id,current_task_id,attempt,status,review_task_id,last_verdict,task_history_json,review_history_json,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(workflowId, "worker", taskId, 1, "READY", null, null, JSON.stringify([{ task_id: taskId, attempt: 1 }]), "[]", now)
    const envelope = { schema_version: 1, task_id: taskId, project_id: projectId, route: "code_change", objective: "identity chain", metadata: { execution_root: root } }
    registry.db.query("INSERT INTO tasks (task_id,parent_task_id,project_id,target_role,target_session_key,status,input_json,result_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(taskId, null, projectId, "feature-executor", null, "READY", JSON.stringify(envelope), null, now, now)
    return { taskId, plan }
  }

  const rejectedScenarios = [
    ["variant", { providerID: "deepseek", id: "deepseek-flash", variant: "beta" }, "MODEL_RUNTIME_ID_MISMATCH"],
    ["provider", { providerID: "openai", id: "deepseek-flash", variant: "default" }, "MODEL_RUNTIME_ID_MISMATCH"],
    ["model", { providerID: "deepseek", id: "other-model", variant: "default" }, "MODEL_RUNTIME_ID_MISMATCH"],
    ["missing", { providerID: "deepseek", id: "", variant: "default" }, "MODEL_RUNTIME_ID_MISSING"],
  ]
  for (const [name, response, expectedCode] of rejectedScenarios) {
    Object.assign(responseModel, response)
    const workflowId = `wf-default-identity-${name}`
    const { taskId } = materialize(workflowId)
    const result = await scheduler.runWorkflow(workflowId)
    assert.equal(result.status, "FAILED", `${name}: ${JSON.stringify(result)}`)
    assert.equal(result.waves[0].results[0].code, expectedCode, name)
    const task = registry.db.query("SELECT result_json FROM tasks WHERE task_id=?").get(taskId)
    assert.match(JSON.parse(task.result_json).error, new RegExp(`^${expectedCode}:`), name)
    assert.equal(result.runtime_evidence.status, "EVIDENCE_BLOCKED", `${name}: mismatched or missing raw actual must not become L3 evidence`)
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM workflow_wave_nodes WHERE run_id=?").get(result.runtime_evidence.run_id).count, 0, name)
  }

  Object.assign(responseModel, { providerID: "deepseek", id: "deepseek-flash", variant: "default" })
  const workflowId = "wf-default-identity-success"
  const { taskId, plan } = materialize(workflowId)
  const accepted = await scheduler.runWorkflow(workflowId)
  assert.equal(accepted.status, "REVIEW_PASSED", JSON.stringify(accepted))
  assert.equal(accepted.runtime_evidence.status, "COMPLETE", JSON.stringify(accepted))
  const taskResult = JSON.parse(registry.db.query("SELECT result_json FROM tasks WHERE task_id=?").get(taskId).result_json)
  assert.equal(taskResult.model_runtime_id, `${modelRef}#default`, "task result preserves raw actual telemetry")
  const persistedNode = store.db.prepare("SELECT model_runtime_id FROM workflow_wave_nodes WHERE run_id=?").get(accepted.runtime_evidence.run_id)
  assert.equal(persistedNode.model_runtime_id, `${modelRef}#default`, "scheduler -> collector -> adapter preserves raw #default")

  assert.equal(normalizePlan12RuntimeModelRef(modelRef), modelRef)
  assert.equal(normalizePlan12RuntimeModelRef(configuredModelRef), modelRef)
  assert.equal(normalizePlan12RuntimeModelRef(`${modelRef}#beta`), `${modelRef}#beta`)
  assert.notEqual(normalizePlan12RuntimeModelRef("openai/deepseek-flash#default"), modelRef)
  assert.throws(() => normalizePlan12RuntimeModelRef("deepseek/#default"), /ROLE_MODEL_RUNTIME_ID_INVALID/)

  const runId = accepted.runtime_evidence.run_id
  store.close(); store = null
  const guarded = evaluateRuntimeEvidence({ dbPath, root, workflowId, runId, configRevision: revision, plan })
  assert.equal(guarded.ok, true, JSON.stringify(guarded))
  assert.equal(guarded.status, "COMPLETE")
  assert.ok(responseSequence >= (rejectedScenarios.length + 1) * 2, "all acceptance and rejection cases used the real scheduler -> registry send path")

  console.log("PLAN12_DEFAULT_IDENTITY_CHAIN_PASS")
} finally {
  try { store?.close() } catch {}
  try { registry?.close() } catch {}
  fs.rmSync(root, { recursive: true, force: true })
}
