import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import {
  validateExecutionEvent,
  validateModelCatalogEntry,
  validateRouteBinding,
  validateWorkflowConfigSnapshot,
  validateWorkflowLockEvent,
  validateWorkflowRunFact,
  validateWorkflowWaveFact,
  validateWorkflowWaveNodeFact,
  type Plan12ValidationContext,
  sha256Canonical,
} from "./plan12-contract.ts"

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
const SCHEMA_FILE = path.join(MODULE_DIR, "plan12-control-plane-schema.sql")
const SCHEMA_VERSION = 1
const WORKFLOW_RUN_EVENT_TYPES = new Set(["ACQUIRE", "WAIT", "RELEASE", "CONFLICT", "EXPIRE", "RUN_STARTED", "WAVE_STARTED", "NODE_STARTED", "NODE_FINISHED", "WAVE_FINISHED", "RUN_FINISHED", "EVIDENCE_WRITE_FAILED"])

type Fact = Record<string, any>
type Result = { ok: true; status: "INSERTED" | "IDEMPOTENT"; value: any; inserted: boolean } | { ok: false; status: "REJECTED"; code: string; detail: string; path?: string }

export type Plan12PathEnvelope = {
  policy: "explicit-runtime-root-v1"
  runtime_root: string
  runtime_root_real: string
  requested_db_path: string
  control_plane_db: string
  control_plane_db_real: string
  existing_ancestor_real: string
  allowed_roots: string[]
  allowed_roots_real: string[]
  environment_root_observed: string | null
  environment_root_used: false
}

function within(candidate: string, allowed: string): boolean {
  const relative = path.relative(allowed, candidate)
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
}

/** Resolve a possibly-not-yet-created path through the nearest existing
 * ancestor. This catches a symlink/junction in any existing parent while
 * still allowing fixture initialization to create the final directory/file. */
function realpathThroughExistingAncestor(input: string): { resolved: string; ancestorReal: string } {
  const missing: string[] = []
  let cursor = path.resolve(input)
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor)
    if (parent === cursor) throw new Error("CONTROL_PLANE_DB_EXISTING_ANCESTOR_NOT_FOUND")
    missing.unshift(path.basename(cursor))
    cursor = parent
  }
  const ancestorReal = fs.realpathSync(cursor)
  return { resolved: path.resolve(ancestorReal, ...missing), ancestorReal }
}

/** One path policy for fixture initialization, Workflow Runtime and the
 * Completion Guard. runtimeRoot is always explicit: AI_DEV_ROOT is observed
 * for diagnostics only and is never a fallback. Every lexical path is checked
 * again after existing/ancestor realpath resolution so junction escapes fail
 * closed before a DB is opened or created. */
export function resolveControlPlanePathEnvelope(options: {
  dbPath?: string
  runtimeRoot?: string
  allowedRoots?: string[]
  requireExisting?: boolean
  productionRoot?: string | null
  forbidProductionDefault?: boolean
} = {}): Plan12PathEnvelope {
  const requested = typeof options.dbPath === "string" ? options.dbPath.trim() : ""
  if (!requested) throw new Error("CONTROL_PLANE_DB_PATH_REQUIRED")
  if (typeof options.runtimeRoot !== "string" || !options.runtimeRoot.trim()) throw new Error("CONTROL_PLANE_DB_RUNTIME_ROOT_REQUIRED")
  const rootLexical = path.resolve(options.runtimeRoot)
  if (!fs.existsSync(rootLexical)) throw new Error("CONTROL_PLANE_DB_RUNTIME_ROOT_NOT_FOUND")
  const rootReal = fs.realpathSync(rootLexical)
  const targetLexical = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(rootLexical, requested)
  const configuredAllowed = Array.isArray(options.allowedRoots) && options.allowedRoots.length > 0
    ? options.allowedRoots
    : [rootLexical]
  const allowedLexical = configuredAllowed.map((entry) => {
    if (typeof entry !== "string" || !entry.trim()) throw new Error("CONTROL_PLANE_DB_ALLOWED_ROOT_INVALID")
    return path.isAbsolute(entry) ? path.resolve(entry) : path.resolve(rootLexical, entry)
  })
  if (!allowedLexical.some((allowed) => within(targetLexical, allowed))) throw new Error("CONTROL_PLANE_DB_OUTSIDE_ALLOWED_ROOTS")
  const target = realpathThroughExistingAncestor(targetLexical)
  const allowedReal = allowedLexical.map((allowed) => realpathThroughExistingAncestor(allowed).resolved)
  if (!allowedReal.some((allowed) => within(target.resolved, allowed))) throw new Error("CONTROL_PLANE_DB_SYMLINK_ESCAPE")
  if (options.requireExisting === true && !fs.existsSync(targetLexical)) throw new Error("CONTROL_PLANE_DB_NOT_FOUND")
  const targetReal = fs.existsSync(targetLexical) ? fs.realpathSync(targetLexical) : target.resolved
  if (!allowedReal.some((allowed) => within(targetReal, allowed))) throw new Error("CONTROL_PLANE_DB_SYMLINK_ESCAPE")
  if (options.forbidProductionDefault === true && typeof options.productionRoot === "string" && options.productionRoot.trim()) {
    const production = realpathThroughExistingAncestor(path.resolve(options.productionRoot, "runtime", "control-plane.db")).resolved
    if (targetReal.toLowerCase() === production.toLowerCase()) throw new Error("CONTROL_PLANE_DB_PRODUCTION_DEFAULT_FORBIDDEN")
  }
  return {
    policy: "explicit-runtime-root-v1",
    runtime_root: rootLexical,
    runtime_root_real: rootReal,
    requested_db_path: requested,
    control_plane_db: targetLexical,
    control_plane_db_real: targetReal,
    existing_ancestor_real: target.ancestorReal,
    allowed_roots: allowedLexical,
    allowed_roots_real: allowedReal,
    environment_root_observed: typeof process.env.AI_DEV_ROOT === "string" && process.env.AI_DEV_ROOT.trim() ? path.resolve(process.env.AI_DEV_ROOT) : null,
    environment_root_used: false,
  }
}

export function resolveControlPlaneDatabasePath(options: { dbPath?: string; runtimeRoot?: string; allowedRoots?: string[] } = {}): string {
  return resolveControlPlanePathEnvelope(options).control_plane_db_real
}

class ControlPlaneAbort extends Error {
  result: Result

  constructor(result: Result) {
    super(result.ok ? result.status : result.detail)
    this.name = "ControlPlaneAbort"
    this.result = result
  }
}

function failure(code: string, detail: string, path?: string): Result {
  return { ok: false, status: "REJECTED", code, detail, ...(path ? { path } : {}) }
}

function nowUtc(): string {
  return new Date().toISOString()
}

function validUtc(value: any): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return false
  try {
    const normalized = value.replace(/\.(\d{1,2})Z$/, (_match, fraction) => `.${fraction.padEnd(3, "0")}Z`).replace(/T(\d{2}:\d{2}:\d{2})Z$/, "T$1.000Z")
    return new Date(value).toISOString() === normalized
  } catch { return false }
}

function validHash(value: any): boolean { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) }

function tableForFact(factType: string): string | null {
  return {
    workflow_run: "workflow_runs",
    workflow_wave: "workflow_waves",
    workflow_wave_node: "workflow_wave_nodes",
    workflow_lock_event: "workflow_lock_events",
    execution_event: "execution_events",
    workflow_config_snapshot: "workflow_config_snapshots",
  }[factType] ?? null
}

function recordKeyForFact(fact: Fact): string {
  switch (fact.fact_type) {
    case "workflow_run": return fact.run_id
    case "workflow_wave": return JSON.stringify([fact.run_id, fact.wave_id])
    case "workflow_wave_node": return JSON.stringify([fact.run_id, fact.wave_id, fact.node_id, fact.attempt])
    case "workflow_lock_event": return fact.event_id
    case "execution_event": return fact.event_id
    case "workflow_config_snapshot": return fact.config_revision
    default: return fact.idempotency_key ?? "unknown"
  }
}

function configureDatabase(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = ON")
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec("PRAGMA journal_mode = WAL")
}

function dbFrom(value: ControlPlaneStore | DatabaseSync): DatabaseSync {
  return value instanceof ControlPlaneStore ? value.db : value
}

export function migrateControlPlaneDatabase(target: ControlPlaneStore | DatabaseSync): { ok: true; schema_version: number } {
  const db = dbFrom(target)
  configureDatabase(db)
  const schema = fs.readFileSync(SCHEMA_FILE, "utf8")
  db.exec("BEGIN IMMEDIATE")
  try {
    db.exec(schema)
    // Keep the v1 table shape compatible while allowing lifecycle envelopes
    // to carry verified runtime location metadata. Existing databases created
    // before this column was introduced are migrated in place.
    const eventColumns = db.prepare("PRAGMA table_info(workflow_run_events)").all() as any[]
    if (!eventColumns.some((column) => column.name === "payload_json")) db.exec("ALTER TABLE workflow_run_events ADD COLUMN payload_json TEXT")
    const nodeColumns = db.prepare("PRAGMA table_info(workflow_wave_nodes)").all() as any[]
    if (!nodeColumns.some((column) => column.name === "model_runtime_id")) db.exec("ALTER TABLE workflow_wave_nodes ADD COLUMN model_runtime_id TEXT")
    db.prepare("INSERT OR IGNORE INTO control_plane_meta(key, value) VALUES (?, ?)").run("schema_version", String(SCHEMA_VERSION))
    db.prepare("INSERT OR IGNORE INTO control_plane_meta(key, value) VALUES (?, ?)").run("created_at", nowUtc())
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    db.exec("COMMIT")
    return { ok: true, schema_version: SCHEMA_VERSION }
  } catch (error) {
    try { db.exec("ROLLBACK") } catch {}
    throw error
  }
}

export function initializeControlPlaneDatabase(options: { dbPath: string; runtimeRoot: string; allowedRoots?: string[] }): ControlPlaneStore {
  const pathEnvelope = resolveControlPlanePathEnvelope(options)
  const dbPath = pathEnvelope.control_plane_db_real
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  try {
    migrateControlPlaneDatabase(db)
    return new ControlPlaneStore(db, dbPath, pathEnvelope)
  } catch (error) {
    try { db.close() } catch {}
    throw error
  }
}

function loadContext(db: DatabaseSync): Plan12ValidationContext {
  const context: Plan12ValidationContext = {
    idempotency: new Map(),
    runIds: new Map(),
    runAttempts: new Map(),
    workflowRevisions: new Map(),
    waveIndexes: new Map(),
    lockSequences: new Map(),
    executionSequences: new Map(),
    nodeEventSequences: new Map(),
    snapshots: new Map(),
    activeRevision: null,
  }
  for (const row of db.prepare("SELECT idempotency_key, payload_sha256 FROM evidence_idempotency").all() as any[]) context.idempotency!.set(row.idempotency_key, row.payload_sha256)
  for (const row of db.prepare("SELECT * FROM workflow_config_snapshots").all() as any[]) {
    context.snapshots!.set(row.config_revision, row)
    if (row.state === "ACTIVE") context.activeRevision = row.config_revision
  }
  for (const row of db.prepare("SELECT run_id, payload_sha256, attempt, workflow_id, config_revision FROM workflow_runs").all() as any[]) {
    context.runIds!.set(row.run_id, row.payload_sha256)
    context.runAttempts!.set(row.run_id, row.attempt)
    context.workflowRevisions!.set(row.workflow_id, row.config_revision)
  }
  for (const row of db.prepare("SELECT run_id, wave_index, payload_sha256 FROM workflow_waves").all() as any[]) {
    const index = context.waveIndexes!.get(row.run_id) ?? new Map<number, string>()
    index.set(row.wave_index, row.payload_sha256)
    context.waveIndexes!.set(row.run_id, index)
  }
  for (const row of db.prepare("SELECT run_id, lock_key, sequence FROM workflow_lock_events").all() as any[]) {
    const key = `${row.run_id}:${row.lock_key}`
    context.lockSequences!.set(key, Math.max(context.lockSequences!.get(key) ?? 0, row.sequence))
  }
  for (const row of db.prepare("SELECT run_id, sequence FROM execution_events").all() as any[]) {
    context.executionSequences!.set(row.run_id, Math.max(context.executionSequences!.get(row.run_id) ?? 0, row.sequence))
  }
  for (const row of db.prepare("SELECT run_id, event_seq FROM workflow_wave_nodes").all() as any[]) {
    context.nodeEventSequences!.set(row.run_id, Math.max(context.nodeEventSequences!.get(row.run_id) ?? 0, row.event_seq))
  }
  return context
}

function validateFact(fact: Fact, context: Plan12ValidationContext): any {
  switch (fact.fact_type) {
    case "workflow_run": return validateWorkflowRunFact(fact, context)
    case "workflow_wave": return validateWorkflowWaveFact(fact, context)
    case "workflow_wave_node": return validateWorkflowWaveNodeFact(fact, context)
    case "workflow_lock_event": return validateWorkflowLockEvent(fact, context)
    case "execution_event": return validateExecutionEvent(fact, context)
    case "workflow_config_snapshot": return validateWorkflowConfigSnapshot(fact, context)
    default: return failure("FACT_TYPE_UNSUPPORTED", "fact_type is not supported by Plan 12.2", "$.fact_type")
  }
}

function normalizedRow(db: DatabaseSync, table: string, keyColumns: Record<string, any>): any | null {
  const where = Object.keys(keyColumns).map((key) => `${key} = ?`).join(" AND ")
  return db.prepare(`SELECT * FROM ${table} WHERE ${where}`).get(...Object.values(keyColumns)) as any ?? null
}

function existingByIdempotency(db: DatabaseSync, key: string): any | null {
  const evidence = db.prepare("SELECT * FROM evidence_idempotency WHERE idempotency_key = ?").get(key) as any
  if (!evidence) return null
  const row = normalizedRow(db, evidence.table_name, evidence.table_name === "workflow_config_snapshots"
    ? { config_revision: evidence.record_key }
    : evidence.table_name === "workflow_runs"
      ? { run_id: evidence.record_key }
      : evidence.table_name === "workflow_waves"
        ? (() => { const [run_id, wave_id] = JSON.parse(evidence.record_key); return { run_id, wave_id } })()
        : evidence.table_name === "workflow_wave_nodes"
          ? (() => { const [run_id, wave_id, node_id, attempt] = JSON.parse(evidence.record_key); return { run_id, wave_id, node_id, attempt: Number(attempt) } })()
          : { event_id: evidence.record_key })
  return { metadata: evidence, row }
}

function deriveWorkflowId(db: DatabaseSync, fact: Fact): string | null {
  if (!fact.run_id) return fact.workflow_id ?? null
  const actual = (db.prepare("SELECT workflow_id FROM workflow_runs WHERE run_id = ?").get(fact.run_id) as any)?.workflow_id ?? null
  if (actual && fact.workflow_id && actual !== fact.workflow_id) throw new Error("WORKFLOW_ID_MISMATCH")
  return actual
}

function insertRow(db: DatabaseSync, table: string, row: Record<string, any>): void {
  const columns = Object.keys(row)
  const placeholders = columns.map(() => "?").join(",")
  db.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${placeholders})`).run(...columns.map((column) => row[column]))
}

function insertFact(db: DatabaseSync, fact: Fact): void {
  const table = tableForFact(fact.fact_type)!
  const common = {
    schema_version: fact.schema_version,
    config_revision: fact.config_revision,
    source: fact.source,
    observed_at: fact.observed_at,
    payload_sha256: fact.payload_sha256,
    idempotency_key: fact.idempotency_key,
    evidence_level: fact.evidence_level,
    fact_type: fact.fact_type,
  }
  if (fact.fact_type === "workflow_config_snapshot") {
    insertRow(db, table, { ...common, parent_revision: fact.parent_revision, source_kind: fact.source_kind, drawio_raw_sha256: fact.drawio_raw_sha256, drawio_semantic_sha256: fact.drawio_semantic_sha256, ir_sha256: fact.ir_sha256, config_digest: fact.config_digest, model_catalog_digest: fact.model_catalog_digest, route_bindings_digest: fact.route_bindings_digest, canonical_json: fact.canonical_json, state: fact.state, created_by: fact.created_by, created_at: fact.created_at, activated_at: fact.activated_at, rollback_of: fact.rollback_of })
    return
  }
  if (fact.fact_type === "workflow_run") {
    insertRow(db, table, { ...common, run_id: fact.run_id, workflow_id: fact.workflow_id, parent_run_id: fact.parent_run_id, plan_digest: fact.plan_digest, attempt: fact.attempt, trigger: fact.trigger, project_id: fact.project_id, status: fact.status, started_at: fact.started_at, ended_at: fact.ended_at, outcome_digest: fact.outcome_digest, evidence_write_status: fact.evidence_write_status, error_code: fact.error_code, error_detail: fact.error_detail, engine_version: fact.engine_version })
    return
  }
  if (fact.fact_type === "workflow_wave") {
    const workflowId = deriveWorkflowId(db, fact)
    if (!workflowId) throw new Error("WORKFLOW_ID_NOT_FOUND")
    insertRow(db, table, { ...common, run_id: fact.run_id, wave_id: fact.wave_id, workflow_id: workflowId, wave_index: fact.wave_index, ready_set_digest: fact.ready_set_digest, policy_digest: fact.policy_digest, parallelism: fact.parallelism, status: fact.status, started_at: fact.started_at, ended_at: fact.ended_at, lock_snapshot_json: fact.lock_snapshot_json, evidence_digest: fact.evidence_digest })
    return
  }
  if (fact.fact_type === "workflow_wave_node") {
    const workflowId = deriveWorkflowId(db, fact)
    if (!workflowId) throw new Error("WORKFLOW_ID_NOT_FOUND")
    insertRow(db, table, { ...common, run_id: fact.run_id, wave_id: fact.wave_id, node_id: fact.node_id, attempt: fact.attempt, workflow_id: workflowId, task_id: fact.task_id, route: fact.route, resource_digest: fact.resource_digest, lock_key_json: fact.lock_key_json, session_key: fact.session_key ?? null, session_id: fact.session_id, model_runtime_id: fact.model_runtime_id ?? null, status: fact.status, event_seq: fact.event_seq, started_at: fact.started_at, ended_at: fact.ended_at, result_digest: fact.result_digest, error_code: fact.error_code })
    return
  }
  if (fact.fact_type === "workflow_lock_event") {
    insertRow(db, table, { ...common, event_id: fact.event_id, run_id: fact.run_id, wave_id: fact.wave_id, node_id: fact.node_id, lock_key: fact.lock_key, event_type: fact.event_type, owner_token: fact.owner_token, sequence: fact.sequence, occurred_at: fact.occurred_at, outcome: fact.outcome, error_code: fact.error_code })
    return
  }
  const workflowId = deriveWorkflowId(db, fact)
  if (!workflowId) throw new Error("WORKFLOW_ID_NOT_FOUND")
  insertRow(db, table, { ...common, event_id: fact.event_id, run_id: fact.run_id, workflow_id: workflowId, wave_id: fact.wave_id, node_id: fact.node_id, task_id: fact.task_id, attempt: fact.attempt, event_type: fact.event_type, status: fact.status, sequence: fact.sequence, payload_digest: fact.payload_digest, payload_ref: fact.payload_ref, occurred_at: fact.occurred_at, error_code: fact.error_code })
}

function classifySqlError(error: any): { code: string; detail: string } {
  const detail = error?.message ?? String(error)
  if (/WORKFLOW_ID_NOT_FOUND/i.test(detail)) return { code: "FOREIGN_KEY_CONSTRAINT", detail: "workflow run foreign key was not found" }
  if (/WORKFLOW_ID_MISMATCH/i.test(detail)) return { code: "WORKFLOW_ID_MISMATCH", detail: "fact workflow_id differs from the persisted workflow run" }
  if (/FOREIGN KEY constraint failed/i.test(detail)) return { code: "FOREIGN_KEY_CONSTRAINT", detail }
  if (/APPEND_ONLY_UPDATE_FORBIDDEN/i.test(detail)) return { code: "APPEND_ONLY_UPDATE_FORBIDDEN", detail }
  if (/APPEND_ONLY_DELETE_FORBIDDEN/i.test(detail)) return { code: "APPEND_ONLY_DELETE_FORBIDDEN", detail }
  if (/UNIQUE constraint failed/i.test(detail)) return { code: "NATURAL_KEY_CONFLICT", detail }
  if (/CHECK constraint failed/i.test(detail)) return { code: "STATE_OR_ENUM_CONSTRAINT", detail }
  return { code: "DATABASE_WRITE_FAILED", detail }
}

export class ControlPlaneStore {
  readonly db: DatabaseSync
  readonly dbPath: string
  readonly pathEnvelope: Plan12PathEnvelope | null

  constructor(db: DatabaseSync, dbPath: string, pathEnvelope: Plan12PathEnvelope | null = null) {
    this.db = db
    this.dbPath = dbPath
    this.pathEnvelope = pathEnvelope
  }

  close(): void { this.db.close() }

  private appendInternal(fact: Fact): Result {
    const table = tableForFact(fact.fact_type)
    if (!table) return failure("FACT_TYPE_UNSUPPORTED", "fact_type is not supported by Plan 12.2", "$.fact_type")
    const hasEnvelopeShape = ["schema_version", "config_revision", "source", "observed_at", "payload_sha256", "idempotency_key", "evidence_level"].every((field) => Object.prototype.hasOwnProperty.call(fact, field) && fact[field] !== null && fact[field] !== "")
    if (hasEnvelopeShape && typeof fact.idempotency_key === "string" && typeof fact.payload_sha256 === "string") {
      const prior = existingByIdempotency(this.db, fact.idempotency_key)
      if (prior) {
        if (prior.metadata.payload_sha256 !== fact.payload_sha256) return failure("EVIDENCE_IDEMPOTENCY_CONFLICT", "idempotency key was used with a different digest", "$.idempotency_key")
        return { ok: true, status: "IDEMPOTENT", value: prior.row, inserted: false }
      }
    }
    const validation = validateFact(fact, loadContext(this.db))
    if (!validation.ok) return failure(validation.code, validation.detail, validation.path)
    const normalized = validation.value
    const existing = existingByIdempotency(this.db, normalized.idempotency_key)
    if (existing) {
      if (existing.metadata.payload_sha256 !== normalized.payload_sha256) return failure("EVIDENCE_IDEMPOTENCY_CONFLICT", "idempotency key was used with a different digest", "$.idempotency_key")
      return { ok: true, status: "IDEMPOTENT", value: existing.row, inserted: false }
    }
    try {
      const createdAt = nowUtc()
      this.db.prepare("INSERT INTO evidence_idempotency(idempotency_key, payload_sha256, fact_type, table_name, record_key, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(normalized.idempotency_key, normalized.payload_sha256, normalized.fact_type, table, recordKeyForFact(normalized), createdAt)
      insertFact(this.db, normalized)
      return { ok: true, status: "INSERTED", value: normalizedRow(this.db, table, table === "workflow_config_snapshots" ? { config_revision: normalized.config_revision } : table === "workflow_runs" ? { run_id: normalized.run_id } : table === "workflow_waves" ? { run_id: normalized.run_id, wave_id: normalized.wave_id } : table === "workflow_wave_nodes" ? { run_id: normalized.run_id, wave_id: normalized.wave_id, node_id: normalized.node_id, attempt: normalized.attempt } : { event_id: normalized.event_id }), inserted: true }
    } catch (error: any) {
      throw new ControlPlaneAbort(failure(classifySqlError(error).code, classifySqlError(error).detail))
    }
  }

  appendEvidence(fact: Fact): Result {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const result = this.appendInternal(fact)
      if (!result.ok) { this.db.exec("ROLLBACK"); return result }
      this.db.exec("COMMIT")
      return result
    } catch (error: any) {
      try { this.db.exec("ROLLBACK") } catch {}
      if (error instanceof ControlPlaneAbort) return error.result
      return failure(classifySqlError(error).code, classifySqlError(error).detail)
    }
  }

  appendEvidenceBatch(facts: Fact[]): Result[] {
    const results: Result[] = []
    this.db.exec("BEGIN IMMEDIATE")
    try {
      for (const fact of facts) {
        const result = this.appendInternal(fact)
        results.push(result)
        if (!result.ok) { this.db.exec("ROLLBACK"); return results }
      }
      this.db.exec("COMMIT")
      return results
    } catch (error: any) {
      try { this.db.exec("ROLLBACK") } catch {}
      results.push(error instanceof ControlPlaneAbort ? error.result : failure(classifySqlError(error).code, classifySqlError(error).detail))
      return results
    }
  }

  appendWorkflowRun(fact: Fact): Result { return this.appendEvidence(fact) }
  appendWorkflowWave(fact: Fact): Result { return this.appendEvidence(fact) }
  appendWorkflowWaveNode(fact: Fact): Result { return this.appendEvidence(fact) }
  appendWorkflowLockEvent(fact: Fact): Result { return this.appendEvidence(fact) }
  appendExecutionEvent(fact: Fact): Result { return this.appendEvidence(fact) }
  appendWorkflowConfigSnapshot(fact: Fact): Result { return this.appendEvidence(fact) }

  /** Append-only run/wave/node lifecycle events.  This table deliberately
   * has no wave/node foreign keys so RUN_STARTED can be recorded before the
   * first wave exists; node-scoped execution_events remain strict. */
  appendWorkflowRunEvent(fact: Fact): Result {
    const required = ["event_id", "run_id", "workflow_id", "event_type", "status", "sequence", "config_revision", "source", "observed_at", "payload_sha256", "idempotency_key", "evidence_level", "fact_type", "payload_digest", "payload_ref", "occurred_at"]
    for (const field of required) if (fact?.[field] === undefined || fact?.[field] === null || fact?.[field] === "") return failure("FIELD_REQUIRED", `${field} is required`, `$.${field}`)
    if (fact.fact_type !== "workflow_run_event" || fact.evidence_level !== "L3") return failure("FACT_TYPE_INVALID", "workflow run events must be L3 workflow_run_event facts", "$.fact_type")
    if (!WORKFLOW_RUN_EVENT_TYPES.has(fact.event_type)) return failure("EVENT_TYPE_INVALID", "workflow run event_type is not supported", "$.event_type")
    if (!Number.isInteger(fact.sequence) || fact.sequence < 1) return failure("SEQUENCE_INVALID", "sequence must be >= 1", "$.sequence")
    if (!validUtc(fact.observed_at) || !validUtc(fact.occurred_at)) return failure("EVIDENCE_TIME_INVALID", "observed_at and occurred_at must be UTC ISO-8601 timestamps", "$.occurred_at")
    if (!validHash(fact.payload_sha256) || !validHash(fact.payload_digest)) return failure("EVIDENCE_HASH_INVALID", "payload_sha256 and payload_digest must be lowercase SHA-256 digests", "$.payload_sha256")
    try {
      const { payload_sha256: _ignored, ...body } = fact
      if (sha256Canonical(body) !== fact.payload_sha256) return failure("PAYLOAD_HASH_MISMATCH", "payload_sha256 does not match the canonical lifecycle event", "$.payload_sha256")
    } catch (error: any) {
      return failure(error?.code ?? "INVALID_JSON_VALUE", error?.detail ?? String(error), error?.path ?? "$")
    }
    const prior = this.db.prepare("SELECT * FROM workflow_run_events WHERE idempotency_key = ?").get(fact.idempotency_key) as any
    if (prior) return prior.payload_sha256 === fact.payload_sha256
      ? { ok: true, status: "IDEMPOTENT", value: prior, inserted: false }
      : failure("EVIDENCE_IDEMPOTENCY_CONFLICT", "idempotency key was used with a different digest", "$.idempotency_key")
    const identities = this.db.prepare("SELECT DISTINCT workflow_id FROM workflow_run_events WHERE run_id = ?").all(fact.run_id) as any[]
    if (identities.some((row) => row.workflow_id !== fact.workflow_id)) return failure("WORKFLOW_ID_MISMATCH", "run_id is already bound to a different workflow_id", "$.workflow_id")
    const existing = this.db.prepare("SELECT MAX(sequence) AS sequence FROM workflow_run_events WHERE run_id = ?").get(fact.run_id) as any
    if (existing?.sequence !== null && existing?.sequence !== undefined && Number(fact.sequence) !== Number(existing.sequence) + 1) return failure("SEQUENCE_NONCONTIGUOUS", "lifecycle event sequence must advance by exactly one", "$.sequence")
    try {
      this.db.exec("BEGIN IMMEDIATE")
      const columns = Object.keys(fact).filter((column) => column !== "payload_json" || fact.payload_json !== undefined)
      this.db.prepare(`INSERT INTO workflow_run_events (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...columns.map((column) => fact[column]))
      const row = this.db.prepare("SELECT * FROM workflow_run_events WHERE event_id = ?").get(fact.event_id) as any
      this.db.exec("COMMIT")
      return { ok: true, status: "INSERTED", value: row, inserted: true }
    } catch (error: any) {
      try { this.db.exec("ROLLBACK") } catch {}
      return failure(/UNIQUE constraint/i.test(error?.message ?? "") ? "NATURAL_KEY_CONFLICT" : "DATABASE_WRITE_FAILED", error?.message ?? String(error))
    }
  }

  getWorkflowRun(runId: string): any | null { return this.db.prepare("SELECT * FROM workflow_runs WHERE run_id = ?").get(runId) as any ?? null }
  listWorkflowWaves(filter: { run_id?: string; workflow_id?: string } = {}): any[] {
    const clauses: string[] = []; const params: any[] = []
    if (filter.run_id) { clauses.push("run_id = ?"); params.push(filter.run_id) }
    if (filter.workflow_id) { clauses.push("workflow_id = ?"); params.push(filter.workflow_id) }
    return this.db.prepare(`SELECT * FROM workflow_waves${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY run_id, wave_index`).all(...params) as any[]
  }
  listWorkflowWaveNodes(filter: { run_id?: string; wave_id?: string; node_id?: string } = {}): any[] {
    const clauses: string[] = []; const params: any[] = []
    for (const field of ["run_id", "wave_id", "node_id"] as const) if (filter[field]) { clauses.push(`${field} = ?`); params.push(filter[field]) }
    return this.db.prepare(`SELECT * FROM workflow_wave_nodes${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY run_id, wave_id, event_seq`).all(...params) as any[]
  }
  listExecutionEvents(filter: { run_id?: string; workflow_id?: string; wave_id?: string; node_id?: string } = {}): any[] {
    const clauses: string[] = []; const params: any[] = []
    for (const field of ["run_id", "workflow_id", "wave_id", "node_id"] as const) if (filter[field]) { clauses.push(`${field} = ?`); params.push(filter[field]) }
    return this.db.prepare(`SELECT * FROM execution_events${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY run_id, sequence`).all(...params) as any[]
  }
  listWorkflowRunEvents(filter: { run_id?: string; workflow_id?: string; event_type?: string } = {}): any[] {
    const clauses: string[] = []; const params: any[] = []
    for (const field of ["run_id", "workflow_id", "event_type"] as const) if (filter[field]) { clauses.push(`${field} = ?`); params.push(filter[field]) }
    return this.db.prepare(`SELECT * FROM workflow_run_events${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY run_id, sequence`).all(...params) as any[]
  }
  getEvidenceByIdempotencyKey(key: string): any | null { return existingByIdempotency(this.db, key) }
}

export function appendEvidence(store: ControlPlaneStore, fact: Fact): Result { return store.appendEvidence(fact) }
export function appendWorkflowRun(store: ControlPlaneStore, fact: Fact): Result { return store.appendWorkflowRun(fact) }
export function appendWorkflowWave(store: ControlPlaneStore, fact: Fact): Result { return store.appendWorkflowWave(fact) }
export function appendWorkflowWaveNode(store: ControlPlaneStore, fact: Fact): Result { return store.appendWorkflowWaveNode(fact) }
export function appendWorkflowLockEvent(store: ControlPlaneStore, fact: Fact): Result { return store.appendWorkflowLockEvent(fact) }
export function appendExecutionEvent(store: ControlPlaneStore, fact: Fact): Result { return store.appendExecutionEvent(fact) }
export function appendWorkflowConfigSnapshot(store: ControlPlaneStore, fact: Fact): Result { return store.appendWorkflowConfigSnapshot(fact) }
export function appendWorkflowRunEvent(store: ControlPlaneStore, fact: Fact): Result { return store.appendWorkflowRunEvent(fact) }
export function getWorkflowRun(store: ControlPlaneStore, runId: string): any | null { return store.getWorkflowRun(runId) }
export function listWorkflowWaves(store: ControlPlaneStore, filter: { run_id?: string; workflow_id?: string } = {}): any[] { return store.listWorkflowWaves(filter) }
export function listWorkflowWaveNodes(store: ControlPlaneStore, filter: { run_id?: string; wave_id?: string; node_id?: string } = {}): any[] { return store.listWorkflowWaveNodes(filter) }
export function listExecutionEvents(store: ControlPlaneStore, filter: { run_id?: string; workflow_id?: string; wave_id?: string; node_id?: string } = {}): any[] { return store.listExecutionEvents(filter) }
export function getEvidenceByIdempotencyKey(store: ControlPlaneStore, key: string): any | null { return store.getEvidenceByIdempotencyKey(key) }
export function listWorkflowRunEvents(store: ControlPlaneStore, filter: { run_id?: string; workflow_id?: string; event_type?: string } = {}): any[] { return store.listWorkflowRunEvents(filter) }
