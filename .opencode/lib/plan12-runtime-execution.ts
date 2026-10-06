import crypto from "node:crypto"
import { canonicalizePlan12Json, sha256Canonical } from "./plan12-contract.ts"
import type { ControlPlaneStore } from "./plan12-control-plane.ts"
import { appendRuntimeEvidenceBatch } from "./plan12-runtime-evidence-adapter.ts"

type AnyRecord = Record<string, any>
type GateResult = { ok: true; value?: any } | { ok: false; code: string; detail: string; path?: string; guard: "BLOCKED" }

const DENIED_ROUTES = new Set(["long_term_memory_write", "database_write", "database_ddl", "database_backup"])
const DENIED_CAPABILITIES = new Set(["mem0_write", "production_db_write", "business_repo_write"])

function failure(code: string, detail: string, path = "$"): GateResult {
  return { ok: false, code, detail, path, guard: "BLOCKED" }
}

function nonEmpty(value: any): value is string { return typeof value === "string" && value.trim().length > 0 }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) }
function nowUtc(): string { return new Date().toISOString() }
function id(prefix: string): string { return `${prefix}-${crypto.randomUUID()}` }

export type WorkflowExecutionPolicy = {
  mode: "legacy" | "isolated_fixture"
  delivery: "architecture" | "none"
  allow_mem0_write: boolean
  allow_production_db_write: boolean
  allow_business_repo_write: boolean
  allowed_project_ids: string[]
  allowed_roots: string[]
  config_revision: string | null
  control_plane_db: string | null
}

export function normalizeWorkflowExecutionPolicy(input: any = {}): WorkflowExecutionPolicy {
  const isolated = input?.mode === "isolated_fixture"
  return {
    mode: isolated ? "isolated_fixture" : "legacy",
    delivery: input?.delivery === "none" ? "none" : "architecture",
    allow_mem0_write: isolated ? input?.allow_mem0_write === true : input?.allow_mem0_write !== false,
    allow_production_db_write: isolated ? input?.allow_production_db_write === true : input?.allow_production_db_write !== false,
    allow_business_repo_write: isolated ? input?.allow_business_repo_write === true : input?.allow_business_repo_write !== false,
    allowed_project_ids: Array.isArray(input?.allowed_project_ids) ? input.allowed_project_ids.filter(nonEmpty) : [],
    allowed_roots: Array.isArray(input?.allowed_roots) ? input.allowed_roots.filter(nonEmpty) : [],
    config_revision: nonEmpty(input?.config_revision) ? input.config_revision : null,
    control_plane_db: nonEmpty(input?.control_plane_db) ? input.control_plane_db : null,
  }
}

function capabilitiesOf(value: any): string[] {
  const metadata = value?.metadata ?? {}
  const requested = [
    ...(Array.isArray(metadata.capabilities) ? metadata.capabilities : []),
    ...(Array.isArray(metadata.requested_capabilities) ? metadata.requested_capabilities : []),
    ...(nonEmpty(metadata.capability) ? [metadata.capability] : []),
  ]
  return requested.filter(nonEmpty).map((entry) => entry.trim())
}

function checkPolicy(value: any, policy: WorkflowExecutionPolicy): GateResult {
  const route = nonEmpty(value?.route) ? value.route : ""
  const capabilities = capabilitiesOf(value)
  if (!policy.allow_mem0_write && (route === "long_term_memory_write" || capabilities.some((cap) => DENIED_CAPABILITIES.has(cap) && cap === "mem0_write"))) {
    return failure("MEM0_WRITE_FORBIDDEN", "isolated execution policy forbids Mem0 writes; no planner or worker dispatch is permitted", "$.route")
  }
  if (!policy.allow_production_db_write && (DENIED_ROUTES.has(route) && route !== "long_term_memory_write" || capabilities.includes("production_db_write"))) {
    return failure("PRODUCTION_DB_WRITE_FORBIDDEN", "isolated execution policy forbids production database writes", "$.route")
  }
  if (!policy.allow_business_repo_write && (route === "code_change" || route === "api_code_change" || capabilities.includes("business_repo_write"))) {
    return failure("BUSINESS_REPO_WRITE_FORBIDDEN", "isolated execution policy forbids business repository writes", "$.route")
  }
  if (policy.allowed_project_ids.length > 0 && !policy.allowed_project_ids.includes(String(value?.project_id ?? ""))) {
    return failure("PROJECT_SCOPE_FORBIDDEN", "project is outside the isolated execution allowlist", "$.project_id")
  }
  if (policy.allowed_roots.length > 0) {
    const metadata = value?.metadata ?? {}
    const candidate = value?.project_root ?? value?.project_path ?? value?.root ?? metadata.project_root ?? metadata.execution_root ?? metadata.root
    if (!nonEmpty(candidate)) return failure("ROOT_SCOPE_FORBIDDEN", "isolated execution requires an explicit project/root path when allowed_roots is set", "$.project_root")
    const normalize = (entry: string) => entry.replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase()
    const target = normalize(String(candidate))
    const allowed = policy.allowed_roots.some((root) => {
      const normalized = normalize(root)
      return target === normalized || target.startsWith(`${normalized}/`)
    })
    if (!allowed) return failure("ROOT_SCOPE_FORBIDDEN", "path is outside the isolated allowed_roots boundary", "$.project_root")
  }
  return { ok: true, value }
}

export function validatePlannerExecutionPolicy(plan: any, policyInput: any): GateResult {
  const policy = normalizeWorkflowExecutionPolicy(policyInput)
  if (!plan || !Array.isArray(plan.nodes)) return failure("PLAN_PERMISSION_INPUT_INVALID", "planner output must contain nodes")
  for (let index = 0; index < plan.nodes.length; index += 1) {
    const result = checkPolicy(plan.nodes[index], policy)
    if (!result.ok) return { ...result, path: `$.nodes[${index}]${result.path === "$.route" ? ".route" : ""}` }
  }
  if (policy.delivery === "none" && plan.metadata?.delivery?.required_routes?.length) {
    return failure("DELIVERY_CHAIN_FORBIDDEN", "isolated execution policy requires an execution-only plan without delivery routes", "$.metadata.delivery")
  }
  return { ok: true, value: policy }
}

export function validateNodeExecutionPolicy(taskOrEnvelope: any, policyInput: any): GateResult {
  return checkPolicy(taskOrEnvelope, normalizeWorkflowExecutionPolicy(policyInput))
}

function payloadEnvelope(payload: any, configRevision: string, source: string, key: string, factType: string, extras: AnyRecord = {}): AnyRecord {
  const base: AnyRecord = {
    schema_version: 1,
    config_revision: configRevision,
    source,
    observed_at: nowUtc(),
    idempotency_key: key,
    evidence_level: "L3",
    fact_type: factType,
    ...extras,
  }
  return { ...base, payload_sha256: sha256Canonical(base) }
}

function activeRevision(store: ControlPlaneStore, revision: string): boolean {
  const row: any = store.db.prepare("SELECT s.state, COALESCE(r.current_state, s.state) AS effective_state FROM workflow_config_snapshots s LEFT JOIN config_revision_state r ON r.config_revision=s.config_revision WHERE s.config_revision=?").get(revision)
  return !!row && (row.effective_state === "ACTIVE" || row.state === "ACTIVE")
}

function eventRow(store: ControlPlaneStore, fact: AnyRecord): any {
  const result = store.appendWorkflowRunEvent(fact)
  if (!result.ok) throw new Error(`${result.code}: ${result.detail}`)
  return result.value
}

export function createRuntimeEvidenceCollector(options: {
  store: ControlPlaneStore
  workflowId: string
  configRevision: string
  projectId: string
  plan: any
  source?: string
  runId?: string
  runtimeRoot?: string | null
  controlPlaneDb?: string | null
}) {
  const store = options.store
  const source = options.source ?? "workflow-engine"
  const runId = options.runId ?? crypto.randomUUID()
  const startedAt = nowUtc()
  const runEvents: AnyRecord[] = []
  const waves = new Map<number, AnyRecord>()
  const nodes = new Map<string, AnyRecord>()
  let sequence = 0
  let executionSequence = 0
  let started = false
  let finished = false

  function runtimeLocation(): AnyRecord | null {
    const pathEnvelope = store.pathEnvelope
    if (!pathEnvelope || typeof options.runtimeRoot !== "string" || !options.runtimeRoot.trim() || typeof options.controlPlaneDb !== "string" || !options.controlPlaneDb.trim()) return null
    const normalize = (value: string) => value.replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase()
    const rootMatches = [pathEnvelope.runtime_root, pathEnvelope.runtime_root_real].some((value) => normalize(value) === normalize(options.runtimeRoot!))
    const dbMatches = [pathEnvelope.control_plane_db, pathEnvelope.control_plane_db_real].some((value) => normalize(value) === normalize(options.controlPlaneDb!))
    if (!rootMatches || !dbMatches || normalize(store.dbPath) !== normalize(pathEnvelope.control_plane_db_real)) return null
    return { runtime_root: pathEnvelope.runtime_root_real, control_plane_db: pathEnvelope.control_plane_db_real, path_envelope: pathEnvelope }
  }

  function appendEvent(eventType: string, payload: any, refs: AnyRecord = {}, status = "RUNNING"): GateResult {
    const payloadDigest = sha256Canonical(payload)
    const seq = ++sequence
    const key = `${runId}:event:${seq}:${eventType}`
    const base = payloadEnvelope(payload, options.configRevision, source, key, "workflow_run_event", {
      event_id: id("event"), run_id: runId, workflow_id: options.workflowId,
      wave_id: refs.wave_id ?? null, node_id: refs.node_id ?? null, task_id: refs.task_id ?? null,
      attempt: refs.attempt ?? null, event_type: eventType, status, sequence: seq,
      payload_digest: payloadDigest, payload_ref: `inline:${key}`, occurred_at: nowUtc(), error_code: refs.error_code ?? null,
      payload_json: JSON.stringify(payload),
    })
    try {
      runEvents.push(eventRow(store, base))
      return { ok: true, value: base }
    } catch (error: any) {
      return failure("EVIDENCE_WRITE_FAILED", `workflow_run_events append failed: ${error?.message ?? String(error)}`)
    }
  }

  function start(): GateResult {
    if (!activeRevision(store, options.configRevision)) return failure("CONFIG_REVISION_NOT_FOUND", `config_revision '${options.configRevision}' is not an ACTIVE immutable snapshot`)
    const location = runtimeLocation()
    if (!location) return failure("RUNTIME_LOCATION_UNRESOLVED", "isolated runtime evidence requires the scheduler-provided runtime_root and the actual Control Plane store.dbPath", "$.runtime_location")
    if (started) return { ok: true, value: { run_id: runId } }
    const result = appendEvent("RUN_STARTED", { workflow_id: options.workflowId, run_id: runId, plan_digest: sha256Canonical(options.plan), ...location }, {}, "RUNNING")
    if (result.ok) started = true
    return result
  }

  function waveId(index: number): string { return waves.get(index)?.wave_id ?? `${runId}:wave:${index}` }
  function recordWaveStart(index: number, items: any[]): GateResult {
    const wave = waves.get(index) ?? { wave_id: waveId(index), wave_index: index, started_at: nowUtc(), items: clone(items), nodes: [] }
    waves.set(index, wave)
    return appendEvent("WAVE_STARTED", { run_id: runId, wave_id: wave.wave_id, wave_index: index, node_ids: items.map((item) => item.node_id) }, { wave_id: wave.wave_id })
  }
  function recordNodeStart(index: number, node: AnyRecord): GateResult {
    const wave = waves.get(index) ?? { wave_id: waveId(index), wave_index: index, started_at: nowUtc(), items: [], nodes: [] }
    waves.set(index, wave)
    const key = `${index}:${node.node_id}:${node.attempt ?? 1}`
    const prior = nodes.get(key) ?? { ...node, wave_id: wave.wave_id, wave_index: index, attempt: node.attempt ?? 1, started_at: nowUtc() }
    nodes.set(key, prior)
    return appendEvent("NODE_STARTED", { node_id: node.node_id, task_id: node.task_id, session_id: node.session_id, session_key: node.session_key ?? null }, { wave_id: wave.wave_id, node_id: node.node_id, task_id: node.task_id, attempt: prior.attempt })
  }
  function recordNodeFinish(index: number, node: AnyRecord): GateResult {
    const wave = waves.get(index) ?? { wave_id: waveId(index), wave_index: index, started_at: nowUtc(), items: [], nodes: [] }
    waves.set(index, wave)
    const key = `${index}:${node.node_id}:${node.attempt ?? 1}`
    const prior = nodes.get(key) ?? { ...node, wave_id: wave.wave_id, wave_index: index, attempt: node.attempt ?? 1, started_at: node.started_at ?? nowUtc() }
    const finishedNode = { ...prior, ...node, wave_id: wave.wave_id, wave_index: index, ended_at: node.ended_at ?? nowUtc(), status: node.status ?? "COMPLETED" }
    nodes.set(key, finishedNode)
    return appendEvent("NODE_FINISHED", node.output ?? node.result ?? {}, { wave_id: wave.wave_id, node_id: node.node_id, task_id: node.task_id, attempt: finishedNode.attempt }, finishedNode.status)
  }
  function recordWaveFinish(index: number, items: any[]): GateResult {
    const wave = waves.get(index) ?? { wave_id: waveId(index), wave_index: index, started_at: nowUtc(), items: [], nodes: [] }
    wave.ended_at = nowUtc(); wave.items = items
    waves.set(index, wave)
    return appendEvent("WAVE_FINISHED", { run_id: runId, wave_id: wave.wave_id, wave_index: index, node_count: [...nodes.values()].filter((node) => node.wave_index === index).length }, { wave_id: wave.wave_id }, "COMPLETED")
  }

  function finish(status = "COMPLETED"): GateResult {
    if (finished) return { ok: true, value: { run_id: runId } }
    const end = nowUtc()
    const location = runtimeLocation()
    if (!location) return failure("RUNTIME_LOCATION_UNRESOLVED", "isolated runtime evidence requires the scheduler-provided runtime_root and the actual Control Plane store.dbPath", "$.runtime_location")
    const runPayload = { workflow_id: options.workflowId, run_id: runId, status, started_at: startedAt, ended_at: end, plan_digest: sha256Canonical(options.plan), ...location }
    const run = payloadEnvelope(runPayload, options.configRevision, source, `${runId}:run`, "workflow_run", {
      run_id: runId, workflow_id: options.workflowId, parent_run_id: null, plan_digest: sha256Canonical(options.plan), attempt: 1,
      trigger: "workflow_execute", project_id: options.projectId, status, started_at: startedAt, ended_at: end,
      outcome_digest: sha256Canonical(runPayload), evidence_write_status: "COMPLETE", error_code: null, error_detail: null, engine_version: "workflow-engine-r2",
    })
    const facts: AnyRecord[] = [run]
    for (const wave of [...waves.values()].sort((a, b) => a.wave_index - b.wave_index)) {
      const wavePayload = { run_id: runId, wave_id: wave.wave_id, wave_index: wave.wave_index, items: wave.items ?? [] }
      facts.push(payloadEnvelope(wavePayload, options.configRevision, source, `${runId}:wave:${wave.wave_index}`, "workflow_wave", {
        run_id: runId, wave_id: wave.wave_id, workflow_id: options.workflowId, wave_index: wave.wave_index,
        ready_set_digest: sha256Canonical((wave.items ?? []).map((item: any) => item.node_id)), policy_digest: sha256Canonical({}), parallelism: Math.max(1, (wave.items ?? []).length),
        status: "COMPLETED", started_at: wave.started_at, ended_at: wave.ended_at ?? end, lock_snapshot_json: JSON.stringify([]), evidence_digest: sha256Canonical(wavePayload),
      }))
    }
    let eventSeq = 1
    for (const node of [...nodes.values()].sort((a, b) => String(a.node_id).localeCompare(String(b.node_id)))) {
      const nodePayload = { node_id: node.node_id, task_id: node.task_id, output: node.output ?? node.result ?? null }
      facts.push(payloadEnvelope(nodePayload, options.configRevision, source, `${runId}:node:${node.wave_id}:${node.node_id}:${node.attempt}`, "workflow_wave_node", {
        run_id: runId, wave_id: node.wave_id, node_id: node.node_id, attempt: node.attempt ?? 1, workflow_id: options.workflowId,
        task_id: node.task_id, route: node.route ?? "code_read", resource_digest: sha256Canonical(node.resources ?? {}), lock_key_json: JSON.stringify(node.lock_key ?? null),
        session_key: node.session_key ?? null, session_id: node.session_id ?? null, model_runtime_id: node.model_runtime_id ?? null, status: node.status ?? "COMPLETED", event_seq: eventSeq++,
        started_at: node.started_at ?? startedAt, ended_at: node.ended_at ?? end, result_digest: sha256Canonical(node.output ?? node.result ?? null), error_code: node.error_code ?? null,
      }))
    }
    const executionEvents: AnyRecord[] = []
    for (const event of runEvents.filter((entry) => entry.event_type === "NODE_FINISHED")) {
      const executionSeq = ++executionSequence
      const node = [...nodes.values()].find((candidate) => candidate.node_id === event.node_id && candidate.task_id === event.task_id && (candidate.attempt ?? 1) === (event.attempt ?? 1))
      const payload = node?.output ?? node?.result ?? {}
      executionEvents.push({
        ...payloadEnvelope(payload, options.configRevision, source, `${runId}:execution:${executionSeq}`, "execution_event", {
        event_id: id("execution"), run_id: runId, workflow_id: options.workflowId, wave_id: event.wave_id, node_id: event.node_id, task_id: event.task_id,
        attempt: event.attempt ?? 1, event_type: event.event_type, status: event.status, sequence: executionSeq, payload_digest: event.payload_digest, payload_ref: event.payload_ref,
        occurred_at: event.occurred_at, error_code: event.error_code,
        }),
        payload,
      })
    }
    const waveFacts = facts.filter((fact) => fact.fact_type === "workflow_wave")
    const nodeFacts = facts.filter((fact) => fact.fact_type === "workflow_wave_node")
    if (nodeFacts.length === 0 || nodeFacts.some((node) => typeof node.session_id !== "string" || !node.session_id.trim())) {
      return failure("EVIDENCE_WRITE_FAILED", "runtime evidence requires a real Worker session_id for every node")
    }
    const adapterWaves = waveFacts.map((wave) => ({
      ...wave,
      nodes: nodeFacts.filter((node) => node.run_id === wave.run_id && node.wave_id === wave.wave_id),
    }))
    const adapterResult = appendRuntimeEvidenceBatch(store, {
      run,
      waves: adapterWaves,
      nodes: nodeFacts,
      lock_events: [],
      execution_events: executionEvents,
    })
    if (!adapterResult.ok) {
      const blocked = failure("EVIDENCE_WRITE_FAILED", adapterResult.detail ?? adapterResult.code)
      const causeCode = adapterResult.cause_code ?? adapterResult.code
      const causeDetail = adapterResult.cause_detail ?? adapterResult.detail
      const receipt = appendEvent("EVIDENCE_WRITE_FAILED", {
        run_id: runId,
        workflow_id: options.workflowId,
        cause_code: causeCode,
        cause_detail: causeDetail,
      }, { error_code: causeCode }, "EVIDENCE_BLOCKED")
      return receipt.ok ? { ...blocked, value: { run_id: runId, failure_event: receipt.value } } : blocked
    }
    const event = appendEvent("RUN_FINISHED", { run_id: runId, status, workflow_id: options.workflowId }, {}, status)
    if (!event.ok) return event
    finished = true
    return { ok: true, value: { run_id: runId, status, facts: adapterResult.facts?.length ?? facts.length, ended_at: end, adapter: "appendRuntimeEvidenceBatch" } }
  }

  return { runId, start, recordWaveStart, recordNodeStart, recordNodeFinish, recordWaveFinish, finish, events: () => clone(runEvents) }
}
