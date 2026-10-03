import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { sha256Canonical } from "./plan12-contract.ts"

type AnyRecord = Record<string, any>

const TERMINAL_NODE_STATES = new Set(["COMPLETED", "REVIEW_PASSED"])
const TERMINAL_RUN_STATES = new Set(["COMPLETED"])
const LOCK_EVENTS = new Set(["ACQUIRE", "WAIT", "RELEASE", "CONFLICT", "EXPIRE"])
const MODEL_FAILURES = new Map([
  ["MODEL_UNASSIGNED", "MODEL_UNASSIGNED"],
  ["UNAVAILABLE", "MODEL_UNAVAILABLE"],
  ["REJECTED", "MODEL_REJECTED"],
])
const REQUIRED_RUNTIME_TOOLS = new Set(["workflow_plan", "workflow_run", "workflow_execute", "workflow_get", "workflow_list"])
const NODE_CLOSURE_STATES = new Set([...TERMINAL_NODE_STATES, "FAILED", "BLOCKED", "CANCELLED", "INCOMPLETE"])

function blocked(code: string, detail: string, missing: AnyRecord[] = [], extra: AnyRecord = {}) {
  return {
    ok: false,
    status: "BLOCKED",
    verification: "BLOCKED",
    code,
    detail,
    missing: [{ code, detail }, ...missing],
    evidence_level: "L3",
    ...extra,
  }
}

function success(run: AnyRecord, extra: AnyRecord = {}) {
  return {
    ok: true,
    status: "COMPLETE",
    verification: "PASS",
    evidence_level: "L3",
    workflow_id: run.workflow_id,
    run_id: run.run_id,
    config_revision: run.config_revision,
    evidence_ref: `control-plane:${run.run_id}`,
    missing: [],
    run,
    ...extra,
  }
}

function requiredPlanNodes(plan: AnyRecord): AnyRecord[] {
  return Array.isArray(plan?.nodes) ? plan.nodes.filter((node: AnyRecord) => node?.metadata?.required !== false) : []
}

function isDigest(value: any): boolean { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) }

function rowDigest(row: AnyRecord, kind?: string): string | null {
  if (!row || !isDigest(row.payload_sha256)) return null
  const body: AnyRecord = { ...row }
  delete body.payload_sha256
  if (kind === "workflow_wave" || kind === "workflow_wave_node") delete body.workflow_id
  try { return sha256Canonical(body) } catch { return null }
}

function digestMatches(row: AnyRecord, kind?: string): boolean {
  const actual = rowDigest(row, kind)
  // Adapter wave/node envelopes omit workflow_id; Writer derives that column
  // from the parent run. Direct Writer envelopes may already include it.
  return (actual !== null && actual === row.payload_sha256) || ((kind === "workflow_wave" || kind === "workflow_wave_node") && rowDigest(row) === row.payload_sha256)
}

function nonEmpty(value: any): boolean { return typeof value === "string" && value.trim().length > 0 }

function parseJson(value: any): any {
  if (typeof value !== "string" || !value) return null
  try { return JSON.parse(value) } catch { return null }
}

function validUtc(value: any): boolean {
  if (!nonEmpty(value) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return false
  try {
    const normalized = value.replace(/T(\d{2}:\d{2}:\d{2})Z$/, "T$1.000Z").replace(/\.(\d{1,2})Z$/, (_m: string, fraction: string) => `.${fraction.padEnd(3, "0")}Z`)
    return new Date(value).toISOString() === normalized
  } catch { return false }
}

function checkUtc(value: any, field: string, key: any, missing: AnyRecord[]) {
  if (!validUtc(value)) missing.push({ code: "L3_TIME_INVALID", field, key })
}

function checkFactEnvelope(row: AnyRecord, expectedFact: string, revision: string, missing: AnyRecord[], timeFields: string[] = []) {
  const key = row.run_id ?? row.event_id ?? row.wave_id ?? row.node_id ?? row.config_revision ?? null
  if (Number(row.schema_version) !== 1 || row.evidence_level !== "L3" || row.fact_type !== expectedFact || !nonEmpty(row.source) || !nonEmpty(row.idempotency_key) || !isDigest(row.payload_sha256)) {
    missing.push({ code: "L3_FACT_ENVELOPE_INVALID", fact_type: expectedFact, key })
  }
  if (!nonEmpty(row.config_revision) || row.config_revision !== revision) missing.push({ code: "REVISION_MIXED", key, fact_type: expectedFact })
  checkUtc(row.observed_at, `${expectedFact}.observed_at`, key, missing)
  for (const field of timeFields) {
    if (row[field] !== null && row[field] !== undefined) checkUtc(row[field], `${expectedFact}.${field}`, key, missing)
  }
}

function checkEnvelope(row: AnyRecord, table: string, revision: string, missing: AnyRecord[]) {
  // Plan 12.4 model tables predate the common L3 columns.  Validate the
  // persisted equivalents (source/time/config/idempotency/hash) and validate
  // optional common envelope columns when a newer writer provides them.
  const source = row.source ?? row.runtime_source ?? row.endpoint
  const observedAt = row.observed_at ?? row.updated_at ?? row.last_seen_at ?? row.first_seen_at
  const expectedFact = table === "model_catalog" ? "model_catalog" : table === "route_bindings" ? "route_binding" : "runtime_model_probe"
  const envelopeInvalid = (row.schema_version !== undefined && Number(row.schema_version) !== 1)
    || !nonEmpty(source) || !validUtc(observedAt)
    || (row.evidence_level !== undefined && row.evidence_level !== "L3")
    || (row.fact_type !== undefined && row.fact_type !== expectedFact)
    || !nonEmpty(row.idempotency_key) || !isDigest(row.payload_sha256)
  if (envelopeInvalid) {
    missing.push({ code: "MODEL_EVIDENCE_ENVELOPE_INVALID", table, key: row.catalog_entry_id ?? row.route_binding_id ?? row.probe_id ?? null })
  }
  if (!nonEmpty(row.config_revision) || row.config_revision !== revision) missing.push({ code: "MODEL_CONFIG_REVISION_MISMATCH", table, key: row.catalog_entry_id ?? row.route_binding_id ?? row.probe_id ?? null })
}

function modelEnvelopeCandidates(table: string, row: AnyRecord): AnyRecord[] {
  const withoutDigest = (value: AnyRecord) => { const copy = { ...value }; delete copy.payload_sha256; return copy }
  const parse = (value: any, fallback: any) => parseJson(value) ?? fallback
  if (table === "model_catalog") {
    const base: AnyRecord = {
      catalog_entry_id: row.catalog_entry_id, config_revision: row.config_revision,
      source: row.runtime_source, runtime_source: row.runtime_source, observed_at: row.first_seen_at,
      provider: row.provider, model_id: row.model_id, exact_model_ref: row.exact_model_ref,
      display_name: row.display_name, capability: parse(row.capability_json, {}), runtime_version: row.runtime_version,
      first_seen_at: row.first_seen_at, last_seen_at: row.last_seen_at, probe_status: row.probe_status,
      availability_state: row.availability_state, metadata_sha256: row.metadata_sha256,
      probe_error: row.probe_error, probe_id: row.probe_id, idempotency_key: row.idempotency_key,
    }
    const candidates = [base, { ...base, provider_id: row.provider_id }, { ...base, variant: row.variant }, { ...base, provider_id: row.provider_id, variant: row.variant }]
    return candidates.map(withoutDigest)
  }
  if (table === "route_bindings") {
    const base: AnyRecord = {
      route_binding_id: row.route_binding_id, role: row.role, workflow_scope: row.workflow_scope,
      project_scope: row.project_scope, lane: row.lane, provider: row.provider, model_id: row.model_id,
      exact_model_ref: row.exact_model_ref, binding_state: row.binding_state, config_revision: row.config_revision,
      source: row.source, reason: row.reason, created_at: row.created_at, updated_at: row.updated_at,
      idempotency_key: row.idempotency_key,
    }
    const candidates = [base, { ...base, provider_id: row.provider_id }, { ...base, variant: row.variant }, { ...base, provider_id: row.provider_id, variant: row.variant }]
    return candidates.map(withoutDigest)
  }
  const base: AnyRecord = {
    probe_id: row.probe_id, endpoint: row.endpoint, runtime_version: row.runtime_version,
    workflow_plugin_loaded: Boolean(row.workflow_plugin_loaded), tools: parse(row.tools_json, {}), provider: row.provider,
    model_id: row.model_id, exact_model_ref: row.exact_model_ref, probe_status: row.probe_status,
    availability_state: row.availability_state, probe_error: row.probe_error, observed_at: row.observed_at,
    config_revision: row.config_revision, metadata: parse(row.metadata_json, {}), idempotency_key: row.idempotency_key,
  }
  return [base, { ...base, provider_id: row.provider_id }].map(withoutDigest)
}

function checkModelEnvelopeDigest(db: DatabaseSync, table: string, row: AnyRecord, missing: AnyRecord[]) {
  const computed = modelEnvelopeCandidates(table, row).map((candidate) => {
    try { return sha256Canonical(candidate) } catch { return null }
  }).filter(Boolean)
  const persistedRowDigest = rowDigest(row)
  const idempotency = one(db, "SELECT * FROM evidence_idempotency WHERE idempotency_key = ?", [row.idempotency_key])
  const idempotencyMatches = idempotency && idempotency.payload_sha256 === row.payload_sha256 && idempotency.record_key === (row.catalog_entry_id ?? row.route_binding_id ?? row.probe_id) && idempotency.table_name === table
  if (!idempotencyMatches) missing.push({ code: "MODEL_EVIDENCE_IDEMPOTENCY_MISMATCH", table, key: row.catalog_entry_id ?? row.route_binding_id ?? row.probe_id })
  if (!computed.includes(row.payload_sha256) && persistedRowDigest !== row.payload_sha256) {
    missing.push({ code: "MODEL_EVIDENCE_DIGEST_MISMATCH", table, key: row.catalog_entry_id ?? row.route_binding_id ?? row.probe_id, expected: row.payload_sha256, actual: computed[0] ?? persistedRowDigest })
  }
}

function canonicalPlanDigest(plan: AnyRecord): string | null {
  try { return sha256Canonical(plan) } catch { return null }
}

function resolvePath(options: AnyRecord): { ok: true; path: string } | { ok: false; result: AnyRecord } {
  const root = typeof options.root === "string" && options.root ? path.resolve(options.root) : process.cwd()
  const requested = typeof options.dbPath === "string" ? options.dbPath.trim() : ""
  if (!requested) return { ok: false, result: blocked("EVIDENCE_STORE_UNAVAILABLE", "an explicit isolated Control Plane DB path is required") }
  let resolved = path.resolve(root, requested)
  const productionDefault = typeof options.productionRoot === "string" && options.productionRoot
    ? path.resolve(options.productionRoot, "runtime", "control-plane.db")
    : null
  if (productionDefault && resolved.toLowerCase() === productionDefault.toLowerCase()) {
    return { ok: false, result: blocked("EVIDENCE_STORE_SCOPE_FORBIDDEN", "Completion Guard cannot read the default production control-plane.db") }
  }
  const configuredRoots = Array.isArray(options.allowed_roots) ? options.allowed_roots.filter(nonEmpty).map((entry: string) => path.resolve(root, entry)) : []
  const allowedRoots = configuredRoots.length > 0 ? configuredRoots : [root]
  const within = (candidate: string, allowed: string) => {
    const relative = path.relative(allowed, candidate)
    return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  }
  if (!allowedRoots.some((allowed: string) => within(resolved, allowed))) {
    return { ok: false, result: blocked("EVIDENCE_STORE_SCOPE_FORBIDDEN", "Control Plane DB is outside the isolated allowed_roots boundary") }
  }
  if (!fs.existsSync(resolved)) return { ok: false, result: blocked("EVIDENCE_STORE_UNAVAILABLE", `Control Plane DB does not exist: ${resolved}`) }
  resolved = fs.realpathSync(resolved)
  if (!allowedRoots.some((allowed: string) => fs.existsSync(allowed) && within(resolved, fs.realpathSync(allowed)))) return { ok: false, result: blocked("EVIDENCE_STORE_SCOPE_FORBIDDEN", "resolved Control Plane DB crosses the isolation boundary") }
  return { ok: true, path: resolved }
}

function query(db: DatabaseSync, sql: string, params: any[] = []): AnyRecord[] {
  return db.prepare(sql).all(...params) as AnyRecord[]
}

function one(db: DatabaseSync, sql: string, params: any[] = []): AnyRecord | null {
  return (db.prepare(sql).get(...params) as AnyRecord | undefined) ?? null
}

function checkRowDigest(row: AnyRecord, kind: string, missing: AnyRecord[]) {
  if (!digestMatches(row, kind)) missing.push({ code: "L3_DIGEST_MISMATCH", kind, key: row.run_id ?? row.event_id ?? row.wave_id ?? row.node_id ?? row.config_revision ?? null, expected: row.payload_sha256, actual: rowDigest(row, kind) })
}

function checkLifecycle(db: DatabaseSync, run: AnyRecord, missing: AnyRecord[]) {
  const events = query(db, "SELECT * FROM workflow_run_events WHERE run_id = ? ORDER BY sequence", [run.run_id])
  if (events.length === 0) {
    missing.push({ code: "L3_EVENT_MISSING", detail: "workflow_run_events are required" })
    return events
  }
  events.forEach((event, index) => {
    if (Number(event.sequence) !== index + 1) missing.push({ code: "L3_EVENT_SEQUENCE_GAP", sequence: event.sequence })
    if (event.run_id !== run.run_id || event.workflow_id !== run.workflow_id || event.config_revision !== run.config_revision) missing.push({ code: "REVISION_MIXED", event_id: event.event_id })
    if (event.fact_type !== "workflow_run_event" || event.evidence_level !== "L3" || Number(event.schema_version) !== 1) missing.push({ code: "L3_EVENT_ENVELOPE_INVALID", event_id: event.event_id })
    checkFactEnvelope(event, "workflow_run_event", run.config_revision, missing, ["occurred_at"])
    checkUtc(event.observed_at, "workflow_run_event.observed_at", event.event_id, missing)
    checkUtc(event.occurred_at, "workflow_run_event.occurred_at", event.event_id, missing)
    checkRowDigest(event, "workflow_run_event", missing)
  })
  if (events[0]?.event_type !== "RUN_STARTED") missing.push({ code: "RUN_STARTED_MISSING" })
  if (events.at(-1)?.event_type !== "RUN_FINISHED") missing.push({ code: "RUN_FINISHED_MISSING" })
  if (Date.parse(events[0]?.occurred_at ?? "") < Date.parse(run.started_at ?? "")) missing.push({ code: "RUN_STARTED_TIME_MISMATCH" })
  if (Date.parse(events.at(-1)?.occurred_at ?? "") < Date.parse(run.ended_at ?? "")) missing.push({ code: "RUN_FINISHED_TIME_MISMATCH" })
  if (events.at(-1)?.status !== run.status) missing.push({ code: "RUN_FINISHED_STATUS_MISMATCH" })
  if (events.some((event) => event.event_type === "EVIDENCE_WRITE_FAILED")) missing.push({ code: "EVIDENCE_WRITE_FAILED", detail: "run contains an evidence write failure event" })
  return events
}

function checkLocks(db: DatabaseSync, run: AnyRecord, nodes: AnyRecord[], missing: AnyRecord[]) {
  const locks = query(db, "SELECT * FROM workflow_lock_events WHERE run_id = ? ORDER BY lock_key, sequence", [run.run_id])
  const nodeById = new Map(nodes.map((node) => [String(node.node_id), node]))
  const declaredKeys = new Map<string, Set<string>>()
  for (const node of nodes) {
    let parsed: any
    try { parsed = JSON.parse(String(node.lock_key_json ?? "")) } catch { parsed = Symbol("invalid") }
    const valid = parsed === null || (Array.isArray(parsed) && parsed.every((key) => nonEmpty(key)))
    if (!valid) {
      missing.push({ code: "LOCK_KEY_JSON_INVALID", node_id: node.node_id })
      continue
    }
    declaredKeys.set(String(node.node_id), new Set(Array.isArray(parsed) ? parsed.map(String) : []))
  }
  const sequences = new Map<string, number>()
  const owners = new Map<string, string>()
  for (const lock of locks) {
    if (!LOCK_EVENTS.has(String(lock.event_type))) missing.push({ code: "LOCK_EVIDENCE_INVALID", event_id: lock.event_id })
    if (!nonEmpty(lock.owner_token)) missing.push({ code: "LOCK_OWNER_MISSING", event_id: lock.event_id })
    const previous = sequences.get(lock.lock_key) ?? 0
    if (Number(lock.sequence) !== previous + 1) missing.push({ code: "LOCK_SEQUENCE_INVALID", lock_key: lock.lock_key, sequence: lock.sequence })
    sequences.set(lock.lock_key, Number(lock.sequence))
    const holder = owners.get(lock.lock_key)
    if (lock.event_type === "ACQUIRE") {
      if (holder) missing.push({ code: "LOCK_OWNER_INVALID", event_id: lock.event_id, detail: "ACQUIRE cannot replace an active owner" })
      else owners.set(lock.lock_key, lock.owner_token)
    } else if (lock.event_type === "RELEASE" || lock.event_type === "EXPIRE") {
      if (!holder || holder !== lock.owner_token) missing.push({ code: "LOCK_OWNER_INVALID", event_id: lock.event_id, detail: "release/expire owner does not hold the lock" })
      else owners.delete(lock.lock_key)
    } else if (lock.event_type === "WAIT" && holder && holder === lock.owner_token) {
      missing.push({ code: "LOCK_OWNER_INVALID", event_id: lock.event_id, detail: "WAIT owner cannot be the active holder" })
    }
    const ownerNode = nodeById.get(String(lock.node_id))
    if (!ownerNode || ownerNode.wave_id !== lock.wave_id) missing.push({ code: "LOCK_EVENT_ORPHANED", event_id: lock.event_id })
    const keys = declaredKeys.get(String(lock.node_id))
    if (!keys || !keys.has(String(lock.lock_key))) missing.push({ code: "LOCK_EVENT_UNKNOWN_KEY", event_id: lock.event_id, lock_key: lock.lock_key })
    if (lock.config_revision !== run.config_revision || lock.run_id !== run.run_id) missing.push({ code: "REVISION_MIXED", event_id: lock.event_id })
    checkFactEnvelope(lock, "workflow_lock_event", run.config_revision, missing, ["occurred_at"])
    checkUtc(lock.observed_at, "workflow_lock_event.observed_at", lock.event_id, missing)
    checkUtc(lock.occurred_at, "workflow_lock_event.occurred_at", lock.event_id, missing)
    checkRowDigest(lock, "workflow_lock_event", missing)
  }
  for (const node of nodes) {
    const keys = declaredKeys.get(String(node.node_id)) ?? new Set<string>()
    if (keys.size > 0 && !locks.some((lock) => lock.node_id === node.node_id && keys.has(String(lock.lock_key)))) {
      missing.push({ code: "LOCK_EVIDENCE_UNAVAILABLE", node_id: node.node_id })
    }
  }
  if (owners.size > 0) missing.push({ code: "LOCK_NOT_RELEASED", lock_keys: [...owners.keys()] })
  return locks
}

function checkNodeAttempts(nodes: AnyRecord[], executionEvents: AnyRecord[], lifecycleEvents: AnyRecord[], missing: AnyRecord[]) {
  const byNode = new Map<string, AnyRecord[]>()
  for (const node of nodes) {
    const key = String(node.node_id)
    const attempts = byNode.get(key) ?? []
    attempts.push(node)
    byNode.set(key, attempts)
    if (!Number.isInteger(Number(node.attempt)) || Number(node.attempt) < 1) missing.push({ code: "NODE_ATTEMPT_INVALID", node_id: node.node_id, attempt: node.attempt })
  }
  for (const [nodeId, attempts] of byNode) {
    const ordered = [...attempts].sort((a, b) => Number(a.attempt) - Number(b.attempt))
    const maxAttempt = Number(ordered.at(-1)?.attempt ?? 0)
    const seen = new Set<number>()
    for (const node of ordered) {
      const attempt = Number(node.attempt)
      if (seen.has(attempt)) missing.push({ code: "NODE_ATTEMPT_DUPLICATE", node_id: nodeId, attempt })
      seen.add(attempt)
    }
    for (let expected = 1; expected <= maxAttempt; expected++) {
      if (!seen.has(expected)) missing.push({ code: "NODE_ATTEMPT_SEQUENCE_INVALID", node_id: nodeId, expected_attempt: expected })
    }
    for (const node of ordered) {
      const attempt = Number(node.attempt)
      const finished = executionEvents.find((event) => event.node_id === node.node_id && event.task_id === node.task_id && Number(event.attempt) === attempt && event.event_type === "NODE_FINISHED")
      const startedLifecycle = lifecycleEvents.some((event) => event.event_type === "NODE_STARTED" && event.node_id === node.node_id && event.task_id === node.task_id && Number(event.attempt) === attempt)
      const finishedLifecycle = lifecycleEvents.some((event) => event.event_type === "NODE_FINISHED" && event.node_id === node.node_id && event.task_id === node.task_id && Number(event.attempt) === attempt)
      if (!finished || !NODE_CLOSURE_STATES.has(String(finished.status))) missing.push({ code: "NODE_ATTEMPT_UNCLOSED", node_id: nodeId, attempt })
      if (!startedLifecycle || !finishedLifecycle) missing.push({ code: "NODE_ATTEMPT_LIFECYCLE_INCOMPLETE", node_id: nodeId, attempt })
      if (attempt < maxAttempt && !NODE_CLOSURE_STATES.has(String(node.status))) missing.push({ code: "NODE_ATTEMPT_UNCLOSED", node_id: nodeId, attempt })
    }
  }
}

function checkModelRoute(db: DatabaseSync, node: AnyRecord, revision: string, missing: AnyRecord[], projectId: string | null = null) {
  const bindings = query(db, "SELECT * FROM route_bindings WHERE route_binding_id = ? AND config_revision = ? AND (project_scope IS NULL OR project_scope = ?)", [node.route, revision, projectId])
  if (bindings.length > 1) {
    missing.push({ code: "ROUTE_BINDING_AMBIGUOUS", route: node.route, node_id: node.node_id })
    return
  }
  const binding = bindings[0] ?? null
  if (!binding) {
    missing.push({ code: "ROUTE_BINDING_MISSING", route: node.route, node_id: node.node_id })
    return
  }
  checkEnvelope(binding, "route_bindings", revision, missing)
  checkModelEnvelopeDigest(db, "route_bindings", binding, missing)
  const bindingState = String(binding.binding_state ?? "")
  if (bindingState !== "BOUND") {
    missing.push({ code: MODEL_FAILURES.get(bindingState) ?? "MODEL_ROUTE_NOT_BOUND", route: node.route, state: bindingState, node_id: node.node_id })
    return
  }
  if (!nonEmpty(binding.exact_model_ref) || !nonEmpty(binding.provider_id) || !nonEmpty(binding.model_id)) {
    missing.push({ code: "MODEL_UNASSIGNED", route: node.route, node_id: node.node_id })
    return
  }
  const catalog = one(db, "SELECT * FROM model_catalog WHERE exact_model_ref = ? AND config_revision = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1", [binding.exact_model_ref, revision])
  if (!catalog || catalog.availability_state !== "AVAILABLE" || catalog.probe_status !== "AVAILABLE") {
    missing.push({ code: "MODEL_UNAVAILABLE", route: node.route, exact_model_ref: binding.exact_model_ref, node_id: node.node_id })
    return
  }
  checkEnvelope(catalog, "model_catalog", revision, missing)
  checkModelEnvelopeDigest(db, "model_catalog", catalog, missing)
  const probe = one(db, "SELECT * FROM runtime_model_probes WHERE exact_model_ref = ? AND config_revision = ? ORDER BY observed_at DESC, rowid DESC LIMIT 1", [binding.exact_model_ref, revision])
  if (!probe || probe.availability_state !== "AVAILABLE" || probe.probe_status !== "AVAILABLE") {
    missing.push({ code: "MODEL_UNAVAILABLE", route: node.route, exact_model_ref: binding.exact_model_ref, node_id: node.node_id })
    return
  }
  checkEnvelope(probe, "runtime_model_probes", revision, missing)
  checkModelEnvelopeDigest(db, "runtime_model_probes", probe, missing)
  const bindingCatalogFields = ["provider_id", "model_id", "variant", "exact_model_ref"]
  const runtimeIdentityFields = ["provider_id", "model_id", "exact_model_ref"]
  const exactVariant = (ref: any) => typeof ref === "string" && ref.includes("#") ? ref.split("#")[1] : null
  if (!nonEmpty(binding.provider_id) || !nonEmpty(binding.model_id) || !nonEmpty(binding.exact_model_ref)
    || binding.exact_model_ref !== `${binding.provider_id}/${binding.model_id}${binding.variant ? `#${binding.variant}` : ""}`
    || bindingCatalogFields.some((field) => String(binding[field] ?? "") !== String(catalog[field] ?? ""))
    || String(catalog.provider ?? "") !== String(catalog.provider_id ?? "")
    || catalog.exact_model_ref !== `${catalog.provider_id}/${catalog.model_id}${exactVariant(catalog.exact_model_ref) ? `#${exactVariant(catalog.exact_model_ref)}` : ""}`
    || runtimeIdentityFields.some((field) => String(binding[field] ?? "") !== String(probe[field] ?? ""))
    || String(probe.provider ?? "") !== String(probe.provider_id ?? "")
    || String(catalog.probe_id ?? "") !== String(probe.probe_id ?? "")
    || String(catalog.runtime_version ?? "") !== String(probe.runtime_version ?? "")
    || (probe.workflow_plugin_loaded !== 1)
    || (() => { const tools = parseJson(probe.tools_json); const available = Array.isArray(tools) ? new Set(tools) : new Set(Object.keys(tools ?? {}).filter((tool) => tools[tool])); return [...REQUIRED_RUNTIME_TOOLS].some((tool) => !available.has(tool)) })()) {
    missing.push({ code: "MODEL_RUNTIME_PROBE_IDENTITY_MISMATCH", route: node.route, node_id: node.node_id })
  }
}

export function evaluateRuntimeEvidence(options: AnyRecord = {}): AnyRecord {
  const plan = options.plan && typeof options.plan === "object" ? options.plan : {}
  const policy = plan.metadata?.execution_policy ?? {}
  const required = policy.mode === "isolated_fixture" || plan.metadata?.runtime_evidence_required === true
  if (!required) return { ok: true, status: "NOT_REQUIRED", verification: "UNVERIFIED", evidence_level: "UNVERIFIED", missing: [] }

  const revision = typeof options.configRevision === "string" && options.configRevision.trim() ? options.configRevision.trim() : (nonEmpty(policy.config_revision) ? policy.config_revision : "")
  if (!revision) return blocked("CONFIG_REVISION_MISSING", "Plan 12 evidence requires an explicit config_revision")
  let resolved: ReturnType<typeof resolvePath>
  try { resolved = resolvePath({ ...options, dbPath: options.dbPath ?? policy.control_plane_db, allowed_roots: policy.allowed_roots }) } catch (error: any) { return blocked("EVIDENCE_STORE_UNAVAILABLE", error?.message ?? String(error)) }
  if (!resolved.ok) return resolved.result

  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(resolved.path, { readOnly: true })
    // All evidence reads share a committed SQLite snapshot. No migration or
    // evidence mutation takes place in this transaction.
    db.exec("BEGIN")
    const runRows = options.runId
      ? query(db, "SELECT * FROM workflow_runs WHERE workflow_id = ? AND run_id = ?", [options.workflowId, options.runId])
      : query(db, "SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY started_at, run_id", [options.workflowId])
    if (runRows.length === 0) {
      const failures = options.runId
        ? query(db, "SELECT * FROM workflow_run_events WHERE workflow_id = ? AND run_id = ? AND event_type = 'EVIDENCE_WRITE_FAILED' ORDER BY sequence", [options.workflowId, options.runId])
        : query(db, "SELECT * FROM workflow_run_events WHERE workflow_id = ? AND event_type = 'EVIDENCE_WRITE_FAILED' ORDER BY sequence", [options.workflowId])
      return failures.length ? blocked("EVIDENCE_WRITE_FAILED", "only failed lifecycle evidence exists; no committed run fact", [], { failure_events: failures }) : blocked("EVIDENCE_RUN_NOT_FOUND", `no Control Plane run exists for workflow '${options.workflowId}'`)
    }
    if (!options.runId && runRows.length !== 1) return blocked("EVIDENCE_RUN_AMBIGUOUS", "completion requires an explicit run_id when a workflow has multiple Control Plane runs")
    const run = runRows[0]
    const missing: AnyRecord[] = []
    checkFactEnvelope(run, "workflow_run", revision, missing, ["started_at", "ended_at"])
    if (run.workflow_id !== options.workflowId) missing.push({ code: "WORKFLOW_ID_MISMATCH" })
    if (run.config_revision !== revision) missing.push({ code: "REVISION_MIXED", detail: "run config_revision does not match the immutable plan revision" })
    if (!TERMINAL_RUN_STATES.has(String(run.status))) missing.push({ code: "RUN_NOT_COMPLETE", status: run.status })
    if (run.evidence_write_status !== "COMPLETE") missing.push({ code: "EVIDENCE_STATUS_INCOMPLETE", evidence_write_status: run.evidence_write_status })
    if (!nonEmpty(run.started_at) || !nonEmpty(run.ended_at)) missing.push({ code: "RUN_TIME_INCOMPLETE" })
    const expectedPlanDigest = canonicalPlanDigest(plan)
    if (!expectedPlanDigest || expectedPlanDigest !== run.plan_digest) missing.push({ code: "PLAN_DIGEST_MISMATCH" })
    checkRowDigest(run, "workflow_run", missing)
    if (Number(run.attempt) > 1) {
      const parent = run.parent_run_id ? one(db, "SELECT * FROM workflow_runs WHERE run_id = ?", [run.parent_run_id]) : null
      if (!parent) missing.push({ code: "PARENT_RUN_NOT_FOUND", run_id: run.run_id })
      else {
        if (parent.run_id === run.run_id || parent.workflow_id !== run.workflow_id) missing.push({ code: "PARENT_WORKFLOW_MISMATCH", run_id: run.run_id })
        if (parent.config_revision !== run.config_revision) missing.push({ code: "PARENT_CONFIG_REVISION_MISMATCH", run_id: run.run_id })
        if (Number(parent.attempt) + 1 !== Number(run.attempt)) missing.push({ code: "ATTEMPT_NONCONTIGUOUS", run_id: run.run_id })
      }
    }

    const snapshot = one(db, "SELECT * FROM workflow_config_snapshots WHERE config_revision = ?", [revision])
    if (!snapshot) missing.push({ code: "CONFIG_SNAPSHOT_MISSING", config_revision: revision })
    else {
      checkFactEnvelope(snapshot, "workflow_config_snapshot", revision, missing, ["created_at", "activated_at"])
      const state = one(db, "SELECT current_state FROM config_revision_state WHERE config_revision = ?", [revision])?.current_state ?? snapshot.state
      if (!['ACTIVE', 'SUPERSEDED', 'ROLLED_BACK'].includes(String(state))) missing.push({ code: "CONFIG_SNAPSHOT_INVALID_STATE", state })
      if (!isDigest(snapshot.config_digest) || !isDigest(snapshot.model_catalog_digest) || !isDigest(snapshot.route_bindings_digest)) missing.push({ code: "CONFIG_SNAPSHOT_DIGEST_MISSING" })
      const config = parseJson(snapshot.canonical_json)
      if (!config || sha256Canonical(config) !== snapshot.config_digest || sha256Canonical(config.model_catalog ?? []) !== snapshot.model_catalog_digest || sha256Canonical(config.route_bindings ?? []) !== snapshot.route_bindings_digest) missing.push({ code: "CONFIG_SNAPSHOT_DIGEST_MISMATCH" })
      if (![snapshot.drawio_raw_sha256, snapshot.drawio_semantic_sha256, snapshot.ir_sha256].every(isDigest)) missing.push({ code: "ARCHITECTURE_EVIDENCE_MISSING" })
      checkRowDigest(snapshot, "workflow_config_snapshot", missing)
    }

    const lifecycleEvents = checkLifecycle(db, run, missing)
    const waves = query(db, "SELECT * FROM workflow_waves WHERE run_id = ? ORDER BY wave_index", [run.run_id])
    if (waves.length === 0) missing.push({ code: "L3_WAVE_MISSING" })
    const waveIds = new Set<string>()
    waves.forEach((wave, index) => {
      waveIds.add(wave.wave_id)
      checkFactEnvelope(wave, "workflow_wave", run.config_revision, missing, ["started_at", "ended_at"])
      if (Number(wave.wave_index) !== index) missing.push({ code: "WAVE_INDEX_INVALID", wave_id: wave.wave_id })
      if (wave.workflow_id !== run.workflow_id || wave.config_revision !== run.config_revision) missing.push({ code: "REVISION_MIXED", wave_id: wave.wave_id })
      if (!TERMINAL_NODE_STATES.has(String(wave.status)) || !nonEmpty(wave.ended_at)) missing.push({ code: "WAVE_NOT_COMPLETE", wave_id: wave.wave_id })
      checkRowDigest(wave, "workflow_wave", missing)
    })

    const executionEvents = query(db, "SELECT * FROM execution_events WHERE run_id = ? ORDER BY sequence", [run.run_id])
    if (executionEvents.length === 0) missing.push({ code: "L3_EXECUTION_MISSING", detail: "execution_events are required" })
    executionEvents.forEach((event, index) => {
      checkFactEnvelope(event, "execution_event", run.config_revision, missing, ["occurred_at"])
      if (Number(event.sequence) !== index + 1) missing.push({ code: "EXECUTION_SEQUENCE_GAP", sequence: event.sequence })
      if (event.run_id !== run.run_id || event.workflow_id !== run.workflow_id || event.config_revision !== run.config_revision) missing.push({ code: "REVISION_MIXED", event_id: event.event_id })
      if (event.event_type === "EVIDENCE_WRITE_FAILED") missing.push({ code: "EVIDENCE_WRITE_FAILED", event_id: event.event_id })
      checkRowDigest(event, "execution_event", missing)
    })
    const nodes = query(db, "SELECT * FROM workflow_wave_nodes WHERE run_id = ? ORDER BY node_id, attempt", [run.run_id])
    const planNodes = requiredPlanNodes(plan)
    const planIds = new Set((Array.isArray(plan.nodes) ? plan.nodes : []).map((node: AnyRecord) => node.node_id))
    for (const node of nodes) {
      checkFactEnvelope(node, "workflow_wave_node", run.config_revision, missing, ["started_at", "ended_at"])
      if (!planIds.has(node.node_id)) missing.push({ code: "UNPLANNED_WORKFLOW_NODE", node_id: node.node_id })
    }
    for (const planNode of planNodes) {
      const candidates = nodes.filter((node) => node.node_id === planNode.node_id)
      const node = candidates.sort((a, b) => Number(b.attempt) - Number(a.attempt))[0]
      if (!node) {
        missing.push({ code: "L3_NODE_MISSING", node_id: planNode.node_id })
        continue
      }
      if (!waveIds.has(node.wave_id) || node.workflow_id !== run.workflow_id || node.config_revision !== run.config_revision) missing.push({ code: "REVISION_MIXED", node_id: node.node_id })
      if (node.route !== planNode.route) missing.push({ code: "NODE_ROUTE_MISMATCH", node_id: node.node_id })
      if (Array.isArray(options.runtimeNodes)) {
        const taskNode = options.runtimeNodes.find((entry: AnyRecord) => entry.node_id === node.node_id)
        if (!taskNode || taskNode.current_task_id !== node.task_id || (taskNode.attempt !== undefined && Number(taskNode.attempt) !== Number(node.attempt))) missing.push({ code: "NODE_TASK_ATTEMPT_MISMATCH", node_id: node.node_id })
      }
      if (!nonEmpty(node.session_id) || !nonEmpty(node.task_id) || !nonEmpty(node.started_at) || !nonEmpty(node.ended_at) || !TERMINAL_NODE_STATES.has(String(node.status))) missing.push({ code: "L3_NODE_INCOMPLETE", node_id: node.node_id })
      checkRowDigest(node, "workflow_wave_node", missing)
      checkModelRoute(db, node, revision, missing, planNode.project_id ?? run.project_id ?? null)
      const execution = executionEvents.filter((event) => event.node_id === node.node_id && event.task_id === node.task_id && Number(event.attempt) === Number(node.attempt) && event.event_type === "NODE_FINISHED").at(-1)
      if (!execution) missing.push({ code: "L3_EXECUTION_MISSING", node_id: node.node_id })
      else {
        if (execution.wave_id !== node.wave_id || execution.status !== node.status) missing.push({ code: "EXECUTION_NODE_MISMATCH", event_id: execution.event_id })
        if (execution.config_revision !== run.config_revision || execution.workflow_id !== run.workflow_id || !TERMINAL_NODE_STATES.has(String(execution.status))) missing.push({ code: "REVISION_MIXED", event_id: execution.event_id })
        if (!nonEmpty(execution.payload_ref) || !isDigest(execution.payload_digest)) missing.push({ code: "L3_EXECUTION_DIGEST_MISSING", node_id: node.node_id })
        if (node.result_digest && execution.payload_digest !== node.result_digest) missing.push({ code: "L3_DIGEST_MISMATCH", node_id: node.node_id })
      }
      const lifecycleFinish = lifecycleEvents.find((event) => event.event_type === "NODE_FINISHED" && event.node_id === node.node_id && event.task_id === node.task_id && Number(event.attempt) === Number(node.attempt))
      if (lifecycleFinish && execution && lifecycleFinish.payload_digest !== execution.payload_digest) missing.push({ code: "L3_DIGEST_MISMATCH", node_id: node.node_id, detail: "lifecycle and execution payload digests differ" })
      if (!lifecycleEvents.some((event) => event.event_type === "NODE_STARTED" && event.node_id === node.node_id && event.task_id === node.task_id && Number(event.attempt) === Number(node.attempt))) missing.push({ code: "NODE_STARTED_MISSING", node_id: node.node_id })
      if (!lifecycleEvents.some((event) => event.event_type === "NODE_FINISHED" && event.node_id === node.node_id && event.task_id === node.task_id && Number(event.attempt) === Number(node.attempt))) missing.push({ code: "NODE_FINISHED_MISSING", node_id: node.node_id })
    }
    checkNodeAttempts(nodes, executionEvents, lifecycleEvents, missing)
    for (const wave of waves) {
      if (!lifecycleEvents.some((event) => event.event_type === "WAVE_STARTED" && event.wave_id === wave.wave_id)) missing.push({ code: "WAVE_STARTED_MISSING", wave_id: wave.wave_id })
      if (!lifecycleEvents.some((event) => event.event_type === "WAVE_FINISHED" && event.wave_id === wave.wave_id)) missing.push({ code: "WAVE_FINISHED_MISSING", wave_id: wave.wave_id })
    }
    checkLocks(db, run, nodes, missing)
    if (missing.length > 0) return blocked(missing[0].code, "Completion Guard L3 evidence is incomplete or inconsistent", missing, { run, config_revision: revision, evidence_ref: `control-plane:${run.run_id}` })
    return success(run, { config_revision: revision, wave_count: waves.length, node_count: planNodes.length, execution_event_count: executionEvents.length })
  } catch (error: any) {
    return blocked("EVIDENCE_STORE_UNAVAILABLE", error?.message ?? String(error))
  } finally {
    try { db?.close() } catch {}
  }
}
