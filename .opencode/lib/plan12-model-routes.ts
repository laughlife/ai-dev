import crypto from "node:crypto"
import {
  KNOWN_RUNTIME_IDS,
  canonicalizePlan12Json,
  sha256Canonical,
} from "./plan12-contract.ts"
import { type ControlPlaneStore } from "./plan12-control-plane.ts"

type AnyRecord = Record<string, any>
type Failure = { ok: false; status: "REJECTED"; code: string; detail: string; path?: string }
type Success<T = any> = { ok: true; status: "INSERTED" | "IDEMPOTENT" | "ADMITTED"; value: T; inserted: boolean }
export type ModelRouteResult<T = any> = Success<T> | Failure

const MODEL_STATES = new Set(["AVAILABLE", "UNAVAILABLE", "UNKNOWN", "REJECTED"])
const BINDING_STATES = new Set(["BOUND", "MODEL_UNASSIGNED", "UNAVAILABLE", "REJECTED"])
const ROLE_NAMES = new Set([
  "Global Orchestrator", "Planner", "Project Reader", "Feature Executor", "Reviewer",
  "DB Operator", "API Runner", "Test Runner", "Memory Agent",
])
const REVISION_BLOCKED = new Set(["SUPERSEDED", "ROLLED_BACK", "REJECTED"])

function failure(code: string, detail: string, path?: string): Failure {
  return { ok: false, status: "REJECTED", code, detail, ...(path ? { path } : {}) }
}
function nowUtc(): string { return new Date().toISOString() }
function id(prefix: string): string { return `${prefix}-${crypto.randomUUID()}` }
function isString(value: any): value is string { return typeof value === "string" && value.trim().length > 0 }
function sha(value: AnyRecord): string {
  const { payload_sha256: _ignored, ...body } = value
  return sha256Canonical(body)
}
function validHash(value: any): boolean { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) }
function validUtc(value: any): boolean {
  if (!isString(value) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return false
  try { return new Date(value).toISOString() === value.replace(/T(\d{2}:\d{2}:\d{2})Z$/, "T$1.000Z").replace(/\.(\d{1,2})Z$/, (_m, f) => `.${f.padEnd(3, "0")}Z`) } catch { return false }
}
function exactIdentity(provider: any, modelId: any, exact: any): { ok: true; variant: string | null } | Failure {
  if (!isString(provider)) return failure("MODEL_PROVIDER_REQUIRED", "provider is required", "$.provider")
  if (!isString(modelId)) return failure("MODEL_ID_MISSING", "model_id is required", "$.model_id")
  if (!isString(exact)) return failure("MODEL_EXACT_REF_REQUIRED", "exact_model_ref is required", "$.exact_model_ref")
  const slash = exact.indexOf("/")
  const hash = exact.indexOf("#")
  const base = hash >= 0 ? exact.slice(0, hash) : exact
  const variant = hash >= 0 ? exact.slice(hash + 1) : null
  if (slash <= 0 || slash === base.length - 1 || (hash >= 0 && !variant)) return failure("MODEL_ID_INVALID", "exact_model_ref must be provider/model or provider/model#variant", "$.exact_model_ref")
  const expected = `${provider}/${modelId}${variant ? `#${variant}` : ""}`
  if (exact !== expected) return failure("MODEL_RUNTIME_REF_MISMATCH", "exact_model_ref must be composed from exact provider/model/variant", "$.exact_model_ref")
  return { ok: true, variant }
}
function lifecycle(store: ControlPlaneStore, revision: string): any | null {
  return store.db.prepare(`SELECT s.config_revision, COALESCE(r.current_state, s.state) AS state
    FROM workflow_config_snapshots s LEFT JOIN config_revision_state r ON r.config_revision=s.config_revision
    WHERE s.config_revision = ?`).get(revision) as any ?? null
}
function revisionAllowed(store: ControlPlaneStore, revision: any): Failure | null {
  if (!isString(revision)) return failure("MODEL_CONFIG_REVISION_REQUIRED", "config_revision is required", "$.config_revision")
  const row = lifecycle(store, revision)
  if (!row) return failure("MODEL_CONFIG_REVISION_NOT_FOUND", "config_revision does not exist", "$.config_revision")
  if (REVISION_BLOCKED.has(row.state)) return failure("MODEL_CONFIG_REVISION_CONFLICT", `config_revision is ${row.state} and cannot receive new model routing`, "$.config_revision")
  return null
}
function currentIdempotency(store: ControlPlaneStore, key: string): any | null {
  return store.db.prepare("SELECT * FROM evidence_idempotency WHERE idempotency_key = ?").get(key) as any ?? null
}
function checkIdempotency(store: ControlPlaneStore, key: string, digest: string): ModelRouteResult | null {
  const prior = currentIdempotency(store, key)
  if (!prior) return null
  if (prior.payload_sha256 !== digest) return failure("EVIDENCE_IDEMPOTENCY_CONFLICT", "idempotency key was used with a different digest", "$.idempotency_key")
  const row = prior.table_name && prior.record_key ? store.db.prepare(`SELECT * FROM ${prior.table_name} WHERE ${prior.table_name === "model_catalog" ? "catalog_entry_id" : prior.table_name === "route_bindings" ? "route_binding_id" : prior.table_name === "runtime_model_probes" ? "probe_id" : "event_id"} = ?`).get(prior.record_key) : null
  return { ok: true, status: "IDEMPOTENT", value: row, inserted: false }
}
function reserveIdempotency(store: ControlPlaneStore, input: AnyRecord, table: string, recordKey: string, digest: string): void {
  store.db.prepare(`INSERT INTO evidence_idempotency
    (idempotency_key, payload_sha256, fact_type, table_name, record_key, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(input.idempotency_key, digest, input.fact_type ?? table, table, recordKey, nowUtc())
}
function parseJson(value: any, fallback: any): any {
  if (typeof value !== "string") return value ?? fallback
  try { return JSON.parse(value) } catch { return fallback }
}
function canonicalInput(input: AnyRecord): { ok: true; value: AnyRecord; digest: string } | Failure {
  let value: AnyRecord
  try { value = canonicalizePlan12Json(input) as AnyRecord } catch (error: any) { return failure(error?.code ?? "INVALID_JSON_VALUE", error?.detail ?? String(error), error?.path ?? "$") }
  if (!isString(value.idempotency_key)) return failure("MODEL_IDEMPOTENCY_KEY_REQUIRED", "idempotency_key is required", "$.idempotency_key")
  const digest = value.payload_sha256 ?? sha(value)
  if (!validHash(digest)) return failure("PAYLOAD_HASH_INVALID", "payload_sha256 must be a lowercase SHA-256 hash", "$.payload_sha256")
  if (value.payload_sha256 && value.payload_sha256 !== sha(value)) return failure("PAYLOAD_HASH_MISMATCH", "payload_sha256 does not match canonical payload", "$.payload_sha256")
  value.payload_sha256 = digest
  return { ok: true, value, digest }
}

export function validateModelCatalogRecord(input: unknown, store?: ControlPlaneStore): ModelRouteResult<AnyRecord> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return failure("MODEL_RECORD_INVALID", "model catalog entry must be an object")
  const value: AnyRecord = { ...(input as AnyRecord) }
  if (value.provider !== undefined && value.provider_id !== undefined && value.provider !== value.provider_id) return failure("MODEL_PROVIDER_MISMATCH", "provider and provider_id must match exactly", "$.provider_id")
  const provider = value.provider ?? value.provider_id
  const modelId = value.model_id
  const exact = value.exact_model_ref ?? value.runtime_id
  if (!isString(provider)) return failure("MODEL_PROVIDER_REQUIRED", "provider is required", "$.provider")
  if (!isString(modelId)) return failure("MODEL_ID_MISSING", "model_id is required", "$.model_id")
  if (!isString(exact)) return failure("MODEL_EXACT_REF_REQUIRED", "exact_model_ref is required", "$.exact_model_ref")
  const identity = exactIdentity(provider, modelId, exact); if (!identity.ok) return identity
  if (value.variant !== undefined && value.variant !== identity.variant) return failure("MODEL_VARIANT_MISMATCH", "variant must match exact_model_ref", "$.variant")
  if (!KNOWN_RUNTIME_IDS.has(exact)) return failure("MODEL_ID_UNKNOWN", "provider/model/variant is not an exact known runtime identity", "$.exact_model_ref")
  const state = value.availability_state ?? (value.availability_status === "VERIFIED" ? "AVAILABLE" : value.availability_status)
  if (!MODEL_STATES.has(state)) return failure("MODEL_AVAILABILITY_INVALID", "availability_state must be AVAILABLE, UNAVAILABLE, UNKNOWN or REJECTED", "$.availability_state")
  const source = value.runtime_source ?? value.source
  if (!isString(source)) return failure("MODEL_RUNTIME_SOURCE_REQUIRED", "runtime_source is required", "$.runtime_source")
  const probeStatus = value.probe_status ?? (state === "AVAILABLE" ? "AVAILABLE" : state)
  if (!isString(probeStatus)) return failure("MODEL_PROBE_STATUS_REQUIRED", "probe_status is required", "$.probe_status")
  const revisionError = store ? revisionAllowed(store, value.config_revision) : (!isString(value.config_revision) ? failure("MODEL_CONFIG_REVISION_REQUIRED", "config_revision is required", "$.config_revision") : null)
  if (revisionError) return revisionError
  const capabilities = value.capability ?? value.capabilities
  if (capabilities === undefined || capabilities === null || typeof capabilities !== "object" || Array.isArray(capabilities)) return failure("MODEL_CAPABILITY_REQUIRED", "capability must be an object", "$.capability")
  const verifiedAt = value.last_seen_at ?? value.verified_at
  if (!isString(verifiedAt)) return failure("MODEL_PROBE_TIME_REQUIRED", "last_seen_at/verified_at is required", "$.last_seen_at")
  if (!validUtc(verifiedAt)) return failure("MODEL_PROBE_TIME_INVALID", "last_seen_at/verified_at must be a UTC ISO-8601 timestamp", "$.last_seen_at")
  if (value.first_seen_at !== undefined && !validUtc(value.first_seen_at)) return failure("MODEL_PROBE_TIME_INVALID", "first_seen_at must be a UTC ISO-8601 timestamp", "$.first_seen_at")
  if (value.created_at !== undefined && !validUtc(value.created_at)) return failure("MODEL_PROBE_TIME_INVALID", "created_at must be a UTC ISO-8601 timestamp", "$.created_at")
  if (value.updated_at !== undefined && !validUtc(value.updated_at)) return failure("MODEL_PROBE_TIME_INVALID", "updated_at must be a UTC ISO-8601 timestamp", "$.updated_at")
  if (state === "AVAILABLE" && (source !== "runtime_probe" || !["AVAILABLE", "PASS", "VERIFIED"].includes(probeStatus))) return failure("MODEL_RUNTIME_PROBE_REQUIRED", "AVAILABLE requires a successful runtime probe", "$.availability_state")
  if (state === "AVAILABLE" && !isString(value.probe_id)) return failure("MODEL_RUNTIME_PROBE_REQUIRED", "AVAILABLE requires probe_id evidence", "$.probe_id")
  if (state === "AVAILABLE" && store && !store.db.prepare("SELECT probe_id FROM runtime_model_probes WHERE probe_id = ? AND availability_state = 'AVAILABLE'").get(value.probe_id)) return failure("MODEL_RUNTIME_PROBE_REQUIRED", "probe_id does not reference a successful runtime probe", "$.probe_id")
  if (exact === "bailian-token-plan/qwen3.8-max" && state === "AVAILABLE" && source !== "runtime_probe") return failure("MODEL_AVAILABILITY_UNVERIFIED", "qwen3.8-max configuration presence cannot prove availability", "$.availability_state")
  if (value.display_name !== undefined && !isString(value.display_name)) return failure("MODEL_DISPLAY_NAME_INVALID", "display_name must be a non-empty string", "$.display_name")
  const normalized = {
    catalog_entry_id: value.catalog_entry_id ?? value.model_ref,
    provider,
    provider_id: provider,
    model_id: modelId,
    variant: identity.variant,
    exact_model_ref: exact,
    display_name: value.display_name ?? exact,
    capability_json: JSON.stringify(canonicalizePlan12Json(capabilities)),
    availability_state: state,
    runtime_source: source,
    runtime_version: value.runtime_version ?? null,
    first_seen_at: value.first_seen_at ?? verifiedAt,
    last_seen_at: verifiedAt,
    probe_status: probeStatus,
    probe_error: value.probe_error ?? null,
    probe_id: value.probe_id ?? null,
    metadata_sha256: value.metadata_sha256 ?? sha256Canonical(capabilities),
    config_revision: value.config_revision,
    created_at: value.created_at ?? nowUtc(),
    updated_at: value.updated_at ?? nowUtc(),
    idempotency_key: value.idempotency_key,
    payload_sha256: value.payload_sha256,
  }
  if (!isString(normalized.catalog_entry_id)) return failure("MODEL_CATALOG_ENTRY_ID_REQUIRED", "catalog_entry_id is required", "$.catalog_entry_id")
  if (!validHash(normalized.metadata_sha256)) return failure("MODEL_METADATA_HASH_INVALID", "metadata_sha256 must be a lowercase SHA-256 hash", "$.metadata_sha256")
  if (!isString(normalized.idempotency_key)) return failure("MODEL_IDEMPOTENCY_KEY_REQUIRED", "idempotency_key is required", "$.idempotency_key")
  return { ok: true, status: "INSERTED", value: normalized, inserted: true }
}

export function validateRouteBindingRecord(input: unknown, store?: ControlPlaneStore): ModelRouteResult<AnyRecord> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return failure("ROUTE_BINDING_INVALID", "route binding must be an object")
  const value: AnyRecord = { ...(input as AnyRecord) }
  const state = value.binding_state ?? value.status
  const routeId = value.route_binding_id ?? value.route_id
  const role = value.role
  if (!isString(routeId)) return failure("ROUTE_BINDING_ID_REQUIRED", "route_binding_id is required", "$.route_binding_id")
  if (!isString(role)) return failure("ROUTE_ROLE_REQUIRED", "role is required", "$.role")
  if (!ROLE_NAMES.has(role)) return failure("ROUTE_ROLE_INVALID", "role must be a formal architecture role", "$.role")
  if (!BINDING_STATES.has(state)) return failure("ROUTE_STATE_INVALID", "binding_state must be BOUND, MODEL_UNASSIGNED, UNAVAILABLE or REJECTED", "$.binding_state")
  const revisionError = store ? revisionAllowed(store, value.config_revision) : (!isString(value.config_revision) ? failure("MODEL_CONFIG_REVISION_REQUIRED", "config_revision is required", "$.config_revision") : null)
  if (revisionError) return revisionError
  if (value.provider !== undefined && value.provider_id !== undefined && value.provider !== value.provider_id) return failure("MODEL_PROVIDER_MISMATCH", "provider and provider_id must match exactly", "$.provider_id")
  const provider = value.provider ?? value.provider_id ?? null
  const modelId = value.model_id ?? null
  const exact = value.exact_model_ref ?? value.runtime_id ?? null
  let variant = value.variant ?? null
  if (state === "MODEL_UNASSIGNED") {
    if (provider !== null || modelId !== null || exact !== null || variant !== null) return failure("MODEL_UNASSIGNED_BOUND", "MODEL_UNASSIGNED cannot carry a model binding", "$.binding_state")
  } else {
    if (!isString(provider) || !isString(modelId) || !isString(exact)) return failure("MODEL_ID_MISSING", "provider, model_id and exact_model_ref are required for a configured route", "$.binding_state")
    const identity = exactIdentity(provider, modelId, exact); if (!identity.ok) return identity
    if (value.variant !== undefined && value.variant !== identity.variant) return failure("MODEL_VARIANT_MISMATCH", "variant must match exact_model_ref", "$.variant")
    variant = identity.variant
    if (!KNOWN_RUNTIME_IDS.has(exact)) return failure("MODEL_ID_UNKNOWN", "provider/model/variant is not an exact known runtime identity", "$.exact_model_ref")
  }
  if (value.project_scope === "xxl-job" || value.project_id === "xxl-job") {
    if (state !== "MODEL_UNASSIGNED") return failure("PROJECT_MODEL_UNASSIGNED", "xxl-job must remain MODEL_UNASSIGNED", "$.binding_state")
  }
  if (value.created_at !== undefined && !validUtc(value.created_at)) return failure("ROUTE_TIME_INVALID", "created_at must be a UTC ISO-8601 timestamp", "$.created_at")
  if (value.updated_at !== undefined && !validUtc(value.updated_at)) return failure("ROUTE_TIME_INVALID", "updated_at must be a UTC ISO-8601 timestamp", "$.updated_at")
  const normalized = {
    route_binding_id: routeId,
    role,
    workflow_scope: value.workflow_scope ?? "global",
    project_scope: value.project_scope ?? value.project_id ?? null,
    lane: value.lane ?? "default",
    provider,
    provider_id: provider,
    model_id: modelId,
    variant: exact && exact.includes("#") ? exact.split("#")[1] : null,
    exact_model_ref: exact,
    binding_state: state,
    config_revision: value.config_revision,
    source: value.source ?? "verified_config",
    reason: value.reason ?? "",
    created_at: value.created_at ?? nowUtc(),
    updated_at: value.updated_at ?? nowUtc(),
    idempotency_key: value.idempotency_key,
    payload_sha256: value.payload_sha256,
  }
  if (!isString(normalized.idempotency_key)) return failure("ROUTE_IDEMPOTENCY_KEY_REQUIRED", "idempotency_key is required", "$.idempotency_key")
  if (!isString(normalized.reason)) return failure("ROUTE_REASON_REQUIRED", "reason is required", "$.reason")
  return { ok: true, status: "INSERTED", value: normalized, inserted: true }
}

function insertAuditNoTx(store: ControlPlaneStore, value: AnyRecord): void {
  const canonical = canonicalizePlan12Json(value) as AnyRecord
  const digest = canonical.payload_sha256 ?? sha(canonical)
  const key = canonical.idempotency_key
  const prior = currentIdempotency(store, key)
  if (prior) {
    if (prior.payload_sha256 !== digest) throw new Error("EVIDENCE_IDEMPOTENCY_CONFLICT")
    return
  }
  reserveIdempotency(store, { ...canonical, fact_type: "model_route_audit" }, "model_route_audit_events", canonical.event_id, digest)
  store.db.prepare(`INSERT INTO model_route_audit_events
    (event_id,event_type,catalog_entry_id,route_binding_id,probe_id,config_revision,provider,model_id,exact_model_ref,status,endpoint,runtime_version,reason,detail_json,observed_at,idempotency_key,payload_sha256)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      canonical.event_id, canonical.event_type, canonical.catalog_entry_id ?? null, canonical.route_binding_id ?? null,
      canonical.probe_id ?? null, canonical.config_revision ?? null, canonical.provider ?? null, canonical.model_id ?? null,
      canonical.exact_model_ref ?? null, canonical.status, canonical.endpoint ?? null, canonical.runtime_version ?? null,
      canonical.reason ?? "", JSON.stringify(canonicalizePlan12Json(canonical.detail ?? {})), canonical.observed_at ?? nowUtc(), key, digest)
}
function audit(store: ControlPlaneStore, value: AnyRecord): void {
  store.db.exec("BEGIN IMMEDIATE")
  try { insertAuditNoTx(store, value); store.db.exec("COMMIT") } catch (error) { try { store.db.exec("ROLLBACK") } catch {}; throw error }
}
function classify(error: any): Failure {
  const detail = error?.message ?? String(error)
  if (/EVIDENCE_IDEMPOTENCY_CONFLICT/i.test(detail)) return failure("EVIDENCE_IDEMPOTENCY_CONFLICT", "idempotency key was used with a different digest", "$.idempotency_key")
  if (/FOREIGN KEY constraint failed/i.test(detail)) return failure("MODEL_CONFIG_REVISION_NOT_FOUND", "config_revision or related model record does not exist", "$.config_revision")
  if (/UNIQUE constraint failed/i.test(detail)) return failure("MODEL_RECORD_CONFLICT", "model or route record already exists")
  if (/APPEND_ONLY_(UPDATE|DELETE)_FORBIDDEN/i.test(detail)) return failure("MODEL_AUDIT_APPEND_ONLY", "model and route evidence is append-only")
  return failure("MODEL_DATABASE_WRITE_FAILED", detail)
}

export function appendModelCatalogEntry(store: ControlPlaneStore, input: AnyRecord): ModelRouteResult {
  const envelope = canonicalInput(input); if (!envelope.ok) return envelope
  const validation = validateModelCatalogRecord(envelope.value, store); if (!validation.ok) return validation
  const model = validation.value
  const prior = checkIdempotency(store, model.idempotency_key, envelope.digest); if (prior) return prior
  try {
    store.db.exec("BEGIN IMMEDIATE")
    reserveIdempotency(store, { ...model, fact_type: "model_catalog" }, "model_catalog", model.catalog_entry_id, envelope.digest)
    store.db.prepare(`INSERT INTO model_catalog
      (catalog_entry_id,provider,provider_id,model_id,variant,exact_model_ref,display_name,capability_json,availability_state,runtime_source,runtime_version,first_seen_at,last_seen_at,probe_status,probe_error,probe_id,metadata_sha256,config_revision,created_at,updated_at,idempotency_key,payload_sha256)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      model.catalog_entry_id, model.provider, model.provider_id, model.model_id, model.variant, model.exact_model_ref, model.display_name, model.capability_json,
      model.availability_state, model.runtime_source, model.runtime_version, model.first_seen_at, model.last_seen_at,
      model.probe_status, model.probe_error, model.probe_id, model.metadata_sha256, model.config_revision, model.created_at, model.updated_at,
      model.idempotency_key, envelope.digest)
    insertAuditNoTx(store, {
      event_id: id("audit"), event_type: model.availability_state === "AVAILABLE" ? "MODEL_PROBE" : "MODEL_STATUS_CHANGED",
      catalog_entry_id: model.catalog_entry_id, config_revision: model.config_revision, provider: model.provider, model_id: model.model_id,
      exact_model_ref: model.exact_model_ref, status: model.availability_state, runtime_version: model.runtime_version,
      reason: model.probe_error ?? "catalog entry recorded", detail: { probe_status: model.probe_status }, observed_at: model.updated_at,
      idempotency_key: `${model.idempotency_key}:audit`,
    })
    store.db.exec("COMMIT")
    return { ok: true, status: "INSERTED", value: store.db.prepare("SELECT * FROM model_catalog WHERE catalog_entry_id = ?").get(model.catalog_entry_id), inserted: true }
  } catch (error) { try { store.db.exec("ROLLBACK") } catch {}; return classify(error) }
}

export function appendRouteBinding(store: ControlPlaneStore, input: AnyRecord): ModelRouteResult {
  const envelope = canonicalInput(input); if (!envelope.ok) return envelope
  const validation = validateRouteBindingRecord(envelope.value, store); if (!validation.ok) return validation
  const route = validation.value
  const prior = checkIdempotency(store, route.idempotency_key, envelope.digest); if (prior) return prior
  if (route.binding_state === "BOUND") {
    const catalog = store.db.prepare("SELECT * FROM model_catalog WHERE exact_model_ref = ? AND config_revision = ? AND availability_state = 'AVAILABLE' ORDER BY updated_at DESC, rowid DESC LIMIT 1").get(route.exact_model_ref, route.config_revision) as any
    if (!catalog) return failure("MODEL_CATALOG_NOT_FOUND", "BOUND route requires an AVAILABLE catalog entry for the same config_revision", "$.exact_model_ref")
  }
  try {
    store.db.exec("BEGIN IMMEDIATE")
    reserveIdempotency(store, { ...route, fact_type: "route_binding" }, "route_bindings", route.route_binding_id, envelope.digest)
    store.db.prepare(`INSERT INTO route_bindings
      (route_binding_id,role,workflow_scope,project_scope,lane,provider,provider_id,model_id,variant,exact_model_ref,binding_state,config_revision,source,reason,created_at,updated_at,idempotency_key,payload_sha256)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      route.route_binding_id, route.role, route.workflow_scope, route.project_scope, route.lane, route.provider, route.provider_id, route.model_id, route.variant,
      route.exact_model_ref, route.binding_state, route.config_revision, route.source, route.reason, route.created_at, route.updated_at,
      route.idempotency_key, envelope.digest)
    insertAuditNoTx(store, {
      event_id: id("audit"), event_type: route.binding_state === "BOUND" ? "ROUTE_BOUND" : "ROUTE_REJECTED",
      route_binding_id: route.route_binding_id, config_revision: route.config_revision, provider: route.provider, model_id: route.model_id,
      exact_model_ref: route.exact_model_ref, status: route.binding_state, reason: route.reason, detail: { role: route.role, project_scope: route.project_scope },
      observed_at: route.updated_at, idempotency_key: `${route.idempotency_key}:audit`,
    })
    store.db.exec("COMMIT")
    return { ok: true, status: "INSERTED", value: store.db.prepare("SELECT * FROM route_bindings WHERE route_binding_id = ?").get(route.route_binding_id), inserted: true }
  } catch (error) { try { store.db.exec("ROLLBACK") } catch {}; return classify(error) }
}

export function recordRuntimeProbe(store: ControlPlaneStore, input: AnyRecord): ModelRouteResult {
  const envelope = canonicalInput(input); if (!envelope.ok) return envelope
  const value = envelope.value
  if (!isString(value.probe_id)) return failure("MODEL_PROBE_ID_REQUIRED", "probe_id is required", "$.probe_id")
  if (!isString(value.endpoint)) return failure("MODEL_PROBE_ENDPOINT_REQUIRED", "endpoint is required", "$.endpoint")
  if (!isString(value.observed_at)) return failure("MODEL_PROBE_TIME_REQUIRED", "observed_at is required", "$.observed_at")
  if (!validUtc(value.observed_at)) return failure("MODEL_PROBE_TIME_INVALID", "observed_at must be a UTC ISO-8601 timestamp", "$.observed_at")
  const rawProbeStatus = value.probe_status ?? "UNKNOWN"
  if (!new Set(["AVAILABLE", "UNAVAILABLE", "UNKNOWN", "REJECTED", "BLOCKED", "PASS", "VERIFIED"]).has(rawProbeStatus)) return failure("MODEL_PROBE_STATUS_INVALID", "probe_status is not a supported runtime probe state", "$.probe_status")
  const status = value.availability_state ?? (rawProbeStatus === "PASS" ? "AVAILABLE" : rawProbeStatus === "BLOCKED" ? "UNKNOWN" : rawProbeStatus)
  const persistedProbeStatus = ["PASS", "VERIFIED"].includes(rawProbeStatus) ? "AVAILABLE" : rawProbeStatus
  if ((status === "AVAILABLE") !== (persistedProbeStatus === "AVAILABLE")) return failure("MODEL_PROBE_STATE_MISMATCH", "availability_state and probe_status must agree on AVAILABLE", "$.availability_state")
  if (!MODEL_STATES.has(status)) return failure("MODEL_PROBE_STATE_INVALID", "probe availability_state is invalid", "$.availability_state")
  const tools = value.tools ?? value.tools_json ?? {}
  if (typeof value.workflow_plugin_loaded !== "boolean") return failure("MODEL_RUNTIME_PLUGIN_REQUIRED", "workflow_plugin_loaded must be explicitly true or false", "$.workflow_plugin_loaded")
  const requiredTools = ["workflow_plan", "workflow_run", "workflow_execute", "workflow_get", "workflow_list"]
  const availableTools = Array.isArray(tools) ? new Set(tools) : new Set(Object.keys(tools ?? {}).filter((key) => tools[key]))
  if (status === "AVAILABLE" && (!value.workflow_plugin_loaded || requiredTools.some((tool) => !availableTools.has(tool)))) return failure("MODEL_RUNTIME_PROBE_BLOCKED", "AVAILABLE requires the workflow-engine plugin and all required tools", "$.tools")
  const prior = checkIdempotency(store, value.idempotency_key, envelope.digest); if (prior) return prior
  if (value.config_revision) { const revisionError = revisionAllowed(store, value.config_revision); if (revisionError) return revisionError }
  if (value.provider !== undefined && value.provider_id !== undefined && value.provider !== value.provider_id) return failure("MODEL_PROVIDER_MISMATCH", "provider and provider_id must match exactly", "$.provider_id")
  const provider = value.provider ?? value.provider_id ?? null
  const modelId = value.model_id ?? null
  const exact = value.exact_model_ref ?? value.runtime_id ?? null
  if (provider !== null || modelId !== null || exact !== null) {
    const identity = exactIdentity(provider, modelId, exact); if (!identity.ok) return identity
    if (value.variant !== undefined && value.variant !== identity.variant) return failure("MODEL_VARIANT_MISMATCH", "variant must match exact_model_ref", "$.variant")
    if (!KNOWN_RUNTIME_IDS.has(exact)) return failure("MODEL_ID_UNKNOWN", "provider/model/variant is not an exact known runtime identity", "$.exact_model_ref")
  }
  try {
    store.db.exec("BEGIN IMMEDIATE")
    reserveIdempotency(store, { ...value, fact_type: "runtime_model_probe" }, "runtime_model_probes", value.probe_id, envelope.digest)
    store.db.prepare(`INSERT INTO runtime_model_probes
      (probe_id,endpoint,runtime_version,workflow_plugin_loaded,tools_json,provider,provider_id,model_id,exact_model_ref,probe_status,availability_state,probe_error,observed_at,config_revision,metadata_json,idempotency_key,payload_sha256)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      value.probe_id, value.endpoint, value.runtime_version ?? null, value.workflow_plugin_loaded ? 1 : 0, JSON.stringify(canonicalizePlan12Json(tools)),
      provider, provider, modelId, exact, persistedProbeStatus, status, value.probe_error ?? null, value.observed_at, value.config_revision ?? null,
      JSON.stringify(canonicalizePlan12Json(value.metadata ?? {})), value.idempotency_key, envelope.digest)
    insertAuditNoTx(store, {
      event_id: id("audit"), event_type: "MODEL_PROBE", probe_id: value.probe_id, config_revision: value.config_revision ?? null,
      provider, model_id: modelId, exact_model_ref: exact, status, endpoint: value.endpoint, runtime_version: value.runtime_version ?? null,
      reason: value.probe_error ?? "runtime probe recorded", detail: { tools }, observed_at: value.observed_at,
      idempotency_key: `${value.idempotency_key}:audit`,
    })
    store.db.exec("COMMIT")
    return { ok: true, status: "INSERTED", value: store.db.prepare("SELECT * FROM runtime_model_probes WHERE probe_id = ?").get(value.probe_id), inserted: true }
  } catch (error) { try { store.db.exec("ROLLBACK") } catch {}; return classify(error) }
}

export function recordModelRouteAudit(store: ControlPlaneStore, input: AnyRecord): ModelRouteResult {
  const envelope = canonicalInput(input); if (!envelope.ok) return envelope
  if (!isString(envelope.value.event_id)) return failure("MODEL_AUDIT_EVENT_ID_REQUIRED", "event_id is required", "$.event_id")
  if (!isString(envelope.value.event_type)) return failure("MODEL_AUDIT_EVENT_TYPE_REQUIRED", "event_type is required", "$.event_type")
  if (!isString(envelope.value.status)) return failure("MODEL_AUDIT_STATUS_REQUIRED", "status is required", "$.status")
  const prior = checkIdempotency(store, envelope.value.idempotency_key, envelope.digest); if (prior) return prior
  try { audit(store, envelope.value); return { ok: true, status: "INSERTED", value: store.db.prepare("SELECT * FROM model_route_audit_events WHERE event_id = ?").get(envelope.value.event_id), inserted: true } }
  catch (error) { return classify(error) }
}

function admissionFailure(store: ControlPlaneStore, row: any, revision: string, result: Failure): Failure {
  try {
    const persistedRouteId = row?.binding_state ? row.route_binding_id : null
    const stableObservedAt = row?.updated_at ?? lifecycle(store, revision)?.updated_at ?? "1970-01-01T00:00:00.000Z"
    const admissionKey = `admission:${row?.route_binding_id ?? "missing"}:${revision}:${result.code}`
    const admissionEventId = `admission-${sha256Canonical({ route_binding_id: row?.route_binding_id ?? null, revision, code: result.code }).slice(0, 40)}`
    audit(store, { event_id: admissionEventId, event_type: "ADMISSION_REJECTED", route_binding_id: persistedRouteId,
      config_revision: revision, provider: row?.provider ?? null, model_id: row?.model_id ?? null, exact_model_ref: row?.exact_model_ref ?? null,
      status: result.code, reason: result.detail, detail: { code: result.code, path: result.path ?? null, requested_route_binding_id: row?.route_binding_id ?? null }, observed_at: stableObservedAt,
      idempotency_key: admissionKey })
  } catch (error: any) {
    return failure("MODEL_AUDIT_WRITE_FAILED", `admission rejection could not be recorded: ${error?.message ?? String(error)}`, "$.audit")
  }
  return result
}

export function validateRouteBinding(store: ControlPlaneStore, routeBindingId: string, configRevision: string, options: AnyRecord = {}): ModelRouteResult {
  if (!isString(routeBindingId)) return failure("ROUTE_BINDING_ID_REQUIRED", "route_binding_id is required", "$.route_binding_id")
  if (!isString(configRevision)) return failure("MODEL_CONFIG_REVISION_REQUIRED", "config_revision is required", "$.config_revision")
  const lifecycleRow = lifecycle(store, configRevision)
  if (!lifecycleRow) return revisionAllowed(store, configRevision)!
  const row = store.db.prepare("SELECT * FROM route_bindings WHERE route_binding_id = ?").get(routeBindingId) as any
  if (!row) return admissionFailure(store, { route_binding_id: routeBindingId }, configRevision, failure("MODEL_ROUTE_REJECTED", "route binding was not found"))
  if (REVISION_BLOCKED.has(lifecycleRow.state)) return admissionFailure(store, row, configRevision, failure("MODEL_CONFIG_REVISION_CONFLICT", "route binding revision is superseded or rolled back"))
  if (row.config_revision !== configRevision) return admissionFailure(store, row, configRevision, failure("MODEL_CONFIG_REVISION_CONFLICT", "route binding config_revision does not match requested revision"))
  if (row.binding_state === "MODEL_UNASSIGNED") return admissionFailure(store, row, configRevision, failure("MODEL_UNASSIGNED", "route is MODEL_UNASSIGNED and cannot execute"))
  if (row.binding_state === "UNAVAILABLE") return admissionFailure(store, row, configRevision, failure("MODEL_UNAVAILABLE", "route model is unavailable"))
  if (row.binding_state === "REJECTED") return admissionFailure(store, row, configRevision, failure("MODEL_ROUTE_REJECTED", "route binding was rejected"))
  if (!isString(row.provider) || !isString(row.model_id) || !isString(row.exact_model_ref)) return admissionFailure(store, row, configRevision, failure("MODEL_ID_MISSING", "BOUND route lacks provider/model/exact_model_ref"))
  const catalog = store.db.prepare("SELECT * FROM model_catalog WHERE exact_model_ref = ? AND config_revision = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1").get(row.exact_model_ref, configRevision) as any
  if (!catalog) return admissionFailure(store, row, configRevision, failure("MODEL_CATALOG_NOT_FOUND", "BOUND route has no catalog entry"))
  if (catalog.availability_state !== "AVAILABLE") return admissionFailure(store, row, configRevision, failure("MODEL_UNAVAILABLE", `catalog model is ${catalog.availability_state}`))
  if ((!options.allowUnprobed && !["AVAILABLE", "PASS", "VERIFIED"].includes(catalog.probe_status)) || catalog.runtime_source !== "runtime_probe") return admissionFailure(store, row, configRevision, failure("MODEL_RUNTIME_PROBE_REQUIRED", "BOUND route requires a successful runtime probe"))
  if (options.runtime_version && catalog.runtime_version !== options.runtime_version) return admissionFailure(store, row, configRevision, failure("MODEL_RUNTIME_PROBE_REQUIRED", "runtime probe version does not match admission requirement"))
  return { ok: true, status: "ADMITTED", value: { route: row, catalog }, inserted: false }
}

export const admitRoute = validateRouteBinding
export const appendModelCatalog = appendModelCatalogEntry
export const appendRoute = appendRouteBinding
export const saveRuntimeProbe = recordRuntimeProbe

export function getModelCatalog(store: ControlPlaneStore, filter: { config_revision?: string; exact_model_ref?: string; availability_state?: string } = {}): any[] {
  const clauses: string[] = []; const params: any[] = []
  for (const field of ["config_revision", "exact_model_ref", "availability_state"] as const) if (filter[field]) { clauses.push(`${field} = ?`); params.push(filter[field]) }
  return store.db.prepare(`SELECT * FROM model_catalog${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY exact_model_ref, updated_at`).all(...params) as any[]
}
export function getModelCatalogEntry(store: ControlPlaneStore, catalogEntryId: string): any | null { return store.db.prepare("SELECT * FROM model_catalog WHERE catalog_entry_id = ?").get(catalogEntryId) as any ?? null }
export function getRouteBinding(store: ControlPlaneStore, routeBindingId: string): any | null { return store.db.prepare("SELECT * FROM route_bindings WHERE route_binding_id = ?").get(routeBindingId) as any ?? null }
export function listRouteBindings(store: ControlPlaneStore, filter: { config_revision?: string; role?: string; project_scope?: string; binding_state?: string } = {}): any[] {
  const clauses: string[] = []; const params: any[] = []
  for (const field of ["config_revision", "role", "project_scope", "binding_state"] as const) if (filter[field]) { clauses.push(`${field} = ?`); params.push(filter[field]) }
  return store.db.prepare(`SELECT * FROM route_bindings${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY role, project_scope, created_at`).all(...params) as any[]
}
export function listRuntimeProbes(store: ControlPlaneStore, filter: { exact_model_ref?: string; provider?: string; model_id?: string } = {}): any[] {
  const clauses: string[] = []; const params: any[] = []
  for (const field of ["exact_model_ref", "provider", "model_id"] as const) if (filter[field]) { clauses.push(`${field} = ?`); params.push(filter[field]) }
  return store.db.prepare(`SELECT * FROM runtime_model_probes${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY observed_at`).all(...params) as any[]
}
export function listModelRouteAudit(store: ControlPlaneStore, filter: { config_revision?: string; route_binding_id?: string; event_type?: string } = {}): any[] {
  const clauses: string[] = []; const params: any[] = []
  for (const field of ["config_revision", "route_binding_id", "event_type"] as const) if (filter[field]) { clauses.push(`${field} = ?`); params.push(filter[field]) }
  return store.db.prepare(`SELECT * FROM model_route_audit_events${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY observed_at, event_id`).all(...params) as any[]
}
