import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  adaptExecutionEvent,
  adaptWorkflowLockEvent,
  adaptWorkflowRun,
  adaptWorkflowWave,
  adaptWorkflowWaveNode,
  appendRuntimeEvidenceBatch,
  recordEvidenceWriteFailure,
} from "../lib/plan12-runtime-evidence-adapter.ts"
import { initializeControlPlaneDatabase } from "../lib/plan12-control-plane.ts"
import { applyConfigRevision, transitionConfigRevision } from "../lib/plan12-config-revision.ts"
import { appendModelCatalogEntry, appendRouteBinding, recordRuntimeProbe } from "../lib/plan12-model-routes.ts"
import { sha256Canonical } from "../lib/plan12-contract.ts"
import { makeFacts } from "./plan12-control-plane-fixtures.mjs"

const observedAt = "2026-10-02T00:00:00.000Z"
const revision = "cr-20261002-0001"
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "plan12-5-adapter-"))
const store = initializeControlPlaneDatabase({ dbPath: path.join(fixture, "control-plane.db"), runtimeRoot: fixture, allowedRoots: [fixture] })
const source = "runtime-adapter-fixture"
const digest = (value) => sha256Canonical(value)
const withDigest = (value) => {
  const { payload_sha256: _ignored, ...body } = value
  return { ...body, payload_sha256: digest(body) }
}

const runtimeRun = (workflowId = "wf-12-5", runId = "run-12-5", attempt = 1) => ({
  source, observed_at: observedAt, config_revision: revision, workflow_id: workflowId, run_id: runId,
  parent_run_id: null, plan_digest: "1".repeat(64), attempt, trigger: "manual", project_id: "fixture-project",
  status: "RUNNING", evidence_write_status: "INCOMPLETE", started_at: observedAt, ended_at: null,
  outcome_digest: null, error_code: null, error_detail: null, engine_version: "fixture-engine-2.0",
})
const runtimeWave = (runId, waveId, index, nodes = []) => ({
  source, observed_at: observedAt, config_revision: revision, run_id: runId, wave_id: waveId, wave_index: index,
  ready_set_digest: "2".repeat(64), policy_digest: "3".repeat(64), parallelism: nodes.length || 1, status: "RUNNING",
  started_at: observedAt, ended_at: null, lock_snapshot_json: "{}", evidence_digest: "4".repeat(64),
  nodes,
})
const runtimeNode = (runId, waveId, nodeId, taskId, sessionId, eventSeq, attempt = 1) => ({
  source, observed_at: observedAt, config_revision: revision, run_id: runId, wave_id: waveId, node_id: nodeId,
  attempt, task_id: taskId, route: "route-code-read", resource_digest: "5".repeat(64), lock_key_json: "[]",
  session_key: `${sessionId}:key`, session_id: sessionId, model_runtime_id: "openai/gpt-5.6-sol#high", status: "RUNNING", event_seq: eventSeq,
  started_at: observedAt, ended_at: null, result_digest: null, error_code: null,
})
const runtimeLock = (runId, waveId, nodeId, eventId, sequence, eventType = "ACQUIRE") => ({
  source, observed_at: observedAt, config_revision: revision, run_id: runId, wave_id: waveId, node_id: nodeId,
  event_id: eventId, lock_key: "resource:fixture", event_type: eventType, owner_token: "owner-token-1",
  sequence, occurred_at: observedAt, outcome: eventType === "CONFLICT" ? "CONFLICT" : "GRANTED", error_code: null,
})
const runtimeEvent = (runId, workflowId, waveId, nodeId, taskId, eventId, sequence, payload = { ok: true }) => ({
  source, observed_at: observedAt, config_revision: revision, run_id: runId, workflow_id: workflowId,
  wave_id: waveId, node_id: nodeId, task_id: taskId, attempt: 1, event_id: eventId, event_type: "NODE_STARTED",
  status: "RUNNING", sequence, payload, payload_ref: `${eventId}:payload`, occurred_at: observedAt, error_code: null,
})

function runAdapterWorker(dbPath, input) {
  const code = "import path from 'node:path'; import {initializeControlPlaneDatabase} from './.opencode/lib/plan12-control-plane.ts'; import {appendRuntimeEvidenceBatch} from './.opencode/lib/plan12-runtime-evidence-adapter.ts'; const root=path.dirname(process.env.PLAN12_DB); const store=initializeControlPlaneDatabase({dbPath:process.env.PLAN12_DB,runtimeRoot:root,allowedRoots:[root]}); const result=appendRuntimeEvidenceBatch(store, JSON.parse(Buffer.from(process.env.PLAN12_INPUT,'base64').toString('utf8'))); console.log(JSON.stringify({ok:result.ok,status:result.status,code:result.code})); store.close();"
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], {
      cwd: path.resolve("."),
      env: { ...process.env, PLAN12_DB: dbPath, PLAN12_INPUT: Buffer.from(JSON.stringify(input), "utf8").toString("base64") },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""; let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk.toString() })
    child.stderr.on("data", (chunk) => { stderr += chunk.toString() })
    child.on("error", reject)
    child.on("close", (codeValue) => codeValue === 0 ? resolve(JSON.parse(stdout.trim())) : reject(new Error(stderr || `worker exited ${codeValue}`)))
  })
}

try {
  const facts = makeFacts("plan12-5")
  assert.equal(store.appendWorkflowConfigSnapshot(facts.snapshot).ok, true)
  const probe = withDigest({
    probe_id: "probe-plan12-5", endpoint: "http://fixture-runtime", runtime_version: "fixture-2.0",
    workflow_plugin_loaded: true, tools: { workflow_plan: true, workflow_run: true, workflow_execute: true, workflow_get: true, workflow_list: true },
    provider: "openai", model_id: "gpt-5.6-sol", exact_model_ref: "openai/gpt-5.6-sol#high", probe_status: "AVAILABLE",
    availability_state: "AVAILABLE", probe_error: null, observed_at: observedAt, config_revision: revision, metadata: {}, idempotency_key: "probe-plan12-5",
  })
  assert.equal(recordRuntimeProbe(store, probe).ok, true)
  const model = withDigest({
    catalog_entry_id: "catalog-plan12-5", config_revision: revision, source: "runtime_probe", observed_at: observedAt,
    provider: "openai", model_id: "gpt-5.6-sol", exact_model_ref: "openai/gpt-5.6-sol#high", display_name: "fixture",
    capability: { input: true, output: true }, runtime_source: "runtime_probe", runtime_version: "fixture-2.0",
    first_seen_at: observedAt, last_seen_at: observedAt, probe_status: "AVAILABLE", availability_state: "AVAILABLE",
    metadata_sha256: "d".repeat(64), probe_error: null, probe_id: "probe-plan12-5", idempotency_key: "model-plan12-5",
  })
  assert.equal(appendModelCatalogEntry(store, model).ok, true)
  const route = withDigest({
    route_binding_id: "route-code-read", role: "Project Reader", workflow_scope: "global", project_scope: "fixture-project", lane: "default",
    provider: "openai", model_id: "gpt-5.6-sol", exact_model_ref: "openai/gpt-5.6-sol#high", binding_state: "BOUND", config_revision: revision,
    source: "fixture", reason: "fixture route", created_at: observedAt, updated_at: observedAt, idempotency_key: "route-plan12-5",
  })
  assert.equal(appendRouteBinding(store, route).ok, true)
  const operation = (key) => ({ actor: "plan12-5-test", reason: key, correlation_id: `${key}:correlation`, idempotency_key: key })
  assert.equal(transitionConfigRevision(store, { config_revision: revision, to_state: "VALIDATED", ...operation("plan12-5-validated") }).ok, true)
  assert.equal(transitionConfigRevision(store, { config_revision: revision, to_state: "STAGED", ...operation("plan12-5-staged") }).ok, true)
  assert.equal(transitionConfigRevision(store, { config_revision: revision, to_state: "APPLIED", ...operation("plan12-5-applied") }).ok, true)
  assert.equal(applyConfigRevision(store, { expected_active_revision: null, target_revision: revision, ...operation("plan12-5-active") }).ok, true)

  const run = adaptWorkflowRun(runtimeRun())
  assert.equal(run.ok, true, JSON.stringify(run))
  assert.equal(run.fact.workflow_id, "wf-12-5")
  assert.equal(run.fact.run_id, "run-12-5")
  assert.equal(store.appendWorkflowRun(run.fact).ok, true)
  assert.equal(store.appendWorkflowRun(run.fact).status, "IDEMPOTENT")
  assert.equal(adaptWorkflowRun({ ...runtimeRun("wf-invalid", "run-invalid"), started_at: "2026-02-31T00:00:00.000Z" }).code, "EVIDENCE_TIME_INVALID")
  assert.equal(store.appendWorkflowRun({ ...run.fact, status: "FAILED", payload_sha256: digest({ ...run.fact, status: "FAILED" }) }).code, "EVIDENCE_IDEMPOTENCY_CONFLICT")
  assert.equal(adaptWorkflowRun({ ...runtimeRun("wf-12-5", "run-12-5", 2), parent_run_id: "run-12-5" }).code, "RUN_ID_REUSE")
  assert.equal(adaptWorkflowRun({ ...runtimeRun("wf-12-5", "run-12-5-rework", 2), parent_run_id: "run-12-5" }).ok, true)

  const wave0Runtime = runtimeWave("run-12-5", "wave-0", 0, [runtimeNode("run-12-5", "wave-0", "node-a", "task-a", "session-a", 1)])
  const wave0 = adaptWorkflowWave(wave0Runtime, { run_id: "run-12-5", config_revision: revision, prior_wave_indexes: [] })
  assert.equal(wave0.ok, true, JSON.stringify(wave0))
  assert.equal(store.appendWorkflowWave(wave0.fact).ok, true)
  assert.equal(adaptWorkflowWave({ ...wave0Runtime, policy_digest: "bad" }, { run_id: "run-12-5", config_revision: revision, prior_wave_indexes: [] }).code, "EVIDENCE_HASH_INVALID")
  const wave1 = adaptWorkflowWave(runtimeWave("run-12-5", "wave-1", 1, [runtimeNode("run-12-5", "wave-1", "node-c", "task-c", "session-c", 1)]), { run_id: "run-12-5", config_revision: revision, prior_wave_indexes: [0] })
  assert.equal(wave1.ok, true, JSON.stringify(wave1))
  assert.equal(store.appendWorkflowWave(wave1.fact).ok, true)
  assert.equal(adaptWorkflowWave(runtimeWave("run-12-5", "wave-revision", 2, [runtimeNode("run-12-5", "wave-revision", "node-r", "task-r", "session-r", 3)]), { run_id: "run-12-5", config_revision: "cr-other", prior_wave_indexes: [0, 1] }).code, "CONFIG_REVISION_MISMATCH")
  assert.equal(adaptWorkflowWave(runtimeWave("run-12-5", "wave-gap", 3), { run_id: "run-12-5", config_revision: revision, prior_wave_indexes: [0, 1] }).code, "WAVE_INDEX_NONCONTIGUOUS")
  assert.equal(adaptWorkflowWave({ ...runtimeWave("other", "wave-bad", 2), nodes: [] }, { run_id: "run-12-5", config_revision: revision, prior_wave_indexes: [0, 1] }).code, "WAVE_RUN_MISMATCH")
  assert.equal(adaptWorkflowWave({ run_id: "run-12-5", wave_id: "summary-only", wave_index: 2, config_revision: revision, source }, { run_id: "run-12-5", config_revision: revision, prior_wave_indexes: [0, 1] }).code, "EVIDENCE_INCOMPLETE")

  const nodeA = adaptWorkflowWaveNode(runtimeNode("run-12-5", "wave-0", "node-a", "task-a", "session-a", 1), { run_id: "run-12-5", wave_id: "wave-0", config_revision: revision })
  const nodeB = adaptWorkflowWaveNode(runtimeNode("run-12-5", "wave-0", "node-b", "task-b", "session-b", 2), { run_id: "run-12-5", wave_id: "wave-0", config_revision: revision, prior_event_seq: 1 })
  assert.equal(nodeA.ok, true, JSON.stringify(nodeA))
  assert.equal(nodeB.ok, true, JSON.stringify(nodeB))
  assert.equal(store.appendWorkflowWaveNode(nodeA.fact).ok, true)
  assert.equal(store.appendWorkflowWaveNode(nodeB.fact).ok, true)
  assert.equal(adaptWorkflowWaveNode({ ...runtimeNode("run-12-5", "wave-0", "node-invalid", "task-invalid", "session-invalid", 3), attempt: 0 }, { run_id: "run-12-5", wave_id: "wave-0", config_revision: revision }).code, "EVIDENCE_SEQUENCE_INVALID")
  assert.equal(adaptWorkflowWaveNode({ ...runtimeNode("run-12-5", "wave-0", "node-first-gap", "task-first-gap", "session-first-gap", 3) }, { run_id: "run-12-5", wave_id: "wave-0", config_revision: revision }).code, "NODE_SEQUENCE_NONCONTIGUOUS")
  assert.equal(adaptWorkflowWaveNode({ ...runtimeNode("run-12-5", "wave-0", "node-context-session", "task-context-session", "session-context-session", 1), session_id: undefined }, { run_id: "run-12-5", wave_id: "wave-0", config_revision: revision, session_id: "forged-context-session" }).code, "EVIDENCE_INCOMPLETE")
  assert.equal(adaptWorkflowWaveNode({ ...runtimeNode("run-12-5", "wave-0", "node-c", "task-c", "", 3), session_id: null }, { run_id: "run-12-5", wave_id: "wave-0", config_revision: revision }).code, "EVIDENCE_INCOMPLETE")
  assert.equal(adaptWorkflowWaveNode(runtimeNode("run-12-5", "wave-1", "node-a", "task-a", "session-a", 3, 2), { run_id: "run-12-5", wave_id: "wave-0", config_revision: revision }).code, "NODE_WAVE_MISMATCH")

  const lock1 = adaptWorkflowLockEvent(runtimeLock("run-12-5", "wave-0", "node-a", "lock-1", 1), { run_id: "run-12-5", config_revision: revision, lock_sequences: {} })
  const lock2 = adaptWorkflowLockEvent(runtimeLock("run-12-5", "wave-0", "node-a", "lock-2", 2, "RELEASE"), { run_id: "run-12-5", config_revision: revision, lock_sequences: { "resource:fixture": 1 } })
  assert.equal(lock1.ok, true, JSON.stringify(lock1))
  assert.equal(lock2.ok, true, JSON.stringify(lock2))
  const conflictLock = adaptWorkflowLockEvent(runtimeLock("run-12-5", "wave-0", "node-a", "lock-conflict", 1, "CONFLICT"), { run_id: "run-12-5", wave_id: "wave-0", node_id: "node-a", config_revision: revision, lock_sequences: {} })
  assert.equal(conflictLock.ok, true)
  assert.equal(conflictLock.fact.outcome, "CONFLICT")
  assert.equal(store.appendWorkflowLockEvent(lock1.fact).ok, true)
  assert.equal(store.appendWorkflowLockEvent(lock2.fact).ok, true)
  assert.equal(adaptWorkflowLockEvent({ ...runtimeLock("run-12-5", "wave-0", "node-a", "lock-bad", 3), owner_token: null }, { run_id: "run-12-5", config_revision: revision, lock_sequences: { "resource:fixture": 2 } }).code, "EVIDENCE_INCOMPLETE")
  assert.equal(adaptWorkflowLockEvent({ ...runtimeLock("run-12-5", "wave-0", "node-a", "lock-first-gap", 3), owner_token: undefined }, { run_id: "run-12-5", config_revision: revision, owner_token: "forged-context-owner" }).code, "EVIDENCE_INCOMPLETE")

  const event1 = adaptExecutionEvent(runtimeEvent("run-12-5", "wf-12-5", "wave-0", "node-a", "task-a", "event-1", 1), { run_id: "run-12-5", workflow_id: "wf-12-5", config_revision: revision })
  assert.equal(event1.ok, true, JSON.stringify(event1))
  assert.equal(event1.fact.payload_digest, digest({ ok: true }))
  assert.equal(store.appendExecutionEvent(event1.fact).ok, true)
  assert.equal(adaptExecutionEvent({ ...runtimeEvent("run-12-5", "wf-12-5", "wave-0", "node-a", "task-a", "event-invalid", 2), event_type: "NOT_AN_EVENT" }, { run_id: "run-12-5", workflow_id: "wf-12-5", config_revision: revision }).code, "EXECUTION_EVENT_INVALID")
  assert.equal(adaptExecutionEvent(runtimeEvent("run-12-5", "wf-12-5", "wave-0", "node-a", "task-a", "event-bad", 2, { ok: false }), { run_id: "run-12-5", workflow_id: "wf-12-5", config_revision: revision, payload_digest: digest({ ok: true }) }).code, "PAYLOAD_DIGEST_MISMATCH")
  assert.equal(adaptExecutionEvent(runtimeEvent("run-12-5", "wf-12-5", "wave-0", "node-a", "task-a", "event-gap", 4), { run_id: "run-12-5", workflow_id: "wf-12-5", config_revision: revision, prior_sequence: 1 }).code, "EXECUTION_SEQUENCE_NONCONTIGUOUS")

  const batchRun = runtimeRun("wf-batch", "run-batch")
  const batchWave = runtimeWave("run-batch", "batch-wave-0", 0)
  const batchNode = runtimeNode("run-batch", "batch-wave-0", "batch-node", "batch-task", "batch-session", 1)
  batchWave.nodes = [batchNode]
  const batchResult = appendRuntimeEvidenceBatch(store, {
    run: batchRun, waves: [batchWave], nodes: [batchNode], lock_events: [], execution_events: [],
    config_snapshot: facts.snapshot,
  })
  assert.equal(batchResult.ok, true, JSON.stringify(batchResult))
  const mismatchModel = appendRuntimeEvidenceBatch(store, {
    run: runtimeRun("wf-model-mismatch", "run-model-mismatch"),
    waves: [runtimeWave("run-model-mismatch", "model-wave", 0, [runtimeNode("run-model-mismatch", "model-wave", "model-node", "model-task", "model-session", 1)])],
    nodes: [{ ...runtimeNode("run-model-mismatch", "model-wave", "model-node", "model-task", "model-session", 1), model_runtime_id: "deepseek/deepseek-flash" }], lock_events: [], execution_events: [], config_snapshot: facts.snapshot,
  })
  assert.equal(mismatchModel.ok, false)
  assert.equal(mismatchModel.code, "EVIDENCE_WRITE_FAILED")
  assert.equal(mismatchModel.cause_code, "MODEL_RUNTIME_ID_MISMATCH")
  const matchingModel = appendRuntimeEvidenceBatch(store, {
    run: runtimeRun("wf-model-match", "run-model-match"),
    waves: [runtimeWave("run-model-match", "model-wave", 0, [runtimeNode("run-model-match", "model-wave", "model-node", "model-task", "model-session", 1)])],
    nodes: [runtimeNode("run-model-match", "model-wave", "model-node", "model-task", "model-session", 1)], lock_events: [], execution_events: [], config_snapshot: facts.snapshot,
  })
  assert.equal(matchingModel.ok, true, JSON.stringify(matchingModel))
  assert.equal(store.getWorkflowRun("run-batch").workflow_id, "wf-batch")
  const replayBatch = appendRuntimeEvidenceBatch(store, {
    run: batchRun, waves: [batchWave], nodes: [batchNode], lock_events: [], execution_events: [], config_snapshot: facts.snapshot,
  })
  assert.equal(replayBatch.ok, true, JSON.stringify(replayBatch))
  assert.equal(replayBatch.status, "IDEMPOTENT")
  const mismatchWave = runtimeWave("run-mismatch", "mismatch-wave", 0, [runtimeNode("run-mismatch", "mismatch-wave", "declared-node", "declared-task", "declared-session", 1)])
  const actualNode = runtimeNode("run-mismatch", "mismatch-wave", "actual-node", "actual-task", "actual-session", 1)
  const mismatchBatch = appendRuntimeEvidenceBatch(store, { run: runtimeRun("wf-mismatch", "run-mismatch"), waves: [mismatchWave], nodes: [actualNode], lock_events: [], execution_events: [], config_snapshot: facts.snapshot })
  assert.equal(mismatchBatch.ok, false)
  assert.equal(mismatchBatch.cause_code, "WAVE_NODE_SET_MISMATCH")
  const crossWorkflowRetry = appendRuntimeEvidenceBatch(store, {
    run: { ...runtimeRun("wf-other", "run-cross-workflow", 2), parent_run_id: "run-batch" },
    waves: [runtimeWave("run-cross-workflow", "cross-wave", 0, [runtimeNode("run-cross-workflow", "cross-wave", "cross-node", "cross-task", "cross-session", 1)])],
    nodes: [runtimeNode("run-cross-workflow", "cross-wave", "cross-node", "cross-task", "cross-session", 1)], lock_events: [], execution_events: [], config_snapshot: facts.snapshot,
  })
  assert.equal(crossWorkflowRetry.code, "EVIDENCE_WRITE_FAILED")
  assert.equal(crossWorkflowRetry.cause_code, "PARENT_WORKFLOW_MISMATCH")
  const conflictEventA = runtimeEvent("run-batch", "wf-batch", "batch-wave-0", "batch-node", "batch-task", "conflict-event", 1, { ok: true })
  const conflictEventB = { ...conflictEventA, sequence: 2, payload: { ok: false } }
  const failedExisting = appendRuntimeEvidenceBatch(store, {
    run: batchRun, waves: [batchWave], nodes: [batchNode], lock_events: [], execution_events: [conflictEventA, conflictEventB], config_snapshot: facts.snapshot,
  })
  assert.equal(failedExisting.ok, false)
  assert.equal(failedExisting.code, "EVIDENCE_WRITE_FAILED")
  assert.equal(failedExisting.failure_event?.ok, true, JSON.stringify(failedExisting))
  assert.equal(store.listExecutionEvents({ run_id: "run-batch" }).some((event) => event.event_type === "EVIDENCE_WRITE_FAILED"), true)

  const failedBatch = appendRuntimeEvidenceBatch(store, {
    run: runtimeRun("wf-fail", "run-fail"), waves: [runtimeWave("run-fail", "fail-wave", 0)],
    nodes: [{ ...runtimeNode("run-fail", "fail-wave", "fail-node", "fail-task", null, 1), session_id: null }],
    lock_events: [], execution_events: [], config_snapshot: facts.snapshot,
  })
  assert.equal(failedBatch.ok, false)
  assert.equal(failedBatch.code, "EVIDENCE_WRITE_FAILED")
  assert.equal(failedBatch.evidence_write_status, "FAILED")
  assert.equal(store.getWorkflowRun("run-fail"), null)
  const failureEvent = recordEvidenceWriteFailure(store, failedBatch)
  assert.equal(failureEvent.ok, false)

  const explicitFailure = recordEvidenceWriteFailure(store, {
    code: "DATABASE_WRITE_FAILED", detail: "fixture failure", source, workflow_id: "wf-batch", run_id: "run-batch",
    wave_id: "batch-wave-0", node_id: "batch-node", config_revision: revision, idempotency_key: "failure-batch-1", observed_at: observedAt,
  })
  assert.equal(explicitFailure.ok, true, JSON.stringify(explicitFailure))
  const explicitFailureReplay = recordEvidenceWriteFailure(store, {
    code: "DATABASE_WRITE_FAILED", detail: "fixture failure", source, workflow_id: "wf-batch", run_id: "run-batch",
    wave_id: "batch-wave-0", node_id: "batch-node", config_revision: revision, idempotency_key: "failure-batch-1", observed_at: observedAt,
  })
  assert.equal(explicitFailureReplay.ok, true)
  assert.equal(explicitFailureReplay.status, "IDEMPOTENT")
  assert.equal(store.listExecutionEvents({ run_id: "run-batch" }).some((event) => event.event_type === "EVIDENCE_WRITE_FAILED"), true)

  const parallelInput = (prefix) => {
    const runId = `run-${prefix}`; const workflowId = `wf-${prefix}`; const waveId = `wave-${prefix}`
    const node = runtimeNode(runId, waveId, `node-${prefix}`, `task-${prefix}`, `session-${prefix}`, 1)
    const wave = runtimeWave(runId, waveId, 0, [node])
    return { run: runtimeRun(workflowId, runId), waves: [wave], nodes: [node], lock_events: [], execution_events: [] }
  }
  const parallelResults = await Promise.all([
    runAdapterWorker(path.join(fixture, "control-plane.db"), parallelInput("parallel-a")),
    runAdapterWorker(path.join(fixture, "control-plane.db"), parallelInput("parallel-b")),
  ])
  assert.equal(parallelResults.every((result) => result.ok), true, JSON.stringify(parallelResults))
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM workflow_runs WHERE run_id IN ('run-parallel-a','run-parallel-b')").get().count, 2)

  const reopened = initializeControlPlaneDatabase({ dbPath: path.join(fixture, "control-plane.db"), runtimeRoot: fixture, allowedRoots: [fixture] })
  assert.equal(reopened.getWorkflowRun("run-batch").workflow_id, "wf-batch")
  reopened.close()
  console.log("PLAN12_WORKFLOW_RUN_ADAPTER_PASS")
  console.log("PLAN12_WAVE_EVIDENCE_PASS")
  console.log("PLAN12_WAVE_NODE_EVIDENCE_PASS")
  console.log("PLAN12_LOCK_EVIDENCE_PASS")
  console.log("PLAN12_EXECUTION_EVENT_ADAPTER_PASS")
  console.log("PLAN12_EVIDENCE_WRITE_FAILURE_GATE_PASS")
} finally {
  store.close()
  fs.rmSync(fixture, { recursive: true, force: true })
}
