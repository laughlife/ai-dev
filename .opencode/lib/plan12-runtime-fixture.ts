import { canonicalizePlan12Json, sha256Canonical } from "./plan12-contract.ts"
import { initializeControlPlaneDatabase, type ControlPlaneStore } from "./plan12-control-plane.ts"
import { createConfigRevision, applyConfigRevision, transitionConfigRevision } from "./plan12-config-revision.ts"
import { appendModelCatalogEntry, appendRouteBinding, recordRuntimeProbe } from "./plan12-model-routes.ts"

type AnyRecord = Record<string, any>

export type Plan12VerifiedRuntimeProbe = {
  runtime_version: string
  provider: string
  model_id: string
  exact_model_ref: string
  workflow_plugin_loaded: boolean
  tools: Record<string, boolean> | string[]
  probe_status: string
  availability_state: string
  observed_at: string
  evidence_source: string
  endpoint?: string
  probe_id?: string
}

function digest(value: AnyRecord): AnyRecord {
  const { payload_sha256: _ignored, ...body } = value
  return { ...body, payload_sha256: sha256Canonical(body) }
}
function operation(key: string): AnyRecord {
  return { actor: "plan12-runtime-fixture", reason: `initialize ${key}`, correlation_id: `${key}-correlation` }
}
function assertOk(value: any, operationName: string): any {
  if (!value?.ok) throw new Error(`${operationName}: ${value?.code ?? "REJECTED"}: ${value?.detail ?? "operation failed"}`)
  return value.value
}

/**
 * Creates the one supported isolated Runtime fixture through the production
 * revision and model-route APIs.  It deliberately does not use SQL and never
 * marks a model AVAILABLE without a successful, identity-matched probe.
 */
export function initializePlan12RuntimeFixture(options: {
  dbPath: string
  runtimeRoot?: string
  configRevision?: string
  workflowId?: string
  routeBindingId?: string
  role?: string
  projectScope?: string
  includeXxlJob?: boolean
  /** A real Desktop probe supplied by the caller. Never synthesized here. */
  runtimeProbe?: Plan12VerifiedRuntimeProbe
  /** Alias kept explicit for callers that name the input by its trust level. */
  verifiedProbe?: Plan12VerifiedRuntimeProbe
  observedAt?: string // rejected unless it agrees with the explicit probe
}): { store: ControlPlaneStore; dbPath: string; configRevision: string; modelRef: string; routeBindingId: string; plan: AnyRecord } {
  const revision = options.configRevision ?? "rev-r2"
  const routeBindingId = options.routeBindingId ?? "code_read"
  if (routeBindingId === "code_read" && options.role !== undefined && options.role !== "Project Reader") throw new Error("CODE_READ_ROUTE_ROLE_MISMATCH: code_read requires Project Reader")
  const routeRole = options.role ?? (routeBindingId === "code_read" ? "Project Reader" : undefined)
  if (!routeRole) throw new Error("ROUTE_ROLE_REQUIRED")
  const projectScope = options.projectScope ?? "desktop"
  const probe = options.runtimeProbe ?? options.verifiedProbe
  if (!probe) throw new Error("RUNTIME_PROBE_REQUIRED")
  const requiredProbeFields = ["runtime_version", "provider", "model_id", "exact_model_ref", "observed_at", "evidence_source"]
  if (requiredProbeFields.some((key) => typeof (probe as any)[key] !== "string" || !(probe as any)[key].trim())) throw new Error("RUNTIME_PROBE_INCOMPLETE")
  if (probe.provider !== "openai" || probe.model_id !== "gpt-6.1-sol" || probe.exact_model_ref !== "openai/gpt-6.1-sol#default") throw new Error("RUNTIME_PROBE_IDENTITY_MISMATCH")
  if (probe.probe_status !== "AVAILABLE" || probe.availability_state !== "AVAILABLE" || probe.workflow_plugin_loaded !== true) throw new Error("RUNTIME_PROBE_NOT_AVAILABLE")
  const availableTools = Array.isArray(probe.tools) ? new Set(probe.tools) : new Set(Object.keys(probe.tools ?? {}).filter((tool) => (probe.tools as Record<string, boolean>)[tool]))
  const requiredTools = ["workflow_plan", "workflow_run", "workflow_execute", "workflow_get", "workflow_list"]
  if (requiredTools.some((tool) => !availableTools.has(tool))) throw new Error("RUNTIME_PROBE_TOOLS_INCOMPLETE")
  if (options.observedAt !== undefined && options.observedAt !== probe.observed_at) throw new Error("RUNTIME_PROBE_TIME_MISMATCH")
  const observedAt = probe.observed_at
  const modelRef = "openai/gpt-6.1-sol#default"
  const provider = "openai"
  const modelId = "gpt-6.1-sol"
  const runtimeVersion = probe.runtime_version
  const probeId = probe.probe_id ?? `probe-${revision}-${routeBindingId}`
  const catalogId = `catalog-${revision}-${routeBindingId}`
  const capabilities = { input: true, output: true }
  const tools = probe.tools
  const model = {
    catalog_entry_id: catalogId, config_revision: revision, source: "runtime_probe", runtime_source: "runtime_probe",
    observed_at: observedAt, provider, provider_id: provider, model_id: modelId, variant: "default", exact_model_ref: modelRef,
    display_name: modelRef, capability: capabilities, runtime_version: runtimeVersion, first_seen_at: observedAt, last_seen_at: observedAt,
    probe_status: "AVAILABLE", availability_state: "AVAILABLE", metadata_sha256: sha256Canonical(capabilities), probe_error: null, probe_id: probeId,
    idempotency_key: `model-${revision}-${routeBindingId}`,
  }
  const route = {
    route_binding_id: routeBindingId, role: routeRole, workflow_scope: "global", project_scope: projectScope, lane: "default",
    provider, provider_id: provider, model_id: modelId, variant: "default", exact_model_ref: modelRef, binding_state: "BOUND",
    config_revision: revision, source: "runtime_probe", reason: "verified Desktop runtime route", created_at: observedAt, updated_at: observedAt,
    idempotency_key: `route-${revision}-${routeBindingId}`,
  }
  const xxlRoute = {
    route_binding_id: "xxl-job-unassigned", role: "Project Reader", workflow_scope: "global", project_scope: "xxl-job", lane: "default",
    provider: null, provider_id: null, model_id: null, variant: null, exact_model_ref: null, binding_state: "MODEL_UNASSIGNED",
    config_revision: revision, source: "verified_config", reason: "xxl-job has no assigned Runtime model", created_at: observedAt, updated_at: observedAt,
    idempotency_key: `route-${revision}-xxl-job-unassigned`,
  }
  const snapshotPayload = { revision, model_catalog: [model], route_bindings: options.includeXxlJob === false ? [route] : [route, xxlRoute] }
  const snapshot = digest({
    schema_version: 1, config_revision: revision, source: "plan12-runtime-fixture", observed_at: observedAt, evidence_level: "L3",
    fact_type: "workflow_config_snapshot", parent_revision: null, source_kind: "verified_config", drawio_raw_sha256: "a".repeat(64),
    drawio_semantic_sha256: "b".repeat(64), ir_sha256: "c".repeat(64), config_digest: sha256Canonical(snapshotPayload),
    model_catalog_digest: sha256Canonical(snapshotPayload.model_catalog), route_bindings_digest: sha256Canonical(snapshotPayload.route_bindings),
    canonical_json: JSON.stringify(canonicalizePlan12Json(snapshotPayload)), state: "DRAFT", created_by: "plan12-runtime-fixture",
    created_at: observedAt, activated_at: null, rollback_of: null, idempotency_key: `snapshot-${revision}`,
  })
  const store = initializeControlPlaneDatabase({ dbPath: options.dbPath, runtimeRoot: options.runtimeRoot })
  try {
    assertOk(createConfigRevision(store, snapshot), "createConfigRevision")
    assertOk(transitionConfigRevision(store, { config_revision: revision, to_state: "VALIDATED", idempotency_key: `${revision}-validated`, ...operation(`${revision}-validated`) }), "validate revision")
    assertOk(transitionConfigRevision(store, { config_revision: revision, to_state: "STAGED", idempotency_key: `${revision}-staged`, ...operation(`${revision}-staged`) }), "stage revision")
    assertOk(transitionConfigRevision(store, { config_revision: revision, to_state: "APPLIED", idempotency_key: `${revision}-applied`, ...operation(`${revision}-applied`) }), "apply revision state")
    assertOk(applyConfigRevision(store, { target_revision: revision, expected_active_revision: null, idempotency_key: `${revision}-activate`, ...operation(`${revision}-activate`) }), "activate revision")
    assertOk(recordRuntimeProbe(store, digest({
      probe_id: probeId, endpoint: probe.endpoint ?? probe.evidence_source, runtime_version: runtimeVersion, workflow_plugin_loaded: true, tools,
      provider, provider_id: provider, model_id: modelId, exact_model_ref: modelRef, probe_status: "AVAILABLE", availability_state: "AVAILABLE",
      probe_error: null, observed_at: observedAt, config_revision: revision, metadata: { evidence_source: probe.evidence_source }, idempotency_key: `probe-${revision}-${routeBindingId}`,
    })), "recordRuntimeProbe")
    assertOk(appendModelCatalogEntry(store, digest(model)), "appendModelCatalogEntry")
    assertOk(appendRouteBinding(store, digest(route)), "appendRouteBinding")
    if (options.includeXxlJob !== false) assertOk(appendRouteBinding(store, digest(xxlRoute)), "append xxl-job route")
    return {
      store, dbPath: store.dbPath, configRevision: revision, modelRef, routeBindingId,
      plan: { nodes: [{ node_id: "desktop-node", route: routeBindingId, project_id: projectScope, depends_on: [], metadata: { required: true } }], metadata: { runtime_evidence_required: true, execution_policy: { mode: "isolated_fixture", config_revision: revision, control_plane_db: store.dbPath } } },
    }
  } catch (error) {
    store.close()
    throw error
  }
}

export const initializeRuntimeFixture = initializePlan12RuntimeFixture
