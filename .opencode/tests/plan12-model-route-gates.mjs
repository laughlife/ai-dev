import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { initializeControlPlaneDatabase } from "../lib/plan12-control-plane.ts"
import {
  applyConfigRevision,
  createConfigRevision,
  rollbackConfigRevision,
  transitionConfigRevision,
} from "../lib/plan12-config-revision.ts"
import {
  appendModelCatalogEntry,
  appendRouteBinding,
  listModelRouteAudit,
  listRouteBindings,
  recordRuntimeProbe,
  validateModelCatalogRecord,
  validateRouteBindingRecord,
  validateRouteBinding,
} from "../lib/plan12-model-routes.ts"
import { canonicalizePlan12Json, sha256Canonical } from "../lib/plan12-contract.ts"

const observed = "2026-10-02T00:00:00.000Z"
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan12-4-gates-"))
const store = initializeControlPlaneDatabase({ dbPath: path.join(dir, "control-plane.db") })
const digest = (value) => {
  const { payload_sha256: _ignored, ...body } = value
  return { ...body, payload_sha256: sha256Canonical(body) }
}
const snapshot = (revision, parent_revision = null) => digest({
  schema_version: 1, config_revision: revision, source: "fixture", observed_at: observed,
  evidence_level: "L3", fact_type: "workflow_config_snapshot", parent_revision,
  source_kind: "verified_config", drawio_raw_sha256: "a".repeat(64), drawio_semantic_sha256: "b".repeat(64),
  ir_sha256: "c".repeat(64), config_digest: sha256Canonical({ revision, model_catalog: [], route_bindings: [] }),
  model_catalog_digest: sha256Canonical([]), route_bindings_digest: sha256Canonical([]),
  canonical_json: JSON.stringify(canonicalizePlan12Json({ revision, model_catalog: [], route_bindings: [] })), state: "DRAFT",
  created_by: "plan12-4-gates", created_at: observed, activated_at: null, rollback_of: null,
  idempotency_key: `${revision}:snapshot`,
})
const operation = (key) => ({ actor: "plan12-4-gates", reason: key, correlation_id: `${key}:correlation`, idempotency_key: key })
const transition = (revision, state, key) => transitionConfigRevision(store, { config_revision: revision, to_state: state, ...operation(key) })
const makeProbe = (revision, key, status = "AVAILABLE", availability_state = status) => digest({
  probe_id: key, endpoint: "http://fixture-runtime", runtime_version: "fixture-2.0",
  workflow_plugin_loaded: status === "AVAILABLE",
  tools: { workflow_plan: true, workflow_run: true, workflow_execute: true, workflow_get: true, workflow_list: true },
  provider: status === "AVAILABLE" ? "openai" : null, model_id: status === "AVAILABLE" ? "gpt-5.6-sol" : null,
  exact_model_ref: status === "AVAILABLE" ? "openai/gpt-5.6-sol#high" : null,
  probe_status: status, availability_state, probe_error: status === "AVAILABLE" ? null : "fixture unavailable",
  observed_at: observed, config_revision: revision, metadata: {}, idempotency_key: key,
})
const makeModel = (revision, key, state = "AVAILABLE", exact = "openai/gpt-5.6-sol#high", probe_id = "probe-a") => digest({
  catalog_entry_id: `catalog-${key}`, config_revision: revision, source: state === "AVAILABLE" ? "runtime_probe" : "unavailable_probe",
  observed_at: observed, provider: exact.split("/")[0], model_id: exact.split("/")[1].split("#")[0], exact_model_ref: exact,
  display_name: exact, capability: { input: true, output: true }, runtime_source: state === "AVAILABLE" ? "runtime_probe" : "unavailable_probe",
  runtime_version: "fixture-2.0", first_seen_at: observed, last_seen_at: observed, probe_status: state,
  availability_state: state, metadata_sha256: "d".repeat(64), probe_error: state === "AVAILABLE" ? null : "not available",
  probe_id: state === "AVAILABLE" ? probe_id : null, idempotency_key: key,
})
const makeRoute = (revision, key, state = "BOUND", exact = "openai/gpt-5.6-sol#high", project_scope = "framework") => digest({
  route_binding_id: `route-${key}`, role: "Reviewer", workflow_scope: "global", project_scope, lane: "review",
  provider: state === "MODEL_UNASSIGNED" ? null : exact.split("/")[0], model_id: state === "MODEL_UNASSIGNED" ? null : exact.split("/")[1].split("#")[0],
  exact_model_ref: state === "MODEL_UNASSIGNED" ? null : exact, binding_state: state, config_revision: revision,
  source: "fixture", reason: `fixture ${state}`, created_at: observed, updated_at: observed, idempotency_key: key,
})

try {
  const first = "plan12-4-gates-r1"
  assert.equal(createConfigRevision(store, snapshot(first)).ok, true)

  // Missing identity fields and unknown exact IDs are rejected before any write.
  assert.equal(validateModelCatalogRecord({ config_revision: first }).code, "MODEL_PROVIDER_REQUIRED")
  assert.equal(validateModelCatalogRecord({ provider: "openai", config_revision: first }).code, "MODEL_ID_MISSING")
  assert.equal(validateModelCatalogRecord({ provider: "openai", model_id: "gpt-5.6-sol", config_revision: first }).code, "MODEL_EXACT_REF_REQUIRED")
  assert.equal(validateModelCatalogRecord({ ...makeModel(first, "mismatch"), provider_id: "deepseek" }).code, "MODEL_PROVIDER_MISMATCH")
  assert.equal(validateModelCatalogRecord({ ...makeModel(first, "variant-mismatch"), variant: "low" }).code, "MODEL_VARIANT_MISMATCH")
  assert.equal(validateModelCatalogRecord({ provider: "openai", model_id: "gpt 6.1 sol", exact_model_ref: "openai/gpt 6.1 sol", config_revision: first }).code, "MODEL_ID_INVALID")
  assert.equal(validateModelCatalogRecord({ provider: "openai", model_id: "gpt-6.1-sol", exact_model_ref: "openai/gpt-6.1-sol#v#2", config_revision: first }).code, "MODEL_ID_INVALID")
  assert.equal(validateModelCatalogRecord({ provider: "openai", model_id: "gpt-6.1-sol", exact_model_ref: "openai/gpt-6.1-sol#", config_revision: first }).code, "MODEL_ID_INVALID")

  assert.equal(recordRuntimeProbe(store, makeProbe(first, "probe-a")).ok, true)
  const incompleteAvailableProbe = makeProbe(first, "probe-incomplete")
  incompleteAvailableProbe.config_revision = null
  incompleteAvailableProbe.runtime_version = null
  incompleteAvailableProbe.provider = null
  incompleteAvailableProbe.provider_id = null
  incompleteAvailableProbe.model_id = null
  incompleteAvailableProbe.exact_model_ref = null
  Object.assign(incompleteAvailableProbe, digest(incompleteAvailableProbe))
  assert.equal(recordRuntimeProbe(store, incompleteAvailableProbe).code, "MODEL_CONFIG_REVISION_REQUIRED")
  assert.equal(recordRuntimeProbe(store, { ...makeProbe(first, "probe-inconsistent", "UNAVAILABLE", "AVAILABLE") }).code, "MODEL_PROBE_STATE_MISMATCH")
  const available = makeModel(first, "model-a")
  assert.equal(appendModelCatalogEntry(store, available).ok, true)
  const dynamicUnknown = digest({ ...makeModel(first, "dynamic-unknown", "UNKNOWN", "openai/gpt-6.1-sol"), runtime_source: "runtime_catalog" })
  assert.equal(appendModelCatalogEntry(store, dynamicUnknown).ok, true)
  const dynamicUnavailable = digest({ ...makeModel(first, "dynamic-unavailable", "UNAVAILABLE", "bailian-token-plan/qwen3.8-flash"), runtime_source: "unavailable_probe" })
  assert.equal(appendModelCatalogEntry(store, dynamicUnavailable).ok, true)
  const dynamicProbe = digest({ ...makeProbe(first, "probe-dynamic"), model_id: "model-x", exact_model_ref: "acme/model-x#v1", provider: "acme" })
  assert.equal(recordRuntimeProbe(store, dynamicProbe).ok, true)
  const dynamicAvailable = makeModel(first, "dynamic-available", "AVAILABLE", "acme/model-x#v1", "probe-dynamic")
  assert.equal(appendModelCatalogEntry(store, dynamicAvailable).ok, true)
  assert.equal(appendRouteBinding(store, makeRoute(first, "dynamic-route", "BOUND", "acme/model-x#v1")).ok, true)
  assert.equal(validateRouteBinding(store, "route-dynamic-route", first).status, "ADMITTED")
  assert.equal(appendModelCatalogEntry(store, available).status, "IDEMPOTENT")
  assert.equal(appendModelCatalogEntry(store, digest({ ...available, display_name: "conflict", idempotency_key: "model-a" })).code, "EVIDENCE_IDEMPOTENCY_CONFLICT")
  assert.equal(appendModelCatalogEntry(store, makeModel(first, "model-unavailable", "UNAVAILABLE", "deepseek/deepseek-flash")).ok, true)
  assert.equal(appendModelCatalogEntry(store, makeModel(first, "model-unknown", "UNKNOWN", "openai/gpt-5.6-sol-fast#high")).ok, true)
  assert.equal(appendModelCatalogEntry(store, makeModel(first, "model-rejected", "REJECTED", "openai/gpt-6-sol-fast#xhigh")).ok, true)

  // A blocked probe is persisted as UNKNOWN/BLOCKED and can never back an AVAILABLE entry.
  assert.equal(recordRuntimeProbe(store, makeProbe(first, "probe-blocked", "BLOCKED", "UNKNOWN")).ok, true)
  assert.equal(appendModelCatalogEntry(store, makeModel(first, "model-fake-available", "AVAILABLE", "openai/gpt-5.6-sol#high", "probe-blocked")).code, "MODEL_RUNTIME_PROBE_REQUIRED")

  assert.equal(appendRouteBinding(store, makeRoute(first, "bound")).ok, true)
  assert.equal(validateRouteBinding(store, "route-bound", first).ok, true)
  assert.equal(appendRouteBinding(store, makeRoute(first, "unassigned", "MODEL_UNASSIGNED")).ok, true)
  assert.equal(validateRouteBinding(store, "route-unassigned", first).code, "MODEL_UNASSIGNED")
  assert.equal(validateRouteBinding(store, "route-unassigned", first).code, "MODEL_UNASSIGNED")
  assert.equal(appendRouteBinding(store, makeRoute(first, "unavailable", "UNAVAILABLE")).ok, true)
  assert.equal(validateRouteBinding(store, "route-unavailable", first).code, "MODEL_UNAVAILABLE")
  assert.equal(appendRouteBinding(store, makeRoute(first, "rejected", "REJECTED")).ok, true)
  assert.equal(validateRouteBinding(store, "route-rejected", first).code, "MODEL_ROUTE_REJECTED")
  assert.equal(validateRouteBinding(store, "route-does-not-exist", first).code, "MODEL_ROUTE_REJECTED")
  assert.equal(appendRouteBinding(store, makeRoute(first, "xxl", "MODEL_UNASSIGNED", "openai/gpt-5.6-sol#high", "xxl-job")).ok, true)
  assert.equal(validateRouteBinding(store, "route-xxl", first).code, "MODEL_UNASSIGNED")
  assert.equal(appendRouteBinding(store, makeRoute(first, "missing-catalog", "BOUND", "openai/gpt-5.6-sol-fast#high")).code, "MODEL_CATALOG_NOT_FOUND")
  const badTime = makeRoute(first, "bad-time")
  badTime.created_at = "not-a-utc-time"
  assert.equal(validateRouteBindingRecord(badTime).code, "ROUTE_TIME_INVALID")
  const strayVariant = makeRoute(first, "stray-variant", "MODEL_UNASSIGNED")
  strayVariant.variant = "high"
  assert.equal(validateRouteBindingRecord(strayVariant).code, "MODEL_UNASSIGNED_BOUND")

  // A second revision demonstrates cross-revision isolation and lifecycle fail-closed behavior.
  assert.equal(transition(first, "VALIDATED", "r1-validated").ok, true)
  assert.equal(transition(first, "STAGED", "r1-staged").ok, true)
  assert.equal(transition(first, "APPLIED", "r1-applied").ok, true)
  assert.equal(applyConfigRevision(store, { expected_active_revision: null, target_revision: first, ...operation("apply-r1") }).ok, true)
  const second = "plan12-4-gates-r2"
  assert.equal(createConfigRevision(store, snapshot(second, first)).ok, true)
  assert.equal(recordRuntimeProbe(store, makeProbe(second, "probe-b")).ok, true)
  assert.equal(appendModelCatalogEntry(store, makeModel(second, "model-b", "AVAILABLE", "openai/gpt-5.6-sol#high", "probe-b")).ok, true)
  assert.equal(appendRouteBinding(store, makeRoute(second, "route-b")).ok, true)
  assert.equal(validateRouteBinding(store, "route-bound", second).code, "MODEL_CONFIG_REVISION_CONFLICT")
  assert.equal(transition(second, "VALIDATED", "r2-validated").ok, true)
  assert.equal(transition(second, "STAGED", "r2-staged").ok, true)
  assert.equal(transition(second, "APPLIED", "r2-applied").ok, true)
  assert.equal(applyConfigRevision(store, { expected_active_revision: first, target_revision: second, ...operation("apply-r2") }).ok, true)
  assert.equal(validateRouteBinding(store, "route-bound", first).code, "MODEL_CONFIG_REVISION_CONFLICT")
  assert.equal(validateRouteBinding(store, "route-route-b", second).ok, true)
  assert.equal(rollbackConfigRevision(store, { expected_active_revision: second, target_revision: first, ...operation("rollback-r1") }).ok, true)
  assert.equal(validateRouteBinding(store, "route-route-b", second).code, "MODEL_CONFIG_REVISION_CONFLICT")

  const audit = listModelRouteAudit(store)
  assert.ok(audit.some((row) => row.status === "MODEL_UNASSIGNED"))
  assert.ok(audit.some((row) => row.status === "MODEL_UNAVAILABLE"))
  assert.ok(listRouteBindings(store).length >= 5)
  console.log("PLAN12_MODEL_ROUTE_GATES_PASS")
  console.log("PLAN12_DYNAMIC_RUNTIME_ID_PASS")
  console.log("PLAN12_MODEL_IDENTITY_REGRESSION_PASS")
} finally {
  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
}
