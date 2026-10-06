import { sha256Canonical } from "../lib/plan12-contract.ts"

const observedAt = "2026-10-02T00:00:00.000Z"
const revision = "cr-20261002-0001"

export function withDigest(value) {
  const { payload_sha256: _ignored, ...withoutDigest } = value
  return { ...withoutDigest, payload_sha256: sha256Canonical(withoutDigest) }
}

function fact(fields, key) {
  return withDigest({
    schema_version: 1,
    config_revision: revision,
    source: "runtime/control-plane.db",
    observed_at: observedAt,
    evidence_level: "L3",
    ...fields,
    idempotency_key: key,
  })
}

export function makeFacts(prefix = "fixture") {
  const snapshot = fact({
    fact_type: "workflow_config_snapshot",
    parent_revision: null,
    source_kind: "verified_config",
    drawio_raw_sha256: "a".repeat(64),
    drawio_semantic_sha256: "b".repeat(64),
    ir_sha256: "c".repeat(64),
    config_digest: sha256Canonical({}),
    model_catalog_digest: "e".repeat(64),
    route_bindings_digest: "f".repeat(64),
    canonical_json: "{}",
    state: "DRAFT",
    created_by: "plan12-2-test",
    created_at: observedAt,
    activated_at: null,
    rollback_of: null,
  }, `${prefix}-snapshot`)
  const run = fact({
    fact_type: "workflow_run",
    run_id: `${prefix}-run-1`,
    workflow_id: `${prefix}-workflow-1`,
    parent_run_id: null,
    plan_digest: "1".repeat(64),
    attempt: 1,
    trigger: "manual",
    project_id: "fixture-project",
    status: "RUNNING",
    started_at: observedAt,
    ended_at: null,
    outcome_digest: null,
    evidence_write_status: "COMPLETE",
    error_code: null,
    error_detail: null,
    engine_version: "plan12-2-test",
  }, `${prefix}-run-1`)
  const wave = fact({
    fact_type: "workflow_wave",
    run_id: run.run_id,
    wave_id: `${prefix}-wave-1`,
    wave_index: 0,
    ready_set_digest: "2".repeat(64),
    policy_digest: "3".repeat(64),
    parallelism: 1,
    status: "RUNNING",
    started_at: observedAt,
    ended_at: null,
    lock_snapshot_json: "{}",
    evidence_digest: "4".repeat(64),
  }, `${prefix}-wave-1`)
  const node = fact({
    fact_type: "workflow_wave_node",
    run_id: run.run_id,
    wave_id: wave.wave_id,
    node_id: `${prefix}-node-1`,
    attempt: 1,
    task_id: `${prefix}-task-1`,
    route: "code_read",
    resource_digest: "5".repeat(64),
    lock_key_json: "[]",
    session_key: `${prefix}-session-key`,
    session_id: `${prefix}-session-1`,
    model_runtime_id: "fixture-provider/fixture-model#contract",
    status: "RUNNING",
    event_seq: 1,
    started_at: observedAt,
    ended_at: null,
    result_digest: null,
    error_code: null,
  }, `${prefix}-node-1`)
  const lock = fact({
    fact_type: "workflow_lock_event",
    event_id: `${prefix}-lock-event-1`,
    run_id: run.run_id,
    wave_id: wave.wave_id,
    node_id: node.node_id,
    lock_key: `${prefix}-resource-lock`,
    event_type: "ACQUIRE",
    owner_token: `${prefix}-owner-1`,
    sequence: 1,
    occurred_at: observedAt,
    outcome: "GRANTED",
    error_code: null,
  }, `${prefix}-lock-1`)
  const execution = fact({
    fact_type: "execution_event",
    event_id: `${prefix}-execution-event-1`,
    run_id: run.run_id,
    workflow_id: run.workflow_id,
    wave_id: wave.wave_id,
    node_id: node.node_id,
    task_id: node.task_id,
    attempt: 1,
    event_type: "NODE_STARTED",
    status: "RUNNING",
    sequence: 1,
    payload_digest: "6".repeat(64),
    payload_ref: `${prefix}-payload-1`,
    occurred_at: observedAt,
    error_code: null,
  }, `${prefix}-execution-1`)
  return { snapshot, run, wave, node, lock, execution }
}

export { observedAt, revision }
