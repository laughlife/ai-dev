// Runtime Registry Core — shared runtime session core (Plan 6 Phase 2)
//
// Extracted verbatim (behavior 100% compatible) from the Plan 5 plugin
// .opencode/plugins/runtime-registry/index.ts so that the runtime-registry
// plugin and the future Task Bus plugin share ONE implementation of:
//
//   root resolution / SQLite open (WAL) / schema init / YAML config load /
//   project lookup / runtime_id parse / project-main + project-reader model
//   resolve / session ensure / send / list / get / archive / per-session_key lock
//
// Authority boundaries (unchanged from Plan 5):
// - Architecture source of truth: diagrams/multi_agent_framework_v4_completion_guard.drawio
// - Runtime data source: framework-config/projects.yaml + framework-config/agents.yaml
//   (read fresh on every call; nothing project- or model-specific is hardcoded here)
//
// NOT implemented here either: full Task Bus, DAG scheduling, automatic lifecycle
// rotation, automatic checkpointing, drawio parsing. The `tasks` table stays
// schema-only until the Task Bus phase.
//
// Plan 7 Phase 5 (§45-§49) additive extension: generic scoped session API
// (ensureScopedSession / sendScopedSession / archiveScopedSession) on top of
// the SAME `sessions` table (no ALTER, no new table). Workflow-scoped keys
// (e.g. `workflow:<id>:planner`,
// `workflow:<id>:project:<pid>:feature-executor[:node:<node_id>]`) are stored verbatim as
// ordinary session_key values. runtime_id must ALWAYS be passed explicitly —
// a scoped session never guesses, inherits or defaults a model (§47).
// The existing project-main/project-reader API surface and the five
// runtime_session_* tool behaviors are unchanged; runtime_session_list simply
// shows the scoped rows too (the registry is a superset).
//
// Plan 8 T3 (schema/migration support ONLY) additive extension:
// - registry schema_version 1 -> 2: `sessions` gains six additive nullable
//   columns (four verified-context-telemetry + two lifecycle-state). Existing
//   v1 databases are migrated idempotently at core construction time via
//   PRAGMA table_info(sessions) + BEGIN IMMEDIATE + ALTER TABLE ADD COLUMN
//   for MISSING columns only. ADD COLUMN with a NULL default is a
//   metadata-only change in SQLite: existing row data is never rewritten or
//   altered. Fresh installs get the columns directly from schema.sql, so the
//   migration is a no-op there.
// - the lifecycle-engine schema (.opencode/plugins/lifecycle-engine/
//   schema.sql: lifecycle_events / lifecycle_rotations, all CREATE ...
//   IF NOT EXISTS) is applied to the SAME shared runtime/tasks.db when the
//   file is present; a missing file never breaks existing plugin behavior.
// - PRAGMA busy_timeout is set so concurrent migrators (three plugins build
//   this core per startup, each with its own db handle) wait for the write
//   lock instead of failing with SQLITE_BUSY. Uncontended operations behave
//   exactly as before.
// These columns/tables are STORAGE ONLY. This core does not capture
// telemetry, does not write checkpoints, does not rotate sessions and
// contains NO threshold or context-window logic: the 60/70/80 rotation bands
// are declared exclusively in framework-config/lifecycle.yaml (drawio
// mirror) and will be evaluated by the later Plan 8 lifecycle-engine tasks.
//
// Plan 8 T4 (locking ONLY): the per-session_key `withLock` chain registry
// moved from a per-core Map to the process-global lock in
// .opencode/lib/global-lock.ts (Symbol.for-keyed on globalThis). Multiple
// core instances in one process (runtime-registry / task-bus /
// workflow-engine / lifecycle-core) now share ONE FIFO chain per key, so a
// lifecycle rotation can never interrupt a running prompt/send on the same
// session_key. Public API, lock semantics (FIFO, error-isolated,
// NON-REENTRANT) and all Plan 5-7 tool behavior are unchanged.
//
// Plan 8 T6 (lifecycle preflight seam ONLY): the persistent
// project-main/project-reader send() path accepts an OPTIONAL lifecycle
// preflight callback (options.lifecyclePreflight at construction or
// setLifecyclePreflight() afterwards; the plugin setup wires it once BOTH
// cores exist — this core NEVER imports lifecycle-core, avoiding the import
// cycle, and holds no threshold/rotation logic of its own). When wired, the
// callback runs AFTER ensure() and BEFORE the prompt, INSIDE the process-
// global session_key lock the send caller already holds (the runtime-registry
// plugin wrapper and task-bus dispatchToRole both wrap send in withLock).
// The callback therefore MUST be built from the LOCK-FREE lifecycle APIs
// (refreshTelemetry / evaluateThreshold / rotateSessionLocked) and MUST NOT
// re-acquire the same key's lock (globalWithLock is NON-REENTRANT — doing so
// deadlocks). Admission policy lives entirely in the callback: refresh the
// verified telemetry, evaluate the lifecycle.yaml bands and rotate ONLY when
// the evaluated lifecycle_state is ROTATE_PENDING/HARD_ROTATE AND
// framework-config/framework.yaml `runtime_registry.automatic_rotation` is
// true (it currently stays false; nothing here enables it), then report
// { ok: true, rotated: true }. On rotated:true send() re-reads the latest
// sessions row and prompts the committed ACTIVE successor generation. Seam
// failures are fail-closed (ok:false / throw => LIFECYCLE_PREFLIGHT_FAILED,
// no prompt is sent). When NO seam is set, send() behavior, locking and
// result shapes are IDENTICAL to Plan 5-7 (no extra fields). sendScopedSession
// is intentionally NOT part of this seam.
//
// Runtime facts verified on this machine (desktop 2.0.19): Bun 1.4.2,
// bun:sqlite (SQLite 3.53.2), Bun.YAML.parse.

import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import * as path from "node:path"
import { globalWithLock } from "./global-lock.ts"

const SCHEMA_VERSION = "2" // Plan 8 T3: registry schema v2 (sessions telemetry/lifecycle columns + lifecycle tables)
const WAIT_TIMEOUT_MS = 15 * 60 * 1000
// Plan 8 T3: wait for the SQLite write lock instead of failing immediately
// with SQLITE_BUSY when several plugin cores (runtime-registry / task-bus /
// workflow-engine, or concurrent processes) migrate or write the same
// runtime/tasks.db at the same time. Behavior-preserving: uncontended
// operations are unaffected.
const BUSY_TIMEOUT_MS = 5000

// Plan 8 T3: the six additive v2 `sessions` columns — verified context
// telemetry (context_tokens / context_limit / context_pct / telemetry_source /
// telemetry_at; measurement protocol normative in
// docs/runtime-context-telemetry.md, values recorded only, never estimated)
// and lifecycle state (lifecycle_state). All nullable
// with no default so ALTER TABLE ADD COLUMN is metadata-only on existing v1
// databases (row data untouched). Pure storage: no threshold/context-window
// logic lives here — the rotation bands are declared in
// framework-config/lifecycle.yaml.
const SESSIONS_V2_COLUMNS: Array<{ name: string; alter: string }> = [
  { name: "context_tokens", alter: "ALTER TABLE sessions ADD COLUMN context_tokens INTEGER" },
  { name: "context_limit", alter: "ALTER TABLE sessions ADD COLUMN context_limit INTEGER" },
  { name: "context_pct", alter: "ALTER TABLE sessions ADD COLUMN context_pct REAL" },
  { name: "telemetry_source", alter: "ALTER TABLE sessions ADD COLUMN telemetry_source TEXT" },
  { name: "telemetry_at", alter: "ALTER TABLE sessions ADD COLUMN telemetry_at TEXT" },
  { name: "lifecycle_state", alter: "ALTER TABLE sessions ADD COLUMN lifecycle_state TEXT" },
]

// Idempotent v1 -> v2 `sessions` migration (Plan 8 T3).
//
// Safety under repeated/concurrent core construction:
// - repeated construction in one process: the PRAGMA pre-check finds no
//   missing columns after the first run, so later runs are pure no-ops
//   (no transaction is even opened);
// - concurrent processes: BEGIN IMMEDIATE acquires the write lock (waiting
//   up to busy_timeout), and the column set is RE-CHECKED inside the
//   transaction, so if another migrator committed first, this one ALTERs
//   nothing and commits an empty transaction;
// - failure: the transaction is rolled back and the error propagates to the
//   caller's db-init catch (db = null, dbError set) — the same existing
//   SQLITE_RUNTIME_UNAVAILABLE failure path, never a half-migrated stamp of
//   schema_version = 2 (the registry_meta upsert runs only after this).
// DDL only: no statement here reads, rewrites or deletes row data.
function migrateSessionsToV2(db: any): string[] {
  const existing = new Set(
    (db.prepare("PRAGMA table_info(sessions)").all() as any[]).map((c: any) => String(c?.name)),
  )
  const missing = SESSIONS_V2_COLUMNS.filter((c) => !existing.has(c.name))
  if (missing.length === 0) return [] // fresh install (schema.sql v2) or already migrated
  db.exec("BEGIN IMMEDIATE")
  try {
    // re-check inside the write transaction: a concurrent migrator may have
    // committed the columns between the pre-check above and BEGIN IMMEDIATE
    const current = new Set(
      (db.prepare("PRAGMA table_info(sessions)").all() as any[]).map((c: any) => String(c?.name)),
    )
    const added: string[] = []
    for (const col of SESSIONS_V2_COLUMNS) {
      if (current.has(col.name)) continue
      db.exec(col.alter)
      added.push(col.name)
    }
    db.exec("COMMIT")
    return added
  } catch (e) {
    try {
      db.exec("ROLLBACK")
    } catch {}
    throw e
  }
}

const LIFECYCLE_EVENT_COLUMNS = [
  "event_id", "session_key", "generation", "opencode_session_id", "event_type",
  "context_pct", "checkpoint_path", "details_json", "created_at",
]
const LIFECYCLE_ROTATION_COLUMNS = [
  "rotation_id", "session_key", "from_generation", "from_session_id", "to_generation",
  "checkpoint_path", "successor_session_id", "status", "error", "created_at", "updated_at",
]

function tableColumns(db: any, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((c: any) => String(c?.name)))
}

/** Repair only empty incompatible draft lifecycle tables; never discard audit data. */
function ensureLifecycleSchema(db: any, schemaFile: string): { applied: boolean; repaired: boolean; detail: string | null } {
  if (!fs.existsSync(schemaFile)) return { applied: false, repaired: false, detail: `file not found: ${schemaFile}` }
  const sql = fs.readFileSync(schemaFile, "utf8")
  db.exec(sql)
  const events = tableColumns(db, "lifecycle_events")
  const rotations = tableColumns(db, "lifecycle_rotations")
  const shapeOk = LIFECYCLE_EVENT_COLUMNS.every((c) => events.has(c)) && LIFECYCLE_ROTATION_COLUMNS.every((c) => rotations.has(c))
  if (shapeOk) return { applied: true, repaired: false, detail: null }

  const eventCount = Number(db.query("SELECT COUNT(*) AS count FROM lifecycle_events").get()?.count ?? 0)
  const rotationCount = Number(db.query("SELECT COUNT(*) AS count FROM lifecycle_rotations").get()?.count ?? 0)
  if (eventCount > 0 || rotationCount > 0) {
    throw new Error(`LIFECYCLE_SCHEMA_DIVERGED: incompatible lifecycle tables contain data (events=${eventCount}, rotations=${rotationCount}); refusing destructive migration`)
  }

  db.exec("BEGIN IMMEDIATE")
  try {
    db.exec("DROP TABLE IF EXISTS lifecycle_events")
    db.exec("DROP TABLE IF EXISTS lifecycle_rotations")
    db.exec(sql)
    const repairedEvents = tableColumns(db, "lifecycle_events")
    const repairedRotations = tableColumns(db, "lifecycle_rotations")
    if (!LIFECYCLE_EVENT_COLUMNS.every((c) => repairedEvents.has(c)) || !LIFECYCLE_ROTATION_COLUMNS.every((c) => repairedRotations.has(c))) {
      throw new Error("LIFECYCLE_SCHEMA_DIVERGED: schema file did not create required Plan 8 columns")
    }
    db.exec("COMMIT")
    return { applied: true, repaired: true, detail: "recreated empty incompatible lifecycle tables" }
  } catch (e) {
    try { db.exec("ROLLBACK") } catch {}
    throw e
  }
}

// Plan 8 §6 migration evidence. Missing workflow tables are represented as
// null because the workflow plugin may not have initialized them yet; rows in
// tables that do exist are counted before and after the additive migration.
function snapshotRowCounts(db: any): Record<string, number | null> {
  const counts: Record<string, number | null> = {}
  for (const table of ["sessions", "tasks", "workflows", "workflow_nodes"]) {
    const exists = db
      .query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(table)
    if (!exists) {
      counts[table] = null
      continue
    }
    const row = db.query(`SELECT COUNT(*) AS count FROM ${table}`).get()
    counts[table] = Number(row?.count ?? 0)
  }
  return counts
}

// role -> session_key suffix (plan §16: project:<project-id>:main|reader)
const ROLE_KEYS: Record<string, string> = {
  "project-main": "main",
  "project-reader": "reader",
}

function nowIso(): string {
  return new Date().toISOString()
}

function errMsg(e: any): string {
  return e?.message ?? String(e)
}

function failure(code: string, detail: string, extra?: Record<string, unknown>) {
  return { ok: false, status: "ERROR", code, detail, ...(extra ?? {}) }
}

// "openai/gpt-5.6-sol-fast#high" -> { providerID: "openai", id: "gpt-5.6-sol-fast", variant: "high" }
// Only parses already-validated runtime_id values from framework-config; never guesses models.
export function parseRuntimeId(runtimeId: unknown): { providerID: string; id: string; variant?: string } | null {
  if (typeof runtimeId !== "string" || !runtimeId.includes("/")) return null
  const slash = runtimeId.indexOf("/")
  const providerID = runtimeId.slice(0, slash)
  const rest = runtimeId.slice(slash + 1)
  const hash = rest.indexOf("#")
  if (hash < 0) return { providerID, id: rest }
  const variant = rest.slice(hash + 1)
  return variant ? { providerID, id: rest.slice(0, hash), variant } : { providerID, id: rest.slice(0, hash) }
}

// =====================================================================
// Plan 8 T6: lifecycle preflight seam contract (types only — the runtime
// core never imports lifecycle-core; the plugin setup wires a callback
// built from the lifecycle core's LOCK-FREE methods).
//
// The callback is invoked from send() with the ensured row's identity,
// while the caller-held process-global session_key lock is ALREADY held.
// It must:
// - be lock-free (refreshTelemetry / evaluateThreshold / rotateSessionLocked;
//   NEVER rotateSession / ensureCheckpoint / restoreSession — those call
//   globalWithLock(key) again and DEADLOCK on the non-reentrant lock),
// - own the admission policy: rotate only when the evaluated
//   lifecycle_state is ROTATE_PENDING/HARD_ROTATE AND framework-config/
//   framework.yaml `runtime_registry.automatic_rotation` is true (read
//   fresh; it currently stays false),
// - report a committed rotation with { ok: true, rotated: true } so send()
//   re-reads the latest ACTIVE row and prompts the successor generation.
// Return-value handling in send():
// - null/undefined          -> treated as "no admission info", send proceeds
// - { ok: true, rotated?: false, ... } -> send proceeds on the ensured row;
//   the result object is passed through verbatim as `lifecycle_preflight`
// - { ok: true, rotated: true, ... }   -> send re-reads the latest ACTIVE
//   row (successor) and prompts THAT session/generation
// - { ok: false, ... } or a thrown error -> fail-closed: the send returns
//   LIFECYCLE_PREFLIGHT_FAILED and NO prompt is sent
// =====================================================================
export interface LifecyclePreflightInfo {
  project_id: string
  role: string
  session_key: string
  session_id: string
  generation: number
}

export interface LifecyclePreflightResult {
  ok: boolean
  /** true ONLY when a rotation was COMMITTED inside this callback (successor row is latest ACTIVE) */
  rotated?: boolean
  code?: string | null
  detail?: string | null
  lifecycle_state?: string | null
  context_pct?: number | null
  recommended_action?: string | null
  /** pass-through for diagnostics (thresholds, rotation_id, ...); surfaced under `lifecycle_preflight` */
  [extra: string]: unknown
}

export type LifecyclePreflightFn = (
  info: LifecyclePreflightInfo,
) => LifecyclePreflightResult | null | undefined | Promise<LifecyclePreflightResult | null | undefined>

// Create the shared runtime registry core. All heavy state (root, SQLite handle,
// prepared queries, lock chains) is created synchronously here — the same
// initialization timing and idempotency as the Plan 5 plugin setup():
// schema.sql uses CREATE TABLE IF NOT EXISTS and the registry_meta upsert uses
// ON CONFLICT DO UPDATE, so repeated creation is safe.
//
// options.schemaFile: absolute path to schema.sql (the plugin passes
//   path.join(import.meta.dir, "schema.sql")); falls back to the canonical
//   plugin location under the resolved framework root.
// options.lifecycleSchemaFile: absolute path to the lifecycle-engine
//   schema.sql (Plan 8 T3); falls back to the canonical plugin location
//   under the resolved framework root. Applied when present, skipped when
//   absent — never an error for the existing plugins.
// options.lifecyclePreflight: optional Plan 8 T6 seam callback (see
//   LifecyclePreflightFn); equivalent to calling setLifecyclePreflight()
//   right after construction. Absent => send() behaves exactly as before.
export function createRuntimeRegistryCore(ctx: any, options?: any) {
  // --- resolve framework root (the directory containing framework-config/) ---
  let root: string = ctx?.location?.directory ?? process.cwd()
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(root, "framework-config", "projects.yaml"))) break
    const parent = path.dirname(root)
    if (parent === root) break
    root = parent
  }
  const projectsFile = path.join(root, "framework-config", "projects.yaml")
  const agentsFile = path.join(root, "framework-config", "agents.yaml")
  const configReady = fs.existsSync(projectsFile) && fs.existsSync(agentsFile)

  // --- SQLite registry via Bun built-in (plan §14: no third-party sqlite package) ---
  const runtimeDir = path.join(root, "runtime")
  const schemaFile =
    typeof options?.schemaFile === "string" && options.schemaFile
      ? options.schemaFile
      : path.join(root, ".opencode", "plugins", "runtime-registry", "schema.sql")
  // Plan 8 T3: lifecycle-engine schema (lifecycle_events / lifecycle_rotations)
  // shares the SAME runtime/tasks.db; applied idempotently when the file exists.
  const lifecycleSchemaFile =
    typeof options?.lifecycleSchemaFile === "string" && options.lifecycleSchemaFile
      ? options.lifecycleSchemaFile
      : path.join(root, ".opencode", "plugins", "lifecycle-engine", "schema.sql")
  let db: any = null
  let dbError: string | null = null
  // Plan 8 T3 diagnostics (additive; no existing field changes meaning):
  const schemaMigration: {
    schema_version: string
    sessions_columns_added: string[]
    lifecycle_schema_applied: boolean
    lifecycle_schema_repaired: boolean
    lifecycle_schema_skipped_reason: string | null
    row_counts_before: Record<string, number | null>
    row_counts_after: Record<string, number | null>
  } = {
    schema_version: SCHEMA_VERSION,
    sessions_columns_added: [],
    lifecycle_schema_applied: false,
    lifecycle_schema_repaired: false,
    lifecycle_schema_skipped_reason: null,
    row_counts_before: {},
    row_counts_after: {},
  }
  try {
    fs.mkdirSync(runtimeDir, { recursive: true })
    db = new Database(path.join(runtimeDir, "tasks.db"))
    // Plan 8 T3: serialize concurrent writers/migrators on the shared db
    // (behavior-preserving: only affects lock-contention cases that used to
    // fail immediately with SQLITE_BUSY).
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`)
    db.exec("PRAGMA journal_mode = WAL;")
    const schemaSql = fs.readFileSync(schemaFile, "utf8")
    db.exec(schemaSql)
    schemaMigration.row_counts_before = snapshotRowCounts(db)
    // Plan 8 T3: idempotent v1 -> v2 sessions migration. Fresh installs get
    // the six columns from schema.sql above and this is a verified no-op;
    // existing v1 databases gain ONLY the missing columns via ALTER TABLE
    // ADD COLUMN inside BEGIN IMMEDIATE (row data never touched).
    schemaMigration.sessions_columns_added = migrateSessionsToV2(db)
    const lifecycleSchema = ensureLifecycleSchema(db, lifecycleSchemaFile)
    schemaMigration.lifecycle_schema_applied = lifecycleSchema.applied
    schemaMigration.lifecycle_schema_repaired = lifecycleSchema.repaired
    schemaMigration.lifecycle_schema_skipped_reason = lifecycleSchema.detail
    schemaMigration.row_counts_after = snapshotRowCounts(db)
    // stamped LAST: schema_version = 2 is only recorded after the base
    // schema, the sessions migration and the lifecycle tables all succeeded
    db.query(
      "INSERT INTO registry_meta (key, value) VALUES ('schema_version', ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(SCHEMA_VERSION)
  } catch (e: any) {
    db = null
    dbError = errMsg(e)
  }

  const q = db
    ? {
        latest: db.query(
          "SELECT * FROM sessions WHERE session_key = ? ORDER BY generation DESC LIMIT 1",
        ),
        insert: db.query(
          "INSERT INTO sessions (session_key, project_id, role, opencode_session_id, generation, " +
            "agent_id, model_runtime_id, project_path, status, checkpoint_path, created_at, last_used_at, replaced_by) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ),
        touch: db.query(
          "UPDATE sessions SET last_used_at = ? WHERE session_key = ? AND generation = ?",
        ),
        markStatus: db.query(
          "UPDATE sessions SET status = ?, last_used_at = ? WHERE session_key = ? AND generation = ?",
        ),
        linkReplaced: db.query(
          "UPDATE sessions SET replaced_by = ?, last_used_at = ? WHERE session_key = ? AND generation = ?",
        ),
        current: db.query(
          "SELECT s.session_key, s.project_id, s.role, s.opencode_session_id, s.generation, " +
            "s.agent_id, s.model_runtime_id, s.status, s.last_used_at " +
            "FROM sessions s JOIN (SELECT session_key, MAX(generation) AS g FROM sessions GROUP BY session_key) m " +
            "ON s.session_key = m.session_key AND s.generation = m.g " +
            "ORDER BY s.project_id, s.role, s.generation",
        ),
      }
    : null

  // --- config access (plan §17: read framework-config, never hardcode) ---
  function loadConfig() {
    const B = (globalThis as any).Bun
    if (typeof B?.YAML?.parse !== "function") {
      throw new Error("YAML_PARSER_UNAVAILABLE: Bun.YAML.parse is not present in this runtime")
    }
    return {
      projects: B.YAML.parse(fs.readFileSync(projectsFile, "utf8")),
      agents: B.YAML.parse(fs.readFileSync(agentsFile, "utf8")),
    }
  }

  function findProject(cfg: any, projectId: string) {
    const list = cfg?.projects?.projects
    if (!Array.isArray(list)) return null
    return list.find((p: any) => p?.id === projectId) ?? null
  }

  function resolveRoleModel(cfg: any, projectId: string, role: string): string | null {
    if (role === "project-reader") {
      const list = cfg?.agents?.agents
      if (!Array.isArray(list)) return null
      const agent = list.find((a: any) => a?.id === "project-reader")
      const rid = agent?.model?.runtime_id
      return typeof rid === "string" && rid ? rid : null
    }
    // project-main: model comes from project_sessions.<project>.model.runtime_id
    const rid = cfg?.agents?.project_sessions?.[projectId]?.model?.runtime_id
    return typeof rid === "string" && rid ? rid : null
  }

  // --- initial scope context (plan §22), written as a synthetic message ---
  function initialContext(projectId: string, projectPath: string, role: string): string {
    if (role === "project-main") {
      return [
        `PROJECT_ID: ${projectId}`,
        `PROJECT_PATH: ${projectPath}`,
        "ROLE: PROJECT_MAIN",
        "",
        "Rules:",
        "- only coordinate this project",
        "- root framework Git must not stage business project source",
        "- project Git operations must target the project repository explicitly",
        "- obey D:\\ai-dev\\AGENTS.md",
        "- no git pull",
        "- no git push",
        "- code implementation must go to Feature Executor",
        "",
        "(Synthetic scope context written by the runtime-registry plugin, Plan 5.)",
      ].join("\n")
    }
    return [
      `PROJECT_ID: ${projectId}`,
      `PROJECT_PATH: ${projectPath}`,
      "ROLE: PROJECT_READER",
      "",
      "Rules:",
      "- read-only",
      "- focus only on this project",
      "- maintain project reading context across requests",
      "- no code modifications",
      "- no DB write / DDL",
      "- no Mem0 write",
      "",
      "(Synthetic scope context written by the runtime-registry plugin, Plan 5.)",
    ].join("\n")
  }

  function guard() {
    if (!db || !q) return failure("SQLITE_RUNTIME_UNAVAILABLE", dbError ?? "registry database unavailable")
    if (!configReady) {
      return failure("CONFIG_ROOT_NOT_FOUND", `framework-config not found from root '${root}'`)
    }
    return null
  }

  function sessionKey(projectId: string, role: string): string {
    return `project:${projectId}:${ROLE_KEYS[role]}`
  }

  function rowToResult(row: any, reused: boolean) {
    return {
      ok: true,
      status: row.status,
      session_key: row.session_key,
      session_id: row.opencode_session_id,
      project_id: row.project_id,
      role: row.role,
      generation: row.generation,
      reused,
      agent_id: row.agent_id,
      model_runtime_id: row.model_runtime_id,
      project_path: row.project_path,
      created_at: row.created_at,
      last_used_at: row.last_used_at,
    }
  }

  // --- core: ensure (plan §20/§21) ---
  async function ensure(projectId: any, role: any) {
    const g = guard()
    if (g) return g
    if (typeof projectId !== "string" || !projectId) return failure("INVALID_INPUT", "project_id is required")
    if (typeof role !== "string" || !ROLE_KEYS[role]) {
      return failure("ROLE_NOT_SUPPORTED", "role must be one of: project-main, project-reader")
    }

    let cfg: any
    try {
      cfg = loadConfig()
    } catch (e: any) {
      return failure("CONFIG_LOAD_FAILED", errMsg(e))
    }
    const project = findProject(cfg, projectId)
    if (!project) {
      return failure("PROJECT_NOT_FOUND", `project '${projectId}' is not registered in framework-config/projects.yaml`)
    }
    const projectPath = typeof project.path === "string" ? project.path : ""
    const key = sessionKey(projectId, role)

    const runtimeId = resolveRoleModel(cfg, projectId, role)
    if (!runtimeId) {
      // plan §20.3 / §39: no configured runtime_id -> refuse, never guess, never inherit
      return {
        ok: false,
        status: "MODEL_UNASSIGNED",
        session_key: key,
        project_id: projectId,
        role,
        session_created: false,
        detail:
          role === "project-main"
            ? `agents.yaml project_sessions.${projectId}.model.runtime_id is null; refusing to create a session or guess a model`
            : "agents.yaml project-reader.model.runtime_id is missing; refusing to create a session or guess a model",
      }
    }
    const model = parseRuntimeId(runtimeId)
    if (!model) return failure("RUNTIME_ID_UNPARSEABLE", `cannot parse runtime_id '${runtimeId}'`)

    const latest: any = q.latest.get(key)
    if (latest && latest.status === "ACTIVE") {
      let alive = true
      try {
        await ctx.session.get({ sessionID: latest.opencode_session_id })
      } catch {
        alive = false
      }
      if (alive) {
        q.touch.run(nowIso(), key, latest.generation)
        return rowToResult({ ...latest, last_used_at: nowIso() }, true)
      }
      // registry record exists but the OpenCode session is gone -> STALE, generation + 1
      q.markStatus.run("STALE", nowIso(), key, latest.generation)
    }

    const prevGeneration = latest ? (latest.generation as number) : 0
    const generation = prevGeneration + 1
    const title = `[runtime] ${projectId} ${role} gen${generation}`
    let sessionID: string
    try {
      // plan §19: session location stays at the framework root (plugin location),
      // project scoping is done via registry fields + synthetic scope context.
      const info: any = await ctx.session.create({ title })
      sessionID = info?.id ?? info?.sessionID
      if (!sessionID) throw new Error("session create returned no id")
    } catch (e: any) {
      return failure("SESSION_CREATE_FAILED", errMsg(e))
    }

    try {
      // plan §20.8: switchAgent -> role profile, switchModel -> configured runtime model
      await ctx.session.switchAgent({ sessionID, agent: role })
      const modelRef: any = { providerID: model.providerID, id: model.id }
      if (model.variant) modelRef.variant = model.variant
      await ctx.session.switchModel({ sessionID, model: modelRef })
      await ctx.session.synthetic({ sessionID, text: initialContext(projectId, projectPath, role) })
    } catch (e: any) {
      return failure("SESSION_INIT_FAILED", `${errMsg(e)} (session ${sessionID} was created but initialization failed)`, {
        session_id: sessionID,
      })
    }

    const ts = nowIso()
    q.insert.run(key, projectId, role, sessionID, generation, role, runtimeId, projectPath, "ACTIVE", null, ts, ts, null)
    if (latest) q.linkReplaced.run(sessionID, ts, key, prevGeneration)

    return {
      ok: true,
      status: "ACTIVE",
      session_key: key,
      session_id: sessionID,
      project_id: projectId,
      role,
      generation,
      reused: false,
      agent_id: role,
      model_runtime_id: runtimeId,
      project_path: projectPath,
      created_at: ts,
      last_used_at: ts,
    }
  }

  // --- shared prompt/wait/extract mechanism (plan §25). Used by send() and,
  // since Plan 7 §47, by sendScopedSession(). Throws on prompt/wait/context
  // errors (callers map that to SEND_FAILED); never touches the DB itself. ---
  async function promptAndExtract(
    sessionID: string,
    text: string,
  ): Promise<
    | { code: "OK"; text: string; detail?: undefined }
    | { code: "NO_ASSISTANT_TEXT" | "NO_ASSISTANT_RESULT"; text: null; detail?: string }
  > {
    await ctx.session.prompt({ sessionID, text })
    let timer: any
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("WAIT_TIMEOUT")), WAIT_TIMEOUT_MS)
    })
    try {
      await Promise.race([ctx.session.wait({ sessionID }), timeout])
    } finally {
      clearTimeout(timer)
    }
    const contextRes: any = await ctx.session.context({ sessionID })
    const messages: any[] = Array.isArray(contextRes) ? contextRes : (contextRes?.messages ?? [])
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m?.type !== "assistant") continue
      const parts: any[] = Array.isArray(m.content) ? m.content : []
      const resultText = parts
        .filter((p: any) => p?.type === "text" && typeof p.text === "string")
        .map((p: any) => p.text)
        .join("\n")
        .trim()
      if (resultText) return { code: "OK", text: resultText }
      return {
        code: "NO_ASSISTANT_TEXT",
        text: null,
        detail: "the last assistant message contained no text part",
      }
    }
    return { code: "NO_ASSISTANT_RESULT", text: null }
  }

  // =====================================================================
  // Plan 8 T6: optional lifecycle preflight seam (mutable wiring point).
  //
  // Stored as a plain closure reference — NO import of lifecycle-core here
  // (lifecycle-core imports parseRuntimeId from THIS module, so a reverse
  // import would be a cycle). The lifecycle-engine/runtime plugin setup
  // wires the callback once both cores exist:
  //
  //   const rt = createRuntimeRegistryCore(ctx, { schemaFile })
  //   const lc = createLifecycleCore(ctx, rt)
  //   rt.setLifecyclePreflight(async (info) => {
  //     // caller already holds globalWithLock(info.session_key):
  //     // ONLY lock-free lifecycle methods may be used here.
  //     const ev = await lc.evaluateThreshold({ session_key: info.session_key, refresh: true })
  //     if (!ev.ok) return { ok: false, code: ev.code, detail: ev.detail }
  //     const st = ev.lifecycle_state
  //     const due = st === "ROTATE_PENDING" || st === "HARD_ROTATE"
  //     if (!due || !automaticRotationEnabled()) // framework.yaml runtime_registry.automatic_rotation (fresh read; currently false)
  //       return { ok: true, rotated: false, lifecycle_state: st, context_pct: ev.context_pct }
  //     const rot = await lc.rotateSessionLocked(info.session_key, "admission:auto", false) // LOCK-FREE variant
  //     if (!rot.ok) return { ok: false, code: rot.code, detail: rot.detail }
  //     return { ok: true, rotated: true, lifecycle_state: st, context_pct: ev.context_pct }
  //   })
  // =====================================================================
  let lifecyclePreflight: LifecyclePreflightFn | null =
    typeof options?.lifecyclePreflight === "function" ? (options.lifecyclePreflight as LifecyclePreflightFn) : null

  // Wire (function) or clear (null/undefined) the seam at runtime. Returns a
  // structured result; never throws for the documented inputs.
  function setLifecyclePreflight(fn: unknown) {
    if (fn == null) {
      lifecyclePreflight = null
      return { ok: true, status: "CLEARED", lifecycle_preflight_set: false }
    }
    if (typeof fn !== "function") {
      return failure("INVALID_INPUT", "lifecycle preflight must be a function or null/undefined")
    }
    lifecyclePreflight = fn as LifecyclePreflightFn
    return { ok: true, status: "SET", lifecycle_preflight_set: true }
  }

  // Introspection for plugin wiring/tests (never returns the closure itself).
  function getLifecyclePreflight() {
    return { ok: true, status: "OK", lifecycle_preflight_set: lifecyclePreflight != null }
  }

  // --- core: send (plan §25: durable prompt, wait, extract last assistant result) ---
  //
  // LOCK CONTRACT (unchanged): send() itself is LOCK-FREE — callers hold the
  // process-global session_key lock around it (runtime-registry plugin tool
  // wrapper and task-bus dispatchToRole both do `withLock(sessionKey, () =>
  // send(...))`). send() must NEVER acquire that lock itself (non-reentrant).
  //
  // Plan 8 T6: when a lifecycle preflight seam is wired it runs after
  // ensure() and before the prompt, under the caller-held lock. Without a
  // seam, behavior and result shapes are IDENTICAL to Plan 5-7.
  async function send(projectId: any, role: any, text: any) {
    const g = guard()
    if (g) return g
    if (typeof text !== "string" || !text.trim()) return failure("INVALID_INPUT", "text is required")
    const ensured: any = await ensure(projectId, role)
    if (!ensured.ok) return ensured
    const key = ensured.session_key
    let sessionID = ensured.session_id
    let generation = ensured.generation
    let reused = ensured.reused

    // Plan 8 T6 admission seam (no-op when unset)
    let preflight: any = null
    let rotated = false
    if (lifecyclePreflight) {
      let res: any = null
      try {
        res = await lifecyclePreflight({
          project_id: projectId,
          role,
          session_key: key,
          session_id: sessionID,
          generation,
        })
      } catch (e: any) {
        res = { ok: false, code: "LIFECYCLE_PREFLIGHT_ERROR", detail: errMsg(e) }
      }
      preflight = res ?? null
      if (res && res.ok === false) {
        // fail-closed: a refused/failed admission never reaches the prompt
        return failure(
          "LIFECYCLE_PREFLIGHT_FAILED",
          typeof res.detail === "string" && res.detail
            ? res.detail
            : "lifecycle preflight refused admission for this send",
          {
            session_key: key,
            session_id: sessionID,
            generation,
            preflight_code: typeof res.code === "string" ? res.code : null,
            lifecycle_preflight: res,
          },
        )
      }
      rotated = !!(res && res.rotated === true)
      if (rotated) {
        // A rotation was COMMITTED inside the seam: the old generation is
        // archived and the successor is the latest ACTIVE row for this key.
        // Re-read it and address the prompt to the successor — never to the
        // archived generation, and never to a stale in-memory session id.
        const latest: any = q.latest.get(key)
        if (!latest || latest.status !== "ACTIVE") {
          return failure(
            "ROTATED_SUCCESSOR_NOT_ACTIVE",
            `lifecycle preflight reported rotated=true for '${key}' but the latest row is ` +
              (latest ? `generation ${latest.generation} with status '${latest.status}'` : "missing") +
              ", not ACTIVE; refusing to prompt an uncommitted successor",
            { session_key: key, lifecycle_preflight: res },
          )
        }
        sessionID = latest.opencode_session_id
        generation = latest.generation
        reused = false // the successor was created by the rotation, not reused
      }
    }

    try {
      const out = await promptAndExtract(sessionID, text)
      // same touch semantics as before: the row is touched when an assistant
      // message was reached (OK / NO_ASSISTANT_TEXT), not on NO_ASSISTANT_RESULT
      // (after a rotation this touches the SUCCESSOR row)
      if (out.code !== "NO_ASSISTANT_RESULT") q.touch.run(nowIso(), key, generation)
      // additive fields ONLY when a seam is wired; absent seam => absent fields
      const lifecycleFields = preflight ? { lifecycle_preflight: preflight, lifecycle_rotated: rotated } : {}
      if (out.code === "OK") {
        return {
          ok: true,
          status: "OK",
          session_key: key,
          session_id: sessionID,
          generation,
          reused_session: reused,
          result: out.text,
          ...lifecycleFields,
        }
      }
      if (out.code === "NO_ASSISTANT_TEXT") {
        return {
          ok: false,
          status: "NO_ASSISTANT_TEXT",
          session_key: key,
          session_id: sessionID,
          generation,
          result: null,
          detail: out.detail,
          ...lifecycleFields,
        }
      }
      return {
        ok: false,
        status: "NO_ASSISTANT_RESULT",
        session_key: key,
        session_id: sessionID,
        generation,
        result: null,
        ...lifecycleFields,
      }
    } catch (e: any) {
      return failure("SEND_FAILED", errMsg(e), {
        session_id: sessionID,
        generation,
        ...(preflight ? { lifecycle_preflight: preflight, lifecycle_rotated: rotated } : {}),
      })
    }
  }

  // --- core: list / get / archive (plan §26-§28) ---
  function list() {
    const g = guard()
    if (g) return g
    const rows: any[] = q.current.all()
    return {
      ok: true,
      status: "OK",
      count: rows.length,
      sessions: rows.map((r) => ({
        project: r.project_id,
        role: r.role,
        session_id: r.opencode_session_id,
        generation: r.generation,
        agent: r.agent_id,
        model: r.model_runtime_id,
        status: r.status,
        last_used_at: r.last_used_at,
        session_key: r.session_key,
      })),
    }
  }

  function get(projectId: any, role: any) {
    const g = guard()
    if (g) return g
    if (typeof role !== "string" || !ROLE_KEYS[role]) {
      return failure("ROLE_NOT_SUPPORTED", "role must be one of: project-main, project-reader")
    }
    if (typeof projectId !== "string" || !projectId) return failure("INVALID_INPUT", "project_id is required")
    const key = sessionKey(projectId, role)
    const row: any = q.latest.get(key)
    if (!row) return { ok: false, status: "NOT_FOUND", session_key: key, project_id: projectId, role }
    // registry read only; never triggers a model request
    return {
      ok: true,
      status: row.status,
      session_key: row.session_key,
      session_id: row.opencode_session_id,
      project_id: row.project_id,
      role: row.role,
      generation: row.generation,
      agent_id: row.agent_id,
      model_runtime_id: row.model_runtime_id,
      project_path: row.project_path,
      checkpoint_path: row.checkpoint_path,
      created_at: row.created_at,
      last_used_at: row.last_used_at,
      replaced_by: row.replaced_by,
    }
  }

  function archive(projectId: any, role: any) {
    const g = guard()
    if (g) return g
    if (typeof role !== "string" || !ROLE_KEYS[role]) {
      return failure("ROLE_NOT_SUPPORTED", "role must be one of: project-main, project-reader")
    }
    if (typeof projectId !== "string" || !projectId) return failure("INVALID_INPUT", "project_id is required")
    const key = sessionKey(projectId, role)
    const row: any = q.latest.get(key)
    if (!row) return { ok: false, status: "NOT_FOUND", session_key: key, project_id: projectId, role }
    if (row.status === "ARCHIVED") {
      return {
        ok: true,
        status: "ALREADY_ARCHIVED",
        session_key: key,
        session_id: row.opencode_session_id,
        generation: row.generation,
      }
    }
    // plan §28: mark ARCHIVED only; the OpenCode session is intentionally NOT deleted.
    q.markStatus.run("ARCHIVED", nowIso(), key, row.generation)
    return {
      ok: true,
      status: "ARCHIVED",
      session_key: key,
      session_id: row.opencode_session_id,
      generation: row.generation,
      opencode_session_deleted: false,
      note: "OpenCode session kept for manual inspection; the next runtime_session_ensure creates generation + 1",
    }
  }

  // =====================================================================
  // Plan 7 §45-§49: generic scoped session API (additive; the existing
  // project-main/project-reader surface above is untouched).
  //
  // - Scoped keys (e.g. `workflow:<id>:planner`,
  //   `workflow:<id>:project:<pid>:feature-executor[:node:<node_id>]`) are stored VERBATIM as
  //   ordinary sessions.session_key values — same table, same composite
  //   primary key (session_key, generation), same replaced_by chain. No
  //   ALTER, no new table.
  // - runtime_id is ALWAYS explicit (§47): ensureScopedSession refuses to
  //   create a session when it is null/missing (MODEL_UNASSIGNED) or cannot
  //   be parsed (RUNTIME_ID_UNPARSEABLE). It never resolves a model from
  //   agents.yaml/projects.yaml and never guesses.
  // - sendScopedSession NEVER auto-creates: without a latest ACTIVE row it
  //   returns SCOPED_SESSION_NOT_FOUND; creation must go through
  //   ensureScopedSession with an explicit runtime_id.
  // - archiveScopedSession marks the latest ACTIVE row ARCHIVED and does NOT
  //   delete the OpenCode session (§49: keep it for audit).
  // - Workflow / reviewer / retry semantics are NOT implemented here; this
  //   is plain session plumbing for the future Workflow Engine.
  // =====================================================================

  async function ensureScopedSession(input: any) {
    const g = guard()
    if (g) return g
    const key = input?.session_key
    if (typeof key !== "string" || !key.trim()) {
      return failure("INVALID_INPUT", "session_key is required (non-empty string, stored verbatim)")
    }
    const projectId = input?.project_id
    if (typeof projectId !== "string" || !projectId) return failure("INVALID_INPUT", "project_id is required")
    const role = input?.role
    if (typeof role !== "string" || !role) return failure("INVALID_INPUT", "role is required")
    // serialize per session_key against concurrent ensure/send/archive
    return withLock(key, () =>
      ensureScopedLocked(key, projectId, role, input?.runtime_id, input?.scope_context, input?.title),
    )
  }

  async function ensureScopedLocked(
    key: string,
    projectId: string,
    role: string,
    runtimeId: any,
    scopeContext: any,
    title: any,
  ) {
    // reuse the latest ACTIVE generation when its OpenCode session still exists
    const latest: any = q.latest.get(key)
    if (latest && latest.status === "ACTIVE") {
      let alive = true
      try {
        await ctx.session.get({ sessionID: latest.opencode_session_id })
      } catch {
        alive = false
      }
      if (alive) {
        q.touch.run(nowIso(), key, latest.generation)
        return rowToResult({ ...latest, last_used_at: nowIso() }, true)
      }
      // registry row exists but the OpenCode session is gone -> STALE, generation + 1
      q.markStatus.run("STALE", nowIso(), key, latest.generation)
    }

    // §47: explicit runtime_id only — refuse before creating anything
    if (typeof runtimeId !== "string" || !runtimeId.trim()) {
      return {
        ok: false,
        status: "MODEL_UNASSIGNED",
        code: "MODEL_UNASSIGNED",
        session_key: key,
        project_id: projectId,
        role,
        session_created: false,
        detail:
          "runtime_id is required for scoped sessions and was null/missing; " +
          "refusing to create a session, resolve a model from config, inherit or guess one (§47)",
      }
    }
    const model = parseRuntimeId(runtimeId)
    if (!model) {
      return failure("RUNTIME_ID_UNPARSEABLE", `cannot parse runtime_id '${runtimeId}'`, {
        session_key: key,
        project_id: projectId,
        role,
        session_created: false,
      })
    }

    // best-effort project_path for the NOT NULL column; a scoped key may
    // reference a project that is fine, but config problems must never block
    // session creation (nothing is guessed from config either)
    let projectPath = ""
    try {
      const cfg = loadConfig()
      const project = findProject(cfg, projectId)
      if (project && typeof project.path === "string") projectPath = project.path
    } catch {}

    const prevGeneration = latest ? (latest.generation as number) : 0
    const generation = prevGeneration + 1 // fresh keys start at generation 1
    const sessionTitle =
      typeof title === "string" && title.trim() ? title : `[scoped] ${role} ${projectId}`
    let sessionID: string
    try {
      // session location stays at the framework root; scope arrives via the
      // synthetic scope_context message below (same pattern as ensure())
      const info: any = await ctx.session.create({ title: sessionTitle })
      sessionID = info?.id ?? info?.sessionID
      if (!sessionID) throw new Error("session create returned no id")
    } catch (e: any) {
      return failure("SESSION_CREATE_FAILED", errMsg(e), { session_key: key })
    }

    try {
      await ctx.session.switchAgent({ sessionID, agent: role })
      const modelRef: any = { providerID: model.providerID, id: model.id }
      if (model.variant) modelRef.variant = model.variant
      await ctx.session.switchModel({ sessionID, model: modelRef })
      if (typeof scopeContext === "string" && scopeContext.trim()) {
        // caller-supplied scope text (PROJECT_ID / PROJECT_PATH / WORKFLOW_ID
        // / TARGET_ROLE ...); injected verbatim, nothing is added or guessed
        await ctx.session.synthetic({ sessionID, text: scopeContext })
      }
    } catch (e: any) {
      return failure("SESSION_INIT_FAILED", `${errMsg(e)} (session ${sessionID} was created but initialization failed)`, {
        session_id: sessionID,
        session_key: key,
      })
    }

    const ts = nowIso()
    q.insert.run(key, projectId, role, sessionID, generation, role, runtimeId, projectPath, "ACTIVE", null, ts, ts, null)
    if (latest) q.linkReplaced.run(sessionID, ts, key, prevGeneration)

    return {
      ok: true,
      status: "ACTIVE",
      session_key: key,
      session_id: sessionID,
      project_id: projectId,
      role,
      generation,
      reused: false,
      agent_id: role,
      model_runtime_id: runtimeId,
      project_path: projectPath,
      created_at: ts,
      last_used_at: ts,
    }
  }

  async function sendScopedSession(input: any) {
    const g = guard()
    if (g) return g
    const key = input?.session_key
    if (typeof key !== "string" || !key.trim()) {
      return failure("INVALID_INPUT", "session_key is required (non-empty string)")
    }
    const text = input?.text
    if (typeof text !== "string" || !text.trim()) return failure("INVALID_INPUT", "text is required")
    return withLock(key, async () => {
      const latest: any = q.latest.get(key)
      if (!latest || latest.status !== "ACTIVE") {
        // NEVER auto-create here: creation must be an explicit
        // ensureScopedSession call carrying a runtime_id (§47)
        return {
          ok: false,
          status: "SCOPED_SESSION_NOT_FOUND",
          code: "SCOPED_SESSION_NOT_FOUND",
          session_key: key,
          detail: latest
            ? `latest generation ${latest.generation} of session_key '${key}' is ${latest.status}, not ACTIVE; ` +
              "call ensureScopedSession with an explicit runtime_id to create a new generation"
            : `no session row exists for session_key '${key}'; call ensureScopedSession with an explicit ` +
              "runtime_id first (sendScopedSession never auto-creates)",
        }
      }
      const sessionID = latest.opencode_session_id
      const generation = latest.generation
      try {
        const out = await promptAndExtract(sessionID, text)
        q.touch.run(nowIso(), key, generation)
        if (out.code === "OK") {
          return {
            ok: true,
            status: "OK",
            session_key: key,
            session_id: sessionID,
            generation,
            output_text: out.text,
          }
        }
        return {
          ok: false,
          status: out.code,
          code: out.code,
          session_key: key,
          session_id: sessionID,
          generation,
          output_text: null,
          ...(out.detail ? { detail: out.detail } : {}),
        }
      } catch (e: any) {
        return failure("SEND_FAILED", errMsg(e), { session_key: key, session_id: sessionID, generation })
      }
    })
  }

  function archiveScopedSession(input: any) {
    const g = guard()
    if (g) return g
    const key = input?.session_key
    if (typeof key !== "string" || !key.trim()) {
      return failure("INVALID_INPUT", "session_key is required (non-empty string)")
    }
    const row: any = q.latest.get(key)
    if (!row || row.status !== "ACTIVE") {
      return {
        ok: false,
        status: "SCOPED_SESSION_NOT_FOUND",
        code: "SCOPED_SESSION_NOT_FOUND",
        session_key: key,
        detail: row
          ? `latest generation ${row.generation} of session_key '${key}' is ${row.status}, not ACTIVE`
          : `no session row exists for session_key '${key}'`,
      }
    }
    // §49: mark ARCHIVED only; the OpenCode session is intentionally NOT
    // deleted so the workflow stays auditable.
    q.markStatus.run("ARCHIVED", nowIso(), key, row.generation)
    return {
      ok: true,
      status: "ARCHIVED",
      session_key: key,
      session_id: row.opencode_session_id,
      project_id: row.project_id,
      role: row.role,
      generation: row.generation,
      opencode_session_deleted: false,
      note: "OpenCode session kept for audit (§49); the scoped registry row is ARCHIVED",
    }
  }

  // --- process-global per-session_key serialization ---
  // All separately-created runtime cores (runtime/task/workflow/lifecycle
  // plugins) must share the same lock chain so a rotation cannot race a send.
  function withLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    return globalWithLock(key, fn)
  }

  // --- teardown: close the SQLite handle (same as the Plan 5 setup cleanup) ---
  function close() {
    try {
      db?.close()
    } catch {}
  }

  return {
    root,
    db,
    dbError,
    configReady,
    // Plan 8 T3 (additive diagnostics): what the schema init/migration did
    // during THIS core construction (columns actually added here, whether the
    // lifecycle schema was applied). Existing fields/tools are unchanged.
    schemaMigration,
    ensure,
    send,
    list,
    get,
    archive,
    // Plan 7 §47 (additive): generic scoped session API. Same `sessions`
    // table, same mechanisms; explicit runtime_id mandatory; no workflow /
    // reviewer / retry logic here.
    ensureScopedSession,
    sendScopedSession,
    archiveScopedSession,
    // Plan 8 T6 (additive): optional lifecycle preflight seam for the
    // persistent project-main/project-reader send() path. Unset => behavior
    // and result shapes are identical to Plan 5-7. The wired callback runs
    // under the caller-held global session_key lock and MUST be lock-free
    // (see LifecyclePreflightFn contract above). No lifecycle-core import
    // here — plugin setup wires the callback once both cores exist.
    setLifecyclePreflight,
    getLifecyclePreflight,
    parseRuntimeId,
    loadConfig,
    // Plan 6 Phase 3 (additive, no behavior change): expose the internal
    // config lookup helpers so the Task Bus plugin resolves projects and
    // persistent-role models with EXACTLY the same semantics as ensure().
    findProject,
    resolveRoleModel,
    sessionKey,
    withLock,
    close,
  }
}
