import { canonicalizePlan12Json, sha256Canonical } from "../lib/plan12-contract.ts"
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { spawn } from "node:child_process"

export const observedAt = "2026-10-02T00:00:00.000Z"

export function withDigest(value) {
  const { payload_sha256: _ignored, ...withoutDigest } = value
  return { ...withoutDigest, payload_sha256: sha256Canonical(withoutDigest) }
}

export function makeSnapshot(config_revision, parent_revision = null, key = `${config_revision}-snapshot`, payload = { revision: config_revision, model_catalog: [], route_bindings: [] }) {
  return withDigest({
    schema_version: 1,
    config_revision,
    source: "runtime/control-plane.db",
    observed_at: observedAt,
    evidence_level: "L3",
    fact_type: "workflow_config_snapshot",
    parent_revision,
    source_kind: "verified_config",
    drawio_raw_sha256: "a".repeat(64),
    drawio_semantic_sha256: "b".repeat(64),
    ir_sha256: "c".repeat(64),
    config_digest: sha256Canonical(payload),
    model_catalog_digest: sha256Canonical(payload.model_catalog ?? []),
    route_bindings_digest: sha256Canonical(payload.route_bindings ?? []),
    canonical_json: JSON.stringify(canonicalizePlan12Json(payload)),
    state: "DRAFT",
    created_by: "plan12-3-test",
    created_at: observedAt,
    activated_at: null,
    rollback_of: null,
    idempotency_key: key,
  })
}

export function operationFields(prefix) {
  return { actor: "plan12-3-test", reason: `${prefix} test`, correlation_id: `${prefix}-correlation` }
}

export function makeRun(config_revision, workflow_id, key) {
  return withDigest({
    schema_version: 1,
    config_revision,
    source: "runtime/control-plane.db",
    observed_at: observedAt,
    evidence_level: "L3",
    fact_type: "workflow_run",
    run_id: `${key}-run`,
    workflow_id,
    parent_run_id: null,
    plan_digest: "1".repeat(64),
    attempt: 1,
    trigger: "manual",
    project_id: "plan12-3-fixture",
    status: "RUNNING",
    started_at: observedAt,
    ended_at: null,
    outcome_digest: null,
    evidence_write_status: "COMPLETE",
    error_code: null,
    error_detail: null,
    engine_version: "plan12-3-test",
    idempotency_key: key,
  })
}

export function transition(store, transitionConfigRevision, revision, to_state, prefix) {
  return transitionConfigRevision(store, { config_revision: revision, to_state, idempotency_key: `${prefix}-${to_state}`, ...operationFields(prefix) })
}

export function tasksDbHashes() {
  return Object.fromEntries(["tasks.db", "tasks.db-wal", "tasks.db-shm"].map((name) => {
    const file = path.resolve("runtime", name)
    return [name, fs.existsSync(file) ? crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") : null]
  }))
}

export function activeCount(store) {
  return store.db.prepare("SELECT COUNT(*) AS n FROM workflow_config_snapshots s WHERE COALESCE((SELECT j.to_state FROM config_revision_journal j WHERE j.config_revision=s.config_revision AND j.result='APPLIED' ORDER BY j.journal_seq DESC LIMIT 1),s.state)='ACTIVE'").get().n
}

// Both processes open the fixture and signal READY before either receives GO.
export async function concurrentOperations(dbPath, name, requests) {
  const code = `import {initializeControlPlaneDatabase} from './.opencode/lib/plan12-control-plane.ts'; import * as lifecycle from './.opencode/lib/plan12-config-revision.ts'; const s=initializeControlPlaneDatabase({dbPath:process.argv[1]}); process.stdout.write('READY\\n'); process.stdin.once('data',()=>{try {console.log(JSON.stringify(lifecycle[process.argv[2]](s,JSON.parse(process.argv[3]))));s.close();process.exit(0)}catch(e){console.error(e);process.exit(1)}});`
  const workers = requests.map((request) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code, dbPath, name, JSON.stringify(request)], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] })
    let output = ""; let error = ""; let readyResolve; let doneResolve; let doneReject
    const ready = new Promise((resolve) => { readyResolve = resolve })
    const done = new Promise((resolve, reject) => { doneResolve = resolve; doneReject = reject })
    child.stdout.on("data", (chunk) => { output += chunk; if (output.includes("READY\n")) readyResolve() })
    child.stderr.on("data", (chunk) => { error += chunk })
    child.on("error", doneReject)
    child.on("close", (code) => {
      readyResolve()
      if (code !== 0) doneReject(new Error(error || `worker exited ${code}`))
      else { try { doneResolve(JSON.parse(output.trim().split("\n").at(-1))) } catch (error) { doneReject(error) } }
    })
    return { child, ready, done }
  })
  await Promise.all(workers.map((worker) => worker.ready))
  for (const worker of workers) worker.child.stdin.end("GO\n")
  return Promise.all(workers.map((worker) => worker.done))
}
