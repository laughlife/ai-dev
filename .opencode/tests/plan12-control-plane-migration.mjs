import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { initializeControlPlaneDatabase, migrateControlPlaneDatabase } from "../lib/plan12-control-plane.ts"

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "plan12-2-migration-"))
const dbPath = path.join(fixture, "runtime", "control-plane.db")
const expectedTables = [
  "control_plane_meta",
  "evidence_idempotency",
  "workflow_config_snapshots",
  "workflow_runs",
  "workflow_waves",
  "workflow_wave_nodes",
  "workflow_lock_events",
  "execution_events",
]

try {
  const store = initializeControlPlaneDatabase({ dbPath, runtimeRoot: fixture, allowedRoots: [fixture] })
  assert.equal(store.db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1)
  assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 1)
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => row.name)
  for (const table of expectedTables) assert.ok(tables.includes(table), `missing ${table}`)
  const requiredColumns = {
    workflow_runs: ["schema_version", "config_revision", "source", "observed_at", "payload_sha256", "idempotency_key", "workflow_id", "run_id", "attempt"],
    workflow_waves: ["run_id", "wave_id", "workflow_id", "wave_index", "parallelism"],
    workflow_wave_nodes: ["run_id", "wave_id", "node_id", "task_id", "session_key", "session_id", "model_runtime_id", "event_seq"],
    workflow_lock_events: ["event_id", "run_id", "lock_key", "event_type", "sequence"],
    execution_events: ["event_id", "run_id", "workflow_id", "wave_id", "node_id", "task_id", "sequence"],
    workflow_config_snapshots: ["config_revision", "parent_revision", "canonical_json", "state"],
  }
  for (const [table, columns] of Object.entries(requiredColumns)) {
    const actual = new Set(store.db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name))
    for (const column of columns) assert.ok(actual.has(column), `${table}.${column} missing`)
  }
  const firstMigration = migrateControlPlaneDatabase(store)
  assert.deepEqual(firstMigration, { ok: true, schema_version: 1 })
  store.close()

  const reopened = initializeControlPlaneDatabase({ dbPath, runtimeRoot: fixture, allowedRoots: [fixture] })
  assert.equal(reopened.db.prepare("SELECT COUNT(*) AS count FROM control_plane_meta").get().count, 2)
  const secondMigration = migrateControlPlaneDatabase(reopened)
  assert.deepEqual(secondMigration, { ok: true, schema_version: 1 })
  reopened.close()
  console.log("PLAN12_CONTROL_PLANE_MIGRATION_PASS")
} finally {
  fs.rmSync(fixture, { recursive: true, force: true })
}
