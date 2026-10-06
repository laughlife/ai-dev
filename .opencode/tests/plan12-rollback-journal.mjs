import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { initializeControlPlaneDatabase } from "../lib/plan12-control-plane.ts"
import { applyConfigRevision, createConfigRevision, getActiveConfigRevision, getConfigRevision, listConfigRevisionJournal, rollbackConfigRevision, transitionConfigRevision } from "../lib/plan12-config-revision.ts"
import { makeSnapshot, operationFields, transition, concurrentOperations, activeCount, tasksDbHashes } from "./plan12-3-fixtures.mjs"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan12-3-rollback-"))
const dbPath = path.join(dir, "control-plane.db")
const store = initializeControlPlaneDatabase({ dbPath, runtimeRoot: dir, allowedRoots: [dir] })
const hashes = tasksDbHashes()
const request = (expected, target, key) => ({ expected_active_revision: expected, target_revision: target, idempotency_key: key, ...operationFields(key) })
try {
  const first = makeSnapshot("cr-20261002-1201")
  const second = makeSnapshot("cr-20261002-1202", first.config_revision)
  const rejected = makeSnapshot("cr-20261002-1203", first.config_revision)
  for (const snapshot of [first, second, rejected]) assert.equal(createConfigRevision(store, snapshot).ok, true)
  for (const state of ["VALIDATED", "STAGED", "APPLIED"]) assert.equal(transition(store, transitionConfigRevision, first.config_revision, state, "first").ok, true)
  assert.equal(applyConfigRevision(store, request(null, first.config_revision, "apply-first")).ok, true)
  for (const state of ["VALIDATED", "STAGED", "APPLIED"]) assert.equal(transition(store, transitionConfigRevision, second.config_revision, state, "second").ok, true)
  assert.equal(applyConfigRevision(store, request(first.config_revision, second.config_revision, "apply-second")).ok, true)
  for (const state of ["VALIDATED", "REJECTED"]) assert.equal(transition(store, transitionConfigRevision, rejected.config_revision, state, "rejected").ok, true)
  const before = getActiveConfigRevision(store).config_revision
  assert.equal(rollbackConfigRevision(store, request("wrong", first.config_revision, "rollback-cas")).code, "CAS_CONFLICT")
  assert.equal(listConfigRevisionJournal(store, { idempotency_key: "rollback-cas" }).at(-1).result, "REJECTED")
  assert.equal(getActiveConfigRevision(store).config_revision, before)
  assert.equal(rollbackConfigRevision(store, request(second.config_revision, "missing", "rollback-missing")).code, "CONFIG_REVISION_NOT_FOUND")
  assert.equal(listConfigRevisionJournal(store, { idempotency_key: "rollback-missing" }).at(-1).result, "REJECTED")
  assert.equal(rollbackConfigRevision(store, request(second.config_revision, rejected.config_revision, "rollback-rejected")).code, "ROLLBACK_TARGET_REJECTED")
  assert.equal(listConfigRevisionJournal(store, { idempotency_key: "rollback-rejected" }).at(-1).result, "REJECTED")
  const success = rollbackConfigRevision(store, request(second.config_revision, first.config_revision, "rollback-success"))
  assert.equal(success.ok, true)
  assert.equal(getActiveConfigRevision(store).config_revision, first.config_revision)
  assert.equal(activeCount(store), 1)
  assert.equal(rollbackConfigRevision(store, request(second.config_revision, first.config_revision, "rollback-success")).status, "IDEMPOTENT")
  assert.equal(rollbackConfigRevision(store, request(first.config_revision, first.config_revision, "rollback-self")).code, "ROLLBACK_TARGET_INVALID")
  const journal = listConfigRevisionJournal(store)
  assert.ok(journal.some((entry) => entry.operation === "ROLLBACK" && entry.to_state === "ROLLED_BACK"))
  assert.ok(journal.some((entry) => entry.operation === "ROLLBACK" && entry.to_state === "ACTIVE"))
  const journalSeq = journal[0].journal_seq
  assert.throws(() => store.db.prepare("UPDATE config_revision_journal SET reason='mutated' WHERE journal_seq=?").run(journalSeq), /APPEND_ONLY_UPDATE_FORBIDDEN/)
  assert.throws(() => store.db.prepare("DELETE FROM config_revision_journal WHERE journal_seq=?").run(journalSeq), /APPEND_ONLY_DELETE_FORBIDDEN/)
  const rollbackTarget = makeSnapshot("cr-20261002-model-unassigned", first.config_revision, "model-unassigned-snapshot", { revision: "model-unassigned", model_catalog: [], route_bindings: [{ route_id: "xxl-route", project_id: "xxl-job", role: "Worker", model_ref: null, provider_id: null, model_id: null, variant: null, runtime_id: null, status: "MODEL_UNASSIGNED", config_revision: "cr-20261002-model-unassigned", evidence_ref: null }] })
  assert.equal(createConfigRevision(store, rollbackTarget).ok, true)
  for (const state of ["VALIDATED", "STAGED", "APPLIED"]) assert.equal(transition(store, transitionConfigRevision, rollbackTarget.config_revision, state, "model-unassigned").ok, true)
  const modelResult = rollbackConfigRevision(store, request(first.config_revision, rollbackTarget.config_revision, "rollback-model-unassigned"))
  assert.equal(modelResult.ok, false)
  assert.equal(modelResult.code, "MODEL_UNASSIGNED")
  assert.equal(listConfigRevisionJournal(store, { idempotency_key: "rollback-model-unassigned" }).at(-1).result, "REJECTED")
  assert.equal(getActiveConfigRevision(store).config_revision, first.config_revision)
  assert.equal(activeCount(store), 1)
  store.close()
  const concurrentTarget = initializeControlPlaneDatabase({ dbPath, runtimeRoot: dir, allowedRoots: [dir] })
  try {
    const third = makeSnapshot("cr-20261002-1204", first.config_revision)
    assert.equal(createConfigRevision(concurrentTarget, third).ok, true)
    for (const state of ["VALIDATED", "STAGED", "APPLIED"]) assert.equal(transition(concurrentTarget, transitionConfigRevision, third.config_revision, state, "third").ok, true)
    assert.equal(applyConfigRevision(concurrentTarget, request(first.config_revision, third.config_revision, "apply-third")).ok, true)
  } finally { concurrentTarget.close() }
  const results = await concurrentOperations(dbPath, "rollbackConfigRevision", [request("cr-20261002-1204", first.config_revision, "concurrent-rollback-a"), request("cr-20261002-1204", first.config_revision, "concurrent-rollback-b")])
  assert.equal(results.filter((result) => result.ok && result.status === "APPLIED").length, 1)
  assert.equal(results.filter((result) => !result.ok && result.code === "CAS_CONFLICT").length, 1)
  const reopened = initializeControlPlaneDatabase({ dbPath, runtimeRoot: dir, allowedRoots: [dir] })
  try { assert.equal(activeCount(reopened), 1); assert.equal(getActiveConfigRevision(reopened).config_revision, first.config_revision) } finally { reopened.close() }
  assert.deepEqual(tasksDbHashes(), hashes)
  console.log("PLAN12_ROLLBACK_JOURNAL_PASS")
} finally { try { store.close() } catch {}; fs.rmSync(dir, { recursive: true, force: true }) }
