import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { initializeControlPlaneDatabase } from "../lib/plan12-control-plane.ts"
import {
  applyConfigRevision,
  createConfigRevision,
  getActiveConfigRevision,
  getConfigRevision,
  listConfigRevisionJournal,
  transitionConfigRevision,
} from "../lib/plan12-config-revision.ts"
import { appendWorkflowRun } from "../lib/plan12-control-plane.ts"
import { makeRun, makeSnapshot, operationFields, transition, withDigest, tasksDbHashes } from "./plan12-3-fixtures.mjs"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan12-3-revision-"))
const store = initializeControlPlaneDatabase({ dbPath: path.join(dir, "control-plane.db") })
const hashes = tasksDbHashes()
try {
  const first = makeSnapshot("cr-20261002-1001")
  assert.equal(createConfigRevision(store, first).ok, true)
  assert.equal(createConfigRevision(store, first).status, "IDEMPOTENT")
  assert.equal(createConfigRevision(store, { ...first, payload_sha256: "0".repeat(64) }).ok, false, "same key cannot accept a forged digest")
  assert.equal(createConfigRevision(store, makeSnapshot("missing-parent", "unknown-parent")).code, "PARENT_REVISION_NOT_FOUND")
  assert.equal(createConfigRevision(store, { ...makeSnapshot("invalid-hash"), payload_sha256: "0".repeat(64) }).code, "PAYLOAD_HASH_MISMATCH")
  assert.equal(createConfigRevision(store, withDigest({ ...makeSnapshot("invalid-config-digest"), config_digest: "0".repeat(64) })).code, "CONFIG_DIGEST_MISMATCH")
  assert.equal(getConfigRevision(store, first.config_revision).effective_state, "DRAFT")
  assert.equal(createConfigRevision(store, makeSnapshot("second-genesis")).code, "PARENT_REVISION_REQUIRED")
  assert.throws(() => store.db.prepare("UPDATE workflow_config_snapshots SET canonical_json='{}' WHERE config_revision=?").run(first.config_revision), /APPEND_ONLY_UPDATE_FORBIDDEN/)
  assert.throws(() => store.db.prepare("DELETE FROM workflow_config_snapshots WHERE config_revision=?").run(first.config_revision), /APPEND_ONLY_DELETE_FORBIDDEN/)
  const mutation = withDigest({ ...first, idempotency_key: "overwrite-first", canonical_json: "{}", config_digest: "0".repeat(64) })
  assert.equal(createConfigRevision(store, mutation).ok, false, "revision contents cannot be overwritten")
  assert.equal(transition(store, transitionConfigRevision, first.config_revision, "VALIDATED", "first").ok, true)
  assert.equal(transition(store, transitionConfigRevision, first.config_revision, "STAGED", "first").ok, true)
  assert.equal(transition(store, transitionConfigRevision, first.config_revision, "APPLIED", "first").ok, true)
  const applied = applyConfigRevision(store, { expected_active_revision: null, target_revision: first.config_revision, idempotency_key: "apply-first", ...operationFields("apply-first") })
  assert.equal(applied.ok, true)
  assert.equal(getActiveConfigRevision(store).config_revision, first.config_revision)
  assert.equal(appendWorkflowRun(store, makeRun(first.config_revision, "workflow-old", "workflow-old-run")).ok, true)
  const activeTransition = transitionConfigRevision(store, { config_revision: first.config_revision, to_state: "SUPERSEDED", idempotency_key: "manual-pointer", ...operationFields("manual-pointer") })
  assert.equal(activeTransition.ok, false, "pointer states require Apply or Rollback CAS")
  assert.equal(getActiveConfigRevision(store).config_revision, first.config_revision)

  const second = makeSnapshot("cr-20261002-1002", first.config_revision)
  assert.equal(createConfigRevision(store, second).ok, true, "child DRAFT must retain parent_revision")
  assert.equal(getConfigRevision(store, second.config_revision).parent_revision, first.config_revision)
  assert.equal(transition(store, transitionConfigRevision, second.config_revision, "VALIDATED", "second").ok, true)
  assert.equal(transition(store, transitionConfigRevision, second.config_revision, "STAGED", "second").ok, true)
  assert.equal(transition(store, transitionConfigRevision, second.config_revision, "APPLIED", "second").ok, true)
  assert.equal(transitionConfigRevision(store, { config_revision: second.config_revision, to_state: "DRAFT", idempotency_key: "illegal", ...operationFields("illegal") }).code, "CONFIG_STATE_TRANSITION_INVALID")
  assert.equal(applyConfigRevision(store, { expected_active_revision: "wrong", target_revision: second.config_revision, idempotency_key: "cas-wrong", ...operationFields("cas-wrong") }).code, "CAS_CONFLICT")
  assert.equal(applyConfigRevision(store, { expected_active_revision: first.config_revision, target_revision: second.config_revision, idempotency_key: "apply-second", ...operationFields("apply-second") }).ok, true)
  assert.equal(getActiveConfigRevision(store).config_revision, second.config_revision)
  assert.equal(getConfigRevision(store, first.config_revision).effective_state, "SUPERSEDED")
  assert.equal(appendWorkflowRun(store, makeRun(second.config_revision, "workflow-new", "workflow-new-run")).ok, true)
  const mixedRun = withDigest({ ...makeRun(second.config_revision, "workflow-old", "workflow-old-mixed"), config_revision: second.config_revision })
  assert.equal(appendWorkflowRun(store, mixedRun).code, "WORKFLOW_REVISION_MIXED")

  const repeat = applyConfigRevision(store, { expected_active_revision: first.config_revision, target_revision: second.config_revision, idempotency_key: "apply-second", ...operationFields("apply-second") })
  assert.equal(repeat.status, "IDEMPOTENT")
  const conflict = applyConfigRevision(store, { expected_active_revision: first.config_revision, target_revision: second.config_revision, idempotency_key: "apply-second", actor: "different", reason: "different", correlation_id: "different" })
  assert.equal(conflict.code, "EVIDENCE_IDEMPOTENCY_CONFLICT")
  const restorePointer = transitionConfigRevision(store, { config_revision: first.config_revision, to_state: "ACTIVE", idempotency_key: "manual-reactivate", ...operationFields("manual-reactivate") })
  assert.equal(restorePointer.ok, false, "generic SUPERSEDED -> ACTIVE must not create a second ACTIVE")
  assert.equal(getActiveConfigRevision(store).config_revision, second.config_revision)
  const rejected = makeSnapshot("rejected-revision", second.config_revision)
  assert.equal(createConfigRevision(store, rejected).ok, true)
  assert.equal(transition(store, transitionConfigRevision, rejected.config_revision, "VALIDATED", "rejected").ok, true)
  assert.equal(transition(store, transitionConfigRevision, rejected.config_revision, "REJECTED", "rejected").ok, true)
  assert.equal(getConfigRevision(store, rejected.config_revision).effective_state, "REJECTED")
  assert.equal(transition(store, transitionConfigRevision, rejected.config_revision, "VALIDATED", "rejected-retry").ok, false)
  assert.ok(listConfigRevisionJournal(store, { config_revision: rejected.config_revision }).some((entry) => entry.to_state === "REJECTED"))
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM workflow_config_snapshots").get().n, 3)
  assert.deepEqual(tasksDbHashes(), hashes)
  console.log("PLAN12_CONFIG_REVISION_PASS")
} finally {
  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
}
