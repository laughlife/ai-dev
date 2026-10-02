import crypto from "node:crypto"
import {
  canonicalizePlan12Json,
  sha256Canonical,
  validateConfigRevisionTransition,
  validateWorkflowConfigSnapshot,
  validateModelCatalogEntry,
  validateRouteBinding,
} from "./plan12-contract.ts"
import { type ControlPlaneStore } from "./plan12-control-plane.ts"

type AnyRecord = Record<string, any>
export type ConfigResult =
  | { ok: true; status: "INSERTED" | "APPLIED" | "IDEMPOTENT"; value?: any; inserted?: boolean }
  | { ok: false; status: "REJECTED"; code: string; detail: string; path?: string }

const CONFIG_STATES = new Set(["DRAFT", "VALIDATED", "STAGED", "APPLIED", "ACTIVE", "SUPERSEDED", "REJECTED", "ROLLED_BACK"])
const APPLYABLE_STATES = new Set(["VALIDATED", "STAGED", "APPLIED"])
const POINTER_STATES = new Set(["ACTIVE", "SUPERSEDED", "ROLLED_BACK"])

function failure(code: string, detail: string, path?: string): ConfigResult {
  return { ok: false, status: "REJECTED", code, detail, ...(path ? { path } : {}) }
}

function nowUtc(): string { return new Date().toISOString() }
function id(prefix: string): string { return `${prefix}-${crypto.randomUUID()}` }
function requestDigest(value: AnyRecord): string { return sha256Canonical(canonicalizePlan12Json(value)) }
function rollback(store: ControlPlaneStore): void { try { store.db.exec("ROLLBACK") } catch {} }
function begin(store: ControlPlaneStore): void { store.db.exec("BEGIN IMMEDIATE") }

function snapshot(store: ControlPlaneStore, revision: string): any | null {
  return store.db.prepare("SELECT * FROM workflow_config_snapshots WHERE config_revision = ?").get(revision) as any ?? null
}

function ensureState(store: ControlPlaneStore, revision: string): any | null {
  const row = snapshot(store, revision)
  if (!row) return null
  store.db.prepare(`INSERT OR IGNORE INTO config_revision_state
    (config_revision, workflow_scope, current_state, version, parent_revision, created_at, activated_at, updated_at)
    VALUES (?, 'global', ?, 0, ?, ?, ?, ?)`)
    .run(row.config_revision, row.state, row.parent_revision, row.created_at, row.activated_at, row.created_at)
  return store.db.prepare("SELECT * FROM config_revision_state WHERE config_revision = ?").get(revision) as any
}

function ensureAllStates(store: ControlPlaneStore): void {
  const rows = store.db.prepare("SELECT config_revision FROM workflow_config_snapshots").all() as any[]
  for (const row of rows) ensureState(store, row.config_revision)
}

function state(store: ControlPlaneStore, revision: string): string | null {
  return (ensureState(store, revision) as any)?.current_state ?? null
}

function view(store: ControlPlaneStore, revision: string): any | null {
  const row = snapshot(store, revision)
  if (!row) return null
  const lifecycle = ensureState(store, revision)
  return { ...row, ...(lifecycle ?? {}), config_state: lifecycle?.current_state ?? row.state, effective_state: lifecycle?.current_state ?? row.state, config_payload: JSON.parse(row.canonical_json) }
}

function head(store: ControlPlaneStore): any {
  ensureAllStates(store)
  const row = store.db.prepare("SELECT * FROM config_active_head WHERE head_key = 'global'").get() as any
  if (row?.active_revision) return row
  const active = store.db.prepare("SELECT config_revision FROM config_revision_state WHERE current_state = 'ACTIVE' ORDER BY config_revision LIMIT 1").get() as any
  if (active?.config_revision) {
    store.db.prepare("UPDATE config_active_head SET active_revision = ?, version = version + 1, updated_at = ? WHERE head_key = 'global' AND active_revision IS NULL")
      .run(active.config_revision, nowUtc())
    return store.db.prepare("SELECT * FROM config_active_head WHERE head_key = 'global'").get() as any
  }
  return row
}

function activeRevision(store: ControlPlaneStore): string | null { return head(store)?.active_revision ?? null }

function operation(store: ControlPlaneStore, key: string): any | null {
  return store.db.prepare("SELECT * FROM config_operation_idempotency WHERE idempotency_key = ?").get(key) as any ?? null
}

function operationResult(prior: any, store: ControlPlaneStore, revision: string): ConfigResult {
  if (prior.result === "APPLIED") return { ok: true, status: "IDEMPOTENT", value: revision ? view(store, revision) : undefined, inserted: false }
  return failure(prior.error_code ?? "CONFIG_OPERATION_REJECTED", prior.error_detail ?? "configuration operation was rejected")
}

function recordOperation(store: ControlPlaneStore, input: AnyRecord, digest: string, operationName: string, revision: string, targetRevision: string | null, result: string, errorCode: string | null = null, errorDetail: string | null = null): void {
  store.db.prepare(`INSERT INTO config_operation_idempotency
    (idempotency_key, request_digest, operation, config_revision, target_revision, correlation_id, result, error_code, error_detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(input.idempotency_key, digest, operationName, revision, targetRevision, input.correlation_id, result, errorCode, errorDetail, nowUtc())
}

function journal(store: ControlPlaneStore, revision: string, fromState: string | null, toState: string | null, input: AnyRecord, operationName: string, result = "APPLIED", errorCode: string | null = null, errorDetail: string | null = null, actualRevision: string | null = null): void {
  const row = snapshot(store, revision)
  store.db.prepare(`INSERT INTO config_revision_journal
    (journal_id, config_revision, operation, from_state, to_state, expected_revision, actual_revision,
     actor, reason, correlation_id, idempotency_key, payload_sha256, created_at, result, error_code, error_detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id("journal"), revision, operationName, fromState, toState,
      input.expected_active_revision ?? input.expected_revision ?? null, actualRevision,
      input.actor, input.reason, input.correlation_id, input.idempotency_key,
      row?.payload_sha256 ?? requestDigest(input), nowUtc(), result, errorCode, errorDetail)
}

function updateState(store: ControlPlaneStore, revision: string, fromState: string, toState: string, input: AnyRecord): void {
  const current = ensureState(store, revision)
  if (!current || current.current_state !== fromState) throw new Error("CONFIG_STATE_CHANGED")
  const timestamp = nowUtc()
  const field = { VALIDATED: "validated_at", STAGED: "staged_at", APPLIED: "applied_at", ACTIVE: "activated_at", SUPERSEDED: "superseded_at", REJECTED: "rejected_at", ROLLED_BACK: "rolled_back_at" }[toState]
  const setField = field ? `, ${field} = ?` : ""
  const params: any[] = [toState, current.version + 1, input.reason ?? null, input.correlation_id ?? null, timestamp]
  if (field) params.push(timestamp)
  params.push(revision, current.version, fromState)
  const result = store.db.prepare(`UPDATE config_revision_state
    SET current_state = ?, version = ?, reason = ?, correlation_id = ?, updated_at = ?${setField}
    WHERE config_revision = ? AND version = ? AND current_state = ?`).run(...params)
  if (result.changes !== 1) throw new Error("CONFIG_STATE_CAS_CONFLICT")
}

function failAudit(store: ControlPlaneStore, input: AnyRecord, digest: string, operationName: string, revision: string, code: string, detail: string): ConfigResult {
  const prior = operation(store, input.idempotency_key)
  if (prior) return prior.request_digest === digest ? operationResult(prior, store, revision) : failure("EVIDENCE_IDEMPOTENCY_CONFLICT", "idempotency key was used with a different request", "$.idempotency_key")
  recordOperation(store, input, digest, operationName, revision, input.target_revision ?? null, "REJECTED", code, detail)
  const current = state(store, revision)
  journal(store, revision, current, current, input, operationName, "REJECTED", code, detail, activeRevision(store))
  store.db.exec("COMMIT")
  return failure(code, detail)
}

function classify(error: any): ConfigResult {
  const detail = error?.message ?? String(error)
  if (/UNIQUE constraint failed/i.test(detail)) return failure("CONFIG_REVISION_IMMUTABLE", "configuration revision, state or operation key already exists")
  if (/FOREIGN KEY constraint failed/i.test(detail)) return failure("CONFIG_REVISION_NOT_FOUND", "journal references a missing revision")
  if (/APPEND_ONLY_(UPDATE|DELETE)_FORBIDDEN/i.test(detail)) return failure("JOURNAL_APPEND_ONLY", "configuration journal is append-only")
  return failure("CONFIG_DATABASE_WRITE_FAILED", detail)
}

function validateRequiredOperation(input: AnyRecord): ConfigResult | null {
  for (const field of ["idempotency_key", "actor", "reason", "correlation_id"]) {
    if (typeof input?.[field] !== "string" || !input[field].trim()) return failure("CONFIG_OPERATION_FIELDS_REQUIRED", `${field} must be a nonempty string`, `$.${field}`)
  }
  return null
}

function validateOriginalPayload(snapshotValue: AnyRecord): ConfigResult | null {
  try {
    const withoutDigest = Object.fromEntries(Object.entries(snapshotValue).filter(([key]) => key !== "payload_sha256"))
    if (sha256Canonical(withoutDigest) !== snapshotValue.payload_sha256) return failure("PAYLOAD_HASH_MISMATCH", "payload_sha256 does not match canonical payload", "$.payload_sha256")
  } catch (error: any) { return failure(error?.code ?? "INVALID_JSON_VALUE", error?.detail ?? String(error), error?.path ?? "$") }
  return null
}

export function createConfigRevision(store: ControlPlaneStore, input: AnyRecord): ConfigResult {
  if (input?.state !== "DRAFT") return failure("CONFIG_INITIAL_STATE_INVALID", "new revisions must start in DRAFT", "$.state")
  const payloadError = validateOriginalPayload(input)
  if (payloadError) return payloadError
  {
    const probe: AnyRecord = { ...input, parent_revision: null }
    delete probe.payload_sha256
    probe.payload_sha256 = sha256Canonical(probe)
    const validation = validateWorkflowConfigSnapshot(probe)
    if (!validation.ok) return failure(validation.code, validation.detail, validation.path)
    if (input.parent_revision !== null && (typeof input.parent_revision !== "string" || !input.parent_revision.trim())) return failure("FIELD_INVALID", "parent_revision must be null or an identifier", "$.parent_revision")
    try {
      begin(store)
      const prior = store.db.prepare("SELECT * FROM evidence_idempotency WHERE idempotency_key = ?").get(input.idempotency_key) as any
      if (prior) {
        const result = prior.payload_sha256 === input.payload_sha256
          ? { ok: true, status: "IDEMPOTENT", value: view(store, input.config_revision), inserted: false } as ConfigResult
          : failure("EVIDENCE_IDEMPOTENCY_CONFLICT", "idempotency key was used with a different digest", "$.idempotency_key")
        rollback(store); return result
      }
      if (snapshot(store, input.config_revision)) { rollback(store); return failure("CONFIG_REVISION_IMMUTABLE", "config_revision cannot be overwritten", "$.config_revision") }
      const count = (store.db.prepare("SELECT COUNT(*) AS count FROM workflow_config_snapshots").get() as any).count
      if (!input.parent_revision && count > 0) { rollback(store); return failure("PARENT_REVISION_REQUIRED", "non-genesis revisions require parent_revision", "$.parent_revision") }
      if (input.parent_revision && !snapshot(store, input.parent_revision)) { rollback(store); return failure("PARENT_REVISION_NOT_FOUND", "parent_revision must reference an existing snapshot", "$.parent_revision") }
      store.db.prepare(`INSERT INTO evidence_idempotency(idempotency_key, payload_sha256, fact_type, table_name, record_key, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(input.idempotency_key, input.payload_sha256, "workflow_config_snapshot", "workflow_config_snapshots", input.config_revision, nowUtc())
      store.db.prepare(`INSERT INTO workflow_config_snapshots
        (config_revision, schema_version, source, observed_at, payload_sha256, idempotency_key, evidence_level,
         fact_type, parent_revision, source_kind, drawio_raw_sha256, drawio_semantic_sha256, ir_sha256, config_digest,
         model_catalog_digest, route_bindings_digest, canonical_json, state, created_by, created_at, activated_at, rollback_of)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.config_revision, input.schema_version, input.source, input.observed_at, input.payload_sha256,
          input.idempotency_key, input.evidence_level, input.fact_type, input.parent_revision, input.source_kind,
          input.drawio_raw_sha256, input.drawio_semantic_sha256, input.ir_sha256, input.config_digest,
          input.model_catalog_digest, input.route_bindings_digest, input.canonical_json, input.state,
          input.created_by, input.created_at, input.activated_at, input.rollback_of)
      journal(store, input.config_revision, null, "DRAFT", {
        actor: input.created_by, reason: "create immutable configuration revision",
        correlation_id: input.idempotency_key, idempotency_key: input.idempotency_key,
      }, "CREATE", "APPLIED", null, null, activeRevision(store))
      store.db.exec("COMMIT")
      return { ok: true, status: "INSERTED", value: view(store, input.config_revision), inserted: true }
    } catch (error: any) { rollback(store); return classify(error) }
  }
}

export function getConfigRevision(store: ControlPlaneStore, configRevision: string): any | null { return view(store, configRevision) }
export function getActiveConfigRevision(store: ControlPlaneStore): any | null { const revision = activeRevision(store); return revision ? view(store, revision) : null }

export function transitionConfigRevision(store: ControlPlaneStore, input: AnyRecord): ConfigResult {
  const revision = input?.config_revision
  const target = input?.to_state
  if (typeof revision !== "string" || !revision) return failure("CONFIG_REVISION_REQUIRED", "config_revision is required", "$.config_revision")
  if (!CONFIG_STATES.has(target)) return failure("CONFIG_STATE_INVALID", "unknown config revision state", "$.to_state")
  if (POINTER_STATES.has(target)) return failure("CONFIG_POINTER_OPERATION_REQUIRED", "ACTIVE, SUPERSEDED and ROLLED_BACK require Apply or Rollback CAS")
  const required = validateRequiredOperation(input); if (required) return required
  const digest = requestDigest({ operation: "TRANSITION", config_revision: revision, to_state: target, actor: input.actor, reason: input.reason, correlation_id: input.correlation_id })
  try {
    begin(store)
    const prior = operation(store, input.idempotency_key)
    if (prior) { const result = prior.request_digest === digest ? operationResult(prior, store, revision) : failure("EVIDENCE_IDEMPOTENCY_CONFLICT", "idempotency key was used with a different request", "$.idempotency_key"); rollback(store); return result }
    if (!snapshot(store, revision)) return failAudit(store, input, digest, "TRANSITION", revision, "CONFIG_REVISION_NOT_FOUND", "target revision does not exist")
    const current = state(store, revision)!
    const valid = validateConfigRevisionTransition(current, target)
    if (!valid.ok) return failAudit(store, input, digest, "TRANSITION", revision, valid.code, valid.detail)
    recordOperation(store, input, digest, "TRANSITION", revision, null, "APPLIED")
    updateState(store, revision, current, target, input)
    journal(store, revision, current, target, input, "TRANSITION", "APPLIED", null, null, activeRevision(store))
    store.db.exec("COMMIT")
    return { ok: true, status: "APPLIED", value: view(store, revision), inserted: true }
  } catch (error: any) { rollback(store); return classify(error) }
}

function applyChain(store: ControlPlaneStore, revision: string, current: string, input: AnyRecord, operationName: string, actualRevision: string | null): void {
  const chain: Record<string, string[]> = { VALIDATED: ["STAGED", "APPLIED", "ACTIVE"], STAGED: ["APPLIED", "ACTIVE"], APPLIED: ["ACTIVE"] }
  let from = current
  for (const to of chain[current] ?? []) {
    updateState(store, revision, from, to, input)
    journal(store, revision, from, to, input, operationName, "APPLIED", null, null, actualRevision)
    from = to
  }
}

function updateHead(store: ControlPlaneStore, expected: string | null, target: string, expectedVersion: number): void {
  const result = store.db.prepare(`UPDATE config_active_head SET active_revision = ?, version = version + 1, updated_at = ?
    WHERE head_key = 'global' AND version = ? AND ((active_revision = ?) OR (active_revision IS NULL AND ? IS NULL))`)
    .run(target, nowUtc(), expectedVersion, expected, expected)
  if (result.changes !== 1) throw new Error("CAS_CONFLICT")
}

export function applyConfigRevision(store: ControlPlaneStore, input: AnyRecord): ConfigResult {
  const targetRevision = input?.target_revision
  const expectedProvided = Object.prototype.hasOwnProperty.call(input ?? {}, "expected_active_revision")
  const expected = input?.expected_active_revision ?? null
  if (typeof targetRevision !== "string" || !targetRevision) return failure("CONFIG_REVISION_REQUIRED", "target_revision is required", "$.target_revision")
  if (!expectedProvided) return failure("EXPECTED_ACTIVE_REVISION_REQUIRED", "expected_active_revision is required", "$.expected_active_revision")
  const required = validateRequiredOperation(input); if (required) return required
  const digest = requestDigest({ operation: "APPLY", expected_active_revision: expected, target_revision: targetRevision, actor: input.actor, reason: input.reason, correlation_id: input.correlation_id })
  try {
    begin(store)
    const currentHead = head(store)
    const prior = operation(store, input.idempotency_key)
    if (prior) { const result = prior.request_digest === digest ? operationResult(prior, store, targetRevision) : failure("EVIDENCE_IDEMPOTENCY_CONFLICT", "idempotency key was used with a different request", "$.idempotency_key"); rollback(store); return result }
    const actual = currentHead?.active_revision ?? null
    const target = snapshot(store, targetRevision)
    if (actual !== expected) return failAudit(store, input, digest, "APPLY", targetRevision, "CAS_CONFLICT", `expected active revision ${expected ?? "<none>"}, actual ${actual ?? "<none>"}`)
    if (!target) return failAudit(store, input, digest, "APPLY", actual ?? targetRevision, "CONFIG_REVISION_NOT_FOUND", "target revision does not exist")
    const targetState = state(store, targetRevision)!
    if (actual === targetRevision && targetState === "ACTIVE") return failAudit(store, input, digest, "APPLY", targetRevision, "CONFIG_TARGET_ALREADY_ACTIVE", "target revision is already ACTIVE")
    if (!APPLYABLE_STATES.has(targetState)) return failAudit(store, input, digest, "APPLY", targetRevision, "CONFIG_TARGET_STATE_INVALID", "target revision must be VALIDATED, STAGED, or APPLIED")
    const headVersion = currentHead?.version ?? 0
    if (actual) {
      const oldState = state(store, actual)!
      const oldTransition = validateConfigRevisionTransition(oldState, "SUPERSEDED")
      if (!oldTransition.ok) return failAudit(store, input, digest, "APPLY", actual, oldTransition.code, oldTransition.detail)
      updateState(store, actual, oldState, "SUPERSEDED", input)
      journal(store, actual, oldState, "SUPERSEDED", input, "APPLY", "APPLIED", null, null, actual)
    }
    applyChain(store, targetRevision, targetState, input, "APPLY", actual)
    recordOperation(store, input, digest, "APPLY", targetRevision, targetRevision, "APPLIED")
    updateHead(store, actual, targetRevision, headVersion)
    store.db.exec("COMMIT")
    return { ok: true, status: "APPLIED", value: view(store, targetRevision), inserted: true }
  } catch (error: any) { rollback(store); return error?.message === "CAS_CONFLICT" ? failure("CAS_CONFLICT", "active revision changed during Apply") : classify(error) }
}

function validateRollbackPayload(snapshotRow: any): ConfigResult | null {
  let parsed: any
  try { parsed = JSON.parse(snapshotRow.canonical_json) } catch { return failure("ROLLBACK_CONFIG_UNVERIFIED", "rollback target canonical_json is not valid JSON") }
  if (!Array.isArray(parsed?.model_catalog) || !Array.isArray(parsed?.route_bindings)) return failure("ROLLBACK_CONFIG_UNVERIFIED", "rollback target must carry validated model_catalog and route_bindings arrays")
  for (const entry of parsed.model_catalog) {
    const result = validateModelCatalogEntry({ ...entry, config_revision: entry.config_revision ?? snapshotRow.config_revision })
    if (!result.ok) return failure("ROLLBACK_CONFIG_UNVERIFIED", `rollback model catalog entry is invalid: ${result.code}`)
  }
  for (const binding of parsed.route_bindings) {
    const result = validateRouteBinding({ ...binding, config_revision: binding.config_revision ?? snapshotRow.config_revision })
    if (!result.ok) return failure("ROLLBACK_CONFIG_UNVERIFIED", `rollback route binding is invalid: ${result.code}`)
    if ((binding as any).status === "MODEL_UNASSIGNED") return failure("MODEL_UNASSIGNED", "rollback target contains MODEL_UNASSIGNED route binding")
  }
  return null
}

export function rollbackConfigRevision(store: ControlPlaneStore, input: AnyRecord): ConfigResult {
  const targetRevision = input?.target_revision
  const expectedProvided = Object.prototype.hasOwnProperty.call(input ?? {}, "expected_active_revision") || Object.prototype.hasOwnProperty.call(input ?? {}, "current_revision")
  const expected = input?.expected_active_revision ?? input?.current_revision ?? null
  if (typeof targetRevision !== "string" || !targetRevision) return failure("CONFIG_REVISION_REQUIRED", "target_revision is required", "$.target_revision")
  if (!expectedProvided) return failure("EXPECTED_ACTIVE_REVISION_REQUIRED", "expected_active_revision is required", "$.expected_active_revision")
  const required = validateRequiredOperation(input); if (required) return required
  const digest = requestDigest({ operation: "ROLLBACK", expected_active_revision: expected, target_revision: targetRevision, actor: input.actor, reason: input.reason, correlation_id: input.correlation_id })
  try {
    begin(store)
    const currentHead = head(store)
    const prior = operation(store, input.idempotency_key)
    if (prior) { const result = prior.request_digest === digest ? operationResult(prior, store, targetRevision) : failure("EVIDENCE_IDEMPOTENCY_CONFLICT", "idempotency key was used with a different request", "$.idempotency_key"); rollback(store); return result }
    const actual = currentHead?.active_revision ?? null
    if (actual !== expected) return failAudit(store, input, digest, "ROLLBACK", actual ?? targetRevision, "CAS_CONFLICT", `expected active revision ${expected ?? "<none>"}, actual ${actual ?? "<none>"}`)
    const target = snapshot(store, targetRevision)
    if (!target) return failAudit(store, input, digest, "ROLLBACK", actual ?? targetRevision, "CONFIG_REVISION_NOT_FOUND", "rollback target does not exist")
    const targetState = state(store, targetRevision)!
    if (targetState === "REJECTED" || targetState === "ROLLED_BACK") return failAudit(store, input, digest, "ROLLBACK", targetRevision, "ROLLBACK_TARGET_REJECTED", "rollback target is rejected or rolled back")
    const payloadGuard = validateRollbackPayload(target)
    if (payloadGuard && !payloadGuard.ok) return failAudit(store, input, digest, "ROLLBACK", targetRevision, payloadGuard.code, payloadGuard.detail)
    if (targetState !== "SUPERSEDED") return failAudit(store, input, digest, "ROLLBACK", targetRevision, "ROLLBACK_TARGET_INVALID", "rollback target must be SUPERSEDED")
    if (!actual || actual === targetRevision) return failAudit(store, input, digest, "ROLLBACK", targetRevision, "ROLLBACK_TARGET_INVALID", "rollback requires a different active revision")
    const headVersion = currentHead?.version ?? 0
    updateState(store, actual, "ACTIVE", "ROLLED_BACK", input)
    journal(store, actual, "ACTIVE", "ROLLED_BACK", input, "ROLLBACK", "APPLIED", null, null, actual)
    updateState(store, targetRevision, "SUPERSEDED", "ACTIVE", input)
    journal(store, targetRevision, "SUPERSEDED", "ACTIVE", input, "ROLLBACK", "APPLIED", null, null, actual)
    recordOperation(store, input, digest, "ROLLBACK", actual, targetRevision, "APPLIED")
    updateHead(store, actual, targetRevision, headVersion)
    store.db.exec("COMMIT")
    return { ok: true, status: "APPLIED", value: view(store, targetRevision), inserted: true }
  } catch (error: any) { rollback(store); return error?.message === "CAS_CONFLICT" ? failure("CAS_CONFLICT", "active revision changed during Rollback") : classify(error) }
}

export function listConfigRevisionJournal(store: ControlPlaneStore, filter: { config_revision?: string; correlation_id?: string; idempotency_key?: string } = {}): any[] {
  const clauses: string[] = []; const params: any[] = []
  for (const field of ["config_revision", "correlation_id", "idempotency_key"] as const) if (filter[field]) { clauses.push(`${field} = ?`); params.push(filter[field]) }
  return store.db.prepare(`SELECT * FROM config_revision_journal${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY journal_seq`).all(...params) as any[]
}

export const createRevision = createConfigRevision
export const applyRevision = applyConfigRevision
export const rollbackRevision = rollbackConfigRevision
export const transitionRevision = transitionConfigRevision
