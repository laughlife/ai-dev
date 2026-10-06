import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import {
  initializePlan12RuntimeFixture,
  loadPlan12ArchitectureFingerprints,
  PLAN12_REQUIRED_RUNTIME_TOOLS,
  resolvePlan12OpenCodeCliInvocation,
  resolvePlan12FixtureRoleModel,
} from "../lib/plan12-runtime-fixture.ts"
import { extractVerifiedProbeFromDesktopResponses } from "../lib/plan12-runtime-fixture-cli.ts"
import { resolveControlPlanePathEnvelope } from "../lib/plan12-control-plane.ts"
import { sha256Canonical } from "../lib/plan12-contract.ts"
import { workerRoleForRoute } from "../plugins/workflow-engine/scheduler.ts"

const frameworkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const observedAt = "2026-10-03T00:00:00.000Z"
const reader = resolvePlan12FixtureRoleModel(frameworkRoot)
const syntheticToolEvidence = Object.fromEntries(PLAN12_REQUIRED_RUNTIME_TOOLS.map((tool) => [tool, {
  response_message_id: "msg_synthetic_non_live",
  tool_call_id: `call_${tool}`,
  channel: "code_mode_execute",
  registered_tool: `workflow.${tool}`,
  status: "completed",
  input_sha256: "1".repeat(64),
  execute_input_sha256: "3".repeat(64),
  response_sha256: "2".repeat(64),
  response_excerpt: "synthetic-not-live",
}]))
const syntheticProbe = (overrides = {}) => ({
  runtime_version: "synthetic-desktop-2026.10.03",
  provider: "deepseek",
  model_id: "deepseek-flash",
  exact_model_ref: "deepseek/deepseek-flash",
  workflow_plugin_loaded: true,
  tools: { workflow_plan: true, workflow_run: true, workflow_execute: true, workflow_get: true, workflow_list: true },
  probe_status: "AVAILABLE",
  availability_state: "AVAILABLE",
  observed_at: observedAt,
  evidence_source: "synthetic-contract-test://not-live",
  endpoint: "synthetic://not-live",
  probe_kind: "synthetic_non_live",
  requested_model_ref: "deepseek/deepseek-flash",
  response_model_ref: "deepseek/deepseek-flash",
  response_session_id: "ses_synthetic_non_live",
  response_message_id: "msg_synthetic_non_live",
  response_completed_at: observedAt,
  challenge: "synthetic-not-live",
  response_text_sha256: sha256Canonical("synthetic-not-live"),
  response_agent: "project-reader",
  raw_response_model_ref: "deepseek/deepseek-flash",
  session_location: frameworkRoot,
  tool_evidence: syntheticToolEvidence,
  ...overrides,
})

test("Reader fixture resolves the formal DeepSeek role and rejects synthetic persistence before database creation", () => {
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "plan12-fixture-"))
  const dbPath = path.join(isolated, "runtime", "control-plane.db")
  try {
    assert.equal(reader.runtimeId, "deepseek/deepseek-flash")
    assert.equal(reader.role, "Project Reader")
    assert.throws(() => initializePlan12RuntimeFixture({ dbPath, runtimeRoot: frameworkRoot, allowedRoots: [isolated] }), /RUNTIME_PROBE_REQUIRED/)
    assert.throws(() => initializePlan12RuntimeFixture({ dbPath, runtimeRoot: frameworkRoot, allowedRoots: [isolated], runtimeProbe: syntheticProbe() }), /RUNTIME_PROBE_SYNTHETIC_PERSISTENCE_FORBIDDEN/)
    assert.throws(() => initializePlan12RuntimeFixture({ dbPath, runtimeRoot: frameworkRoot, allowedRoots: [isolated], runtimeProbe: syntheticProbe(), allowSyntheticNonLive: true }), /RUNTIME_PROBE_SYNTHETIC_PERSISTENCE_FORBIDDEN/)
    assert.throws(() => initializePlan12RuntimeFixture({ dbPath, runtimeRoot: frameworkRoot, allowedRoots: [isolated], runtimeProbe: syntheticProbe({ tools: {} }), allowSyntheticNonLive: true }), /RUNTIME_PROBE_SYNTHETIC_PERSISTENCE_FORBIDDEN/)
    assert.equal(fs.existsSync(dbPath), false, "synthetic evidence must be rejected before creating an L3-capable database")
  } finally {
    fs.rmSync(isolated, { recursive: true, force: true })
  }
})

test("fixture fingerprints come from the real Drawio compiler and are not placeholders", () => {
  const fingerprints = loadPlan12ArchitectureFingerprints(frameworkRoot)
  for (const value of [fingerprints.drawio_raw_sha256, fingerprints.drawio_semantic_sha256, fingerprints.ir_sha256]) {
    assert.match(value, /^[a-f0-9]{64}$/)
    assert.notEqual(value, "a".repeat(64))
    assert.notEqual(value, "b".repeat(64))
    assert.notEqual(value, "c".repeat(64))
  }
  assert.notEqual(fingerprints.drawio_raw_sha256, fingerprints.drawio_semantic_sha256)
  assert.notEqual(fingerprints.drawio_semantic_sha256, fingerprints.ir_sha256)
})

test("unified path envelope requires an explicit root and blocks lexical and symlink escapes", () => {
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "plan12-path-"))
  const allowed = path.join(isolated, "allowed")
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "plan12-outside-"))
  fs.mkdirSync(allowed)
  try {
    assert.throws(() => resolveControlPlanePathEnvelope({ dbPath: "runtime/control-plane.db" }), /CONTROL_PLANE_DB_RUNTIME_ROOT_REQUIRED/)
    assert.throws(() => resolveControlPlanePathEnvelope({ dbPath: path.join(outside, "control-plane.db"), runtimeRoot: frameworkRoot, allowedRoots: [allowed] }), /CONTROL_PLANE_DB_OUTSIDE_ALLOWED_ROOTS/)
    assert.throws(() => resolveControlPlanePathEnvelope({ dbPath: "nested/control-plane.db", runtimeRoot: frameworkRoot, allowedRoots: [allowed] }), /CONTROL_PLANE_DB_OUTSIDE_ALLOWED_ROOTS/)
    const envelope = resolveControlPlanePathEnvelope({ dbPath: path.join(allowed, "nested", "control-plane.db"), runtimeRoot: frameworkRoot, allowedRoots: [allowed] })
    assert.equal(envelope.environment_root_used, false)
    assert.equal(envelope.policy, "explicit-runtime-root-v1")
    assert.equal(envelope.control_plane_db.startsWith(allowed), true)
    const junction = path.join(allowed, "junction-out")
    fs.symlinkSync(outside, junction, "junction")
    assert.throws(() => resolveControlPlanePathEnvelope({ dbPath: path.join(junction, "control-plane.db"), runtimeRoot: frameworkRoot, allowedRoots: [allowed] }), /CONTROL_PLANE_DB_SYMLINK_ESCAPE/)
  } finally {
    fs.rmSync(isolated, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

test("Windows Desktop CLI preserves JSON as one argv item without Windows PowerShell 5.1", () => {
  const payload = JSON.stringify({ title: "probe", nested: { value: "quoted" } })
  const args = ["api", "post", "/api/session", "--data", payload]
  const localAppData = "C:\\Users\\fixture\\AppData\\Local"
  const expected = path.join(localAppData, "Programs", "@opencodedesktop", "resources", "opencode-cli.exe")
  const invocation = resolvePlan12OpenCodeCliInvocation(args, { platform: "win32", env: { LOCALAPPDATA: localAppData, PATH: "C:\\fixture" }, exists: (file) => file === expected })
  assert.equal(invocation.command, expected)
  assert.deepEqual(invocation.args, args)
  assert.equal(invocation.args.at(-1), payload)
  assert.notEqual(path.basename(invocation.command).toLowerCase(), "powershell.exe")
})

test("Desktop probe requires framework location and five Code Mode execute responses, and normalizes #default", () => {
  const invalidId = "plan12-probe-invalid-contract"
  const invalidProject = "plan12-probe-invalid-project"
  const toolParts = [
    ["workflow_list", { limit: 1 }, '{"ok":true,"status":"OK","workflows":[]}'],
    ["workflow_get", { workflow_id: invalidId }, '{"ok":false,"code":"WORKFLOW_NOT_FOUND"}'],
    ["workflow_run", { workflow_id: invalidId }, '{"ok":false,"code":"WORKFLOW_NOT_FOUND"}'],
    ["workflow_plan", { primary_project_id: invalidProject, objective: "capability probe" }, '{"ok":false,"code":"PROJECT_NOT_FOUND"}'],
    ["workflow_execute", { primary_project_id: invalidProject, objective: "capability probe" }, '{"ok":false,"code":"PROJECT_NOT_FOUND"}'],
  ].map(([name, input, text]) => ({
    type: "tool",
    id: `call_execute_${name}`,
    name: "execute",
    state: {
      status: "completed",
      input: { code: `return await tools.workflow.${name}(${JSON.stringify(input)});` },
      content: [{ type: "text", text }],
      metadata: { toolCalls: [{ tool: `workflow.${name}`, status: "completed", input }], truncated: false },
    },
    time: { created: Date.parse(observedAt), completed: Date.parse(observedAt) },
  }))
  const base = {
    targetModelRef: reader.runtimeId,
    runtimeRoot: frameworkRoot,
    serverInfo: { data: { version: "2.0.23" } },
    plugins: { data: [{ id: "workflow-engine", features: { server: true }, state: { status: "active" } }] },
    session: { data: { id: "ses_real_response", agent: "project-reader", model: { providerID: "deepseek", id: "deepseek-flash", variant: "default" }, location: { directory: frameworkRoot } } },
    expectedText: "ok",
    messages: { data: [
      { id: "msg_tool_responses", type: "assistant", agent: "project-reader", model: { providerID: "deepseek", id: "deepseek-flash", variant: "default" }, time: { created: Date.parse(observedAt), completed: Date.parse(observedAt) }, content: toolParts },
      { id: "msg_real_response", type: "assistant", agent: "project-reader", model: { providerID: "deepseek", id: "deepseek-flash", variant: "default" }, time: { created: Date.parse(observedAt), completed: Date.parse(observedAt) }, content: [{ type: "text", text: "ok" }] },
    ] },
    observedAt,
  }
  const probe = extractVerifiedProbeFromDesktopResponses(base)
  assert.equal(probe.exact_model_ref, reader.runtimeId)
  assert.equal(probe.raw_response_model_ref, `${reader.runtimeId}#default`)
  assert.equal(probe.session_location, frameworkRoot)
  assert.deepEqual(Object.keys(probe.tool_evidence).sort(), [...PLAN12_REQUIRED_RUNTIME_TOOLS].sort())
  assert.equal(Object.values(probe.tools).every(Boolean), true)
  assert.equal(Object.values(probe.tool_evidence).every((evidence) => evidence.channel === "code_mode_execute" && evidence.registered_tool.startsWith("workflow.")), true)
  assert.equal(probe.authenticated_transport, "opencode-cli-managed-auth")
  assert.throws(() => extractVerifiedProbeFromDesktopResponses({ ...base, session: { data: { ...base.session.data, location: { directory: path.dirname(frameworkRoot) } } } }), /RUNTIME_PROBE_SESSION_LOCATION_MISMATCH/)
  assert.throws(() => extractVerifiedProbeFromDesktopResponses({ ...base, messages: { data: [base.messages.data[0]] } }), /RUNTIME_PROBE_CHALLENGE_MISMATCH/)
  assert.throws(() => extractVerifiedProbeFromDesktopResponses({ ...base, messages: { data: [base.messages.data[0], { ...base.messages.data[1], agent: undefined }] } }), /RUNTIME_PROBE_AGENT_IDENTITY_MISMATCH/)
  assert.throws(() => extractVerifiedProbeFromDesktopResponses({ ...base, messages: { data: [base.messages.data[0], { ...base.messages.data[1], model: { providerID: "openai", id: "gpt-6-sol-fast", variant: "xhigh" } }] } }), /RUNTIME_PROBE_IDENTITY_MISMATCH/)
  assert.throws(() => extractVerifiedProbeFromDesktopResponses({ ...base, messages: { data: [{ ...base.messages.data[0], content: toolParts.slice(1) }, base.messages.data[1]] } }), /RUNTIME_PROBE_TOOL_RESPONSE_INVALID:workflow_list/)
  const transformed = structuredClone(toolParts)
  transformed[0].state.input.code = `const result = await tools.workflow.workflow_list({"limit":1});\nreturn result;`
  assert.throws(() => extractVerifiedProbeFromDesktopResponses({ ...base, messages: { data: [{ ...base.messages.data[0], content: transformed }, base.messages.data[1]] } }), /RUNTIME_PROBE_CODE_MODE_INPUT_INVALID:workflow_list/)
  const directToolParts = toolParts.map((part, index) => ({ ...part, name: PLAN12_REQUIRED_RUNTIME_TOOLS[index], state: { ...part.state, input: part.state.metadata.toolCalls[0].input, metadata: undefined } }))
  assert.throws(() => extractVerifiedProbeFromDesktopResponses({ ...base, messages: { data: [{ ...base.messages.data[0], content: directToolParts }, base.messages.data[1]] } }), /RUNTIME_PROBE_TOOL_RESPONSE_INVALID:workflow_plan/)
})

test("Plan12 route role policy follows route and never supplies a feature fallback", () => {
  assert.equal(workerRoleForRoute("code_read"), "project-reader")
  assert.equal(workerRoleForRoute("code_read", true), "project-reader")
  assert.equal(workerRoleForRoute("code_change", true), "feature-executor")
})

console.log("PLAN12_SYNTHETIC_FIXTURE_REJECTED_PASS")
console.log("PLAN12_RUNTIME_FIXTURE_CONTRACT_PASS")
