import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import {
  appendEvidence,
  appendWorkflowConfigSnapshot,
  appendWorkflowLockEvent,
  appendWorkflowRun,
  appendWorkflowWave,
  appendWorkflowWaveNode,
  appendExecutionEvent,
  initializeControlPlaneDatabase,
} from "../lib/plan12-control-plane.ts"
import { sha256Canonical } from "../lib/plan12-contract.ts"
import { makeFacts } from "./plan12-control-plane-fixtures.mjs"

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "plan12-2-writer-"))
const dbPath = path.join(fixture, "runtime", "control-plane.db")
let store

function rehash(value) {
  const { payload_sha256: _ignored, ...withoutDigest } = value
  return { ...withoutDigest, payload_sha256: sha256Canonical(withoutDigest) }
}

function runConcurrentWriter(dbPath, facts) {
  const worker = "import { initializeControlPlaneDatabase } from './.opencode/lib/plan12-control-plane.ts'; const facts=JSON.parse(Buffer.from(process.env.PLAN12_FACTS,'base64').toString('utf8')); const store=initializeControlPlaneDatabase({dbPath:process.env.PLAN12_DB}); const snapshot=store.appendWorkflowConfigSnapshot(facts.snapshot); const run=store.appendWorkflowRun(facts.run); console.log(JSON.stringify({snapshot:snapshot.status,run:run.status})); store.close()"
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", worker], {
      cwd: path.resolve("."),
      env: { ...process.env, PLAN12_DB: dbPath, PLAN12_FACTS: Buffer.from(JSON.stringify(facts), "utf8").toString("base64") },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""; let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk.toString() })
    child.stderr.on("data", (chunk) => { stderr += chunk.toString() })
    child.on("error", reject)
    child.on("close", (code) => code === 0 ? resolve(JSON.parse(stdout.trim())) : reject(new Error(stderr || `worker exited ${code}`)))
  })
}

try {
  store = initializeControlPlaneDatabase({ dbPath })
  const facts = makeFacts("writer")
  const inserted = [
    appendWorkflowConfigSnapshot(store, facts.snapshot),
    appendWorkflowRun(store, facts.run),
    appendWorkflowWave(store, facts.wave),
    appendWorkflowWaveNode(store, facts.node),
    appendWorkflowLockEvent(store, facts.lock),
    appendExecutionEvent(store, facts.execution),
  ]
  for (const result of inserted) assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(inserted.map((result) => result.status), ["INSERTED", "INSERTED", "INSERTED", "INSERTED", "INSERTED", "INSERTED"])
  assert.equal(appendWorkflowConfigSnapshot(store, facts.snapshot).status, "IDEMPOTENT")

  const idempotent = appendEvidence(store, facts.execution)
  assert.equal(idempotent.ok, true)
  assert.equal(idempotent.status, "IDEMPOTENT")
  assert.equal(store.listExecutionEvents({ run_id: facts.run.run_id }).length, 1)

  const conflict = appendEvidence(store, rehash({ ...facts.execution, status: "FAILED" }))
  assert.equal(conflict.ok, false)
  assert.equal(conflict.code, "EVIDENCE_IDEMPOTENCY_CONFLICT")

  const missingEnvelope = { ...facts.run }
  delete missingEnvelope.config_revision
  const missing = appendWorkflowRun(store, missingEnvelope)
  assert.equal(missing.ok, false)
  assert.equal(missing.code, "ENVELOPE_FIELD_REQUIRED")

  const wrongSchema = rehash({ ...facts.run, idempotency_key: "writer-wrong-schema", schema_version: 99 })
  assert.equal(appendWorkflowRun(store, wrongSchema).code, "SCHEMA_VERSION_UNSUPPORTED")

  const missingRevision = rehash({ ...facts.run, idempotency_key: "writer-missing-revision", config_revision: "cr-unknown" })
  assert.equal(appendWorkflowRun(store, missingRevision).code, "CONFIG_REVISION_NOT_FOUND")

  const foreignWave = rehash({ ...facts.wave, idempotency_key: "writer-foreign-wave", run_id: "missing-run", wave_id: "foreign-wave" })
  assert.equal(appendWorkflowWave(store, foreignWave).code, "FOREIGN_KEY_CONSTRAINT")
  const mismatchedWorkflowEvent = rehash({ ...facts.execution, workflow_id: "other-workflow", event_id: "writer-workflow-mismatch", sequence: 2, idempotency_key: "writer-workflow-mismatch" })
  assert.equal(appendExecutionEvent(store, mismatchedWorkflowEvent).code, "WORKFLOW_ID_MISMATCH")

  assert.throws(() => store.db.prepare("UPDATE workflow_runs SET status='FAILED' WHERE run_id=?").run(facts.run.run_id), /APPEND_ONLY_UPDATE_FORBIDDEN/)
  assert.throws(() => store.db.prepare("DELETE FROM execution_events WHERE event_id=?").run(facts.execution.event_id), /APPEND_ONLY_DELETE_FORBIDDEN/)

  const before = store.db.prepare("SELECT COUNT(*) AS count FROM workflow_waves").get().count
  const newWave = rehash({ ...facts.wave, wave_id: "writer-wave-2", wave_index: 1, idempotency_key: "writer-wave-2" })
  const failedBatch = store.appendEvidenceBatch([newWave, foreignWave])
  assert.equal(failedBatch.at(-1).ok, false)
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM workflow_waves").get().count, before)

  assert.equal(store.getWorkflowRun(facts.run.run_id).workflow_id, facts.run.workflow_id)
  assert.equal(store.listWorkflowWaves({ run_id: facts.run.run_id }).length, 1)
  assert.equal(store.listWorkflowWaveNodes({ node_id: facts.node.node_id }).length, 1)
  assert.equal(store.listExecutionEvents({ workflow_id: facts.run.workflow_id, wave_id: facts.wave.wave_id, node_id: facts.node.node_id }).length, 1)
  assert.equal(store.getEvidenceByIdempotencyKey(facts.run.idempotency_key).row.run_id, facts.run.run_id)

  store.close()
  store = null

  const concurrentDbPath = path.join(fixture, "runtime", "concurrent-control-plane.db")
  const concurrentA = makeFacts("concurrent-a")
  const concurrentB = makeFacts("concurrent-b")
  const concurrentResults = await Promise.all([
    runConcurrentWriter(concurrentDbPath, { snapshot: concurrentA.snapshot, run: concurrentA.run }),
    runConcurrentWriter(concurrentDbPath, { snapshot: concurrentA.snapshot, run: concurrentA.run }),
    runConcurrentWriter(concurrentDbPath, { snapshot: concurrentA.snapshot, run: concurrentB.run }),
    runConcurrentWriter(concurrentDbPath, { snapshot: concurrentA.snapshot, run: concurrentB.run }),
  ])
  assert.equal(concurrentResults.filter((result) => result.run === "INSERTED").length, 2)
  assert.equal(concurrentResults.filter((result) => result.run === "IDEMPOTENT").length, 2)
  const concurrentStore = initializeControlPlaneDatabase({ dbPath: concurrentDbPath })
  assert.equal(concurrentStore.db.prepare("SELECT COUNT(*) AS count FROM workflow_runs").get().count, 2)
  concurrentStore.close()
  console.log("PLAN12_EVIDENCE_WRITER_PASS")
} finally {
  try { store?.close() } catch {}
  try { fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }) } catch {}
}
