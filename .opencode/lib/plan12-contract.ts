import crypto from "node:crypto"

export const PLAN12_SCHEMA_VERSION = 1

const HASH_RE = /^[a-f0-9]{64}$/
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/
const UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const RUNTIME_ID_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:#[A-Za-z0-9._-]+)?$/

export const EVIDENCE_LEVELS = new Set(["L0", "L1", "L2", "L3", "L4"])
export const CONFIG_STATES = new Set(["DRAFT", "VALIDATED", "STAGED", "APPLIED", "ACTIVE", "SUPERSEDED", "REJECTED", "ROLLED_BACK"])
export const EVIDENCE_WRITE_STATES = new Set(["COMPLETE", "INCOMPLETE", "FAILED"])
export const LOCK_EVENT_TYPES = new Set(["ACQUIRE", "WAIT", "RELEASE", "CONFLICT", "EXPIRE"])
export const EXECUTION_EVENT_TYPES = new Set([
  "RUN_STARTED",
  "WAVE_STARTED",
  "NODE_STARTED",
  "NODE_FINISHED",
  "WAVE_FINISHED",
  "RUN_FINISHED",
  "EVIDENCE_WRITE_FAILED",
])
export const ROUTE_STATES = new Set(["BOUND", "MODEL_UNASSIGNED", "UNAVAILABLE", "REJECTED"])
export const MODEL_SOURCES = new Set(["runtime_catalog", "verified_config", "unavailable_probe"])
export const MODEL_AVAILABILITY = new Set(["VERIFIED", "UNKNOWN", "UNAVAILABLE", "EXPIRED"])

// These are the exact IDs currently present in framework-config/runtime-model-map.yaml
// or the architecture-defined provider/model fields. Presence in this set is only an
// identity check; it never claims that the provider is reachable or available.
export const KNOWN_RUNTIME_IDS = new Set([
  "deepseek/deepseek-flash",
  "openai/gpt-5.6-sol#high",
  "openai/gpt-5.6-sol-fast#high",
  "openai/gpt-6-sol-fast#xhigh",
  "bailian-token-plan/qwen3.8-max",
])

export class Plan12ContractError extends Error {
  code: string
  detail: string
  path: string

  constructor(code: string, detail: string, path = "$") {
    super(detail)
    this.name = "Plan12ContractError"
    this.code = code
    this.detail = detail
    this.path = path
  }
}

type ValidationSuccess<T> = { ok: true; value: T }
type ValidationFailure = { ok: false; code: string; detail: string; path: string }
export type ValidationResult<T = any> = ValidationSuccess<T> | ValidationFailure

export type Plan12ValidationContext = {
  idempotency?: Map<string, string>
  runIds?: Map<string, string>
  runAttempts?: Map<string, number>
  workflowRevisions?: Map<string, string>
  waveIndexes?: Map<string, Map<number, string>>
  lockSequences?: Map<string, number>
  executionSequences?: Map<string, number>
  nodeEventSequences?: Map<string, number>
  snapshots?: Map<string, any>
  activeRevision?: string | null
  knownRuntimeIds?: Set<string>
}

function failure(code: string, detail: string, path: string): ValidationFailure {
  return { ok: false, code, detail, path }
}

function success<T>(value: T): ValidationSuccess<T> {
  return { ok: true, value }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Recursively sort object keys while preserving array order as semantic order. */
export function canonicalizePlan12Json(value: unknown, path = "$"): any {
  if (value === undefined) throw new Plan12ContractError("INVALID_JSON_VALUE", "undefined is not permitted", path)
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Plan12ContractError("INVALID_JSON_VALUE", "NaN and Infinity are not permitted", path)
  }
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw new Plan12ContractError("INVALID_JSON_VALUE", `${typeof value} is not JSON data`, path)
  }
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value
  if (Array.isArray(value)) return value.map((entry, index) => canonicalizePlan12Json(entry, `${path}[${index}]`))
  if (!isPlainObject(value)) throw new Plan12ContractError("INVALID_JSON_VALUE", "only JSON objects are permitted", path)
  const codePointCompare = (left: string, right: string): number => {
    const a = Array.from(left, (char) => char.codePointAt(0) as number)
    const b = Array.from(right, (char) => char.codePointAt(0) as number)
    for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
      if (a[index] !== b[index]) return a[index] - b[index]
    }
    return a.length - b.length
  }
  return Object.fromEntries(
    Object.keys(value).sort(codePointCompare).map((key) => [key, canonicalizePlan12Json(value[key], `${path}.${key}`)]),
  )
}

function canonicalString(value: unknown): string {
  return JSON.stringify(canonicalizePlan12Json(value))
}

export function sha256Canonical(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalString(value), "utf8").digest("hex")
}

function contextOf(context?: Plan12ValidationContext): Required<Plan12ValidationContext> {
  const value = context ?? {}
  value.idempotency ??= new Map()
  value.runIds ??= new Map()
  value.runAttempts ??= new Map()
  value.workflowRevisions ??= new Map()
  value.waveIndexes ??= new Map()
  value.lockSequences ??= new Map()
  value.executionSequences ??= new Map()
  value.nodeEventSequences ??= new Map()
  value.snapshots ??= new Map()
  value.activeRevision ??= null
  value.knownRuntimeIds ??= KNOWN_RUNTIME_IDS
  return value as Required<Plan12ValidationContext>
}

function required(value: any, fields: string[], path = "$"): ValidationFailure | null {
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(value, field) || value[field] === null || value[field] === "") {
      return failure("FIELD_REQUIRED", `${field} is required`, `${path}.${field}`)
    }
  }
  return null
}

function presentField(value: any, field: string, path = "$"): ValidationFailure | null {
  if (!Object.prototype.hasOwnProperty.call(value, field)) return failure("FIELD_REQUIRED", `${field} is required`, `${path}.${field}`)
  return null
}

function stringField(value: any, field: string, path = "$"): ValidationFailure | null {
  if (typeof value[field] !== "string" || !value[field].trim() || !ID_RE.test(value[field])) {
    return failure("FIELD_INVALID", `${field} must be a non-empty identifier string`, `${path}.${field}`)
  }
  return null
}

function hashField(value: any, field: string, path = "$"): ValidationFailure | null {
  if (typeof value[field] !== "string" || !HASH_RE.test(value[field])) {
    return failure("HASH_INVALID", `${field} must be a lowercase SHA-256 hex string`, `${path}.${field}`)
  }
  return null
}

function timeField(value: any, field: string, path = "$"): ValidationFailure | null {
  const raw = value[field]
  if (typeof raw !== "string" || !UTC_RE.test(raw) || !Number.isFinite(Date.parse(raw))) {
    return failure("TIME_INVALID", `${field} must be a UTC ISO-8601 timestamp ending in Z`, `${path}.${field}`)
  }
  // Date.parse normalizes impossible dates (for example February 31). Compare
  // against a normalized ISO representation so those values fail closed.
  const normalized = raw.replace(/\.(\d{1,2})Z$/, (_match: string, fraction: string) => `.${fraction.padEnd(3, "0")}Z`).replace(/T(\d{2}:\d{2}:\d{2})Z$/, "T$1.000Z")
  let parsed: string
  try { parsed = new Date(raw).toISOString() } catch { parsed = "" }
  if (parsed !== normalized) return failure("TIME_INVALID", `${field} must be a real UTC ISO-8601 timestamp`, `${path}.${field}`)
  return null
}

function integerField(value: any, field: string, minimum: number, path = "$"): ValidationFailure | null {
  if (!Number.isInteger(value[field]) || value[field] < minimum) {
    return failure("SEQUENCE_INVALID", `${field} must be an integer >= ${minimum}`, `${path}.${field}`)
  }
  return null
}

function enumField(value: any, field: string, allowed: Set<string>, path = "$"): ValidationFailure | null {
  if (typeof value[field] !== "string" || !allowed.has(value[field])) {
    return failure("ENUM_INVALID", `${field} is not an allowed Plan 12 value`, `${path}.${field}`)
  }
  return null
}

function validateMonotonicSequence(
  sequence: number,
  key: string,
  index: Map<string, number>,
  replay: boolean,
  path = "$.sequence",
): ValidationFailure | null {
  if (!replay) {
    const previous = index.get(key)
    if (previous !== undefined && sequence !== previous + 1) return failure("SEQUENCE_NOT_CONTIGUOUS", "sequence must advance by exactly one within its evidence stream", path)
    index.set(key, sequence)
  }
  return null
}

function payloadWithoutDigest(value: Record<string, unknown>): Record<string, unknown> {
  const { payload_sha256: _payloadSha256, ...withoutDigest } = value
  return withoutDigest
}

function registerIdempotency(value: any, context: Required<Plan12ValidationContext>): ValidationFailure | null {
  const prior = context.idempotency.get(value.idempotency_key)
  if (prior && prior !== value.payload_sha256) {
    return failure("EVIDENCE_IDEMPOTENCY_CONFLICT", "idempotency key was used with a different digest", "$.idempotency_key")
  }
  context.idempotency.set(value.idempotency_key, value.payload_sha256)
  return null
}

export function validatePlan12Envelope(value: unknown, context?: Plan12ValidationContext): ValidationResult {
  if (!isPlainObject(value)) return failure("TYPE_INVALID", "evidence envelope must be an object", "$")
  const envelope = value as any
  const missing = required(envelope, ["schema_version", "config_revision", "source", "observed_at", "payload_sha256", "idempotency_key", "evidence_level"])
  if (missing) return { ok: false, code: "ENVELOPE_FIELD_REQUIRED", detail: missing.detail, path: missing.path }
  if (envelope.schema_version !== PLAN12_SCHEMA_VERSION) return failure("SCHEMA_VERSION_UNSUPPORTED", "schema_version must be 1", "$.schema_version")
  if (typeof envelope.config_revision !== "string" || !envelope.config_revision.trim()) return failure("CONFIG_REVISION_REQUIRED", "config_revision cannot be empty", "$.config_revision")
  if (!ID_RE.test(envelope.config_revision)) return failure("CONFIG_REVISION_INVALID", "config_revision must be an identifier", "$.config_revision")
  if (typeof envelope.source !== "string" || !envelope.source.trim()) return failure("SOURCE_REQUIRED", "source cannot be empty", "$.source")
  const time = timeField(envelope, "observed_at")
  if (time) return time
  const level = enumField(envelope, "evidence_level", EVIDENCE_LEVELS)
  if (level) return level
  const id = stringField(envelope, "idempotency_key")
  if (id) return id
  const hash = hashField(envelope, "payload_sha256")
  if (hash) return hash
  let normalized: any
  try { normalized = canonicalizePlan12Json(envelope) } catch (error: any) {
    return failure(error?.code ?? "INVALID_JSON_VALUE", error?.detail ?? String(error), error?.path ?? "$")
  }
  const expected = sha256Canonical(payloadWithoutDigest(normalized))
  if (expected !== normalized.payload_sha256) return failure("PAYLOAD_HASH_MISMATCH", "payload_sha256 does not match canonical payload", "$.payload_sha256")
  const ctx = contextOf(context)
  const conflict = registerIdempotency(normalized, ctx)
  if (conflict) return conflict
  return success(normalized)
}

function factEnvelope(value: unknown, factType: string, context?: Plan12ValidationContext): ValidationResult {
  // Validate against a copy of the idempotency index. A malformed fact must
  // not reserve its key and prevent a later corrected fact from being accepted.
  const ctx = contextOf(context)
  const stagedContext: Plan12ValidationContext = { ...ctx, idempotency: new Map(ctx.idempotency) }
  const result = validatePlan12Envelope(value, stagedContext)
  if (!result.ok) return result
  if (result.value.evidence_level !== "L3") return failure("EVIDENCE_LEVEL_INVALID", `${factType} must be L3`, "$.evidence_level")
  if (result.value.fact_type !== factType) return failure("FACT_TYPE_INVALID", `fact_type must be ${factType}`, "$.fact_type")
  return { ok: true, value: result.value, stagedContext, targetContext: ctx } as any
}

function commitFact(envelope: any): ValidationResult {
  const target = envelope.targetContext as Required<Plan12ValidationContext>
  const staged = envelope.stagedContext as Required<Plan12ValidationContext>
  target.idempotency.clear()
  for (const [key, digest] of staged.idempotency) target.idempotency.set(key, digest)
  return success(envelope.value)
}

function runStatus(value: any, field = "status"): ValidationFailure | null {
  return enumField(value, field, new Set(["PENDING", "READY", "RUNNING", "COMPLETED", "SUCCEEDED", "PASS", "FAILED", "BLOCKED", "INCOMPLETE", "EVIDENCE_BLOCKED", "EVIDENCE_INCOMPLETE", "CANCELLED"]))
}

function validateRunRelations(run: any, context: Required<Plan12ValidationContext>): ValidationFailure | null {
  if (context.snapshots.size > 0 && !context.snapshots.has(run.config_revision)) {
    return failure("CONFIG_REVISION_NOT_FOUND", "workflow run references an unknown config_revision", "$.config_revision")
  }
  if (run.attempt > 1 && !run.parent_run_id) return failure("PARENT_RUN_REQUIRED", "retry/rework runs require a distinct parent_run_id", "$.parent_run_id")
  if (run.parent_run_id && run.parent_run_id === run.run_id) return failure("RUN_ID_REUSE", "retry cannot reuse the parent run_id", "$.run_id")
  if (run.attempt > 1) {
    if (!context.runIds.has(run.parent_run_id)) return failure("PARENT_RUN_NOT_FOUND", "retry parent_run_id must reference an accepted run", "$.parent_run_id")
    const parentAttempt = context.runAttempts.get(run.parent_run_id)
    if (parentAttempt !== undefined && run.attempt !== parentAttempt + 1) return failure("ATTEMPT_INVALID", "retry attempt must increment its parent attempt by one", "$.attempt")
  }
  const priorRunDigest = context.runIds.get(run.run_id)
  if (priorRunDigest && priorRunDigest !== run.payload_sha256) return failure("RUN_ID_REUSE", "run_id is already bound to a different fact", "$.run_id")
  const priorRevision = context.workflowRevisions.get(run.workflow_id)
  if (priorRevision && priorRevision !== run.config_revision) return failure("WORKFLOW_REVISION_MIXED", "a workflow cannot mix config revisions", "$.config_revision")
  context.runIds.set(run.run_id, run.payload_sha256)
  context.runAttempts.set(run.run_id, run.attempt)
  context.workflowRevisions.set(run.workflow_id, run.config_revision)
  return null
}

export function validateWorkflowRunFact(value: unknown, context?: Plan12ValidationContext): ValidationResult {
  const envelope = factEnvelope(value, "workflow_run", context)
  if (!envelope.ok) return envelope
  const run: any = envelope.value
  const ctx = contextOf(context)
  const missing = required(run, ["run_id", "workflow_id", "plan_digest", "attempt", "trigger", "project_id", "status", "evidence_write_status", "engine_version"])
  if (missing) return missing
  for (const field of ["parent_run_id", "started_at", "ended_at", "outcome_digest", "error_code", "error_detail"]) { const result = presentField(run, field); if (result) return result }
  for (const field of ["run_id", "workflow_id", "project_id", "trigger", "engine_version"]) { const result = stringField(run, field); if (result) return result }
  if (run.parent_run_id !== null) { const parent = stringField(run, "parent_run_id"); if (parent) return parent }
  for (const field of ["plan_digest"]) { const result = hashField(run, field); if (result) return result }
  const attempt = integerField(run, "attempt", 1); if (attempt) return attempt
  const status = runStatus(run); if (status) return status
  const evidence = enumField(run, "evidence_write_status", EVIDENCE_WRITE_STATES); if (evidence) return evidence
  const started = timeField(run, "started_at"); if (started) return started
  if (run.ended_at !== null) { const ended = timeField(run, "ended_at"); if (ended) return ended }
  if (run.outcome_digest !== null) { const outcome = hashField(run, "outcome_digest"); if (outcome) return outcome }
  if (run.error_code !== null) { const errorCode = stringField(run, "error_code"); if (errorCode) return errorCode }
  if (run.error_detail !== null && typeof run.error_detail !== "string") return failure("FIELD_INVALID", "error_detail must be a string or null", "$.error_detail")
  const relation = validateRunRelations(run, ctx); if (relation) return relation
  return commitFact(envelope)
}

function validateRunReference(value: any, context: Required<Plan12ValidationContext>): ValidationFailure | null {
  if (context.snapshots.size > 0 && !context.snapshots.has(value.config_revision)) {
    return failure("CONFIG_REVISION_NOT_FOUND", "fact references an unknown config_revision", "$.config_revision")
  }
  const revision = context.workflowRevisions.get(value.workflow_id)
  if (revision && revision !== value.config_revision) return failure("WORKFLOW_REVISION_MIXED", "fact config_revision differs from its workflow run", "$.config_revision")
  return null
}

export function validateWorkflowWaveFact(value: unknown, context?: Plan12ValidationContext): ValidationResult {
  const envelope = factEnvelope(value, "workflow_wave", context); if (!envelope.ok) return envelope
  const wave: any = envelope.value; const ctx = contextOf(context)
  const missing = required(wave, ["run_id", "wave_id", "wave_index", "ready_set_digest", "policy_digest", "parallelism", "status", "started_at", "evidence_digest"]); if (missing) return missing
  for (const field of ["ended_at", "lock_snapshot_json"]) { const result = presentField(wave, field); if (result) return result }
  for (const field of ["run_id", "wave_id"]) { const result = stringField(wave, field); if (result) return result }
  const ref = validateRunReference(wave, ctx); if (ref) return ref
  const index = integerField(wave, "wave_index", 0); if (index) return index
  for (const field of ["ready_set_digest", "policy_digest", "evidence_digest"]) { const result = hashField(wave, field); if (result) return result }
  const parallel = integerField(wave, "parallelism", 1); if (parallel) return parallel
  const status = runStatus(wave); if (status) return status
  const started = timeField(wave, "started_at"); if (started) return started
  if (wave.ended_at !== null) { const ended = timeField(wave, "ended_at"); if (ended) return ended }
  if (wave.lock_snapshot_json !== null && typeof wave.lock_snapshot_json !== "string") return failure("FIELD_INVALID", "lock_snapshot_json must be a string or null", "$.lock_snapshot_json")
  const indexes = ctx.waveIndexes.get(wave.run_id) ?? new Map<number, string>(); ctx.waveIndexes.set(wave.run_id, indexes)
  const prior = indexes.get(wave.wave_index)
  if (prior && prior !== wave.payload_sha256) return failure("WAVE_INDEX_DUPLICATE", "wave_index is already used in this run", "$.wave_index")
  indexes.set(wave.wave_index, wave.payload_sha256)
  return commitFact(envelope)
}

export function validateWorkflowWaveNodeFact(value: unknown, context?: Plan12ValidationContext): ValidationResult {
  const envelope = factEnvelope(value, "workflow_wave_node", context); if (!envelope.ok) return envelope
  const node: any = envelope.value; const ctx = contextOf(context)
  const missing = required(node, ["run_id", "wave_id", "node_id", "attempt", "task_id", "route", "resource_digest", "lock_key_json", "status", "event_seq", "session_id"]); if (missing) return missing
  for (const field of ["ended_at", "result_digest", "error_code"]) { const result = presentField(node, field); if (result) return result }
  for (const field of ["run_id", "wave_id", "node_id", "task_id", "route", "session_id"]) { const result = stringField(node, field); if (result) return result }
  const ref = validateRunReference(node, ctx); if (ref) return ref
  const attempt = integerField(node, "attempt", 1); if (attempt) return attempt
  const sequence = integerField(node, "event_seq", 1); if (sequence) return sequence
  const digest = hashField(node, "resource_digest"); if (digest) return digest
  const status = runStatus(node); if (status) return status
  const started = timeField(node, "started_at"); if (started) return started
  if (node.ended_at !== null) { const ended = timeField(node, "ended_at"); if (ended) return ended }
  if (node.result_digest !== null) { const resultDigest = hashField(node, "result_digest"); if (resultDigest) return resultDigest }
  if (node.error_code !== null) { const errorCode = stringField(node, "error_code"); if (errorCode) return errorCode }
  const replay = ctx.idempotency.get(node.idempotency_key) === node.payload_sha256
  const sequenceOrder = validateMonotonicSequence(node.event_seq, node.run_id, ctx.nodeEventSequences, replay, "$.event_seq"); if (sequenceOrder) return sequenceOrder
  return commitFact(envelope)
}

export function validateWorkflowLockEvent(value: unknown, context?: Plan12ValidationContext): ValidationResult {
  const envelope = factEnvelope(value, "workflow_lock_event", context); if (!envelope.ok) return envelope
  const event: any = envelope.value; const ctx = contextOf(context)
  const missing = required(event, ["event_id", "run_id", "wave_id", "node_id", "lock_key", "event_type", "owner_token", "sequence", "occurred_at", "outcome"]); if (missing) return missing
  const errorPresent = presentField(event, "error_code"); if (errorPresent) return errorPresent
  for (const field of ["event_id", "run_id", "wave_id", "node_id", "lock_key", "owner_token"]) { const result = stringField(event, field); if (result) return result }
  const ref = validateRunReference(event, ctx); if (ref) return ref
  const type = enumField(event, "event_type", LOCK_EVENT_TYPES); if (type) return type
  const sequence = integerField(event, "sequence", 1); if (sequence) return sequence
  const occurred = timeField(event, "occurred_at"); if (occurred) return occurred
  if (typeof event.outcome !== "string" || !event.outcome.trim()) return failure("FIELD_INVALID", "outcome is required", "$.outcome")
  if (event.error_code !== null) { const errorCode = stringField(event, "error_code"); if (errorCode) return errorCode }
  const replay = ctx.idempotency.get(event.idempotency_key) === event.payload_sha256
  const sequenceOrder = validateMonotonicSequence(event.sequence, `${event.run_id}:${event.lock_key}`, ctx.lockSequences, replay); if (sequenceOrder) return sequenceOrder
  return commitFact(envelope)
}

export function validateExecutionEvent(value: unknown, context?: Plan12ValidationContext): ValidationResult {
  const envelope = factEnvelope(value, "execution_event", context); if (!envelope.ok) return envelope
  const event: any = envelope.value; const ctx = contextOf(context)
  const missing = required(event, ["event_id", "run_id", "workflow_id", "wave_id", "node_id", "task_id", "attempt", "event_type", "status", "sequence", "payload_digest", "payload_ref", "occurred_at"]); if (missing) return missing
  const errorPresent = presentField(event, "error_code"); if (errorPresent) return errorPresent
  for (const field of ["event_id", "run_id", "workflow_id", "wave_id", "node_id", "task_id", "payload_ref"]) { const result = stringField(event, field); if (result) return result }
  const ref = validateRunReference(event, ctx); if (ref) return ref
  const attempt = integerField(event, "attempt", 1); if (attempt) return attempt
  const sequence = integerField(event, "sequence", 1); if (sequence) return sequence
  const type = enumField(event, "event_type", EXECUTION_EVENT_TYPES); if (type) return type
  const status = runStatus(event); if (status) return status
  const digest = hashField(event, "payload_digest"); if (digest) return digest
  const occurred = timeField(event, "occurred_at"); if (occurred) return occurred
  if (event.error_code !== null) { const errorCode = stringField(event, "error_code"); if (errorCode) return errorCode }
  const replay = ctx.idempotency.get(event.idempotency_key) === event.payload_sha256
  const sequenceOrder = validateMonotonicSequence(event.sequence, event.run_id, ctx.executionSequences, replay); if (sequenceOrder) return sequenceOrder
  return commitFact(envelope)
}

const CONFIG_TRANSITIONS: Record<string, Set<string>> = {
  DRAFT: new Set(["VALIDATED", "REJECTED"]),
  VALIDATED: new Set(["STAGED", "REJECTED"]),
  STAGED: new Set(["APPLIED", "REJECTED"]),
  APPLIED: new Set(["ACTIVE", "REJECTED"]),
  ACTIVE: new Set(["SUPERSEDED", "ROLLED_BACK"]),
  SUPERSEDED: new Set(["ACTIVE"]),
  REJECTED: new Set(),
  ROLLED_BACK: new Set(),
}

export function validateConfigRevisionTransition(previousState: string | null, nextState: string): ValidationResult<{ previousState: string | null; nextState: string }> {
  if (!CONFIG_STATES.has(nextState)) return failure("CONFIG_STATE_INVALID", "unknown config revision state", "$.state")
  if (previousState === null) return success({ previousState, nextState })
  if (!CONFIG_STATES.has(previousState) || !CONFIG_TRANSITIONS[previousState]?.has(nextState)) return failure("CONFIG_STATE_TRANSITION_INVALID", `cannot transition ${previousState} to ${nextState}`, "$.state")
  return success({ previousState, nextState })
}

export function validateWorkflowConfigSnapshot(value: unknown, context?: Plan12ValidationContext): ValidationResult {
  const envelope = factEnvelope(value, "workflow_config_snapshot", context); if (!envelope.ok) return envelope
  const snapshot: any = envelope.value; const ctx = contextOf(context)
  const missing = required(snapshot, ["config_revision", "source_kind", "drawio_raw_sha256", "drawio_semantic_sha256", "ir_sha256", "config_digest", "model_catalog_digest", "route_bindings_digest", "canonical_json", "state", "created_by", "created_at"]); if (missing) return missing
  for (const field of ["parent_revision", "activated_at", "rollback_of"]) { const result = presentField(snapshot, field); if (result) return result }
  const revision = stringField(snapshot, "config_revision"); if (revision) return revision
  const state = enumField(snapshot, "state", CONFIG_STATES); if (state) return state
  const source = stringField(snapshot, "source_kind"); if (source) return source
  for (const field of ["drawio_raw_sha256", "drawio_semantic_sha256", "ir_sha256", "config_digest", "model_catalog_digest", "route_bindings_digest"]) { const result = hashField(snapshot, field); if (result) return result }
  const created = timeField(snapshot, "created_at"); if (created) return created
  if (snapshot.activated_at !== null) { const activated = timeField(snapshot, "activated_at"); if (activated) return activated }
  if (snapshot.parent_revision !== null) { const parent = stringField(snapshot, "parent_revision"); if (parent) return parent }
  if (snapshot.rollback_of !== null) { const rollback = stringField(snapshot, "rollback_of"); if (rollback) return rollback }
  if (typeof snapshot.canonical_json !== "string") return failure("FIELD_INVALID", "canonical_json must be a JSON string", "$.canonical_json")
  let canonicalConfig: unknown
  try { canonicalConfig = JSON.parse(snapshot.canonical_json) } catch { return failure("CANONICAL_JSON_INVALID", "canonical_json must contain valid JSON", "$.canonical_json") }
  try {
    const canonicalText = JSON.stringify(canonicalizePlan12Json(canonicalConfig))
    if (snapshot.canonical_json !== canonicalText) return failure("CANONICAL_JSON_NONCANONICAL", "canonical_json must use Plan 12 canonical key order and JSON form", "$.canonical_json")
    if (sha256Canonical(canonicalConfig) !== snapshot.config_digest) return failure("CONFIG_DIGEST_MISMATCH", "config_digest must match canonical_json", "$.config_digest")
  } catch (error: any) {
    return failure(error?.code ?? "CANONICAL_JSON_INVALID", error?.detail ?? "canonical_json is not canonical JSON", error?.path ?? "$.canonical_json")
  }
  if (ctx.snapshots.has(snapshot.config_revision)) return failure("CONFIG_REVISION_IMMUTABLE", "config_revision cannot be overwritten", "$.config_revision")
  let parent: any = null
  if (snapshot.parent_revision) {
    parent = ctx.snapshots.get(snapshot.parent_revision)
    if (!parent) return failure("PARENT_REVISION_NOT_FOUND", "parent_revision must reference an existing snapshot", "$.parent_revision")
    const transition = validateConfigRevisionTransition(parent.state, snapshot.state)
    if (!transition.ok) return transition
  } else if (ctx.snapshots.size > 0 || (snapshot.state !== "DRAFT" && !(snapshot.state === "ACTIVE" && !ctx.activeRevision))) {
    return failure("PARENT_REVISION_REQUIRED", "non-genesis revisions require parent_revision", "$.parent_revision")
  }
  const existingActive = ctx.activeRevision ?? [...ctx.snapshots.values()].find((entry: any) => entry?.state === "ACTIVE")?.config_revision ?? null
  if (snapshot.state === "ACTIVE" && existingActive && existingActive !== snapshot.config_revision) return failure("ACTIVE_REVISION_CONFLICT", "only one ACTIVE revision is permitted", "$.state")
  ctx.snapshots.set(snapshot.config_revision, snapshot)
  if (snapshot.state === "ACTIVE") ctx.activeRevision = snapshot.config_revision
  return commitFact(envelope)
}

function validateRuntimeIdentity(value: any, context?: Plan12ValidationContext): ValidationFailure | null {
  const provider = stringField(value, "provider_id"); if (provider) return provider
  const model = stringField(value, "model_id"); if (model) return model
  if (value.variant !== null && value.variant !== undefined && (typeof value.variant !== "string" || !ID_RE.test(value.variant))) return failure("MODEL_VARIANT_INVALID", "variant must be null or an identifier", "$.variant")
  if (typeof value.runtime_id !== "string" || !RUNTIME_ID_RE.test(value.runtime_id)) return failure("RUNTIME_ID_INVALID", "runtime_id must be provider/model[#variant]", "$.runtime_id")
  const expected = `${value.provider_id}/${value.model_id}${value.variant ? `#${value.variant}` : ""}`
  if (value.runtime_id !== expected) return failure("RUNTIME_ID_MISMATCH", "runtime_id must be composed from exact provider/model/variant", "$.runtime_id")
  const known = contextOf(context).knownRuntimeIds
  if (!known.has(value.runtime_id)) return failure("MODEL_ID_UNKNOWN", "provider/model/variant is not an exact known identity", "$.runtime_id")
  return null
}

export function validateModelCatalogEntry(value: unknown, context?: Plan12ValidationContext): ValidationResult {
  if (!isPlainObject(value)) return failure("TYPE_INVALID", "model catalog entry must be an object", "$")
  let model: any
  try { model = canonicalizePlan12Json(value) } catch (error: any) {
    return failure(error?.code ?? "INVALID_JSON_VALUE", error?.detail ?? "invalid model catalog JSON", error?.path ?? "$")
  }
  const missing = required(model, ["model_ref", "provider_id", "model_id", "runtime_id", "source", "availability_status", "capabilities", "verified_at", "config_revision"]); if (missing) return missing
  if (!Object.prototype.hasOwnProperty.call(model, "variant")) return failure("FIELD_REQUIRED", "variant is required and may be null", "$.variant")
  if (!Object.prototype.hasOwnProperty.call(model, "evidence_ref")) return failure("FIELD_REQUIRED", "evidence_ref is required and may be null", "$.evidence_ref")
  for (const field of ["model_ref", "config_revision"]) { const result = stringField(model, field); if (result) return result }
  const identity = validateRuntimeIdentity(model, context); if (identity) return identity
  const source = enumField(model, "source", MODEL_SOURCES); if (source) return source
  const availability = enumField(model, "availability_status", MODEL_AVAILABILITY); if (availability) return availability
  const verified = timeField(model, "verified_at"); if (verified) return verified
  if (!isPlainObject(model.capabilities)) return failure("FIELD_INVALID", "capabilities must be an object", "$.capabilities")
  if (model.capabilities.context_limit !== null && model.capabilities.context_limit !== undefined && (!Number.isInteger(model.capabilities.context_limit) || model.capabilities.context_limit < 1)) return failure("FIELD_INVALID", "context_limit must be a positive integer or null", "$.capabilities.context_limit")
  if (typeof model.capabilities.context_limit === "undefined") return failure("FIELD_REQUIRED", "context_limit is required", "$.capabilities.context_limit")
  if (typeof model.capabilities.input !== "boolean") return failure("FIELD_INVALID", "capabilities.input must be boolean", "$.capabilities.input")
  if (typeof model.capabilities.output !== "boolean") return failure("FIELD_INVALID", "capabilities.output must be boolean", "$.capabilities.output")
  if (model.runtime_id === "bailian-token-plan/qwen3.8-max" && model.source === "verified_config" && model.availability_status === "VERIFIED") return failure("MODEL_AVAILABILITY_UNVERIFIED", "qwen3.8-max config presence cannot prove availability", "$.availability_status")
  if (model.evidence_ref !== null && model.evidence_ref !== undefined) { const evidenceRef = stringField(model, "evidence_ref"); if (evidenceRef) return evidenceRef }
  return success(model)
}

export function validateRouteBinding(value: unknown, context?: Plan12ValidationContext): ValidationResult {
  if (!isPlainObject(value)) return failure("TYPE_INVALID", "route binding must be an object", "$")
  let route: any
  try { route = canonicalizePlan12Json(value) } catch (error: any) {
    return failure(error?.code ?? "INVALID_JSON_VALUE", error?.detail ?? "invalid route binding JSON", error?.path ?? "$")
  }
  const missing = required(route, ["route_id", "role", "status", "config_revision"]); if (missing) return missing
  for (const field of ["route_id", "role", "config_revision"]) { const result = stringField(route, field); if (result) return result }
  if (route.project_id !== null && route.project_id !== undefined) { const project = stringField(route, "project_id"); if (project) return project }
  const status = enumField(route, "status", ROUTE_STATES); if (status) return status
  if (route.project_id === "xxl-job" && route.status !== "MODEL_UNASSIGNED") return failure("PROJECT_MODEL_UNASSIGNED", "xxl-job must remain MODEL_UNASSIGNED", "$.status")
  for (const field of ["model_ref", "provider_id", "model_id", "variant", "runtime_id"]) {
    if (!Object.prototype.hasOwnProperty.call(route, field)) return failure("FIELD_REQUIRED", `${field} is required; use null for MODEL_UNASSIGNED`, `$.${field}`)
  }
  if (!Object.prototype.hasOwnProperty.call(route, "evidence_ref")) return failure("FIELD_REQUIRED", "evidence_ref is required and may be null", "$.evidence_ref")
  if (route.evidence_ref !== null && route.evidence_ref !== undefined) { const evidenceRef = stringField(route, "evidence_ref"); if (evidenceRef) return evidenceRef }
  const modelFields = [route.model_ref, route.provider_id, route.model_id, route.variant, route.runtime_id]
  if (route.status === "MODEL_UNASSIGNED") {
    if (modelFields.some((field) => field !== null && field !== undefined)) return failure("MODEL_UNASSIGNED_BOUND", "MODEL_UNASSIGNED cannot carry a model binding", "$.status")
    if (route.project_id === "xxl-job") return success(route)
  } else if (route.status === "BOUND") {
    if ([route.model_ref, route.provider_id, route.model_id, route.runtime_id].some((field) => field === null || field === undefined || field === "")) return failure("MODEL_BINDING_REQUIRED", "BOUND requires model_ref/provider_id/model_id/runtime_id fields; variant may be null", "$.status")
    if (typeof route.model_ref !== "string") return failure("MODEL_BINDING_REQUIRED", "BOUND requires model_ref", "$.model_ref")
    const identity = validateRuntimeIdentity(route, context); if (identity) return identity
  }
  return success(route)
}
