import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { initializeControlPlaneDatabase } from "../lib/plan12-control-plane.ts"
import { applyConfigRevision, createConfigRevision, getActiveConfigRevision, getConfigRevision, listConfigRevisionJournal, transitionConfigRevision } from "../lib/plan12-config-revision.ts"
import { makeSnapshot, operationFields, transition, concurrentOperations, activeCount, tasksDbHashes } from "./plan12-3-fixtures.mjs"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan12-3-apply-"))
const dbPath = path.join(dir, "control-plane.db")
const store = initializeControlPlaneDatabase({ dbPath })
const hashes = tasksDbHashes()
const request = (expected, target, key) => ({ expected_active_revision: expected, target_revision: target, idempotency_key: key, ...operationFields(key) })
try {
  const first = makeSnapshot("cr-20261002-1101")
  const second = makeSnapshot("cr-20261002-1102", first.config_revision)
  assert.equal(createConfigRevision(store, first).ok, true)
  assert.equal(transition(store, transitionConfigRevision, first.config_revision, "VALIDATED", "first").ok, true)
  assert.equal(applyConfigRevision(store, request(null, first.config_revision, "apply-validated")).ok, true)
  assert.deepEqual(listConfigRevisionJournal(store, { idempotency_key: "apply-validated" }).filter((entry) => entry.result === "APPLIED").map((entry) => [entry.from_state, entry.to_state]), [["VALIDATED", "STAGED"], ["STAGED", "APPLIED"], ["APPLIED", "ACTIVE"]])
  assert.equal(createConfigRevision(store, second).ok, true)
  for (const state of ["VALIDATED", "STAGED"]) assert.equal(transition(store, transitionConfigRevision, second.config_revision, state, "second").ok, true)
  assert.equal(applyConfigRevision(store, request(first.config_revision, "missing", "missing-target")).code, "CONFIG_REVISION_NOT_FOUND")
  assert.equal(listConfigRevisionJournal(store, { idempotency_key: "missing-target" }).at(-1).result, "REJECTED")
  assert.equal(applyConfigRevision(store, request(first.config_revision, first.config_revision, "same-target")).code, "CONFIG_TARGET_ALREADY_ACTIVE")
  assert.equal(listConfigRevisionJournal(store, { idempotency_key: "same-target" }).at(-1).result, "REJECTED")
  assert.equal(applyConfigRevision(store, request("wrong", second.config_revision, "cas-conflict")).code, "CAS_CONFLICT")
  assert.equal(listConfigRevisionJournal(store, { idempotency_key: "cas-conflict" }).at(-1).result, "REJECTED")
  assert.equal(getActiveConfigRevision(store).config_revision, first.config_revision)
  assert.equal(applyConfigRevision(store, request(first.config_revision, second.config_revision, "apply-staged")).ok, true)
  const stagedJournal = listConfigRevisionJournal(store, { idempotency_key: "apply-staged" }).filter((entry) => entry.result === "APPLIED")
  assert.ok(stagedJournal.some((entry) => entry.config_revision === first.config_revision && entry.from_state === "ACTIVE" && entry.to_state === "SUPERSEDED"))
  assert.deepEqual(stagedJournal.filter((entry) => entry.config_revision === second.config_revision).map((entry) => [entry.from_state, entry.to_state]), [["STAGED", "APPLIED"], ["APPLIED", "ACTIVE"]])
  assert.equal(applyConfigRevision(store, request(first.config_revision, second.config_revision, "apply-staged")).status, "IDEMPOTENT")
  assert.equal(applyConfigRevision(store, { ...request(first.config_revision, second.config_revision, "apply-staged"), actor: "other" }).code, "EVIDENCE_IDEMPOTENCY_CONFLICT")
  for (const entry of stagedJournal) {
    assert.equal(entry.actor, "plan12-3-test")
    assert.equal(entry.correlation_id, "apply-staged-correlation")
    assert.match(entry.payload_sha256, /^[a-f0-9]{64}$/)
    assert.match(entry.created_at, /Z$/)
  }
  const draft = makeSnapshot("apply-draft", second.config_revision)
  assert.equal(createConfigRevision(store, draft).ok, true)
  assert.equal(applyConfigRevision(store, request(second.config_revision, draft.config_revision, "reject-draft")).ok, false)
  const third = makeSnapshot("cr-20261002-1103", second.config_revision)
  assert.equal(createConfigRevision(store, third).ok, true)
  assert.equal(transition(store, transitionConfigRevision, third.config_revision, "VALIDATED", "third").ok, true)
  store.db.exec("CREATE TRIGGER fixture_apply_failure BEFORE INSERT ON config_revision_journal WHEN NEW.idempotency_key='injected-apply' AND NEW.to_state='ACTIVE' BEGIN SELECT RAISE(ABORT,'FIXTURE_APPLY_FAILURE'); END")
  const stateBefore = getConfigRevision(store, third.config_revision).effective_state
  assert.equal(applyConfigRevision(store, request(second.config_revision, third.config_revision, "injected-apply")).ok, false)
  assert.equal(getActiveConfigRevision(store).config_revision, second.config_revision)
  assert.equal(getConfigRevision(store, third.config_revision).effective_state, stateBefore)
  assert.equal(listConfigRevisionJournal(store, { idempotency_key: "injected-apply" }).filter((entry) => entry.result === "APPLIED").length, 0)
  assert.equal(activeCount(store), 1)
  store.db.exec("DROP TRIGGER fixture_apply_failure")
  store.close()
  const results = await concurrentOperations(dbPath, "applyConfigRevision", [request(second.config_revision, third.config_revision, "concurrent-apply-a"), request(second.config_revision, third.config_revision, "concurrent-apply-b")])
  assert.equal(results.filter((result) => result.ok && result.status === "APPLIED").length, 1)
  assert.equal(results.filter((result) => !result.ok && result.code === "CAS_CONFLICT").length, 1)
  const reopened = initializeControlPlaneDatabase({ dbPath })
  try { assert.equal(activeCount(reopened), 1); assert.equal(getActiveConfigRevision(reopened).config_revision, third.config_revision) } finally { reopened.close() }
  assert.deepEqual(tasksDbHashes(), hashes)
  console.log("PLAN12_APPLY_CAS_PASS")
} finally { try { store.close() } catch {}; fs.rmSync(dir, { recursive: true, force: true }) }
