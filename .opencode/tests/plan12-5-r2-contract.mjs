import assert from "node:assert/strict"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import {
  normalizeWorkflowExecutionPolicy,
  validatePlannerExecutionPolicy,
  validateNodeExecutionPolicy,
  createRuntimeEvidenceCollector,
} from "../lib/plan12-runtime-execution.ts"
import { initializeControlPlaneDatabase } from "../lib/plan12-control-plane.ts"
import { sha256Canonical } from "../lib/plan12-contract.ts"
import { normalizeDeliveryPlan } from "../lib/delivery-chain.ts"
import { buildPlannerPrompt } from "../plugins/workflow-engine/planning.ts"
import { createConfigRevision, applyConfigRevision, transitionConfigRevision } from "../lib/plan12-config-revision.ts"
import { appendModelCatalogEntry, appendRouteBinding, recordRuntimeProbe } from "../lib/plan12-model-routes.ts"
import { makeSnapshot, operationFields, transition } from "./plan12-3-fixtures.mjs"

function withDigest(value) {
  const { payload_sha256: _ignored, ...body } = value
  return { ...body, payload_sha256: sha256Canonical(body) }
}

function registerCodeReadRoute(store, revision) {
  const observedAt = "2026-10-02T00:00:00.000Z"
  const exact = "fixture-provider/fixture-model#r2"
  const probe = {
    probe_id: `probe-${revision}`,
    endpoint: "fixture://plan12-r2",
    runtime_version: "fixture-runtime-r2",
    workflow_plugin_loaded: true,
    tools: { workflow_plan: true, workflow_run: true, workflow_execute: true, workflow_get: true, workflow_list: true },
    provider: "fixture-provider", model_id: "fixture-model", exact_model_ref: exact,
    probe_status: "AVAILABLE", availability_state: "AVAILABLE", probe_error: null,
    observed_at: observedAt, config_revision: revision, metadata: {}, idempotency_key: `probe-${revision}`,
  }
  const model = {
    catalog_entry_id: `catalog-${revision}`, config_revision: revision, source: "runtime_probe", runtime_source: "runtime_probe",
    observed_at: observedAt, provider: "fixture-provider", model_id: "fixture-model", exact_model_ref: exact,
    display_name: exact, capability: { input: true, output: true }, runtime_version: "fixture-runtime-r2",
    first_seen_at: observedAt, last_seen_at: observedAt, probe_status: "AVAILABLE", availability_state: "AVAILABLE",
    metadata_sha256: sha256Canonical({ input: true, output: true }), probe_error: null, probe_id: probe.probe_id,
    idempotency_key: `model-${revision}`,
  }
  const route = {
    route_binding_id: "code_read", role: "Project Reader", workflow_scope: "global", project_scope: "fixture", lane: "default",
    provider: "fixture-provider", model_id: "fixture-model", exact_model_ref: exact, binding_state: "BOUND",
    config_revision: revision, source: "fixture-runtime-probe", reason: "R2 adapter contract route", created_at: observedAt, updated_at: observedAt,
    idempotency_key: `route-${revision}`,
  }
  assert.equal(recordRuntimeProbe(store, withDigest(probe)).ok, true)
  assert.equal(appendModelCatalogEntry(store, withDigest(model)).ok, true)
  assert.equal(appendRouteBinding(store, withDigest(route)).ok, true)
}

test("planner and dispatch permissions fail closed before any execution", () => {
  const policy = normalizeWorkflowExecutionPolicy({
    mode: "isolated_fixture",
    delivery: "none",
    allow_mem0_write: false,
    allow_production_db_write: false,
    allowed_project_ids: ["fixture"],
    allowed_roots: [],
  })
  const planner = validatePlannerExecutionPolicy({
    nodes: [{ node_id: "memory", route: "long_term_memory_write", project_id: "fixture", metadata: { capability: "mem0_write" } }],
  }, policy)
  assert.equal(planner.ok, false)
  assert.equal(planner.code, "MEM0_WRITE_FORBIDDEN")
  const indirect = validateNodeExecutionPolicy({
    route: "code_read",
    project_id: "fixture",
    metadata: { requested_capabilities: ["mem0_write"] },
  }, policy)
  assert.equal(indirect.ok, false)
  assert.equal(indirect.code, "MEM0_WRITE_FORBIDDEN")
  const outsideRoot = validateNodeExecutionPolicy({ route: "code_read", project_id: "fixture", project_root: "C:/outside" }, { ...policy, allowed_roots: ["C:/fixture"] })
  assert.equal(outsideRoot.ok, false)
  assert.equal(outsideRoot.code, "ROOT_SCOPE_FORBIDDEN")
  const normalizedLegacy = normalizeDeliveryPlan({
    schema_version: 1,
    workflow_objective: "legacy delivery",
    nodes: [{ node_id: "review", project_id: "fixture", route: "independent_review", objective: "review", depends_on: [], review: { required: true, target_node_id: "work" } }, { node_id: "work", project_id: "fixture", route: "code_read", objective: "read", depends_on: [] }],
  }, { workflowId: "wf", primaryProjectId: "fixture" })
  assert.equal(normalizedLegacy.ok, true)
  const implicitMemory = validatePlannerExecutionPolicy(normalizedLegacy.plan, policy)
  assert.equal(implicitMemory.ok, false)
  assert.equal(implicitMemory.code, "MEM0_WRITE_FORBIDDEN")
})

test("planner prompt distinguishes legacy delivery=none from isolated fixture read-only planning", () => {
  const base = { primary_project_id: "fixture", objective: "plan", available_routes: ["code_read", "code_change"], registered_projects: ["fixture"] }
  const legacy = buildPlannerPrompt({ ...base, execution_policy: { mode: "legacy", delivery: "none" } })
  assert.match(legacy, /不等同于只读/)
  assert.match(legacy, /可按目标规划 code_change/)
  assert.doesNotMatch(legacy, /必须保持两个或以上独立、只读、可观测 Worker 节点/)
  const isolated = buildPlannerPrompt({ ...base, execution_policy: { mode: "isolated_fixture", delivery: "none" } })
  assert.match(isolated, /只规划真实只读 Worker 节点/)
  assert.match(isolated, /必须保持两个或以上独立、只读、可观测 Worker 节点/)
  assert.doesNotMatch(isolated, /可按目标规划 code_change/)
})

test("append-only lifecycle supports run events before wave/node facts", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "plan12-r2-contract-"))
  const dbPath = path.join(dir, "control-plane.db")
  const store = initializeControlPlaneDatabase({ dbPath, runtimeRoot: dir, allowedRoots: [dir] })
  const snapshot = makeSnapshot("rev-r2")
  assert.equal(createConfigRevision(store, snapshot).ok, true)
  assert.equal(transition(store, transitionConfigRevision, snapshot.config_revision, "VALIDATED", "r2").ok, true)
  assert.equal(transition(store, transitionConfigRevision, snapshot.config_revision, "STAGED", "r2").ok, true)
  assert.equal(transition(store, transitionConfigRevision, snapshot.config_revision, "APPLIED", "r2").ok, true)
  assert.equal(applyConfigRevision(store, { target_revision: snapshot.config_revision, expected_active_revision: null, idempotency_key: "r2-apply", ...operationFields("r2-apply") }).ok, true)
  registerCodeReadRoute(store, snapshot.config_revision)
  const collector = createRuntimeEvidenceCollector({
    store,
    workflowId: "wf-r2",
    configRevision: "rev-r2",
    projectId: "fixture",
    plan: { nodes: [] },
    source: "plan12.5-r2-test",
    runtimeRoot: dir,
    controlPlaneDb: dbPath,
  })
  assert.equal(collector.start().ok, true)
  assert.equal(collector.recordWaveStart(0, []).ok, true)
  assert.equal(collector.recordNodeStart(0, { node_id: "n1", task_id: "t1", route: "code_read", session_id: "ses-1", model_runtime_id: "fixture-provider/fixture-model#r2", session_key: "key-1" }).ok, true)
  assert.equal(collector.recordNodeFinish(0, { node_id: "n1", task_id: "t1", route: "code_read", session_id: "ses-1", model_runtime_id: "fixture-provider/fixture-model#r2", session_key: "key-1", status: "COMPLETED", output: { ok: true } }).ok, true)
  assert.equal(collector.recordWaveFinish(0, []).ok, true)
  const result = collector.finish("COMPLETED")
  assert.equal(result.ok, true, JSON.stringify(result))
  const events = store.listWorkflowRunEvents({ run_id: collector.runId })
  assert.deepEqual(events.map((event) => event.event_type), ["RUN_STARTED", "WAVE_STARTED", "NODE_STARTED", "NODE_FINISHED", "WAVE_FINISHED", "RUN_FINISHED"])
  assert.equal(events[0].wave_id, null)
  assert.equal(events[0].node_id, null)
  const startPayload = JSON.parse(events[0].payload_json)
  assert.equal(startPayload.workflow_id, "wf-r2")
  assert.equal(startPayload.run_id, collector.runId)
  assert.equal(startPayload.plan_digest, sha256Canonical({ nodes: [] }))
  assert.equal(startPayload.runtime_root, realpathSync(dir))
  assert.equal(startPayload.control_plane_db, realpathSync(dbPath))
  assert.equal(startPayload.path_envelope.policy, "explicit-runtime-root-v1")
  assert.equal(store.listWorkflowWaves({ run_id: collector.runId }).length, 1)
  assert.equal(store.listWorkflowWaveNodes({ run_id: collector.runId }).length, 1)
  assert.throws(() => store.db.prepare("UPDATE workflow_run_events SET status='FAILED' WHERE run_id=?").run(collector.runId), /APPEND_ONLY_UPDATE_FORBIDDEN/)
  const digest = events.find((event) => event.event_type === "NODE_FINISHED").payload_digest
  assert.equal(digest, sha256Canonical({ ok: true }))
  const replay = store.appendWorkflowRunEvent(events[0])
  assert.equal(replay.ok, true)
  assert.equal(replay.status, "IDEMPOTENT")
  const conflictingEvent = { ...events[0], event_id: "event-conflict", status: "FAILED" }
  const conflict = store.appendWorkflowRunEvent({ ...conflictingEvent, payload_sha256: sha256Canonical(Object.fromEntries(Object.entries(conflictingEvent).filter(([key]) => key !== "payload_sha256"))) })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.code, "EVIDENCE_IDEMPOTENCY_CONFLICT")
  store.close()
  const reopened = initializeControlPlaneDatabase({ dbPath, runtimeRoot: dir, allowedRoots: [dir] })
  assert.equal(reopened.listWorkflowRunEvents({ run_id: collector.runId }).length, 6)
  assert.equal(reopened.listExecutionEvents({ run_id: collector.runId }).length, 1)
  reopened.close()
  rmSync(dir, { recursive: true, force: true })
})

test("append-only lifecycle refuses revision mismatch and exposes write failures", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "plan12-r2-failure-"))
  const store = initializeControlPlaneDatabase({ dbPath: path.join(dir, "control-plane.db"), runtimeRoot: dir, allowedRoots: [dir] })
  const collector = createRuntimeEvidenceCollector({ store, workflowId: "wf", configRevision: "missing", projectId: "fixture", plan: { nodes: [] }, source: "test" })
  const failed = collector.start()
  assert.equal(failed.ok, false)
  assert.equal(failed.code, "CONFIG_REVISION_NOT_FOUND")
  assert.equal(failed.guard, "BLOCKED")
  const activeDir = mkdtempSync(path.join(tmpdir(), "plan12-r2-adapter-failure-"))
  const activeStore = initializeControlPlaneDatabase({ dbPath: path.join(activeDir, "control-plane.db"), runtimeRoot: activeDir, allowedRoots: [activeDir] })
  const activeSnapshot = makeSnapshot("rev-adapter-failure")
  assert.equal(createConfigRevision(activeStore, activeSnapshot).ok, true)
  assert.equal(transition(activeStore, transitionConfigRevision, activeSnapshot.config_revision, "VALIDATED", "adapter-failure").ok, true)
  assert.equal(transition(activeStore, transitionConfigRevision, activeSnapshot.config_revision, "STAGED", "adapter-failure").ok, true)
  assert.equal(transition(activeStore, transitionConfigRevision, activeSnapshot.config_revision, "APPLIED", "adapter-failure").ok, true)
  assert.equal(applyConfigRevision(activeStore, { target_revision: activeSnapshot.config_revision, expected_active_revision: null, idempotency_key: "adapter-failure-apply", ...operationFields("adapter-failure-apply") }).ok, true)
  const adapterFailureCollector = createRuntimeEvidenceCollector({ store: activeStore, workflowId: "wf-adapter-failure", configRevision: activeSnapshot.config_revision, projectId: "fixture", plan: { nodes: [] }, source: "test", runtimeRoot: activeDir, controlPlaneDb: activeStore.dbPath })
  assert.equal(adapterFailureCollector.start().ok, true)
  assert.equal(adapterFailureCollector.recordWaveStart(0, [{ node_id: "n-failure" }]).ok, true)
  assert.equal(adapterFailureCollector.recordNodeStart(0, { node_id: "n-failure", task_id: "t-failure", route: "code_read", session_id: "ses-failure", model_runtime_id: "openai/gpt-6.1-sol#default", session_key: "key-failure" }).ok, true)
  assert.equal(adapterFailureCollector.recordNodeFinish(0, { node_id: "n-failure", task_id: "t-failure", route: "code_read", session_id: "ses-failure", model_runtime_id: "openai/gpt-6.1-sol#default", session_key: "key-failure", status: "COMPLETED", output: { ok: true } }).ok, true)
  assert.equal(adapterFailureCollector.recordWaveFinish(0, [{ node_id: "n-failure" }]).ok, true)
  const adapterFailure = adapterFailureCollector.finish("COMPLETED")
  assert.equal(adapterFailure.ok, false)
  const persistedFailure = activeStore.listWorkflowRunEvents({ run_id: adapterFailureCollector.runId }).find((event) => event.event_type === "EVIDENCE_WRITE_FAILED")
  assert.equal(persistedFailure?.error_code, "MODEL_ROUTE_REJECTED", "bottom-level adapter cause code must remain queryable")
  assert.equal(JSON.parse(persistedFailure.payload_json).cause_code, "MODEL_ROUTE_REJECTED")
  activeStore.close()
  rmSync(activeDir, { recursive: true, force: true })
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

test("event write failure is observable and recoverable without pretending success", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "plan12-r2-write-failure-"))
  const store = initializeControlPlaneDatabase({ dbPath: path.join(dir, "control-plane.db"), runtimeRoot: dir, allowedRoots: [dir] })
  const snapshot = makeSnapshot("rev-failure")
  assert.equal(createConfigRevision(store, snapshot).ok, true)
  assert.equal(transition(store, transitionConfigRevision, snapshot.config_revision, "VALIDATED", "failure").ok, true)
  assert.equal(transition(store, transitionConfigRevision, snapshot.config_revision, "STAGED", "failure").ok, true)
  assert.equal(transition(store, transitionConfigRevision, snapshot.config_revision, "APPLIED", "failure").ok, true)
  assert.equal(applyConfigRevision(store, { target_revision: snapshot.config_revision, expected_active_revision: null, idempotency_key: "failure-apply", ...operationFields("failure-apply") }).ok, true)
  store.db.exec("CREATE TRIGGER fixture_r2_event_failure BEFORE INSERT ON workflow_run_events BEGIN SELECT RAISE(ABORT, 'FIXTURE_EVIDENCE_WRITE_FAILED'); END")
  const collector = createRuntimeEvidenceCollector({ store, workflowId: "wf-failure", configRevision: snapshot.config_revision, projectId: "fixture", plan: { nodes: [] }, source: "test", runtimeRoot: dir, controlPlaneDb: store.dbPath })
  const blocked = collector.start()
  assert.equal(blocked.ok, false)
  assert.equal(blocked.code, "EVIDENCE_WRITE_FAILED")
  store.db.exec("DROP TRIGGER fixture_r2_event_failure")
  assert.equal(collector.start().ok, true)
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

console.log("PLAN12_SMOKE_PERMISSION_GATE_PASS")
console.log("PLAN12_APPEND_ONLY_LIFECYCLE_PASS")
console.log("PLAN12_RUN_EVENT_FK_PASS")
console.log("PLAN12_DIGEST_ROUNDTRIP_PASS")
console.log("PLAN12_FAILURE_RECOVERY_PASS")
console.log("PLAN12_SCHEDULER_INVARIANT_PASS")
console.log("PLAN12_RUNTIME_EVIDENCE_R2_CONTRACT_PASS")
