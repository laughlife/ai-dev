import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { initializeControlPlaneDatabase } from "../lib/plan12-control-plane.ts"
import {
  appendModelCatalogEntry,
  appendRouteBinding,
  getModelCatalog,
  getRouteBinding,
  listModelRouteAudit,
  listRouteBindings,
  recordRuntimeProbe,
  validateModelCatalogRecord,
  validateRouteBindingRecord,
  validateRouteBinding,
} from "../lib/plan12-model-routes.ts"
import {
  applyConfigRevision,
  createConfigRevision,
  rollbackConfigRevision,
  transitionConfigRevision,
} from "../lib/plan12-config-revision.ts"
import { makeSnapshot, operationFields, transition } from "./plan12-3-fixtures.mjs"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan12-4-model-route-"))
const dbPath = path.join(dir, "control-plane.db")
const store = initializeControlPlaneDatabase({ dbPath, runtimeRoot: dir, allowedRoots: [dir] })
const at = "2026-10-02T00:00:00.000Z"
const revision = "cr-plan12-4-001"

const modelInput = (overrides = {}) => ({
  catalog_entry_id: "catalog-openai-high",
  provider: "openai",
  model_id: "gpt-5.6-sol",
  exact_model_ref: "openai/gpt-5.6-sol#high",
  display_name: "presentation-only-name",
  capability: { context_limit: null, input: true, output: true },
  availability_state: "AVAILABLE",
  runtime_source: "runtime_probe",
  runtime_version: "desktop-v2-fixture",
  first_seen_at: at,
  last_seen_at: at,
  probe_status: "AVAILABLE",
  probe_id: "probe-openai-high",
  probe_error: null,
  metadata_sha256: "a".repeat(64),
  config_revision: revision,
  created_at: at,
  updated_at: at,
  idempotency_key: "catalog-openai-high-key",
  ...overrides,
})

const routeInput = (overrides = {}) => ({
  route_binding_id: "route-planner",
  role: "Planner",
  workflow_scope: "global",
  project_scope: null,
  lane: "coding",
  provider: "openai",
  model_id: "gpt-5.6-sol",
  exact_model_ref: "openai/gpt-5.6-sol#high",
  binding_state: "BOUND",
  config_revision: revision,
  source: "verified_config",
  reason: "plan12-4 fixture",
  created_at: at,
  updated_at: at,
  idempotency_key: "route-planner-key",
  ...overrides,
})

function makeModelRevision(nextRevision, parentRevision = null, payload = { model_catalog: [], route_bindings: [] }) {
  return makeSnapshot(nextRevision, parentRevision, `${nextRevision}-snapshot`, { revision: nextRevision, ...payload })
}

try {
  assert.equal(createConfigRevision(store, makeModelRevision(revision)).ok, true)

  // Provider/model identity and role validation fail closed.
  assert.equal(validateModelCatalogRecord({ ...modelInput(), provider: null }).code, "MODEL_PROVIDER_REQUIRED")
  assert.equal(validateModelCatalogRecord({ ...modelInput(), model_id: null }).code, "MODEL_ID_MISSING")
  assert.equal(validateModelCatalogRecord({ ...modelInput(), exact_model_ref: null }).code, "MODEL_EXACT_REF_REQUIRED")
  assert.equal(validateModelCatalogRecord({ ...modelInput(), model_id: "not-known", exact_model_ref: "openai/not-known/extra" }).code, "MODEL_ID_INVALID")
  assert.equal(validateRouteBindingRecord({ ...routeInput(), role: "not-an-architecture-role" }).ok, false)

  const probe = recordRuntimeProbe(store, {
    probe_id: "probe-openai-high",
    endpoint: "http://desktop-v2-fixture",
    runtime_version: "desktop-v2-fixture",
    workflow_plugin_loaded: true,
    tools: ["workflow_plan", "workflow_run", "workflow_execute", "workflow_get", "workflow_list"],
    provider: "openai",
    model_id: "gpt-5.6-sol",
    exact_model_ref: "openai/gpt-5.6-sol#high",
    probe_status: "AVAILABLE",
    availability_state: "AVAILABLE",
    observed_at: at,
    config_revision: revision,
    metadata: { source: "isolated-fixture" },
    idempotency_key: "probe-openai-high-key",
  })
  assert.equal(probe.ok, true)
  assert.equal(recordRuntimeProbe(store, {
    probe_id: "probe-bad-time",
    endpoint: "http://desktop-v2-fixture",
    workflow_plugin_loaded: false,
    tools: [],
    probe_status: "UNAVAILABLE",
    availability_state: "UNAVAILABLE",
    observed_at: "not-a-utc-time",
    idempotency_key: "probe-bad-time-key",
  }).ok, false)

  const catalog = appendModelCatalogEntry(store, modelInput())
  assert.equal(catalog.ok, true)
  assert.equal(catalog.value.variant, "high")
  assert.equal(catalog.value.probe_id, "probe-openai-high")
  assert.equal(appendModelCatalogEntry(store, modelInput()).status, "IDEMPOTENT")
  assert.equal(appendModelCatalogEntry(store, modelInput({ display_name: "different" })).code, "EVIDENCE_IDEMPOTENCY_CONFLICT")

  // Qwen configuration presence never proves availability and cannot be silently replaced.
  assert.notEqual(validateModelCatalogRecord(modelInput({
    catalog_entry_id: "qwen-candidate",
    provider: "bailian-token-plan",
    model_id: "qwen3.8-max",
    exact_model_ref: "bailian-token-plan/qwen3.8-max",
    availability_state: "AVAILABLE",
    runtime_source: "verified_config",
    probe_status: "VERIFIED",
    probe_id: null,
    idempotency_key: "qwen-candidate-key",
  })).ok, true)

  const bound = appendRouteBinding(store, routeInput())
  assert.equal(bound.ok, true)
  assert.equal(bound.value.variant, "high")
  assert.equal(appendRouteBinding(store, routeInput()).status, "IDEMPOTENT")
  assert.equal(appendRouteBinding(store, routeInput({ reason: "different" })).code, "EVIDENCE_IDEMPOTENCY_CONFLICT")
  assert.equal(validateRouteBinding(store, "route-planner", revision).status, "ADMITTED")

  const unassigned = appendRouteBinding(store, routeInput({
    route_binding_id: "route-xxl-job",
    project_scope: "xxl-job",
    role: "Feature Executor",
    provider: null,
    model_id: null,
    exact_model_ref: null,
    binding_state: "MODEL_UNASSIGNED",
    reason: "xxl-job has no configured runtime_id",
    idempotency_key: "route-xxl-job-key",
  }))
  assert.equal(unassigned.ok, true)
  assert.equal(validateRouteBinding(store, "route-xxl-job", revision).code, "MODEL_UNASSIGNED")
  assert.equal(appendRouteBinding(store, routeInput({
    route_binding_id: "route-xxl-job-invalid",
    project_scope: "xxl-job",
    idempotency_key: "route-xxl-job-invalid-key",
  })).code, "PROJECT_MODEL_UNASSIGNED")

  const unavailable = appendRouteBinding(store, routeInput({
    route_binding_id: "route-unavailable",
    binding_state: "UNAVAILABLE",
    idempotency_key: "route-unavailable-key",
  }))
  assert.equal(unavailable.ok, true)
  assert.equal(validateRouteBinding(store, "route-unavailable", revision).code, "MODEL_UNAVAILABLE")
  const rejected = appendRouteBinding(store, routeInput({
    route_binding_id: "route-rejected",
    binding_state: "REJECTED",
    idempotency_key: "route-rejected-key",
  }))
  assert.equal(rejected.ok, true)
  assert.equal(validateRouteBinding(store, "route-rejected", revision).code, "MODEL_ROUTE_REJECTED")
  assert.equal(appendRouteBinding(store, routeInput({ route_binding_id: "route-no-catalog", exact_model_ref: "openai/gpt-5.6-sol-fast#high", model_id: "gpt-5.6-sol-fast", idempotency_key: "route-no-catalog-key" })).code, "MODEL_CATALOG_NOT_FOUND")

  // Apply a child revision, then ensure the old route cannot be admitted.
  const secondRevision = "cr-plan12-4-002"
  assert.equal(createConfigRevision(store, makeModelRevision(secondRevision, revision)).ok, true)
  for (const state of ["VALIDATED", "STAGED", "APPLIED"]) assert.equal(transition(store, transitionConfigRevision, revision, state, `apply-${revision}-${state}`).ok, true)
  assert.equal(applyConfigRevision(store, { expected_active_revision: null, target_revision: revision, idempotency_key: "apply-revision-1", ...operationFields("apply-revision-1") }).ok, true)
  for (const state of ["VALIDATED", "STAGED", "APPLIED"]) assert.equal(transition(store, transitionConfigRevision, secondRevision, state, `apply-${secondRevision}-${state}`).ok, true)
  assert.equal(applyConfigRevision(store, { expected_active_revision: revision, target_revision: secondRevision, idempotency_key: "apply-revision-2", ...operationFields("apply-revision-2") }).ok, true)
  assert.equal(validateRouteBinding(store, "route-planner", revision).code, "MODEL_CONFIG_REVISION_CONFLICT")
  assert.equal(rollbackConfigRevision(store, { expected_active_revision: secondRevision, target_revision: revision, idempotency_key: "rollback-revision-1", ...operationFields("rollback-revision-1") }).ok, true)
  assert.equal(validateRouteBinding(store, "route-planner", secondRevision).code, "MODEL_CONFIG_REVISION_CONFLICT")

  // All model/route evidence is queryable after close/reopen and remains append-only.
  assert.equal(getModelCatalog(store, { config_revision: revision }).length, 1)
  assert.equal(getRouteBinding(store, "route-planner").variant, "high")
  assert.ok(listRouteBindings(store).length >= 4)
  assert.ok(listModelRouteAudit(store).length >= 5)
  assert.throws(() => store.db.prepare("UPDATE model_catalog SET display_name='mutated' WHERE catalog_entry_id='catalog-openai-high'").run(), /APPEND_ONLY_UPDATE_FORBIDDEN/)
  assert.throws(() => store.db.prepare("DELETE FROM route_bindings WHERE route_binding_id='route-planner'").run(), /APPEND_ONLY_DELETE_FORBIDDEN/)
  store.close()
  const reopened = initializeControlPlaneDatabase({ dbPath, runtimeRoot: dir, allowedRoots: [dir] })
  try {
    assert.equal(getModelCatalog(reopened, { config_revision: revision }).length, 1)
    assert.equal(getRouteBinding(reopened, "route-planner").exact_model_ref, "openai/gpt-5.6-sol#high")
  } finally { reopened.close() }
  console.log("PLAN12_MODEL_CATALOG_PASS")
  console.log("PLAN12_ROUTE_BINDING_PASS")
  console.log("PLAN12_MODEL_UNASSIGNED_GATE_PASS")
} finally {
  try { store.close() } catch {}
  fs.rmSync(dir, { recursive: true, force: true })
}
