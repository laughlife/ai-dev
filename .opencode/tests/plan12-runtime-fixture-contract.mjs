import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { initializePlan12RuntimeFixture } from "../lib/plan12-runtime-fixture.ts"
import { resolveControlPlaneDatabasePath } from "../lib/plan12-control-plane.ts"
import { workerRoleForRoute } from "../plugins/workflow-engine/scheduler.ts"

const observedAt = "2026-10-03T00:00:00.000Z"
const probe = (overrides = {}) => ({
  runtime_version: "desktop-2026.10.03",
  provider: "openai",
  model_id: "gpt-6.1-sol",
  exact_model_ref: "openai/gpt-6.1-sol#default",
  workflow_plugin_loaded: true,
  tools: { workflow_plan: true, workflow_run: true, workflow_execute: true, workflow_get: true, workflow_list: true },
  probe_status: "AVAILABLE",
  availability_state: "AVAILABLE",
  observed_at: observedAt,
  evidence_source: "desktop-probe://verified-session",
  endpoint: "desktop://runtime",
  ...overrides,
})

test("Plan12 fixture is fail-closed and admits only an explicit verified probe", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan12-fixture-"))
  try {
    assert.throws(() => initializePlan12RuntimeFixture({ dbPath: "runtime/control-plane.db", runtimeRoot: root }), /RUNTIME_PROBE_REQUIRED/)
    assert.throws(() => initializePlan12RuntimeFixture({ dbPath: "runtime/control-plane.db", runtimeRoot: root, runtimeProbe: probe({ probe_status: "UNKNOWN", availability_state: "UNKNOWN" }) }), /RUNTIME_PROBE_NOT_AVAILABLE/)
    assert.throws(() => initializePlan12RuntimeFixture({ dbPath: "runtime/control-plane.db", runtimeRoot: root, runtimeProbe: probe({ exact_model_ref: "bailian-token-plan/qwen3.8-max" }) }), /RUNTIME_PROBE_IDENTITY_MISMATCH/)
    assert.throws(() => initializePlan12RuntimeFixture({ dbPath: "runtime/control-plane.db", runtimeRoot: root, runtimeProbe: probe({ tools: {} }) }), /RUNTIME_PROBE_TOOLS_INCOMPLETE/)
    assert.throws(() => initializePlan12RuntimeFixture({ dbPath: "runtime/control-plane.db", runtimeRoot: root, runtimeProbe: probe(), observedAt: "2026-10-04T00:00:00.000Z" }), /RUNTIME_PROBE_TIME_MISMATCH/)
    for (const routeBindingId of [undefined, "code_read"]) {
      assert.throws(() => initializePlan12RuntimeFixture({ dbPath: "runtime/control-plane.db", runtimeRoot: root, routeBindingId, role: "Feature Executor", runtimeProbe: probe() }), /CODE_READ_ROUTE_ROLE_MISMATCH: code_read requires Project Reader/)
    }
    assert.equal(fs.existsSync(path.join(root, "runtime", "control-plane.db")), false, "rejected inputs must not create the database")

    const fixture = initializePlan12RuntimeFixture({ dbPath: "runtime/control-plane.db", runtimeRoot: root, runtimeProbe: probe() })
    assert.equal(fixture.modelRef, "openai/gpt-6.1-sol#default")
    assert.equal(fixture.plan.nodes[0].route, "code_read")
    assert.equal(fixture.store.db.prepare("SELECT runtime_version, exact_model_ref, availability_state FROM runtime_model_probes").get().runtime_version, "desktop-2026.10.03")
    assert.equal(fixture.store.db.prepare("SELECT role FROM route_bindings WHERE route_binding_id='code_read'").get().role, "Project Reader")
    assert.equal(fixture.store.db.prepare("SELECT binding_state FROM route_bindings WHERE project_scope='xxl-job'").get().binding_state, "MODEL_UNASSIGNED")
    assert.ok(fixture.store.db.prepare("SELECT COUNT(*) AS n FROM model_route_audit_events").get().n > 0, "probe and route evidence must be written through production APIs")
    fixture.store.close()

    assert.equal(resolveControlPlaneDatabasePath({ dbPath: "runtime/control-plane.db", runtimeRoot: root }), path.join(root, "runtime", "control-plane.db"))
    assert.throws(() => resolveControlPlaneDatabasePath({ dbPath: "../outside.db", runtimeRoot: root }), /CONTROL_PLANE_DB_OUTSIDE_RUNTIME_ROOT/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("Plan12 fixture rejects a relative database path without a runtime root", () => {
  const previousRoot = process.env.AI_DEV_ROOT
  try {
    delete process.env.AI_DEV_ROOT
    assert.throws(() => initializePlan12RuntimeFixture({ dbPath: "runtime/control-plane.db", runtimeProbe: probe() }), /CONTROL_PLANE_DB_ROOT_REQUIRED_FOR_RELATIVE_PATH/)
  } finally {
    if (previousRoot === undefined) delete process.env.AI_DEV_ROOT
    else process.env.AI_DEV_ROOT = previousRoot
  }
})

test("Plan12 fixture preserves other explicit route roles", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan12-fixture-route-"))
  let fixture
  try {
    assert.throws(() => initializePlan12RuntimeFixture({ dbPath: "runtime/control-plane.db", runtimeRoot: root, routeBindingId: "code_change", runtimeProbe: probe() }), /ROUTE_ROLE_REQUIRED/)
    fixture = initializePlan12RuntimeFixture({ dbPath: "runtime/control-plane.db", runtimeRoot: root, routeBindingId: "code_change", role: "Feature Executor", runtimeProbe: probe() })
    assert.equal(fixture.plan.nodes[0].route, "code_change")
    assert.equal(fixture.store.db.prepare("SELECT role FROM route_bindings WHERE route_binding_id='code_change'").get().role, "Feature Executor")
  } finally {
    fixture?.store.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("Plan12 route role policy follows route and never supplies a feature fallback", () => {
  assert.equal(workerRoleForRoute("code_read"), "project-reader")
  assert.equal(workerRoleForRoute("code_read", true), "project-reader")
  assert.equal(workerRoleForRoute("code_change", true), "feature-executor")
})

console.log("PLAN12_RUNTIME_FIXTURE_CONTRACT_PASS")
