import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

const { createCompletionCore } = await import("../lib/completion-core.ts")
const { evaluateRuntimeEvidence } = await import("../lib/plan12-completion-evidence.ts")
const { initializeControlPlaneDatabase, appendWorkflowRunEvent } = await import("../lib/plan12-control-plane.ts")
const { appendRuntimeEvidenceBatch } = await import("../lib/plan12-runtime-evidence-adapter.ts")
const { appendModelCatalogEntry, appendRouteBinding, recordRuntimeProbe } = await import("../lib/plan12-model-routes.ts")
const { sha256Canonical } = await import("../lib/plan12-contract.ts")
const { withDigest, makeSnapshot, observedAt } = await import("./plan12-3-fixtures.mjs")

function runtimeDb(plan, workflowStatus = "REVIEW_PASSED", root = process.cwd(), guardOptions = {}) {
  const db = new DatabaseSync(":memory:")
  db.exec(`
    CREATE TABLE workflows (
      workflow_id TEXT PRIMARY KEY,
      status TEXT,
      plan_json TEXT,
      updated_at TEXT,
      finished_at TEXT,
      completion_guard_finalized_at TEXT
    );
    CREATE TABLE workflow_nodes (
      workflow_id TEXT,
      node_id TEXT,
      status TEXT,
      current_task_id TEXT,
      review_task_id TEXT,
      last_verdict TEXT,
      task_history_json TEXT,
      review_history_json TEXT
    );
    CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY,
      parent_task_id TEXT,
      status TEXT,
      target_role TEXT,
      input_json TEXT,
      result_json TEXT
    );
  `)
  db.prepare("INSERT INTO workflows VALUES (?,?,?,?,?,?)").run("wf", workflowStatus, JSON.stringify(plan), "", null, null)
  db.prepare("INSERT INTO workflow_nodes VALUES (?,?,?,?,?,?,?,?)").run("wf", "gate", "REVIEW_PASSED", "task-gate", "review-task", "PASS", "[]", JSON.stringify([{ task_id: "review-task", verdict: "PASS" }]))
  db.prepare("INSERT INTO workflow_nodes VALUES (?,?,?,?,?,?,?,?)").run("wf", "docs", "COMPLETED", "task-docs", null, null, "[]", "[]")
  db.prepare("INSERT INTO workflow_nodes VALUES (?,?,?,?,?,?,?,?)").run("wf", "memory", "COMPLETED", "task-memory", null, null, "[]", "[]")
  db.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?)").run("task-gate", null, "COMPLETED", "test-runner", JSON.stringify({ route: "build_and_test" }), JSON.stringify({ output_text: "ok" }))
  db.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?)").run("review-task", "task-gate", "COMPLETED", "reviewer", JSON.stringify({ route: "independent_review" }), JSON.stringify({ output_text: JSON.stringify({ schema_version: 1, verdict: "PASS" }) }))
  db.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?)").run("task-docs", null, "COMPLETED", "documentation-agent", JSON.stringify({ route: "documentation_update" }), JSON.stringify({ output_text: "docs", artifacts: ["docs/acceptance.md"] }))
  db.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?)").run("task-memory", "task-docs", "COMPLETED", "memory-agent", JSON.stringify({ route: "long_term_memory_write" }), JSON.stringify({ output_text: "memory", artifacts: ["memory:acceptance"] }))
  const adapter = {
    query(sql) {
      const statement = db.prepare(sql)
      return { get: (...args) => statement.get(...args), all: (...args) => statement.all(...args), run: (...args) => statement.run(...args) }
    },
    transaction(fn) {
      return () => {
        db.exec("BEGIN IMMEDIATE")
        try { const result = fn(); db.exec("COMMIT"); return result } catch (error) { try { db.exec("ROLLBACK") } catch {}; throw error }
      }
    },
  }
  return { db, guard: createCompletionCore({ db: adapter, root }, guardOptions) }
}

const basePlan = {
  nodes: [
    { node_id: "gate", route: "code_change", depends_on: [], review: { required: true }, metadata: { required: true } },
    { node_id: "docs", route: "documentation_update", depends_on: ["gate"], metadata: { required: true } },
    { node_id: "memory", route: "long_term_memory_write", depends_on: ["docs"], metadata: { required: true } },
  ],
  metadata: {
    delivery: { reviewer_pass_required: true, required_evidence: ["docs/acceptance.md", "memory:acceptance"] },
    execution_policy: { mode: "legacy" },
    runtime_evidence_required: true,
  },
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plan12-6-guard-"))
const dbPath = path.join(tmp, "control-plane.db")
const revision = "plan12-6-guard-revision"
const workflowId = "wf-plan12-6"
const runId = "run-plan12-6"

try {
  const positiveFixture = path.join(tmp, "positive")
  fs.mkdirSync(positiveFixture, { recursive: true })
  const positiveDbPath = path.join(positiveFixture, "runtime", "control-plane.db")
  fs.mkdirSync(path.dirname(positiveDbPath), { recursive: true })
  const positiveStore = initializeControlPlaneDatabase({ dbPath: positiveDbPath })
  const modelRef = "openai/gpt-6-sol#xhigh"
  const snapshotPayload = {
    revision,
    model_catalog: [{ exact_model_ref: modelRef, provider_id: "openai", model_id: "gpt-6-sol", variant: "xhigh" }],
    route_bindings: [{ route_binding_id: "code_read", exact_model_ref: modelRef }],
  }
  const snapshot = withDigest({ ...makeSnapshot(revision, null, "positive-snapshot", snapshotPayload), state: "ACTIVE", activated_at: observedAt })
  assert.equal(positiveStore.appendWorkflowConfigSnapshot(snapshot).ok, true)
  const probe = withDigest({
    probe_id: "positive-probe", endpoint: "fixture://runtime", runtime_version: "fixture-2.0", workflow_plugin_loaded: true,
    tools: { workflow_plan: true, workflow_run: true, workflow_execute: true, workflow_get: true, workflow_list: true }, provider: "openai", provider_id: "openai", model_id: "gpt-6-sol", exact_model_ref: modelRef,
    probe_status: "AVAILABLE", availability_state: "AVAILABLE", probe_error: null, observed_at: observedAt, config_revision: revision,
    metadata: {}, idempotency_key: "positive-probe-key",
  })
  assert.equal(recordRuntimeProbe(positiveStore, probe).ok, true)
  const catalog = withDigest({
    catalog_entry_id: "positive-catalog", config_revision: revision, source: "runtime_probe", observed_at: observedAt,
    provider: "openai", provider_id: "openai", model_id: "gpt-6-sol", variant: "xhigh", exact_model_ref: modelRef,
    display_name: "fixture", capability: { input: true, output: true }, runtime_source: "runtime_probe", runtime_version: "fixture-2.0",
    first_seen_at: observedAt, last_seen_at: observedAt, probe_status: "AVAILABLE", availability_state: "AVAILABLE",
    metadata_sha256: "d".repeat(64), probe_error: null, probe_id: "positive-probe", idempotency_key: "positive-catalog-key",
  })
  assert.equal(appendModelCatalogEntry(positiveStore, catalog).ok, true)
  const binding = withDigest({
    route_binding_id: "code_read", role: "Feature Executor", workflow_scope: "global", project_scope: "fixture", lane: "default",
    provider: "openai", provider_id: "openai", model_id: "gpt-6-sol", variant: "xhigh", exact_model_ref: modelRef,
    binding_state: "BOUND", config_revision: revision, source: "fixture", reason: "verified fixture route",
    created_at: observedAt, updated_at: observedAt, idempotency_key: "positive-route-key",
  })
  assert.equal(appendRouteBinding(positiveStore, binding).ok, true)
  const positivePlan = {
    nodes: [{ node_id: "node-a", route: "code_read", depends_on: [], metadata: { required: true } }],
    metadata: { runtime_evidence_required: true, execution_policy: { mode: "isolated_fixture", config_revision: revision, control_plane_db: positiveDbPath } },
  }
  const payload = { ok: true, output: "fixture" }
  const node = {
    source: "plan12-6-fixture", observed_at: observedAt, config_revision: revision, run_id: runId, wave_id: "wave-0", node_id: "node-a",
    attempt: 1, task_id: "task-a", route: "code_read", resource_digest: "5".repeat(64), lock_key_json: "[]",
    session_key: "workflow:positive:node-a", session_id: "session-a", status: "COMPLETED", event_seq: 1,
    started_at: observedAt, ended_at: "2026-10-02T00:00:01.000Z", result_digest: sha256Canonical(payload), error_code: null,
  }
  const wave = {
    source: "plan12-6-fixture", observed_at: observedAt, config_revision: revision, run_id: runId, wave_id: "wave-0", wave_index: 0,
    ready_set_digest: sha256Canonical(["node-a"]), policy_digest: sha256Canonical({}), parallelism: 1, status: "COMPLETED",
    started_at: observedAt, ended_at: "2026-10-02T00:00:01.000Z", lock_snapshot_json: "[]", evidence_digest: sha256Canonical({ wave: "wave-0" }), nodes: [node],
  }
  const run = {
    source: "plan12-6-fixture", observed_at: observedAt, config_revision: revision, workflow_id: workflowId, run_id: runId, parent_run_id: null,
    plan_digest: sha256Canonical(positivePlan), attempt: 1, trigger: "manual", project_id: "fixture", status: "COMPLETED",
    started_at: observedAt, ended_at: "2026-10-02T00:00:01.000Z", outcome_digest: sha256Canonical(payload), evidence_write_status: "COMPLETE",
    error_code: null, error_detail: null, engine_version: "fixture-2.0",
  }
  const execution = { ...node, event_id: "execution-a", workflow_id: workflowId, event_type: "NODE_FINISHED", sequence: 1, payload, payload_ref: "inline:execution-a", occurred_at: node.ended_at }
  const batch = appendRuntimeEvidenceBatch(positiveStore, { run, waves: [wave], nodes: [node], lock_events: [], execution_events: [execution], config_snapshot: null })
  assert.equal(batch.ok, true, JSON.stringify(batch))
  const appendLifecycle = (eventType, sequence, refs = {}, status = "COMPLETED", eventPayload = {}) => {
    const body = {
      event_id: `lifecycle-${sequence}`, run_id: runId, workflow_id: workflowId, wave_id: refs.wave_id ?? null, node_id: refs.node_id ?? null,
      task_id: refs.task_id ?? null, attempt: refs.attempt ?? null, event_type: eventType, status, sequence, schema_version: 1,
      config_revision: revision, source: "plan12-6-fixture", observed_at: observedAt, evidence_level: "L3", fact_type: "workflow_run_event",
      payload_digest: sha256Canonical(eventPayload), payload_ref: `inline:lifecycle-${sequence}`, occurred_at: sequence === 1 ? observedAt : "2026-10-02T00:00:01.000Z", error_code: null,
      idempotency_key: `lifecycle-${sequence}`,
    }
    return appendWorkflowRunEvent(positiveStore, withDigest(body))
  }
  assert.equal(appendLifecycle("RUN_STARTED", 1, {}, "RUNNING", { workflow_id: workflowId }).ok, true)
  assert.equal(appendLifecycle("WAVE_STARTED", 2, { wave_id: "wave-0" }, "RUNNING", { wave_id: "wave-0" }).ok, true)
  assert.equal(appendLifecycle("NODE_STARTED", 3, { wave_id: "wave-0", node_id: "node-a", task_id: "task-a", attempt: 1 }, "RUNNING", { node_id: "node-a" }).ok, true)
  assert.equal(appendLifecycle("NODE_FINISHED", 4, { wave_id: "wave-0", node_id: "node-a", task_id: "task-a", attempt: 1 }, "COMPLETED", payload).ok, true)
  assert.equal(appendLifecycle("WAVE_FINISHED", 5, { wave_id: "wave-0" }, "COMPLETED", { wave_id: "wave-0" }).ok, true)
  assert.equal(appendLifecycle("RUN_FINISHED", 6, {}, "COMPLETED", { run_id: runId }).ok, true)
  positiveStore.close()
  const positive = evaluateRuntimeEvidence({ dbPath: positiveDbPath, root: positiveFixture, workflowId, runId, configRevision: revision, plan: positivePlan })
  assert.equal(positive.ok, true, JSON.stringify(positive))
  assert.equal(positive.status, "COMPLETE")
  assert.equal(positive.evidence_level, "L3")
  const restrictedPlan = {
    ...positivePlan,
    metadata: { ...positivePlan.metadata, execution_policy: { ...positivePlan.metadata.execution_policy, allowed_roots: ["declared-only"] } },
  }
  const restricted = evaluateRuntimeEvidence({ dbPath: positiveDbPath, root: positiveFixture, workflowId, runId, configRevision: revision, plan: restrictedPlan })
  assert.equal(restricted.code, "EVIDENCE_STORE_SCOPE_FORBIDDEN", "policy allowed_roots must constrain the Control Plane DB")
  let capturedAllowedRoots
  const capturePlan = {
    ...basePlan,
    metadata: { ...basePlan.metadata, execution_policy: { mode: "isolated_fixture", allowed_roots: ["captured-only"] } },
  }
  const capture = runtimeDb(capturePlan, "REVIEW_PASSED", tmp, {
    evidenceResolver: (args) => { capturedAllowedRoots = args.allowed_roots; return { ...positive, workflow_id: args.workflowId } },
  })
  assert.equal(capture.guard.finalReportPermission({ workflow_id: "wf" }).status, "FINAL_REPORT_PREAUTHORIZED")
  assert.deepEqual(capturedAllowedRoots, ["captured-only"], "Completion Core must pass policy allowed_roots to the evidence resolver")
  capture.db.close()
  const integration = runtimeDb(basePlan, "REVIEW_PASSED", tmp, {
    evidenceResolver: ({ workflowId: resolvedWorkflowId }) => ({ ...positive, workflow_id: resolvedWorkflowId }),
  })
  const allowed = integration.guard.finalReportPermission({ workflow_id: "wf" })
  assert.equal(allowed.ok, true, JSON.stringify(allowed))
  assert.equal(allowed.status, "FINAL_REPORT_PREAUTHORIZED")
  assert.equal(allowed.permission, true)
  assert.equal(allowed.evidence_level, "L3")
  assert.equal(allowed.verification, "PASS")
  assert.notEqual(allowed.status, "FINAL_REPORT_ALLOWED")
  assert.notEqual(allowed.evidence_level, "L4")
  assert.equal(Object.hasOwn(allowed, "final_report_permission"), false)
  const finalized = integration.guard.finalize({ workflow_id: "wf", run_id: runId, control_plane_db: positiveDbPath })
  assert.equal(finalized.ok, true, JSON.stringify(finalized))
  assert.equal(finalized.status, "COMPLETED")
  assert.equal(finalized.final_report_permission, true)
  assert.equal(finalized.evidence_level, "L4")
  assert.equal(finalized.verification, "PASS")
  assert.equal(integration.db.prepare("SELECT status, finished_at, completion_guard_finalized_at FROM workflows WHERE workflow_id='wf'").get().status, "COMPLETED")
  integration.db.close()

  const copyPositive = (name) => {
    const targetDir = path.join(tmp, name)
    fs.mkdirSync(targetDir, { recursive: true })
    const target = path.join(targetDir, "control-plane.db")
    fs.copyFileSync(positiveDbPath, target)
    return target
  }
  const mutate = (target, sql) => {
    const db = new DatabaseSync(target)
    for (const trigger of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all()) db.exec(`DROP TRIGGER IF EXISTS "${trigger.name.replaceAll('"', '""')}"`)
    if (typeof sql === "function") sql(db)
    else db.exec(sql)
    db.close()
  }
  const evaluateCopy = (target) => evaluateRuntimeEvidence({ dbPath: target, root: path.dirname(path.dirname(target)), workflowId, runId, configRevision: revision, plan: positivePlan })

  const missingFinishDb = copyPositive("missing-finish")
  mutate(missingFinishDb, "DELETE FROM workflow_run_events WHERE event_type='RUN_FINISHED'")
  assert.equal(evaluateCopy(missingFinishDb).code, "RUN_FINISHED_MISSING")

  const sequenceGapDb = copyPositive("sequence-gap")
  mutate(sequenceGapDb, "UPDATE workflow_run_events SET sequence=7 WHERE event_type='RUN_FINISHED'")
  assert.equal(evaluateCopy(sequenceGapDb).code, "L3_EVENT_SEQUENCE_GAP")

  const malformedEnvelopeDb = copyPositive("malformed-envelope")
  mutate(malformedEnvelopeDb, (db) => {
    const original = db.prepare("SELECT * FROM workflow_runs WHERE run_id=?").get(runId)
    const changed = { ...original, source: "" }
    delete changed.payload_sha256
    changed.payload_sha256 = sha256Canonical(changed)
    db.prepare("UPDATE workflow_runs SET source=?, payload_sha256=? WHERE run_id=?").run(changed.source, changed.payload_sha256, runId)
  })
  assert.ok(evaluateCopy(malformedEnvelopeDb).missing.some((entry) => entry.code === "L3_FACT_ENVELOPE_INVALID"), "malformed fact envelope must be rejected")

  const nonUtcTimeDb = copyPositive("non-utc-time")
  mutate(nonUtcTimeDb, (db) => {
    const original = db.prepare("SELECT * FROM workflow_runs WHERE run_id=?").get(runId)
    const changed = { ...original, started_at: "2026-10-02 00:00:00" }
    delete changed.payload_sha256
    changed.payload_sha256 = sha256Canonical(changed)
    db.prepare("UPDATE workflow_runs SET started_at=?, payload_sha256=? WHERE run_id=?").run(changed.started_at, changed.payload_sha256, runId)
  })
  assert.ok(evaluateCopy(nonUtcTimeDb).missing.some((entry) => entry.code === "L3_TIME_INVALID"), "non-UTC fact time must be rejected even with a recomputed row digest")

  const digestDb = copyPositive("digest-mismatch")
  mutate(digestDb, `UPDATE execution_events SET payload_digest='${"f".repeat(64)}'`)
  assert.equal(evaluateCopy(digestDb).code, "L3_DIGEST_MISMATCH")

  const modelDb = copyPositive("model-unassigned")
  mutate(modelDb, "UPDATE route_bindings SET binding_state='MODEL_UNASSIGNED'")
  assert.ok(evaluateCopy(modelDb).missing.some((entry) => entry.code === "MODEL_UNASSIGNED"), "MODEL_UNASSIGNED must remain fail-closed even when the row is tampered")

  const modelTamperDb = copyPositive("model-envelope-tamper")
  mutate(modelTamperDb, "UPDATE model_catalog SET display_name='tampered-model'")
  assert.ok(evaluateCopy(modelTamperDb).missing.some((entry) => entry.code === "MODEL_EVIDENCE_DIGEST_MISMATCH"), "tampered model catalog must fail its envelope digest")

  const routeEnvelopeTamperDb = copyPositive("route-envelope-tamper")
  mutate(routeEnvelopeTamperDb, "UPDATE route_bindings SET reason='tampered-route'")
  assert.ok(evaluateCopy(routeEnvelopeTamperDb).missing.some((entry) => entry.code === "MODEL_EVIDENCE_DIGEST_MISMATCH"), "tampered route binding must fail its envelope digest")

  const probeEnvelopeTamperDb = copyPositive("probe-envelope-tamper")
  mutate(probeEnvelopeTamperDb, "UPDATE runtime_model_probes SET runtime_version='tampered-runtime'")
  assert.ok(evaluateCopy(probeEnvelopeTamperDb).missing.some((entry) => entry.code === "MODEL_EVIDENCE_DIGEST_MISMATCH"), "tampered runtime probe must fail its envelope digest")

  const invalidLockKeyDb = copyPositive("invalid-lock-key-json")
  mutate(invalidLockKeyDb, (db) => {
    db.prepare("UPDATE workflow_wave_nodes SET lock_key_json='not-json' WHERE node_id='node-a'").run()
  })
  assert.ok(evaluateCopy(invalidLockKeyDb).missing.some((entry) => entry.code === "LOCK_KEY_JSON_INVALID"), "invalid lock_key_json must be rejected")

  const orphanLockDb = copyPositive("orphan-lock-event")
  mutate(orphanLockDb, (db) => {
    const lock = {
      event_id: "orphan-lock-event", schema_version: 1, config_revision: revision, source: "plan12-6-fixture",
      observed_at: observedAt, idempotency_key: "orphan-lock-key", evidence_level: "L3", fact_type: "workflow_lock_event",
      run_id: runId, wave_id: "wave-0", node_id: "unknown-node", lock_key: "resource:unknown", event_type: "ACQUIRE",
      owner_token: "orphan-owner", sequence: 1, occurred_at: observedAt, outcome: "ACQUIRED", error_code: null,
    }
    const row = { ...lock, payload_sha256: sha256Canonical(lock) }
    db.prepare(`INSERT INTO workflow_lock_events
      (event_id,schema_version,config_revision,source,observed_at,payload_sha256,idempotency_key,evidence_level,fact_type,run_id,wave_id,node_id,lock_key,event_type,owner_token,sequence,occurred_at,outcome,error_code)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      row.event_id, row.schema_version, row.config_revision, row.source, row.observed_at, row.payload_sha256, row.idempotency_key,
      row.evidence_level, row.fact_type, row.run_id, row.wave_id, row.node_id, row.lock_key, row.event_type, row.owner_token,
      row.sequence, row.occurred_at, row.outcome, row.error_code)
  })
  assert.ok(evaluateCopy(orphanLockDb).missing.some((entry) => entry.code === "LOCK_EVENT_ORPHANED"), "orphan lock event must be rejected")

  const attemptGapDb = copyPositive("attempt-gap")
  mutate(attemptGapDb, (db) => {
    db.prepare("UPDATE workflow_wave_nodes SET attempt=2, task_id='task-a-retry' WHERE node_id='node-a'").run()
  })
  assert.ok(evaluateCopy(attemptGapDb).missing.some((entry) => entry.code === "NODE_ATTEMPT_SEQUENCE_INVALID"), "attempt sequence must begin at one")

  const ambiguousDb = copyPositive("ambiguous")
  mutate(ambiguousDb, `INSERT INTO workflow_runs SELECT 'run-plan12-6-retry',schema_version,config_revision,source,observed_at,'${"e".repeat(64)}','ambiguous-key',evidence_level,fact_type,workflow_id,'${runId}',plan_digest,2,trigger,project_id,status,started_at,ended_at,outcome_digest,evidence_write_status,error_code,error_detail,engine_version FROM workflow_runs WHERE run_id='${runId}'`)
  assert.equal(evaluateRuntimeEvidence({ dbPath: ambiguousDb, root: path.dirname(path.dirname(ambiguousDb)), workflowId, configRevision: revision, plan: positivePlan }).code, "EVIDENCE_RUN_AMBIGUOUS")

  const result = await evaluateRuntimeEvidence({
    dbPath,
    workflowId,
    plan: basePlan,
    configRevision: revision,
    runId,
    root: tmp,
    store: {
      run: { workflow_id: workflowId, run_id: runId, config_revision: revision, status: "COMPLETED", evidence_write_status: "COMPLETE" },
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, "EVIDENCE_STORE_UNAVAILABLE")

  const { db, guard } = runtimeDb(basePlan)
  const blocked = guard.finalReportPermission({ workflow_id: "wf" })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.code, "COMPLETION_GUARD_BLOCKED")
  assert.equal(blocked.permission, false)
  assert.equal(blocked.evidence.verification, "BLOCKED")
  db.close()

  const legacyPlan = { ...basePlan, metadata: { ...basePlan.metadata, runtime_evidence_required: false, execution_policy: { mode: "legacy" } } }
  const legacy = runtimeDb(legacyPlan)
  const legacyAllowed = legacy.guard.finalReportPermission({ workflow_id: "wf" })
  assert.equal(legacyAllowed.ok, true)
  assert.equal(legacyAllowed.status, "FINAL_REPORT_ALLOWED")
  legacy.db.close()

  const isolated = runtimeDb({ ...basePlan, metadata: { ...basePlan.metadata, execution_policy: { mode: "isolated_fixture", config_revision: revision, control_plane_db: dbPath } } }, "REVIEW_PASSED", tmp)
  const missing = isolated.guard.finalReportPermission({ workflow_id: "wf" })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, "COMPLETION_GUARD_BLOCKED")
  assert.equal(missing.evidence.code, "EVIDENCE_STORE_UNAVAILABLE")
  assert.equal(isolated.db.prepare("SELECT status FROM workflows WHERE workflow_id='wf'").get().status, "REVIEW_PASSED")
  const blockedFinalize = isolated.guard.finalize({ workflow_id: "wf", run_id: runId, control_plane_db: dbPath })
  assert.equal(blockedFinalize.ok, false)
  assert.equal(blockedFinalize.code, "COMPLETION_GUARD_BLOCKED")
  const blockedRow = isolated.db.prepare("SELECT status, finished_at, completion_guard_finalized_at FROM workflows WHERE workflow_id='wf'").get()
  assert.equal(blockedRow.status, "REVIEW_PASSED")
  assert.equal(blockedRow.finished_at, null)
  assert.equal(blockedRow.completion_guard_finalized_at, null)
  isolated.db.close()
  console.log("PLAN12_COMPLETION_GUARD_EVIDENCE_PASS")
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }) } catch {}
}
