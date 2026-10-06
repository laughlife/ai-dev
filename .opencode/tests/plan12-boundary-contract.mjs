import assert from "node:assert/strict"
import fs from "node:fs"

const contract = await import("../lib/plan12-contract.ts")
const envelopeSchema = JSON.parse(fs.readFileSync("templates/plan12-runtime-evidence-envelope.schema.json", "utf8"))
const configSchema = JSON.parse(fs.readFileSync("templates/plan12-control-plane-config.schema.json", "utf8"))
assert.equal(envelopeSchema.$defs.workflowRunFact.properties.fact_type.const, "workflow_run")
assert.equal(envelopeSchema.$defs.workflowRunFact.properties.evidence_level.$ref, "#/$defs/l3EvidenceLevel")
assert.equal(envelopeSchema.$defs.routeBinding.properties.status.$ref, "#/$defs/routeStatus")
assert.equal(configSchema.properties.schema_version.const, 1)
const {
  sha256Canonical,
  validatePlan12Envelope,
  validateWorkflowRunFact,
  validateWorkflowWaveFact,
  validateWorkflowWaveNodeFact,
  validateWorkflowLockEvent,
  validateExecutionEvent,
  validateWorkflowConfigSnapshot,
  validateModelCatalogEntry,
  validateRouteBinding,
} = contract

const base = {
  schema_version: 1,
  config_revision: "cr-20261002-0001",
  source: "runtime/control-plane.db",
  observed_at: "2026-10-02T00:00:00.000Z",
  evidence_level: "L3",
}

function withDigest(value) {
  const { payload_sha256: _ignored, ...withoutDigest } = value
  return { ...withoutDigest, payload_sha256: sha256Canonical(withoutDigest) }
}

function fact(fields, key) {
  return withDigest({ ...base, ...fields, idempotency_key: key })
}

const snapshot = fact({
  fact_type: "workflow_config_snapshot",
  config_revision: "cr-20261002-0001",
  parent_revision: null,
  source_kind: "verified_config",
  drawio_raw_sha256: "a".repeat(64),
  drawio_semantic_sha256: "b".repeat(64),
  ir_sha256: "c".repeat(64),
  config_digest: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
  model_catalog_digest: "e".repeat(64),
  route_bindings_digest: "f".repeat(64),
  canonical_json: "{}",
  state: "DRAFT",
  created_by: "plan12-test",
  created_at: base.observed_at,
  activated_at: null,
  rollback_of: null,
}, "snapshot-1")

const model = {
  model_ref: "model-openai-gpt-5.6-sol-high",
  provider_id: "openai",
  model_id: "gpt-5.6-sol",
  variant: "high",
  runtime_id: "openai/gpt-5.6-sol#high",
  source: "verified_config",
  availability_status: "UNKNOWN",
  capabilities: { context_limit: null, input: true, output: true },
  verified_at: base.observed_at,
  evidence_ref: "probe-unknown",
  config_revision: base.config_revision,
}

const run = fact({
  fact_type: "workflow_run",
  run_id: "run-1",
  workflow_id: "wf-1",
  parent_run_id: null,
  plan_digest: "1".repeat(64),
  attempt: 1,
  trigger: "manual",
  project_id: "ruoyi-vue-pro",
  status: "RUNNING",
  started_at: base.observed_at,
  ended_at: null,
  outcome_digest: null,
  evidence_write_status: "COMPLETE",
  error_code: null,
  error_detail: null,
  engine_version: "plan12-test",
}, "run-1")

const wave = fact({
  fact_type: "workflow_wave",
  run_id: "run-1",
  wave_id: "wave-1",
  wave_index: 0,
  ready_set_digest: "2".repeat(64),
  policy_digest: "3".repeat(64),
  parallelism: 1,
  status: "RUNNING",
  started_at: base.observed_at,
  ended_at: null,
  lock_snapshot_json: "{}",
  evidence_digest: "4".repeat(64),
}, "wave-1")

const waveNode = fact({
  fact_type: "workflow_wave_node",
  run_id: "run-1",
  wave_id: "wave-1",
  node_id: "node-1",
  attempt: 1,
  task_id: "task-1",
  route: "code_read",
  resource_digest: "5".repeat(64),
  lock_key_json: "[]",
  status: "RUNNING",
  event_seq: 1,
  started_at: base.observed_at,
  ended_at: null,
  result_digest: null,
  error_code: null,
  session_id: "session-1",
  model_runtime_id: "fixture-provider/fixture-model#contract",
}, "node-1")

const lock = fact({
  fact_type: "workflow_lock_event",
  event_id: "lock-event-1",
  run_id: "run-1",
  wave_id: "wave-1",
  node_id: "node-1",
  lock_key: "framework-docs",
  event_type: "ACQUIRE",
  owner_token: "owner-1",
  sequence: 1,
  occurred_at: base.observed_at,
  outcome: "GRANTED",
  error_code: null,
}, "lock-1")

const execution = fact({
  fact_type: "execution_event",
  event_id: "execution-event-1",
  run_id: "run-1",
  workflow_id: "wf-1",
  wave_id: "wave-1",
  node_id: "node-1",
  task_id: "task-1",
  attempt: 1,
  event_type: "NODE_STARTED",
  status: "RUNNING",
  sequence: 1,
  payload_digest: "6".repeat(64),
  payload_ref: "task-result:task-1",
  occurred_at: base.observed_at,
  error_code: null,
}, "execution-1")

const route = {
  route_id: "code_read",
  project_id: "ruoyi-vue-pro",
  role: "project-reader",
  model_ref: model.model_ref,
  provider_id: model.provider_id,
  model_id: model.model_id,
  variant: model.variant,
  runtime_id: model.runtime_id,
  status: "BOUND",
  config_revision: base.config_revision,
  evidence_ref: model.evidence_ref,
}

for (const [name, value, validator] of [
  ["snapshot", snapshot, validateWorkflowConfigSnapshot],
  ["run", run, validateWorkflowRunFact],
  ["wave", wave, validateWorkflowWaveFact],
  ["wave node", waveNode, validateWorkflowWaveNodeFact],
  ["lock", lock, validateWorkflowLockEvent],
  ["execution", execution, validateExecutionEvent],
]) {
  const result = validator(value)
  assert.equal(result.ok, true, `${name} should be valid: ${JSON.stringify(result)}`)
}
assert.equal(validateModelCatalogEntry(model).ok, true)
assert.equal(validateRouteBinding(route).ok, true)

const missingEnvelope = { ...run }
delete missingEnvelope.config_revision
assert.equal(validateWorkflowRunFact(missingEnvelope).code, "ENVELOPE_FIELD_REQUIRED")

const reordered = { idempotency_key: run.idempotency_key, ...Object.fromEntries(Object.entries(run).filter(([key]) => key !== "idempotency_key")) }
assert.equal(sha256Canonical(run), sha256Canonical(reordered), "object key order must not change digest")
assert.equal(JSON.stringify(contract.canonicalizePlan12Json({ "𐀀": 1, "": 2 })), '{"":2,"𐀀":1}', "object keys use Unicode code point order")

const idemState = {}
assert.equal(validateWorkflowRunFact(run, idemState).ok, true)
assert.equal(validateWorkflowRunFact(run, idemState).ok, true, "same idempotency and digest is idempotent")
const rollbackContext = {}
const malformedFact = { ...run, attempt: 0, idempotency_key: "rollback-key" }
malformedFact.payload_sha256 = sha256Canonical(Object.fromEntries(Object.entries(malformedFact).filter(([key]) => key !== "payload_sha256")))
assert.equal(validateWorkflowRunFact(malformedFact, rollbackContext).code, "SEQUENCE_INVALID")
const correctedFact = { ...run, idempotency_key: "rollback-key" }
correctedFact.payload_sha256 = sha256Canonical(Object.fromEntries(Object.entries(correctedFact).filter(([key]) => key !== "payload_sha256")))
assert.equal(validateWorkflowRunFact(correctedFact, rollbackContext).ok, true, "malformed facts must not reserve idempotency keys")
const conflicting = { ...run, status: "FAILED", payload_sha256: null }
conflicting.payload_sha256 = sha256Canonical(Object.fromEntries(Object.entries(conflicting).filter(([key]) => key !== "payload_sha256")))
assert.equal(validateWorkflowRunFact(conflicting, idemState).code, "EVIDENCE_IDEMPOTENCY_CONFLICT")

const duplicateWave = { ...wave, wave_id: "wave-2", idempotency_key: "wave-2" }
duplicateWave.payload_sha256 = sha256Canonical(Object.fromEntries(Object.entries(duplicateWave).filter(([key]) => key !== "payload_sha256")))
const waveState = { runRevisions: new Map([["run-1", base.config_revision]]) }
assert.equal(validateWorkflowWaveFact(wave, waveState).ok, true)
assert.equal(validateWorkflowWaveFact(duplicateWave, waveState).code, "WAVE_INDEX_DUPLICATE")

const invalidTransition = { ...snapshot, config_revision: "cr-20261002-0002", state: "ACTIVE", parent_revision: null, idempotency_key: "snapshot-2" }
invalidTransition.payload_sha256 = sha256Canonical(Object.fromEntries(Object.entries(invalidTransition).filter(([key]) => key !== "payload_sha256")))
assert.equal(validateWorkflowConfigSnapshot(invalidTransition, { snapshots: new Map([[snapshot.config_revision, snapshot]]) }).code, "PARENT_REVISION_REQUIRED")
assert.equal(contract.validateConfigRevisionTransition("DRAFT", "ACTIVE").code, "CONFIG_STATE_TRANSITION_INVALID")
const immutableContext = { snapshots: new Map() }
assert.equal(validateWorkflowConfigSnapshot(snapshot, immutableContext).ok, true)
assert.equal(validateWorkflowConfigSnapshot(snapshot, immutableContext).code, "CONFIG_REVISION_IMMUTABLE")
const reusedRun = { ...run, attempt: 2, parent_run_id: run.run_id, idempotency_key: "run-reused" }
reusedRun.payload_sha256 = sha256Canonical(Object.fromEntries(Object.entries(reusedRun).filter(([key]) => key !== "payload_sha256")))
assert.equal(validateWorkflowRunFact(reusedRun, {}).code, "RUN_ID_REUSE")

const retryContext = {}
assert.equal(validateWorkflowRunFact(run, retryContext).ok, true)
const validRetry = { ...run, run_id: "run-retry", parent_run_id: run.run_id, attempt: 2, idempotency_key: "run-retry" }
validRetry.payload_sha256 = sha256Canonical(Object.fromEntries(Object.entries(validRetry).filter(([key]) => key !== "payload_sha256")))
assert.equal(validateWorkflowRunFact(validRetry, retryContext).ok, true)
const invalidRetry = { ...validRetry, run_id: "run-retry-99", attempt: 99, idempotency_key: "run-retry-99" }
invalidRetry.payload_sha256 = sha256Canonical(Object.fromEntries(Object.entries(invalidRetry).filter(([key]) => key !== "payload_sha256")))
assert.equal(validateWorkflowRunFact(invalidRetry, retryContext).code, "ATTEMPT_INVALID")

const nonCanonicalSnapshot = { ...snapshot, config_revision: "cr-20261002-0003", idempotency_key: "snapshot-3", canonical_json: '{"b":1,"a":2}' }
nonCanonicalSnapshot.config_digest = sha256Canonical({ a: 2, b: 1 })
nonCanonicalSnapshot.payload_sha256 = sha256Canonical(Object.fromEntries(Object.entries(nonCanonicalSnapshot).filter(([key]) => key !== "payload_sha256")))
assert.equal(validateWorkflowConfigSnapshot(nonCanonicalSnapshot).code, "CANONICAL_JSON_NONCANONICAL")

const unassigned = { ...route, model_ref: null, provider_id: null, model_id: null, variant: null, runtime_id: null, status: "MODEL_UNASSIGNED", evidence_ref: null }
assert.equal(validateRouteBinding(unassigned).ok, true)
assert.notEqual(validateRouteBinding({ ...unassigned, status: "BOUND" }).ok, true, "MODEL_UNASSIGNED cannot become BOUND")

assert.equal(validateModelCatalogEntry({ ...model, runtime_id: "openai/gpt-6.1-sol", provider_id: "openai", model_id: "gpt-6.1-sol", variant: null, availability_status: "UNKNOWN" }).ok, true)
assert.notEqual(validateModelCatalogEntry({ ...model, runtime_id: "openai/gpt-6.1-sol/extra", provider_id: "openai", model_id: "gpt-6.1-sol", variant: null, availability_status: "UNKNOWN" }).ok, true)
assert.notEqual(validateExecutionEvent({ ...execution, occurred_at: "2026-10-02T00:00:00+08:00" }).ok, true)
assert.notEqual(validateExecutionEvent({ ...execution, sequence: 0 }).ok, true)
assert.notEqual(validateWorkflowWaveNodeFact({ ...waveNode, attempt: 0 }).ok, true)
assert.notEqual(validateExecutionEvent({ ...execution, occurred_at: "2026-02-31T00:00:00.000Z" }).ok, true)

const unknownRevisionContext = { snapshots: new Map([[base.config_revision, snapshot]]) }
assert.equal(validateWorkflowRunFact(run, unknownRevisionContext).ok, true)
const unknownRevisionRun = { ...run, run_id: "run-unknown-revision", config_revision: "cr-unknown", idempotency_key: "run-unknown-revision" }
unknownRevisionRun.payload_sha256 = sha256Canonical(Object.fromEntries(Object.entries(unknownRevisionRun).filter(([key]) => key !== "payload_sha256")))
assert.equal(validateWorkflowRunFact(unknownRevisionRun, unknownRevisionContext).code, "CONFIG_REVISION_NOT_FOUND")

assert.throws(() => contract.canonicalizePlan12Json({ invalid: undefined }), (error) => error.code === "INVALID_JSON_VALUE")
assert.throws(() => contract.canonicalizePlan12Json({ invalid: Number.NaN }), (error) => error.code === "INVALID_JSON_VALUE")
assert.throws(() => contract.canonicalizePlan12Json({ invalid: Number.POSITIVE_INFINITY }), (error) => error.code === "INVALID_JSON_VALUE")

assert.equal(validateRouteBinding({ ...unassigned, project_id: "xxl-job", status: "MODEL_UNASSIGNED" }).ok, true)
assert.equal(validateRouteBinding({ ...unassigned, project_id: "xxl-job", status: "BOUND", model_ref: model.model_ref, provider_id: model.provider_id, model_id: model.model_id, variant: model.variant }).code, "PROJECT_MODEL_UNASSIGNED")
assert.equal(validateModelCatalogEntry({ ...model, runtime_id: "bailian-token-plan/qwen3.8-max", provider_id: "bailian-token-plan", model_id: "qwen3.8-max", variant: null, source: "verified_config", availability_status: "VERIFIED", display_name: "Qwen candidate" }).code, "MODEL_AVAILABILITY_UNVERIFIED")
assert.notEqual(validateModelCatalogEntry({ ...model, capabilities: { context_limit: null, input: "yes", output: 1 } }).ok, true)

const lockSequenceContext = {}
assert.equal(validateWorkflowLockEvent(lock, lockSequenceContext).ok, true)
const lockSequenceConflict = { ...lock, event_id: "lock-event-2", idempotency_key: "lock-2" }
lockSequenceConflict.payload_sha256 = sha256Canonical(Object.fromEntries(Object.entries(lockSequenceConflict).filter(([key]) => key !== "payload_sha256")))
assert.equal(validateWorkflowLockEvent(lockSequenceConflict, lockSequenceContext).code, "SEQUENCE_NOT_CONTIGUOUS")
const lockSequenceGap = { ...lock, event_id: "lock-event-3", sequence: 3, idempotency_key: "lock-3" }
lockSequenceGap.payload_sha256 = sha256Canonical(Object.fromEntries(Object.entries(lockSequenceGap).filter(([key]) => key !== "payload_sha256")))
assert.equal(validateWorkflowLockEvent(lockSequenceGap, lockSequenceContext).code, "SEQUENCE_NOT_CONTIGUOUS")

const newRevisionRun = { ...run, run_id: "run-2", workflow_id: "wf-1", config_revision: "cr-20261002-0002", idempotency_key: "run-2" }
newRevisionRun.payload_sha256 = sha256Canonical(Object.fromEntries(Object.entries(newRevisionRun).filter(([key]) => key !== "payload_sha256")))
assert.equal(validateWorkflowRunFact(run, { workflowRevisions: new Map([["wf-1", base.config_revision]]) }).ok, true)
assert.equal(validateWorkflowRunFact(newRevisionRun, { workflowRevisions: new Map([["wf-1", base.config_revision]]) }).code, "WORKFLOW_REVISION_MIXED")

console.log("PLAN12_BOUNDARY_CONTRACT_PASS")
