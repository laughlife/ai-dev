import { sha256Canonical } from "./plan12-contract.ts"
import { type ControlPlaneStore } from "./plan12-control-plane.ts"
import { getActiveConfigRevision } from "./plan12-config-revision.ts"
import { validateRouteBinding as admitRoute } from "./plan12-model-routes.ts"

type AnyRecord = Record<string, any>
type AdapterSuccess = { ok: true; fact: AnyRecord; status?: string; facts?: AnyRecord[]; rolled_back?: false }
type AdapterFailure = {
  ok: false
  code: string
  detail: string
  path?: string
  guard: "BLOCKED"
  evidence_write_status: "INCOMPLETE" | "FAILED"
  source?: string
  workflow_id?: string | null
  run_id?: string | null
  wave_id?: string | null
  node_id?: string | null
  config_revision?: string | null
  idempotency_key?: string | null
  cause_code?: string
  cause_detail?: string
  rolled_back?: boolean
  failure_event?: AnyRecord
}

const SCHEMA_VERSION = 1
const EVIDENCE_LEVEL = "L3"
const LOCK_EVENTS = new Set(["ACQUIRE", "WAIT", "RELEASE", "CONFLICT", "EXPIRE"])
const EXECUTION_EVENTS = new Set([
  "RUN_STARTED", "WAVE_STARTED", "NODE_STARTED", "NODE_FINISHED", "WAVE_FINISHED", "RUN_FINISHED", "EVIDENCE_WRITE_FAILED",
])

function valueOf(raw: AnyRecord, context: AnyRecord, ...keys: string[]): any {
  for (const key of keys) {
    if (raw?.[key] !== undefined) return raw[key]
    if (context?.[key] !== undefined) return context[key]
  }
  return undefined
}

function sourceOf(raw: AnyRecord, context: AnyRecord): string | undefined {
  const source = valueOf(raw, context, "source")
  return typeof source === "string" && source.trim() ? source : undefined
}

function fail(code: string, detail: string, raw: AnyRecord = {}, context: AnyRecord = {}, path?: string, extra: AnyRecord = {}): AdapterFailure {
  const source = sourceOf(raw, context)
  const failure: AdapterFailure = {
    ok: false,
    code,
    detail,
    ...(path ? { path } : {}),
    guard: "BLOCKED",
    evidence_write_status: code === "EVIDENCE_WRITE_FAILED" ? "FAILED" : "INCOMPLETE",
    source,
    workflow_id: valueOf(raw, context, "workflow_id"),
    run_id: valueOf(raw, context, "run_id"),
    wave_id: valueOf(raw, context, "wave_id"),
    node_id: valueOf(raw, context, "node_id"),
    config_revision: valueOf(raw, context, "config_revision"),
    idempotency_key: valueOf(raw, context, "idempotency_key"),
    ...extra,
  }
  return failure
}

function required(raw: AnyRecord, context: AnyRecord, fields: string[]): AdapterFailure | null {
  for (const field of fields) {
    const value = valueOf(raw, context, field)
    if (value === undefined || value === null || value === "") return fail("EVIDENCE_INCOMPLETE", `${field} is required from the Runtime response`, raw, context, `$.${field}`)
  }
  return null
}

function requiredFromRuntime(raw: AnyRecord, fields: string[]): AdapterFailure | null {
  for (const field of fields) {
    const value = raw?.[field]
    if (value === undefined || value === null || value === "") return fail("EVIDENCE_INCOMPLETE", `${field} is required from the Runtime response`, raw, {}, `$.${field}`)
  }
  return null
}

function presentFromRuntime(raw: AnyRecord, fields: string[]): AdapterFailure | null {
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(raw ?? {}, field)) continue
    return fail("EVIDENCE_INCOMPLETE", `${field} must be present in the Runtime response`, raw, {}, `$.${field}`)
  }
  return null
}

function present(raw: AnyRecord, context: AnyRecord, fields: string[]): AdapterFailure | null {
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(raw ?? {}, field) || Object.prototype.hasOwnProperty.call(context ?? {}, field)) continue
    return fail("EVIDENCE_INCOMPLETE", `${field} must be present in the Runtime response`, raw, context, `$.${field}`)
  }
  return null
}

function validUtc(value: any): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return false
  if (!Number.isFinite(Date.parse(value))) return false
  const normalized = value.replace(/\.(\d{1,2})Z$/, (_match, fraction) => `.${fraction.padEnd(3, "0")}Z`).replace(/T(\d{2}:\d{2}:\d{2})Z$/, "T$1.000Z")
  try { return new Date(value).toISOString() === normalized } catch { return false }
}

function validHash(value: any): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
}

function validateTimeFields(raw: AnyRecord, context: AnyRecord, fields: string[]): AdapterFailure | null {
  for (const field of fields) {
    const value = valueOf(raw, context, field)
    if (value === null) continue
    if (!validUtc(value)) return fail("EVIDENCE_TIME_INVALID", `${field} must be a UTC ISO-8601 timestamp`, raw, context, `$.${field}`)
  }
  return null
}

function validateHashFields(raw: AnyRecord, context: AnyRecord, fields: string[]): AdapterFailure | null {
  for (const field of fields) {
    const value = valueOf(raw, context, field)
    if (!validHash(value)) return fail("EVIDENCE_HASH_INVALID", `${field} must be a lowercase SHA-256 digest`, raw, context, `$.${field}`)
  }
  return null
}

function observedAt(raw: AnyRecord, context: AnyRecord): string | undefined {
  const value = valueOf(raw, context, "observed_at", "observedAt")
  return typeof value === "string" && value.trim() ? value : undefined
}

function revision(raw: AnyRecord, context: AnyRecord): string | undefined {
  const value = valueOf(raw, context, "config_revision", "configRevision")
  return typeof value === "string" && value.trim() ? value : undefined
}

function stableKey(source: string, factType: string, parts: unknown[]): string {
  return `plan12:${factType}:${sha256Canonical({ source, factType, parts })}`
}

function withEnvelope(factType: string, raw: AnyRecord, context: AnyRecord, fields: AnyRecord, keyParts: unknown[]): AdapterSuccess | AdapterFailure {
  const source = sourceOf(raw, context)
  const observed = observedAt(raw, context)
  const configRevision = revision(raw, context)
  if (!source) return fail("EVIDENCE_INCOMPLETE", "source is required from the Runtime response", raw, context, "$.source")
  if (!observed) return fail("EVIDENCE_INCOMPLETE", "observed_at is required from the Runtime response or adapter context", raw, context, "$.observed_at")
  if (!validUtc(observed)) return fail("EVIDENCE_TIME_INVALID", "observed_at must be a UTC ISO-8601 timestamp", raw, context, "$.observed_at")
  if (!configRevision) return fail("EVIDENCE_INCOMPLETE", "config_revision is required from the Runtime response or adapter context", raw, context, "$.config_revision")
  const key = valueOf(raw, context, "idempotency_key") || stableKey(source, factType, keyParts)
  const body = {
    schema_version: SCHEMA_VERSION,
    config_revision: configRevision,
    source,
    observed_at: observed,
    evidence_level: EVIDENCE_LEVEL,
    fact_type: factType,
    ...fields,
    idempotency_key: key,
  }
  return { ok: true, fact: { ...body, payload_sha256: sha256Canonical(body) } }
}

function same(value: any, expected: any): boolean {
  return expected === undefined || value === undefined || value === expected
}

function integer(value: any, minimum = 1): boolean {
  return Number.isInteger(value) && value >= minimum
}

function digestPayload(payload: any): string | null {
  if (payload === undefined) return null
  try { return sha256Canonical(payload) } catch { return null }
}

export function adaptWorkflowRun(runtimeResult: AnyRecord, context: AnyRecord = {}): AdapterSuccess | AdapterFailure {
  const missing = requiredFromRuntime(runtimeResult, [
    "workflow_id", "run_id", "plan_digest", "attempt", "trigger", "project_id", "status", "evidence_write_status", "engine_version", "started_at",
  ])
  if (missing) return missing
  const nullable = presentFromRuntime(runtimeResult, ["parent_run_id", "ended_at", "outcome_digest", "error_code", "error_detail"])
  if (nullable) return nullable
  if (context.workflow_id !== undefined && runtimeResult.workflow_id !== context.workflow_id) return fail("WORKFLOW_ID_MISMATCH", "workflow_id differs from its run context", runtimeResult, context, "$.workflow_id")
  if (context.run_id !== undefined && runtimeResult.run_id !== context.run_id) return fail("RUN_ID_MISMATCH", "run_id differs from its run context", runtimeResult, context, "$.run_id")
  if (context.config_revision !== undefined && runtimeResult.config_revision !== undefined && runtimeResult.config_revision !== context.config_revision) return fail("CONFIG_REVISION_MISMATCH", "workflow run config_revision differs from its context", runtimeResult, context, "$.config_revision")
  if (!integer(valueOf(runtimeResult, context, "attempt"))) return fail("EVIDENCE_INCOMPLETE", "attempt must be an integer >= 1", runtimeResult, context, "$.attempt")
  const times = validateTimeFields(runtimeResult, context, ["started_at", "ended_at"]); if (times) return times
  const hashes = validateHashFields(runtimeResult, context, ["plan_digest"]); if (hashes) return hashes
  if (valueOf(runtimeResult, context, "outcome_digest") !== null) {
    const outcome = validateHashFields(runtimeResult, context, ["outcome_digest"]); if (outcome) return outcome
  }
  const runId = valueOf(runtimeResult, context, "run_id")
  const parent = valueOf(runtimeResult, context, "parent_run_id") ?? null
  if (valueOf(runtimeResult, context, "attempt") > 1 && !parent) return fail("PARENT_RUN_REQUIRED", "retry/FIX/REWORK runs require parent_run_id", runtimeResult, context, "$.parent_run_id")
  if (parent && parent === runId) return fail("RUN_ID_REUSE", "run_id cannot reuse parent_run_id", runtimeResult, context, "$.run_id")
  const configRevision = revision(runtimeResult, context)
  if (parent && context.parent_workflow_id !== undefined && context.parent_workflow_id !== valueOf(runtimeResult, context, "workflow_id")) return fail("PARENT_WORKFLOW_MISMATCH", "retry parent belongs to a different workflow", runtimeResult, context, "$.parent_run_id")
  if (parent && context.parent_config_revision !== undefined && context.parent_config_revision !== configRevision) return fail("PARENT_CONFIG_REVISION_MISMATCH", "retry parent belongs to a different config_revision", runtimeResult, context, "$.parent_run_id")
  const fields = {
    run_id: runId,
    workflow_id: valueOf(runtimeResult, context, "workflow_id"),
    parent_run_id: parent,
    plan_digest: valueOf(runtimeResult, context, "plan_digest"),
    attempt: valueOf(runtimeResult, context, "attempt"),
    trigger: valueOf(runtimeResult, context, "trigger"),
    project_id: valueOf(runtimeResult, context, "project_id"),
    status: valueOf(runtimeResult, context, "status"),
    started_at: valueOf(runtimeResult, context, "started_at"),
    ended_at: valueOf(runtimeResult, context, "ended_at") ?? null,
    outcome_digest: valueOf(runtimeResult, context, "outcome_digest") ?? null,
    evidence_write_status: valueOf(runtimeResult, context, "evidence_write_status"),
    error_code: valueOf(runtimeResult, context, "error_code") ?? null,
    error_detail: valueOf(runtimeResult, context, "error_detail") ?? null,
    engine_version: valueOf(runtimeResult, context, "engine_version"),
  }
  return withEnvelope("workflow_run", runtimeResult, context, fields, [runId, fields.attempt])
}

export function adaptWorkflowWave(runtimeResult: AnyRecord, runContext: AnyRecord = {}): AdapterSuccess | AdapterFailure {
  const missing = requiredFromRuntime(runtimeResult, ["run_id", "wave_id", "wave_index", "ready_set_digest", "policy_digest", "parallelism", "status", "started_at", "evidence_digest"])
  if (missing) return missing
  const runId = valueOf(runtimeResult, runContext, "run_id")
  if (!same(valueOf(runtimeResult, runContext, "run_id"), runContext.run_id)) return fail("WAVE_RUN_MISMATCH", "wave run_id differs from its run context", runtimeResult, runContext, "$.run_id")
  if (!same(valueOf(runtimeResult, runContext, "config_revision"), runContext.config_revision)) return fail("CONFIG_REVISION_MISMATCH", "wave config_revision differs from its run context", runtimeResult, runContext, "$.config_revision")
  const index = valueOf(runtimeResult, runContext, "wave_index")
  if (!integer(index, 0)) return fail("EVIDENCE_INCOMPLETE", "wave_index must be an integer >= 0", runtimeResult, runContext, "$.wave_index")
  const nullable = presentFromRuntime(runtimeResult, ["ended_at", "lock_snapshot_json"]); if (nullable) return nullable
  const priorIndexes: number[] = Array.isArray(runContext.prior_wave_indexes) ? runContext.prior_wave_indexes : []
  if (priorIndexes.includes(index) && !runContext.replay) return fail("WAVE_INDEX_DUPLICATE", "wave_index is already used in this run", runtimeResult, runContext, "$.wave_index")
  const expected = priorIndexes.length
  if (index !== expected && !runContext.replay) return fail("WAVE_INDEX_NONCONTIGUOUS", `wave_index must be ${expected} for the next wave`, runtimeResult, runContext, "$.wave_index")
  const nodes = runtimeResult.nodes
  if (!Array.isArray(nodes) || nodes.length === 0) return fail("EVIDENCE_INCOMPLETE", "wave requires complete non-empty node evidence; summary waves cannot become L3 facts", runtimeResult, runContext, "$.nodes")
  const nodeCount = runContext.node_count ?? nodes.length
  if (!integer(valueOf(runtimeResult, runContext, "parallelism")) || valueOf(runtimeResult, runContext, "parallelism") !== nodeCount) return fail("WAVE_PARALLELISM_MISMATCH", "parallelism must equal the actual node evidence count", runtimeResult, runContext, "$.parallelism")
  const times = validateTimeFields(runtimeResult, runContext, ["started_at", "ended_at"]); if (times) return times
  const hashes = validateHashFields(runtimeResult, runContext, ["ready_set_digest", "policy_digest", "evidence_digest"]); if (hashes) return hashes
  const fields = {
    run_id: runId,
    wave_id: valueOf(runtimeResult, runContext, "wave_id"),
    wave_index: index,
    ready_set_digest: valueOf(runtimeResult, runContext, "ready_set_digest"),
    policy_digest: valueOf(runtimeResult, runContext, "policy_digest"),
    parallelism: valueOf(runtimeResult, runContext, "parallelism"),
    status: valueOf(runtimeResult, runContext, "status"),
    started_at: valueOf(runtimeResult, runContext, "started_at"),
    ended_at: valueOf(runtimeResult, runContext, "ended_at") ?? null,
    lock_snapshot_json: valueOf(runtimeResult, runContext, "lock_snapshot_json") ?? null,
    evidence_digest: valueOf(runtimeResult, runContext, "evidence_digest"),
  }
  return withEnvelope("workflow_wave", runtimeResult, runContext, fields, [runId, fields.wave_id])
}

export function adaptWorkflowWaveNode(runtimeNode: AnyRecord, waveContext: AnyRecord = {}): AdapterSuccess | AdapterFailure {
  const missing = requiredFromRuntime(runtimeNode, ["run_id", "wave_id", "node_id", "attempt", "task_id", "route", "resource_digest", "lock_key_json", "status", "event_seq", "started_at", "session_id", "model_runtime_id"])
  if (missing) return missing
  const nullable = presentFromRuntime(runtimeNode, ["ended_at", "result_digest", "error_code"]); if (nullable) return nullable
  if (!same(valueOf(runtimeNode, waveContext, "run_id"), waveContext.run_id) || !same(valueOf(runtimeNode, waveContext, "wave_id"), waveContext.wave_id)) return fail("NODE_WAVE_MISMATCH", "node does not belong to the requested run/wave", runtimeNode, waveContext, "$.wave_id")
  if (!same(valueOf(runtimeNode, waveContext, "config_revision"), waveContext.config_revision)) return fail("CONFIG_REVISION_MISMATCH", "node config_revision differs from its wave context", runtimeNode, waveContext, "$.config_revision")
  const sessionId = valueOf(runtimeNode, waveContext, "session_id")
  if (typeof sessionId !== "string" || !sessionId.trim()) return fail("SESSION_ID_REQUIRED", "session_id must be copied from the Runtime response", runtimeNode, waveContext, "$.session_id")
  const priorAttempt = waveContext.prior_attempt
  if (priorAttempt !== undefined && valueOf(runtimeNode, waveContext, "attempt") !== priorAttempt + 1 && !waveContext.replay) return fail("ATTEMPT_NONCONTIGUOUS", "retry/FIX/REWORK attempt must increment by one", runtimeNode, waveContext, "$.attempt")
  const priorSequence = waveContext.prior_event_seq
  if (!integer(valueOf(runtimeNode, waveContext, "attempt")) || !integer(valueOf(runtimeNode, waveContext, "event_seq"))) return fail("EVIDENCE_SEQUENCE_INVALID", "attempt and event_seq must be positive integers", runtimeNode, waveContext, "$.event_seq")
  if (priorSequence !== undefined && valueOf(runtimeNode, waveContext, "event_seq") !== priorSequence + 1 && !waveContext.replay) return fail("NODE_SEQUENCE_NONCONTIGUOUS", "node event_seq must advance by exactly one", runtimeNode, waveContext, "$.event_seq")
  if (priorSequence === undefined && valueOf(runtimeNode, {}, "event_seq") !== 1 && !waveContext.replay) return fail("NODE_SEQUENCE_NONCONTIGUOUS", "first node event_seq must be 1", runtimeNode, waveContext, "$.event_seq")
  const sessionIds = waveContext.session_ids
  if (sessionIds && typeof sessionIds === "object") {
    for (const [nodeId, knownSession] of Object.entries(sessionIds)) {
      if (nodeId !== valueOf(runtimeNode, waveContext, "node_id") && knownSession === sessionId) return fail("SESSION_ID_REUSED", "one Runtime session_id cannot be merged across nodes", runtimeNode, waveContext, "$.session_id")
    }
  }
  const times = validateTimeFields(runtimeNode, waveContext, ["started_at", "ended_at"]); if (times) return times
  const hashes = validateHashFields(runtimeNode, waveContext, ["resource_digest"]); if (hashes) return hashes
  if (valueOf(runtimeNode, waveContext, "result_digest") !== null) { const result = validateHashFields(runtimeNode, waveContext, ["result_digest"]); if (result) return result }
  const fields = {
    run_id: valueOf(runtimeNode, waveContext, "run_id"),
    wave_id: valueOf(runtimeNode, waveContext, "wave_id"),
    node_id: valueOf(runtimeNode, waveContext, "node_id"),
    attempt: valueOf(runtimeNode, waveContext, "attempt"),
    task_id: valueOf(runtimeNode, waveContext, "task_id"),
    route: valueOf(runtimeNode, waveContext, "route"),
    resource_digest: valueOf(runtimeNode, waveContext, "resource_digest"),
    lock_key_json: valueOf(runtimeNode, waveContext, "lock_key_json"),
    session_key: valueOf(runtimeNode, waveContext, "session_key") ?? null,
    session_id: sessionId,
    model_runtime_id: valueOf(runtimeNode, waveContext, "model_runtime_id"),
    status: valueOf(runtimeNode, waveContext, "status"),
    event_seq: valueOf(runtimeNode, waveContext, "event_seq"),
    started_at: valueOf(runtimeNode, waveContext, "started_at"),
    ended_at: valueOf(runtimeNode, waveContext, "ended_at") ?? null,
    result_digest: valueOf(runtimeNode, waveContext, "result_digest") ?? null,
    error_code: valueOf(runtimeNode, waveContext, "error_code") ?? null,
  }
  return withEnvelope("workflow_wave_node", runtimeNode, waveContext, fields, [fields.run_id, fields.wave_id, fields.node_id, fields.attempt])
}

export function adaptWorkflowLockEvent(runtimeLockEvent: AnyRecord, context: AnyRecord = {}): AdapterSuccess | AdapterFailure {
  const missing = requiredFromRuntime(runtimeLockEvent, ["event_id", "run_id", "wave_id", "node_id", "lock_key", "event_type", "owner_token", "sequence", "occurred_at", "outcome"])
  if (missing) return missing
  const nullable = presentFromRuntime(runtimeLockEvent, ["error_code"]); if (nullable) return nullable
  if (!same(valueOf(runtimeLockEvent, context, "run_id"), context.run_id)) return fail("LOCK_RUN_MISMATCH", "lock event run_id differs from context", runtimeLockEvent, context, "$.run_id")
  if (!same(valueOf(runtimeLockEvent, context, "wave_id"), context.wave_id) || !same(valueOf(runtimeLockEvent, context, "node_id"), context.node_id)) return fail("LOCK_NODE_MISMATCH", "lock event does not belong to its wave/node context", runtimeLockEvent, context, "$.node_id")
  if (!same(valueOf(runtimeLockEvent, context, "config_revision"), context.config_revision)) return fail("CONFIG_REVISION_MISMATCH", "lock event config_revision differs from context", runtimeLockEvent, context, "$.config_revision")
  const eventType = valueOf(runtimeLockEvent, context, "event_type")
  if (!LOCK_EVENTS.has(eventType)) return fail("LOCK_EVENT_INVALID", "lock event_type is not supported", runtimeLockEvent, context, "$.event_type")
  const lockKey = valueOf(runtimeLockEvent, context, "lock_key")
  const prior = context.lock_sequences?.[lockKey]
  if (!integer(valueOf(runtimeLockEvent, context, "sequence"))) return fail("EVIDENCE_SEQUENCE_INVALID", "lock sequence must be a positive integer", runtimeLockEvent, context, "$.sequence")
  if (prior !== undefined && valueOf(runtimeLockEvent, context, "sequence") !== prior + 1 && !context.replay) return fail("LOCK_SEQUENCE_NONCONTIGUOUS", "lock sequence must advance by exactly one", runtimeLockEvent, context, "$.sequence")
  if (prior === undefined && valueOf(runtimeLockEvent, {}, "sequence") !== 1 && !context.replay) return fail("LOCK_SEQUENCE_NONCONTIGUOUS", "first lock sequence must be 1", runtimeLockEvent, context, "$.sequence")
  const time = validateTimeFields(runtimeLockEvent, context, ["occurred_at"]); if (time) return time
  const fields = {
    event_id: valueOf(runtimeLockEvent, context, "event_id"),
    run_id: valueOf(runtimeLockEvent, context, "run_id"),
    wave_id: valueOf(runtimeLockEvent, context, "wave_id"),
    node_id: valueOf(runtimeLockEvent, context, "node_id"),
    lock_key: lockKey,
    event_type: eventType,
    owner_token: valueOf(runtimeLockEvent, context, "owner_token"),
    sequence: valueOf(runtimeLockEvent, context, "sequence"),
    occurred_at: valueOf(runtimeLockEvent, context, "occurred_at"),
    outcome: valueOf(runtimeLockEvent, context, "outcome"),
    error_code: valueOf(runtimeLockEvent, context, "error_code") ?? null,
  }
  return withEnvelope("workflow_lock_event", runtimeLockEvent, context, fields, [fields.event_id])
}

export function adaptExecutionEvent(runtimeEvent: AnyRecord, context: AnyRecord = {}): AdapterSuccess | AdapterFailure {
  const missing = requiredFromRuntime(runtimeEvent, ["event_id", "run_id", "workflow_id", "wave_id", "node_id", "task_id", "attempt", "event_type", "status", "sequence", "payload_ref", "occurred_at"])
  if (missing) return missing
  const nullable = presentFromRuntime(runtimeEvent, ["error_code"]); if (nullable) return nullable
  if (!same(valueOf(runtimeEvent, context, "run_id"), context.run_id) || !same(valueOf(runtimeEvent, context, "workflow_id"), context.workflow_id)) return fail("EXECUTION_RUN_MISMATCH", "execution event run/workflow identity differs from context", runtimeEvent, context, "$.run_id")
  if (!same(valueOf(runtimeEvent, context, "config_revision"), context.config_revision)) return fail("CONFIG_REVISION_MISMATCH", "execution event config_revision differs from context", runtimeEvent, context, "$.config_revision")
  const eventType = valueOf(runtimeEvent, context, "event_type")
  if (!EXECUTION_EVENTS.has(eventType)) return fail("EXECUTION_EVENT_INVALID", "execution event_type is not supported", runtimeEvent, context, "$.event_type")
  const payload = runtimeEvent.payload
  const computedDigest = digestPayload(payload)
  const suppliedDigest = valueOf(runtimeEvent, context, "payload_digest")
  if (!computedDigest) return fail("EVIDENCE_INCOMPLETE", "execution event requires the original Runtime payload", runtimeEvent, context, "$.payload")
  if (computedDigest && suppliedDigest && computedDigest !== suppliedDigest) return fail("PAYLOAD_DIGEST_MISMATCH", "payload_digest does not match the Runtime payload", runtimeEvent, context, "$.payload_digest")
  const prior = context.prior_sequence
  if (!integer(valueOf(runtimeEvent, context, "attempt")) || !integer(valueOf(runtimeEvent, context, "sequence"))) return fail("EVIDENCE_SEQUENCE_INVALID", "attempt and sequence must be positive integers", runtimeEvent, context, "$.sequence")
  if (prior !== undefined && valueOf(runtimeEvent, context, "sequence") !== prior + 1 && !context.replay) return fail("EXECUTION_SEQUENCE_NONCONTIGUOUS", "execution sequence must advance by exactly one", runtimeEvent, context, "$.sequence")
  if (prior === undefined && valueOf(runtimeEvent, {}, "sequence") !== 1 && !context.replay) return fail("EXECUTION_SEQUENCE_NONCONTIGUOUS", "first execution sequence must be 1", runtimeEvent, context, "$.sequence")
  const time = validateTimeFields(runtimeEvent, context, ["occurred_at"]); if (time) return time
  const fields = {
    event_id: valueOf(runtimeEvent, context, "event_id"),
    run_id: valueOf(runtimeEvent, context, "run_id"),
    workflow_id: valueOf(runtimeEvent, context, "workflow_id"),
    wave_id: valueOf(runtimeEvent, context, "wave_id"),
    node_id: valueOf(runtimeEvent, context, "node_id"),
    task_id: valueOf(runtimeEvent, context, "task_id"),
    attempt: valueOf(runtimeEvent, context, "attempt"),
    event_type: eventType,
    status: valueOf(runtimeEvent, context, "status"),
    sequence: valueOf(runtimeEvent, context, "sequence"),
    payload_digest: computedDigest ?? suppliedDigest,
    payload_ref: valueOf(runtimeEvent, context, "payload_ref"),
    occurred_at: valueOf(runtimeEvent, context, "occurred_at"),
    error_code: valueOf(runtimeEvent, context, "error_code") ?? null,
  }
  return withEnvelope("execution_event", runtimeEvent, context, fields, [fields.event_id])
}

function failureFromResult(result: AdapterFailure, rolledBack = false): AdapterFailure {
  return {
    ...result,
    code: "EVIDENCE_WRITE_FAILED",
    detail: `Runtime evidence write failed: ${result.detail}`,
    cause_code: result.code,
    cause_detail: result.detail,
    evidence_write_status: "FAILED",
    rolled_back: rolledBack,
  }
}

export function appendRuntimeEvidenceBatch(store: ControlPlaneStore, input: AnyRecord): AdapterSuccess | AdapterFailure {
  const runInput = input?.run
  if (!runInput || typeof runInput !== "object") return failureFromResult(fail("EVIDENCE_INCOMPLETE", "run Runtime response is required", input ?? {}))
  const run = adaptWorkflowRun(runInput, input.context ?? {})
  if (!run.ok) return failureFromResult(run)
  const active = getActiveConfigRevision(store)
  const persistedRun = store.getWorkflowRun(run.fact.run_id)
  let parentRun: any | null = null
  if (run.fact.attempt > 1 && run.fact.parent_run_id) parentRun = store.getWorkflowRun(run.fact.parent_run_id)
  const activeRevision = active?.config_revision === run.fact.config_revision && active?.effective_state === "ACTIVE"
  const replayOrContinuation = Boolean(persistedRun && persistedRun.workflow_id === run.fact.workflow_id && persistedRun.config_revision === run.fact.config_revision)
  const retryFromSameSnapshot = Boolean(parentRun && parentRun.workflow_id === run.fact.workflow_id && parentRun.config_revision === run.fact.config_revision)
  if (!activeRevision && !replayOrContinuation && !retryFromSameSnapshot) return failureFromResult(fail("CONFIG_REVISION_NOT_ACTIVE", "new Runtime evidence must reference the single ACTIVE config_revision; existing runs retain their original snapshot", runInput, input.context ?? {}, "$.config_revision"))
  if (run.fact.attempt > 1) {
    const parent = parentRun
    if (!parent) return failureFromResult(fail("PARENT_RUN_NOT_FOUND", "retry parent_run_id must reference a persisted run", runInput, input.context ?? {}, "$.parent_run_id"))
    if (parent.workflow_id !== run.fact.workflow_id) return failureFromResult(fail("PARENT_WORKFLOW_MISMATCH", "retry parent belongs to a different workflow", runInput, input.context ?? {}, "$.parent_run_id"))
    if (parent.config_revision !== run.fact.config_revision) return failureFromResult(fail("PARENT_CONFIG_REVISION_MISMATCH", "retry parent belongs to a different config_revision", runInput, input.context ?? {}, "$.parent_run_id"))
    if (parent.attempt >= run.fact.attempt) return failureFromResult(fail("ATTEMPT_NONCONTIGUOUS", "retry attempt must be greater than its parent attempt", runInput, input.context ?? {}, "$.attempt"))
  }
  const rawWaves = Array.isArray(input.waves) ? input.waves : []
  const rawNodes = Array.isArray(input.nodes) ? input.nodes : []
  const rawLocks = Array.isArray(input.lock_events) ? input.lock_events : []
  const rawEvents = Array.isArray(input.execution_events) ? input.execution_events : []
  if (rawWaves.length === 0 || rawNodes.length === 0) return failureFromResult(fail("EVIDENCE_INCOMPLETE", "a complete Runtime evidence batch requires at least one wave and one node", runInput, input.context ?? {}))
  if (run.fact.evidence_write_status === "COMPLETE" && rawEvents.length === 0) return failureFromResult(fail("EVIDENCE_INCOMPLETE", "a COMPLETE run must include execution events", runInput, input.context ?? {}))
  const facts: AnyRecord[] = []
  if (input.config_snapshot) facts.push(input.config_snapshot)
  facts.push(run.fact)
  const waveFacts: AnyRecord[] = []
  const priorWaveIndexes = Array.isArray(input.context?.prior_wave_indexes)
    ? [...input.context.prior_wave_indexes]
    : (store.db.prepare("SELECT wave_index FROM workflow_waves WHERE run_id = ? ORDER BY wave_index").all(run.fact.run_id) as any[]).map((row) => Number(row.wave_index))
  for (let index = 0; index < rawWaves.length; index += 1) {
    const raw = rawWaves[index]
    const waveNodes = rawNodes.filter((node: AnyRecord) => node.run_id === raw.run_id && node.wave_id === raw.wave_id)
    if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) return failureFromResult(fail("EVIDENCE_INCOMPLETE", "wave.nodes must be the complete Runtime node set", raw, input.context ?? {}, "$.nodes"))
    const declared = new Set(raw.nodes.map((node: AnyRecord) => `${node.node_id}\u0000${node.task_id}\u0000${node.attempt}`))
    const actual = new Set(waveNodes.map((node: AnyRecord) => `${node.node_id}\u0000${node.task_id}\u0000${node.attempt}`))
    if (declared.size !== actual.size || [...declared].some((key) => !actual.has(key))) return failureFromResult(fail("WAVE_NODE_SET_MISMATCH", "wave.nodes must exactly match the Runtime node facts in the batch", raw, input.context ?? {}, "$.nodes"))
    const waveKey = raw.idempotency_key || stableKey(sourceOf(raw, input.context ?? {}) ?? run.fact.source, "workflow_wave", [raw.run_id, raw.wave_id])
    const replay = Boolean(store.getEvidenceByIdempotencyKey(waveKey))
    const adapted = adaptWorkflowWave(raw, { ...(input.context ?? {}), run_id: run.fact.run_id, config_revision: run.fact.config_revision, prior_wave_indexes: [...priorWaveIndexes, ...waveFacts.map((wave) => wave.wave_index)], node_count: waveNodes.length, nodes: waveNodes, replay })
    if (!adapted.ok) return failureFromResult(adapted)
    waveFacts.push(adapted.fact)
  }
  facts.push(...waveFacts)
  const persistedNodeSeq = Number((store.db.prepare("SELECT MAX(event_seq) AS sequence FROM workflow_wave_nodes WHERE run_id = ?").get(run.fact.run_id) as any)?.sequence ?? 0)
  let priorNodeSeq: number | undefined = input.context?.prior_node_event_seq ?? (persistedNodeSeq || undefined)
  const nodeFacts: AnyRecord[] = []
  const attempts: Record<string, number> = { ...(input.context?.prior_attempts ?? {}), ...Object.fromEntries((store.db.prepare("SELECT node_id, MAX(attempt) AS attempt FROM workflow_wave_nodes WHERE run_id = ? GROUP BY node_id").all(run.fact.run_id) as any[]).map((row) => [row.node_id, Number(row.attempt)])) }
  const sessions: Record<string, string> = { ...(input.context?.session_ids ?? {}), ...Object.fromEntries((store.db.prepare("SELECT node_id, session_id FROM workflow_wave_nodes WHERE run_id = ? ORDER BY attempt ASC").all(run.fact.run_id) as any[]).map((row) => [row.node_id, row.session_id])) }
  for (const raw of rawNodes) {
    const priorAttempt = attempts[raw.node_id]
    const nodeKey = raw.idempotency_key || stableKey(sourceOf(raw, input.context ?? {}) ?? run.fact.source, "workflow_wave_node", [raw.run_id, raw.wave_id, raw.node_id, raw.attempt])
    const replay = Boolean(store.getEvidenceByIdempotencyKey(nodeKey))
    const admission = admitRoute(store, raw.route, run.fact.config_revision)
    if (!admission.ok) return failureFromResult(fail(admission.code, admission.detail, raw, input.context ?? {}, "$.route"))
    if (raw.route === "code_read" && admission.value?.route?.role !== "Project Reader") return failureFromResult(fail("ROUTE_ROLE_MISMATCH", "code_read evidence requires the formal Project Reader route role", raw, input.context ?? {}, "$.route"))
    const rawActual = raw.model_runtime_id
    const rawAdmitted = admittedCatalogRef(store, raw.route, run.fact.config_revision)
    const actual = normalizeRuntimeId(rawActual)
    const admitted = normalizeRuntimeId(rawAdmitted)
    if (!actual) return failureFromResult(fail("MODEL_RUNTIME_ID_MISMATCH", "Worker node model_runtime_id is missing or unparseable; refusing to write L3 evidence", raw, input.context ?? {}, "$.model_runtime_id"))
    if (!admitted || actual !== admitted) return failureFromResult(fail("MODEL_RUNTIME_ID_MISMATCH", `Worker model_runtime_id '${rawActual}' does not match admitted catalog exact_model_ref '${rawAdmitted ?? "missing"}'`, raw, input.context ?? {}, "$.model_runtime_id"))
    const adapted = adaptWorkflowWaveNode(raw, { ...(input.context ?? {}), run_id: run.fact.run_id, wave_id: raw.wave_id, config_revision: run.fact.config_revision, prior_attempt: priorAttempt, prior_event_seq: priorNodeSeq, session_ids: sessions, replay })
    if (!adapted.ok) return failureFromResult(adapted)
    nodeFacts.push(adapted.fact)
    attempts[adapted.fact.node_id] = adapted.fact.attempt
    sessions[adapted.fact.node_id] = adapted.fact.session_id
    priorNodeSeq = adapted.fact.event_seq
  }
  facts.push(...nodeFacts)
  const lockFacts: AnyRecord[] = []
  const lockSequences: Record<string, number> = { ...(input.context?.lock_sequences ?? {}), ...Object.fromEntries((store.db.prepare("SELECT lock_key, MAX(sequence) AS sequence FROM workflow_lock_events WHERE run_id = ? GROUP BY lock_key").all(run.fact.run_id) as any[]).map((row) => [row.lock_key, Number(row.sequence)])) }
  for (const raw of rawLocks) {
    const node = nodeFacts.find((candidate) => candidate.run_id === raw.run_id && candidate.wave_id === raw.wave_id && candidate.node_id === raw.node_id)
    if (!node) return failureFromResult(fail("LOCK_NODE_MISMATCH", "lock event must reference an adapted node fact", raw, input.context ?? {}, "$.node_id"))
    const lockKey = raw.idempotency_key || stableKey(sourceOf(raw, input.context ?? {}) ?? run.fact.source, "workflow_lock_event", [raw.event_id])
    const replay = Boolean(store.getEvidenceByIdempotencyKey(lockKey))
    const adapted = adaptWorkflowLockEvent(raw, { ...(input.context ?? {}), run_id: run.fact.run_id, wave_id: raw.wave_id, node_id: raw.node_id, config_revision: run.fact.config_revision, lock_sequences: lockSequences, replay })
    if (!adapted.ok) return failureFromResult(adapted)
    lockFacts.push(adapted.fact)
    lockSequences[adapted.fact.lock_key] = adapted.fact.sequence
  }
  facts.push(...lockFacts)
  const eventFacts: AnyRecord[] = []
  const persistedEventSeq = Number((store.db.prepare("SELECT MAX(sequence) AS sequence FROM execution_events WHERE run_id = ?").get(run.fact.run_id) as any)?.sequence ?? 0)
  let priorEventSeq: number | undefined = input.context?.prior_execution_sequence ?? (persistedEventSeq || undefined)
  for (const raw of rawEvents) {
    const node = nodeFacts.find((candidate) => candidate.run_id === raw.run_id && candidate.wave_id === raw.wave_id && candidate.node_id === raw.node_id && candidate.task_id === raw.task_id && candidate.attempt === raw.attempt)
    if (!node) return failureFromResult(fail("EXECUTION_NODE_MISMATCH", "execution event must reference an adapted node fact", raw, input.context ?? {}, "$.node_id"))
    const eventKey = raw.idempotency_key || stableKey(sourceOf(raw, input.context ?? {}) ?? run.fact.source, "execution_event", [raw.event_id])
    const replay = Boolean(store.getEvidenceByIdempotencyKey(eventKey))
    const adapted = adaptExecutionEvent(raw, { ...(input.context ?? {}), run_id: run.fact.run_id, workflow_id: run.fact.workflow_id, config_revision: run.fact.config_revision, prior_sequence: priorEventSeq, replay })
    if (!adapted.ok) return failureFromResult(adapted)
    eventFacts.push(adapted.fact)
    priorEventSeq = adapted.fact.sequence
  }
  facts.push(...eventFacts)
  const results = store.appendEvidenceBatch(facts)
  const failed = results.find((result: any) => !result.ok)
  if (failed) {
    const failure = failureFromResult(fail(failed.code, failed.detail, { ...runInput, ...input.context }, input.context ?? {}, undefined, {
      workflow_id: run.fact.workflow_id, run_id: run.fact.run_id, config_revision: run.fact.config_revision, source: run.fact.source,
    }), true)
    const anchorWave = rawWaves[0]
    const anchorNode = rawNodes.find((node: AnyRecord) => node.run_id === anchorWave?.run_id && node.wave_id === anchorWave?.wave_id)
    if (anchorWave && anchorNode) {
      const anchor = { ...failure, observed_at: valueOf(runInput, input.context ?? {}, "observed_at", "started_at"), wave_id: anchorWave.wave_id, node_id: anchorNode.node_id, idempotency_key: failure.idempotency_key || stableKey(run.fact.source, "evidence_write_failed", [run.fact.run_id, anchorWave.wave_id, anchorNode.node_id, failed.code]) }
      if (store.getWorkflowRun(run.fact.run_id) && store.db.prepare("SELECT 1 FROM workflow_waves WHERE run_id = ? AND wave_id = ?").get(run.fact.run_id, anchorWave.wave_id) && store.db.prepare("SELECT 1 FROM workflow_wave_nodes WHERE run_id = ? AND wave_id = ? AND node_id = ?").get(run.fact.run_id, anchorWave.wave_id, anchorNode.node_id)) {
        failure.failure_event = recordEvidenceWriteFailure(store, anchor)
      }
    }
    return failure
  }
  return {
    ok: true,
    status: results.some((result: any) => result.status === "INSERTED") ? "INSERTED" : "IDEMPOTENT",
    fact: run.fact,
    facts,
    rolled_back: false,
    evidence_store: { control_plane_db: store.dbPath },
  }
}

export function recordEvidenceWriteFailure(store: ControlPlaneStore, failure: AnyRecord): AdapterSuccess | AdapterFailure {
  const requiredFields = ["workflow_id", "run_id", "wave_id", "node_id", "config_revision", "idempotency_key", "source", "observed_at"]
  for (const field of requiredFields) if (failure?.[field] === undefined || failure?.[field] === null || failure?.[field] === "") return failureFromResult(fail("EVIDENCE_WRITE_FAILED", `${field} is required to persist EVIDENCE_WRITE_FAILED`, failure, {}, `$.${field}`))
  const run = store.getWorkflowRun(failure.run_id)
  const wave = store.db.prepare("SELECT 1 FROM workflow_waves WHERE run_id = ? AND wave_id = ?").get(failure.run_id, failure.wave_id)
  const node = store.db.prepare("SELECT * FROM workflow_wave_nodes WHERE run_id = ? AND wave_id = ? AND node_id = ? ORDER BY attempt DESC LIMIT 1").get(failure.run_id, failure.wave_id, failure.node_id) as any
  if (!run || !wave || !node) return failureFromResult(fail("EVIDENCE_WRITE_FAILED", "valid run/wave/node evidence is required before recording a failure event", failure), false)
  const nextSequence = Number((store.db.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM execution_events WHERE run_id = ?").get(failure.run_id) as any)?.sequence ?? 0) + 1
  const payload = { cause_code: failure.cause_code ?? failure.code, cause_detail: failure.cause_detail ?? failure.detail, source: failure.source, idempotency_key: failure.idempotency_key }
  const event: AnyRecord = {
    source: failure.source,
    observed_at: failure.observed_at,
    config_revision: failure.config_revision,
    fact_type: "execution_event",
    evidence_level: EVIDENCE_LEVEL,
    schema_version: SCHEMA_VERSION,
    event_id: `${failure.idempotency_key}:evidence-write-failed`,
    run_id: failure.run_id,
    workflow_id: failure.workflow_id,
    wave_id: failure.wave_id,
    node_id: failure.node_id,
    task_id: node.task_id,
    attempt: node.attempt,
    event_type: "EVIDENCE_WRITE_FAILED",
    status: "EVIDENCE_BLOCKED",
    sequence: nextSequence,
    payload_digest: sha256Canonical(payload),
    payload_ref: `adapter-error:${failure.idempotency_key}`,
    occurred_at: failure.observed_at,
    error_code: failure.cause_code ?? failure.code,
    idempotency_key: `${failure.idempotency_key}:evidence-write-failed`,
    payload,
  }
  const eventKey = event.idempotency_key
  const existing = store.getEvidenceByIdempotencyKey(eventKey)
  if (existing) {
    event.sequence = existing.row.sequence
  }
  const { payload_sha256: _ignored, ...body } = event
  event.payload_sha256 = sha256Canonical(body)
  const result = store.appendExecutionEvent(event)
  if (!result.ok) return failureFromResult(fail(result.code, result.detail, failure), false)
  return { ok: true, status: result.status, fact: event, rolled_back: false }
}

export const appendRuntimeEvidence = appendRuntimeEvidenceBatch

function normalizeRuntimeId(value: any): string | null {
  if (typeof value !== "string" || !value.trim()) return null
  const ref = value.trim()
  const match = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)(?:#([A-Za-z0-9._-]+))?$/.exec(ref)
  if (!match) return null
  return `${match[1]}/${match[2]}${match[3] && match[3] !== "default" ? `#${match[3]}` : ""}`
}

function admittedCatalogRef(store: ControlPlaneStore, route: string, configRevision: string): string | null {
  const row = store.db.prepare("SELECT exact_model_ref FROM route_bindings WHERE route_binding_id = ? AND config_revision = ? AND binding_state = 'BOUND' ORDER BY updated_at DESC, rowid DESC LIMIT 1").get(route, configRevision) as any
  if (!row?.exact_model_ref) return null
  const catalog = store.db.prepare("SELECT exact_model_ref FROM model_catalog WHERE exact_model_ref = ? AND config_revision = ? AND availability_state = 'AVAILABLE' ORDER BY updated_at DESC, rowid DESC LIMIT 1").get(row.exact_model_ref, configRevision) as any
  return catalog?.exact_model_ref ?? null
}
