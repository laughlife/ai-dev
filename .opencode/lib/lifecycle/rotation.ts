// Lifecycle Rotation — session generation rotation mechanism (Plan 8 C3).
//
// Scope of this module (C3): the MECHANISM of rotating one session generation
// into its successor against the committed lifecycle_rotations schema
// (.opencode/plugins/lifecycle-engine/schema.sql, Plan 8 T3):
//
//   lifecycle_rotations(rotation_id, session_key, from_generation,
//     from_session_id, to_generation, checkpoint_path, successor_session_id,
//     status PREPARING/SUCCESSOR_CREATED/INITIALIZED/COMMITTED/FAILED,
//     error, created_at, updated_at)
//
// POLICY (60/70/80 threshold bands, when to rotate) is NOT implemented here —
// it lives in framework-config/lifecycle.yaml and is evaluated by the facade
// (lifecycle core / lifecycle-engine plugin). This engine rotates when it is
// asked to rotate, and it records the verified telemetry it observed.
//
// Strict order of operations (rotateSessionLocked):
//   0. preconditions under the session_key lock (caller/facade supplies the
//      lock-safe primitive; default is the process-global lock)
//   1. refresh verified telemetry        (record-only, never estimated)
//   2. ensure a fresh checkpoint         (forced; rotation without checkpoint
//                                         is refused)
//   3. INSERT lifecycle_rotations row    status = PREPARING (checkpoint_path
//                                         already known at this point)
//   4. create the successor OpenCode session
//   5. persist successor_session_id + status = SUCCESSOR_CREATED BEFORE any
//      further await (crash-recovery anchor for reconcile.ts)
//   6. switchAgent -> switchModel -> base scope synthetic -> restore/handoff
//      synthetic
//   7. status = INITIALIZED
//   8. ONE transaction (BEGIN IMMEDIATE ... COMMIT):
//        INSERT sessions (session_key, generation+1, ACTIVE, checkpoint_path)
//        -> old generation ARCHIVED + replaced_by + checkpoint_path
//        -> rotation status = COMMITTED
//        -> ROTATION_COMMITTED lifecycle_events row
//      (no double ACTIVE: verified inside the transaction)
//   9. success result.
//
// Failure semantics:
// - ANY failure after step 3 marks the rotation row FAILED (with the error
//   detail) and leaves the OLD generation ACTIVE and serviceable
//   (sessions.status of the old row is never changed before the commit
//   transaction; only lifecycle_state flips ROTATING -> ROTATION_FAILED).
// - Neither the OLD nor a partially initialized SUCCESSOR OpenCode session is
//   EVER deleted (audit; mirrors Plan 5 §28 / Plan 7 §49 semantics).
// - The successor is created for the SAME session_key at generation+1 — a
//   second successor is never created while a rotation is incomplete
//   (ROTATION_IN_PROGRESS precondition; reconcile.ts resolves leftovers).
//
// Structural contracts (facade wiring):
// The telemetry and checkpoint APIs are INJECTED, not imported: at the time
// this module was written no telemetry/checkpoint module was committed. The
// injected signatures below are structurally compatible with the
// lifecycle-core public surface (createLifecycleCore in
// .opencode/lib/lifecycle-core.ts), so the facade can pass
// `lifecycleCore.refreshTelemetry` and `lifecycleCore.ensureCheckpointLocked`
// directly — see TelemetryRefreshFn / CheckpointEnsureLockedFn below and the
// C3 delivery report for the expected contract.
//
// Locking: rotateSession acquires the per-session_key lock via
// options.withLock (default: globalWithLock from ../global-lock.ts — the same
// process-global lock the runtime core's withLock delegates to, so a rotation
// can never interrupt a running prompt/send on the key). The lock is
// NON-REENTRANT: callers already inside the lock must use
// rotateSessionLocked, and the injected checkpoint API MUST be the lock-free
// "*Locked" variant (ensureCheckpointLocked), never the lock-acquiring
// wrapper — passing the wrapper DEADLOCKS the key.
//
// Dependencies: only committed/shared modules — bun:sqlite via the runtime
// core's existing db handle (this module never opens its own database, never
// ships a schema file, never ALTERs a table), ../global-lock.ts and
// ../runtime-registry-core.ts (parseRuntimeId + config semantics via the
// injected runtimeCore: loadConfig / findProject / resolveRoleModel /
// sessionKey).

import * as fs from "node:fs"
import * as path from "node:path"
import { globalWithLock } from "../global-lock.ts"
import { parseRuntimeId } from "../runtime-registry-core.ts"

// =====================================================================
// Vocabulary (kept identical to the Plan 8 T3/T4 committed vocabulary:
// lifecycle_rotations.status from schema.sql, lifecycle_state labels and
// lifecycle_events.event_type values from lifecycle-core.ts)
// =====================================================================

export const ROTATION_STATUSES = [
  "PREPARING",
  "SUCCESSOR_CREATED",
  "INITIALIZED",
  "COMMITTED",
  "FAILED",
] as const

export function isTerminalRotationStatus(status: unknown): boolean {
  return status === "COMMITTED" || status === "FAILED"
}

// Event types this engine (and reconcile.ts) writes into lifecycle_events.
// TELEMETRY_SAMPLE / CHECKPOINT_* / SESSION_RESTORED belong to the
// telemetry/checkpoint/restore modules and are never written here.
export const ROTATION_EVENT_TYPES = [
  "ROTATION_STARTED",
  "ROTATION_COMMITTED",
  "ROTATION_FAILED",
  "ROTATION_RECONCILED",
] as const

// sessions.lifecycle_state labels touched by rotation/reconcile (subset of
// the Plan 8 vocabulary; sessions.status keeps its separate Plan 5
// ACTIVE/ARCHIVED/STALE semantics and is only changed by the commit
// transaction / reconcile roll-forward).
export const ROTATION_LIFECYCLE_STATES = {
  rotating: "ROTATING",
  handoffReady: "HANDOFF_READY",
  archived: "ARCHIVED",
  rotationFailed: "ROTATION_FAILED",
  stale: "STALE",
} as const

// Boundaries (mirror lifecycle-core constants so both implementations write
// identically shaped ledger data).
const ROTATION_ERROR_MAX_CHARS = 2000 // lifecycle_rotations.error is detail, not a transcript
const EVENT_DETAILS_MAX_CHARS = 20000
const RESTORE_TEXT_MAX_CHARS = 24000

// =====================================================================
// Structural contracts (facade / dependency injection)
// =====================================================================

// Lock-safe primitive supplied by the caller/facade. Signature-compatible
// with globalWithLock (../global-lock.ts) and with runtimeCore.withLock
// (which delegates to it since Plan 8 T4). FIFO per key, NON-REENTRANT.
export type LockPrimitive = <T>(key: string, fn: () => Promise<T> | T) => Promise<T>

// Verified telemetry refresh — EXPECTED CONTRACT (structural; satisfied 1:1
// by lifecycle-core `refreshTelemetry`):
//   input:  { session_key: string }  (verbatim registry key)
//   result: { ok, status: TELEMETRY_REFRESHED|TELEMETRY_PARTIAL|
//             TELEMETRY_UNAVAILABLE, context_tokens, context_limit,
//             context_pct, telemetry_source, telemetry_at, stored, detail }
//   - LOCK-FREE (safe inside the session_key lock), single-row sessions
//     UPDATE of the verified columns + one TELEMETRY_SAMPLE ledger event.
//   - NEVER estimates: nulls when no exact measurement exists
//     (docs/runtime-context-telemetry.md §7).
// Rotation treats this as RECORD-ONLY: a refresh failure never aborts a
// rotation by itself (the forced checkpoint step independently refuses to
// fabricate context numbers).
export interface TelemetrySampleResult {
  ok: boolean
  status?: string
  code?: string
  detail?: string | null
  context_tokens?: number | null
  context_limit?: number | null
  context_pct?: number | null
  telemetry_source?: string | null
  telemetry_at?: string | null
  stored?: boolean
}
export type TelemetryRefreshFn = (input: { session_key: string }) => Promise<TelemetrySampleResult>

// Checkpoint ensure — EXPECTED CONTRACT (structural; satisfied 1:1 by
// lifecycle-core `ensureCheckpointLocked`):
//   (key, { force: true, row }) -> { ok, status: CHECKPOINT_WRITTEN|
//     CHECKPOINT_REUSED, checkpoint_path (framework-root-relative POSIX),
//     ... } | { ok: false, status: "ERROR", code, detail }
//   - MUST be the LOCK-FREE "*Locked" variant: the caller already holds
//     globalWithLock(key); the lock-acquiring wrapper DEADLOCKS (the lock is
//     non-reentrant).
//   - force=true: a rotation always writes a FRESH checkpoint reflecting the
//     context at rotation time.
//   - Writes a templates/checkpoint.schema.json v1 instance under
//     runtime/checkpoints/ atomically and refuses (never fabricates) when
//     verified telemetry is unavailable.
export interface CheckpointEnsureResult {
  ok: boolean
  status?: string
  code?: string
  detail?: string | null
  checkpoint_path?: string
  [k: string]: unknown
}
export type CheckpointEnsureLockedFn = (
  key: string,
  opts: { force: boolean; row?: any },
) => Promise<CheckpointEnsureResult>

// Optional event-recorder override; the default writer INSERTs directly into
// lifecycle_events (committed T3 schema, append-only).
export interface LifecycleEventEntry {
  session_key: string
  generation: number | null
  opencode_session_id: string | null
  event_type: string
  context_pct: number | null
  checkpoint_path: string | null
  details?: Record<string, unknown> | null
}
export type EventRecorder = (entry: LifecycleEventEntry) => void

export interface BaseSyntheticInfo {
  session_key: string
  project_id: string
  project_path: string
  role: string
  generation: number
}
export interface RestoreSyntheticInfo {
  session_key: string
  generation: number
  rotation_id: string
  predecessor_session_id: string | null
  checkpoint_path: string
  checkpoint_path_absolute: string
  checkpoint: any | null // parsed checkpoint file content (null when unreadable)
  checkpoint_read_error: string | null
}

export interface RotationCoreOptions {
  // lock-safe primitive (default: globalWithLock)
  withLock?: LockPrimitive
  // structural telemetry/checkpoint APIs (see contracts above)
  refreshTelemetry?: TelemetryRefreshFn
  ensureCheckpointLocked?: CheckpointEnsureLockedFn
  // Recheck policy against the just-refreshed exact sample BEFORE any
  // checkpoint/ledger/successor work. The facade reads lifecycle.yaml fresh.
  verifyRotationDue?: (key: string, pct: number | null) => { ok: boolean; code?: string; detail?: string }
  // optional overrides (defaults built in, see below)
  recordEvent?: EventRecorder
  buildBaseSynthetic?: (info: BaseSyntheticInfo) => string
  buildRestoreText?: (info: RestoreSyntheticInfo) => string
  readCheckpoint?: (checkpointPath: string) => any
  root?: string // framework root override (default runtimeCore.root)
}

export interface RotationInput {
  session_key?: string
  project_id?: string
  role?: string
  reason?: string
  // optimistic guards (optional): refuse when the latest ACTIVE generation
  // does not match what the caller believes it is rotating
  from_generation?: number
  from_session_id?: string
}

// =====================================================================
// Small shared helpers (exported for reconcile.ts — the two C3 modules
// share ONE storage factory and ONE ledger writer)
// =====================================================================

export function nowIso(): string {
  return new Date().toISOString()
}

export function errMsg(e: any): string {
  return e?.message ?? String(e)
}

export function failure(code: string, detail: string, extra?: Record<string, unknown>) {
  return { ok: false, status: "ERROR", code, detail, ...(extra ?? {}) }
}

export function uid(prefix: string): string {
  const c: any = (globalThis as any).crypto
  if (typeof c?.randomUUID === "function") return `${prefix}-${c.randomUUID()}`
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function num(v: any): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

// Accepts { session_key } (stored verbatim — project or scoped keys) or the
// managed-role shorthand { project_id, role } resolved through the runtime
// core's own sessionKey() so both engines agree on the key format.
export function resolveSessionKey(runtimeCore: any, input: any): string | null {
  if (typeof input?.session_key === "string" && input.session_key.trim()) return input.session_key.trim()
  const pid = input?.project_id
  const role = input?.role
  if (typeof pid === "string" && pid && typeof role === "string" && role && typeof runtimeCore?.sessionKey === "function") {
    try {
      const k = runtimeCore.sessionKey(pid, role)
      if (typeof k === "string" && k) return k
    } catch {}
  }
  return null
}

// Best-effort OpenCode session liveness probe (ctx.session.get). False when
// unverifiable — callers must treat "cannot verify" as "not alive".
export async function probeSessionAlive(ctx: any, sessionID: string | null): Promise<boolean> {
  if (typeof sessionID !== "string" || !sessionID) return false
  if (typeof ctx?.session?.get !== "function") return false
  try {
    await ctx.session.get({ sessionID })
    return true
  } catch {
    return false
  }
}

// =====================================================================
// Shared storage factory (committed T3 schema ONLY — no DDL, no ALTER)
// =====================================================================

export interface LifecycleStorage {
  db: any
  // sessions
  latest: any
  rowByGen: any
  activeCount: any
  insertSession: any
  setLifecycleState: any
  archiveOldGeneration: any
  // lifecycle_rotations
  rotInsert: any
  rotGet: any
  rotIncomplete: any
  rotIncompleteForKey: any
  rotSetStatus: any
  rotSetSuccessor: any
  rotFail: any
  // lifecycle_events
  insertEvent: any
  // readiness probes
  lifecycleTablesReady: boolean
  telemetryColumnsReady: boolean
}

export function createLifecycleStorage(db: any): LifecycleStorage | null {
  if (!db) return null
  function prep(sql: string): any {
    try {
      return db.query(sql)
    } catch {
      return null
    }
  }
  function tableExists(name: string): boolean {
    try {
      return !!db
        .query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
        .get(name)
    } catch {
      return false
    }
  }
  let sessionsCols = new Set<string>()
  try {
    sessionsCols = new Set(
      (db.prepare("PRAGMA table_info(sessions)").all() as any[]).map((c: any) => String(c?.name)),
    )
  } catch {}

  const st: LifecycleStorage = {
    db,
    latest: prep("SELECT * FROM sessions WHERE session_key = ? ORDER BY generation DESC LIMIT 1"),
    rowByGen: prep("SELECT * FROM sessions WHERE session_key = ? AND generation = ?"),
    activeCount: prep("SELECT COUNT(*) AS n FROM sessions WHERE session_key = ? AND status = 'ACTIVE'"),
    insertSession: prep(
      "INSERT INTO sessions (session_key, project_id, role, opencode_session_id, generation, " +
        "agent_id, model_runtime_id, project_path, status, checkpoint_path, created_at, last_used_at, replaced_by) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    setLifecycleState: prep("UPDATE sessions SET lifecycle_state = ? WHERE session_key = ? AND generation = ?"),
    // rotation-specific archive: status + lifecycle_state + replaced_by +
    // checkpoint_path in ONE statement, conditional on the old row still
    // being ACTIVE (checked again inside the commit transaction)
    archiveOldGeneration: prep(
      "UPDATE sessions SET status = 'ARCHIVED', lifecycle_state = 'ARCHIVED', " +
        "replaced_by = COALESCE(replaced_by, ?), checkpoint_path = COALESCE(?, checkpoint_path), last_used_at = ? " +
        "WHERE session_key = ? AND generation = ? AND status = 'ACTIVE'",
    ),
    // committed lifecycle_rotations schema column order, verbatim
    rotInsert: prep(
      "INSERT INTO lifecycle_rotations (rotation_id, session_key, from_generation, from_session_id, " +
        "to_generation, checkpoint_path, successor_session_id, status, error, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    rotGet: prep("SELECT * FROM lifecycle_rotations WHERE rotation_id = ?"),
    rotIncomplete: prep(
      "SELECT * FROM lifecycle_rotations WHERE status IN ('PREPARING','SUCCESSOR_CREATED','INITIALIZED') " +
        "ORDER BY created_at ASC, rowid ASC",
    ),
    rotIncompleteForKey: prep(
      "SELECT * FROM lifecycle_rotations WHERE session_key = ? " +
        "AND status IN ('PREPARING','SUCCESSOR_CREATED','INITIALIZED') ORDER BY created_at ASC, rowid ASC",
    ),
    rotSetStatus: prep("UPDATE lifecycle_rotations SET status = ?, updated_at = ? WHERE rotation_id = ?"),
    rotSetSuccessor: prep(
      "UPDATE lifecycle_rotations SET successor_session_id = ?, status = ?, updated_at = ? WHERE rotation_id = ?",
    ),
    rotFail: prep("UPDATE lifecycle_rotations SET status = 'FAILED', error = ?, updated_at = ? WHERE rotation_id = ?"),
    insertEvent: prep(
      "INSERT INTO lifecycle_events (event_id, session_key, generation, opencode_session_id, " +
        "event_type, context_pct, checkpoint_path, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    lifecycleTablesReady: tableExists("lifecycle_events") && tableExists("lifecycle_rotations"),
    telemetryColumnsReady: [
      "context_tokens",
      "context_limit",
      "context_pct",
      "telemetry_source",
      "telemetry_at",
      "lifecycle_state",
    ].every((c) => sessionsCols.has(c)),
  }
  return st
}

// Storage guard — same failure codes as lifecycle-core so the facade sees one
// consistent vocabulary.
export function guardStorage(st: LifecycleStorage | null, dbError: string | null) {
  const required = st
    ? [
        "latest",
        "rowByGen",
        "activeCount",
        "insertSession",
        "setLifecycleState",
        "archiveOldGeneration",
        "rotInsert",
        "rotGet",
        "rotIncomplete",
        "rotIncompleteForKey",
        "rotSetStatus",
        "rotSetSuccessor",
        "rotFail",
        "insertEvent",
      ]
    : []
  if (!st || required.some((k) => !(st as any)[k])) {
    return failure("SQLITE_RUNTIME_UNAVAILABLE", dbError ?? "registry database unavailable")
  }
  if (!st.lifecycleTablesReady) {
    return failure(
      "LIFECYCLE_SCHEMA_UNAVAILABLE",
      "lifecycle_events / lifecycle_rotations are missing in runtime/tasks.db " +
        "(apply .opencode/plugins/lifecycle-engine/schema.sql via the shared runtime core first — Plan 8 T3)",
    )
  }
  if (!st.telemetryColumnsReady) {
    return failure(
      "SESSIONS_V2_COLUMNS_MISSING",
      "sessions telemetry/lifecycle columns are missing (expected registry schema v2 — Plan 8 T3 migration)",
    )
  }
  return null
}

// Append-only ledger writer (best-effort: an event insert failure must never
// abort a rotation phase — the lifecycle_rotations row is the authority).
// When called INSIDE the commit transaction the insert participates in it
// (atomic audit); errors are still swallowed there by design.
export function appendEvent(
  st: LifecycleStorage | null,
  recordEvent: EventRecorder | undefined,
  entry: LifecycleEventEntry,
): void {
  try {
    if (recordEvent) {
      recordEvent(entry)
      return
    }
    if (!st?.insertEvent) return
    let detailsJson: string | null = null
    if (entry.details) {
      detailsJson = JSON.stringify(entry.details)
      if (detailsJson.length > EVENT_DETAILS_MAX_CHARS) detailsJson = detailsJson.slice(0, EVENT_DETAILS_MAX_CHARS)
    }
    st.insertEvent.run(
      uid("evt"),
      entry.session_key,
      entry.generation ?? null,
      entry.opencode_session_id ?? null,
      entry.event_type,
      num(entry.context_pct),
      entry.checkpoint_path ?? null,
      detailsJson,
      nowIso(),
    )
  } catch (e: any) {
    console.warn(`[lifecycle/rotation] event insert failed (${entry.event_type}): ${errMsg(e)}`)
  }
}

// =====================================================================
// Factory
// =====================================================================

export function createRotationCore(ctx: any, runtimeCore: any, options?: RotationCoreOptions) {
  const root: string =
    typeof options?.root === "string" && options.root
      ? options.root
      : typeof runtimeCore?.root === "string" && runtimeCore.root
        ? runtimeCore.root
        : (ctx?.location?.directory ?? process.cwd())
  const db: any = runtimeCore?.db ?? null
  const dbError: string | null = runtimeCore?.dbError ?? null
  const st = createLifecycleStorage(db)
  const withLock: LockPrimitive = typeof options?.withLock === "function" ? options.withLock : globalWithLock

  const diagnostics = {
    root,
    db_ready: !!db,
    db_error: dbError,
    lifecycle_tables_ready: !!st?.lifecycleTablesReady,
    telemetry_columns_ready: !!st?.telemetryColumnsReady,
    telemetry_api_wired: typeof options?.refreshTelemetry === "function",
    checkpoint_api_wired: typeof options?.ensureCheckpointLocked === "function",
    lock: typeof options?.withLock === "function" ? "injected" : "globalWithLock",
  }

  function guard() {
    return guardStorage(st, dbError)
  }

  function absCheckpointPath(stored: string): string {
    return path.isAbsolute(stored) ? stored : path.join(root, stored)
  }

  // --- successor model resolution (existing runtimeCore config semantics) ---
  // Managed roles (project-main / project-reader): resolve FRESH from
  // framework-config via the runtime core's own resolveRoleModel (the same
  // source ensure() uses — agents.yaml project_sessions.<pid>.model.runtime_id
  // / agents[project-reader].model.runtime_id). Fall back to the value
  // recorded on the row being rotated (recorded at creation — reuse is not
  // guessing). Scoped keys: the recorded row value only (§47: scoped sessions
  // never resolve from config). Null result -> MODEL_UNASSIGNED refusal;
  // a model is NEVER guessed or invented.
  function resolveSuccessorRuntimeId(key: string, row: any): { runtimeId: string | null; source: string | null } {
    const managed = row?.role === "project-main" || row?.role === "project-reader"
    const keyMatchesManagedForm =
      managed && typeof runtimeCore?.sessionKey === "function" &&
      (() => {
        try {
          return runtimeCore.sessionKey(row.project_id, row.role) === key
        } catch {
          return false
        }
      })()
    if (
      keyMatchesManagedForm &&
      typeof runtimeCore?.loadConfig === "function" &&
      typeof runtimeCore?.resolveRoleModel === "function"
    ) {
      try {
        const cfg = runtimeCore.loadConfig()
        const rid = runtimeCore.resolveRoleModel(cfg, row.project_id, row.role)
        if (typeof rid === "string" && rid) return { runtimeId: rid, source: "framework-config" }
      } catch {}
    }
    if (typeof row?.model_runtime_id === "string" && row.model_runtime_id) {
      return { runtimeId: row.model_runtime_id, source: "registry-row" }
    }
    return { runtimeId: null, source: null }
  }

  // --- successor title (same convention as the registry core / lifecycle core) ---
  function successorTitle(key: string, row: any, generation: number): string {
    if (key.startsWith("project:")) return `[runtime] ${row.project_id} ${row.role} gen${generation}`
    return `[scoped] ${row.role} ${row.project_id} gen${generation}`
  }

  // --- default base synthetic scope context ---
  // Mirrors the Plan 5 runtime-registry initial scope context semantics for
  // the managed roles (same rules the ORIGINAL generation was created with);
  // scoped keys get a minimal verbatim scope header (their full scope_context
  // belonged to the original ensureScopedSession call and is not re-invented
  // here — the restore/handoff message carries the continuity).
  function defaultBaseSynthetic(info: BaseSyntheticInfo): string {
    if (info.role === "project-main") {
      return [
        `PROJECT_ID: ${info.project_id}`,
        `PROJECT_PATH: ${info.project_path}`,
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
        "(Synthetic scope context written by the Plan 8 lifecycle rotation engine; mirrors the runtime-registry Plan 5 initial scope context.)",
      ].join("\n")
    }
    if (info.role === "project-reader") {
      return [
        `PROJECT_ID: ${info.project_id}`,
        `PROJECT_PATH: ${info.project_path}`,
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
        "(Synthetic scope context written by the Plan 8 lifecycle rotation engine; mirrors the runtime-registry Plan 5 initial scope context.)",
      ].join("\n")
    }
    return [
      `PROJECT_ID: ${info.project_id}`,
      `PROJECT_PATH: ${info.project_path}`,
      `ROLE: ${info.role}`,
      `SESSION_KEY: ${info.session_key}`,
      `GENERATION: ${info.generation}`,
      "",
      "(Synthetic scope context written by the Plan 8 lifecycle rotation engine for a scoped session key; the original scope_context of this key is not re-invented — see the ROTATION_HANDOFF message that follows.)",
    ].join("\n")
  }

  function readCheckpointFile(checkpointPath: string): { checkpoint: any | null; error: string | null } {
    try {
      if (typeof options?.readCheckpoint === "function") {
        return { checkpoint: options.readCheckpoint(checkpointPath), error: null }
      }
      const abs = absCheckpointPath(String(checkpointPath))
      return { checkpoint: JSON.parse(fs.readFileSync(abs, "utf8")), error: null }
    } catch (e: any) {
      return { checkpoint: null, error: errMsg(e) }
    }
  }

  // --- default restore/handoff synthetic text (bounded; refs + summary from
  // the checkpoint FILE only — never a transcript, never fabricated state) ---
  function defaultRestoreText(info: RestoreSyntheticInfo): string {
    const cp = info.checkpoint
    const lines: string[] = [
      "ROTATION_HANDOFF (Plan 8 lifecycle rotation engine — generated, not user input)",
      "",
      `ROTATION_ID: ${info.rotation_id}`,
      `SESSION_KEY: ${info.session_key}`,
      `GENERATION: ${info.generation}`,
      `PREDECESSOR_SESSION: ${info.predecessor_session_id ?? "none"}`,
      `CHECKPOINT_FILE: ${info.checkpoint_path_absolute}`,
    ]
    if (cp && typeof cp === "object") {
      lines.push(
        `CONTEXT_AT_CHECKPOINT: tokens=${cp?.context?.tokens ?? "?"} limit=${cp?.context?.limit ?? "?"} pct=${cp?.context?.percent ?? "?"} source=${cp?.context?.source ?? "?"}`,
        `ACTIVE_TASK_IDS: ${cp?.runtime_state?.active_task_ids?.length ? cp.runtime_state.active_task_ids.join(", ") : "none"}`,
        `ACTIVE_WORKFLOW_IDS: ${cp?.runtime_state?.active_workflow_ids?.length ? cp.runtime_state.active_workflow_ids.join(", ") : "none"}`,
        `GIT: repo=${cp?.git_state?.repository ?? "?"} branch=${cp?.git_state?.branch ?? "?"} head=${cp?.git_state?.head ?? "?"} dirty_files=${cp?.git_state?.status_short?.length ?? 0}`,
        `PROJECT_DOCS: ${cp?.restore_refs?.project_docs?.length ? cp.restore_refs.project_docs.join(", ") : "none"}`,
        `MEM0: ${cp?.restore_refs?.mem0?.length ? cp.restore_refs.mem0.join("; ") : "search manually before continuing long-term work"}`,
        `SUMMARY_SOURCE: ${cp?.summary_source ?? "?"}`,
        "",
        "SUMMARY:",
        String(cp?.summary ?? ""),
      )
    } else {
      lines.push(
        `CHECKPOINT_READ_ERROR: ${info.checkpoint_read_error ?? "unknown"} (the checkpoint file above is the authoritative restore state; read it manually)`,
      )
    }
    lines.push(
      "",
      "Restore procedure: read the CHECKPOINT_FILE JSON for the full structured state, resume the ACTIVE tasks/workflows above,",
      "consult the listed project docs and (manually) Mem0. This message is a bounded handoff — never a full transcript.",
    )
    return lines.join("\n").slice(0, RESTORE_TEXT_MAX_CHARS)
  }

  // --- FAILED-path helper: rotation row FAILED, old generation stays ACTIVE
  // (sessions.status untouched), lifecycle_state ROTATING -> ROTATION_FAILED,
  // ledger event. NEVER deletes any OpenCode session. ---
  function failRotation(
    rotationId: string,
    key: string,
    row: any,
    code: string,
    detail: string,
    extra?: { phase?: string; successor_session_id?: string | null; checkpoint_path?: string | null; context_pct?: number | null },
  ) {
    try {
      st!.rotFail.run(`${code}: ${detail}`.slice(0, ROTATION_ERROR_MAX_CHARS), nowIso(), rotationId)
    } catch {}
    try {
      const cur: any = st!.rowByGen.get(key, row.generation)
      if (cur && cur.status === "ACTIVE" && cur.lifecycle_state === ROTATION_LIFECYCLE_STATES.rotating) {
        st!.setLifecycleState.run(ROTATION_LIFECYCLE_STATES.rotationFailed, key, row.generation)
      }
    } catch {}
    appendEvent(st, options?.recordEvent, {
      session_key: key,
      generation: row.generation,
      opencode_session_id: row.opencode_session_id,
      event_type: "ROTATION_FAILED",
      context_pct: num(extra?.context_pct ?? row.context_pct),
      checkpoint_path: extra?.checkpoint_path ?? null,
      details: {
        rotation_id: rotationId,
        code,
        detail,
        phase: extra?.phase ?? null,
        successor_session_id: extra?.successor_session_id ?? null,
        note: extra?.successor_session_id
          ? "successor OpenCode session (when present) is kept for audit and NEVER deleted; the old generation stays ACTIVE"
          : "the old generation stays ACTIVE; no OpenCode session is deleted",
      },
    })
  }

  function failedResult(
    key: string,
    rotationId: string | null,
    row: any,
    code: string,
    detail: string,
    extra?: Record<string, unknown>,
  ) {
    return {
      ok: false,
      status: "ROTATION_FAILED",
      code,
      detail,
      session_key: key,
      rotation_id: rotationId,
      from_generation: row?.generation ?? null,
      from_session_id: row?.opencode_session_id ?? null,
      old_session_status: "ACTIVE",
      opencode_session_deleted: false,
      ...(extra ?? {}),
    }
  }

  // ===================================================================
  // Commit transaction (step 8) — ONE BEGIN IMMEDIATE ... COMMIT covering:
  // successor sessions row (generation+1, ACTIVE, checkpoint_path) + old row
  // ARCHIVED/replaced_by/checkpoint_path + rotation COMMITTED + ledger event.
  // All invariants are RE-VERIFIED inside the write transaction (the process
  // lock does not cover other OS processes; SQLite BEGIN IMMEDIATE does).
  // ===================================================================
  function commitRotationTransaction(params: {
    key: string
    rotationId: string
    row: any // old (from) row as read under the lock
    toGeneration: number
    successorId: string
    runtimeId: string
    checkpointPath: string
    contextPct: number | null
    reason: string
  }): { ok: true } | { ok: false; code: string; detail: string } {
    const { key, rotationId, row, toGeneration, successorId, runtimeId, checkpointPath, contextPct, reason } = params
    const dbx = st!.db
    dbx.exec("BEGIN IMMEDIATE")
    try {
      const rot: any = st!.rotGet.get(rotationId)
      if (!rot || isTerminalRotationStatus(rot.status)) {
        throw new Error(`rotation ${rotationId} is no longer in progress (status ${rot?.status ?? "missing"})`)
      }
      if (rot.successor_session_id !== successorId) {
        throw new Error(
          `rotation ledger successor (${rot.successor_session_id ?? "none"}) does not match the created successor ${successorId}`,
        )
      }
      const from: any = st!.rowByGen.get(key, row.generation)
      if (!from || from.status !== "ACTIVE") {
        throw new Error(
          `generation ${row.generation} of '${key}' is ${from ? from.status : "missing"}, not ACTIVE — refusing to commit over a changed registry`,
        )
      }
      if (st!.rowByGen.get(key, toGeneration)) {
        throw new Error(`sessions (${key}, ${toGeneration}) appeared during rotation (concurrent writer)`)
      }
      const before: any = st!.activeCount.get(key)
      if (Number(before?.n ?? 0) !== 1) {
        throw new Error(`expected exactly 1 ACTIVE generation for '${key}' before commit, found ${before?.n ?? 0}`)
      }

      const ts = nowIso()
      st!.insertSession.run(
        key,
        from.project_id,
        from.role,
        successorId,
        toGeneration,
        from.agent_id ?? from.role,
        runtimeId,
        typeof from.project_path === "string" ? from.project_path : "",
        "ACTIVE",
        null,
        ts,
        ts,
        null,
      )
      st!.setLifecycleState.run(ROTATION_LIFECYCLE_STATES.handoffReady, key, toGeneration)
      const archived: any = st!.archiveOldGeneration.run(successorId, checkpointPath, ts, key, from.generation)
      if (Number(archived?.changes ?? 0) !== 1) {
        throw new Error(`old generation ${from.generation} was not archived (conditional update matched ${archived?.changes ?? 0} rows)`)
      }
      // no-double-ACTIVE invariant, enforced INSIDE the transaction
      const after: any = st!.activeCount.get(key)
      if (Number(after?.n ?? 0) !== 1) {
        throw new Error(`commit would leave ${after?.n ?? 0} ACTIVE generations for '${key}' (exactly 1 required)`)
      }
      const committed: any = st!.rotSetStatus.run("COMMITTED", ts, rotationId)
      if (Number(committed?.changes ?? 0) !== 1) {
        throw new Error(`rotation ${rotationId} status update to COMMITTED matched ${committed?.changes ?? 0} rows`)
      }
      // atomic audit: the COMMITTED event participates in the same transaction
      appendEvent(st, options?.recordEvent, {
        session_key: key,
        generation: toGeneration,
        opencode_session_id: successorId,
        event_type: "ROTATION_COMMITTED",
        context_pct,
        checkpoint_path: checkpointPath,
        details: {
          rotation_id: rotationId,
          from_generation: from.generation,
          from_session_id: from.opencode_session_id,
          reason,
          committed_via: "rotation",
          old_row: { status: "ARCHIVED", replaced_by: successorId, checkpoint_path: checkpointPath },
          successor_row: { status: "ACTIVE", lifecycle_state: ROTATION_LIFECYCLE_STATES.handoffReady },
        },
      })
      dbx.exec("COMMIT")
      return { ok: true }
    } catch (e: any) {
      try {
        dbx.exec("ROLLBACK")
      } catch {}
      return { ok: false, code: "ROTATION_COMMIT_FAILED", detail: errMsg(e) }
    }
  }

  // ===================================================================
  // rotateSessionLocked — LOCK-FREE rotation core.
  // Callers MUST already hold the session_key lock (rotateSession does;
  // a facade may call this directly when it already holds the lock).
  // ===================================================================
  async function rotateSessionLocked(key: string, input?: RotationInput) {
    const g = guard()
    if (g) return g

    // --- 0) preconditions (nothing is written before all of them pass) ---
    const row0: any = st!.latest.get(key)
    if (!row0) return failure("SESSION_NOT_FOUND", `no sessions row exists for session_key '${key}'`)
    if (row0.status !== "ACTIVE") {
      return failure(
        "ROTATION_NOT_ACTIVE",
        `latest generation ${row0.generation} of '${key}' has status '${row0.status}', not ACTIVE; ` +
          "rotation only replaces ACTIVE generations",
        { session_key: key, generation: row0.generation },
      )
    }
    if (input?.from_generation != null && Number(input.from_generation) !== Number(row0.generation)) {
      return failure(
        "ROTATION_STATE_CONFLICT",
        `caller expects from_generation ${input.from_generation} but the latest ACTIVE generation is ${row0.generation}`,
        { session_key: key, generation: row0.generation },
      )
    }
    if (typeof input?.from_session_id === "string" && input.from_session_id && input.from_session_id !== row0.opencode_session_id) {
      return failure(
        "ROTATION_STATE_CONFLICT",
        `caller expects from_session_id '${input.from_session_id}' but the latest ACTIVE generation runs '${row0.opencode_session_id}'`,
        { session_key: key, generation: row0.generation },
      )
    }
    const activeNow: any = st!.activeCount.get(key)
    if (Number(activeNow?.n ?? 0) !== 1) {
      return failure(
        "ROTATION_STATE_CONFLICT",
        `expected exactly 1 ACTIVE generation for '${key}' before rotating, found ${activeNow?.n ?? 0}; ` +
          "fix the registry (or run reconcile) first — a rotation must never produce a double ACTIVE",
        { session_key: key },
      )
    }
    // hard guard against double successors: an unfinished rotation for this
    // key MUST be reconciled first (crash leftovers included)
    const inFlight = st!.rotIncompleteForKey.all(key) as any[]
    if (inFlight.length > 0) {
      return failure(
        "ROTATION_IN_PROGRESS",
        `rotation ${inFlight[0].rotation_id} for '${key}' is still ${inFlight[0].status}; ` +
          "run reconcileRotations first — a second successor is never created",
        { session_key: key, rotation_id: inFlight[0].rotation_id, rotation_status: inFlight[0].status },
      )
    }
    const toGeneration = Number(row0.generation) + 1
    if (st!.rowByGen.get(key, toGeneration)) {
      return failure(
        "ROTATION_STATE_CONFLICT",
        `sessions row (${key}, generation ${toGeneration}) already exists; run reconcileRotations to resolve the ledger first`,
        { session_key: key, to_generation: toGeneration },
      )
    }
    const resolved = resolveSuccessorRuntimeId(key, row0)
    if (!resolved.runtimeId) {
      return failure(
        "MODEL_UNASSIGNED",
        "neither framework-config nor the rotated row carries a model_runtime_id; refusing to rotate without a model (never guessed, never inherited)",
        { session_key: key, generation: row0.generation },
      )
    }
    const model = parseRuntimeId(resolved.runtimeId)
    if (!model) {
      return failure("RUNTIME_ID_UNPARSEABLE", `cannot parse runtime_id '${resolved.runtimeId}'`, {
        session_key: key,
        generation: row0.generation,
      })
    }
    if (typeof options?.ensureCheckpointLocked !== "function") {
      return failure(
        "CHECKPOINT_API_UNAVAILABLE",
        "no ensureCheckpointLocked API is wired into the rotation engine; refusing to rotate without a checkpoint " +
          "(the facade must inject the LOCK-FREE checkpoint primitive — see the C3 contract notes in rotation.ts)",
        { session_key: key },
      )
    }

    let row: any = row0
    const reason = typeof input?.reason === "string" && input.reason.trim() ? input.reason.trim() : "manual"

    // --- 1) refresh verified telemetry (record-only; never gates rotation
    // here — threshold policy belongs to the facade/lifecycle core) ---
    let contextPct: number | null = num(row.context_pct)
    let telemetryNote: string | null = null
    let telemetryRefreshed = false
    if (typeof options?.refreshTelemetry === "function") {
      try {
        const r: any = await options.refreshTelemetry({ session_key: key })
        if (r?.ok) {
          telemetryRefreshed = true
          // A new unavailable measurement invalidates stale admission data;
          // do not fall back to the last stored pre-compaction percentage.
          contextPct = num(r.context_pct)
          if (r.status !== "TELEMETRY_REFRESHED") telemetryNote = r.detail ?? `telemetry status ${r.status}`
          row = st!.latest.get(key) ?? row // pick up freshly stored telemetry columns
        } else {
          telemetryNote = `telemetry refresh reported ${r?.code ?? r?.status ?? "failure"}: ${r?.detail ?? "no detail"}`
        }
      } catch (e: any) {
        telemetryNote = `telemetry refresh threw: ${errMsg(e)}`
      }
    } else {
      telemetryNote = "no telemetry API wired; using the last stored verified sample (never estimated)"
    }

    if (input?.force !== true) {
      if (contextPct == null) {
        return failure("ROTATION_TELEMETRY_UNAVAILABLE", "no fresh verified context_pct; refusing automatic rotation", { session_key: key })
      }
      if (typeof options?.verifyRotationDue !== "function") {
        return failure("ROTATION_POLICY_UNAVAILABLE", "fresh threshold policy callback is required for non-forced rotation", { session_key: key })
      }
      const due = options.verifyRotationDue(key, contextPct)
      if (!due.ok) {
        return failure(due.code ?? "ROTATION_NOT_DUE", due.detail ?? "fresh context has fallen below the configured rotation band", {
          session_key: key, context_pct: contextPct,
        })
      }
    }

    // --- 2) ensure a FRESH checkpoint (forced). Failure here aborts BEFORE
    // any lifecycle_rotations row is written; the old row stays untouched. ---
    const cp: any = await options.ensureCheckpointLocked(key, { force: true, row })
    if (!cp?.ok || typeof cp.checkpoint_path !== "string" || !cp.checkpoint_path) {
      return failure(
        "ROTATION_CHECKPOINT_FAILED",
        `checkpoint ensure failed: ${cp?.detail ?? `status ${cp?.status ?? cp?.code ?? "unknown"}`} ` +
          "(a rotation without a checkpoint is refused; nothing was written to lifecycle_rotations)",
        { session_key: key, generation: row.generation, code: cp?.code ?? null },
      )
    }
    if (input?.force !== true && typeof options?.verifyRotationDue === "function") {
      const checkpointPct = num(cp.context_pct)
      const dueAtCheckpoint = options.verifyRotationDue(key, checkpointPct)
      if (!dueAtCheckpoint.ok) {
        return failure(dueAtCheckpoint.code ?? "ROTATION_NOT_DUE", dueAtCheckpoint.detail ?? "context fell below the rotation band at checkpoint time", {
          session_key: key, context_pct: checkpointPct, checkpoint_path: cp.checkpoint_path,
        })
      }
      contextPct = checkpointPct
    }

    // --- 3) INSERT the rotation ledger row: PREPARING (checkpoint_path is
    // already known — the checkpoint precedes the ledger row by design) ---
    const rotationId = uid("rot")
    const ts0 = nowIso()
    try {
      st!.rotInsert.run(
        rotationId,
        key,
        row.generation,
        row.opencode_session_id,
        toGeneration,
        cp.checkpoint_path,
        null,
        "PREPARING",
        null,
        ts0,
        ts0,
      )
    } catch (e: any) {
      return failure("ROTATION_LEDGER_WRITE_FAILED", `cannot insert the PREPARING rotation row: ${errMsg(e)}`, {
        session_key: key,
        rotation_id: rotationId,
      })
    }
    st!.setLifecycleState.run(ROTATION_LIFECYCLE_STATES.rotating, key, row.generation) // sessions.status stays ACTIVE
    appendEvent(st, options?.recordEvent, {
      session_key: key,
      generation: row.generation,
      opencode_session_id: row.opencode_session_id,
      event_type: "ROTATION_STARTED",
      context_pct: contextPct,
      checkpoint_path: cp.checkpoint_path,
      details: {
        rotation_id: rotationId,
        reason,
        to_generation: toGeneration,
        model_runtime_id: resolved.runtimeId,
        model_runtime_id_source: resolved.source,
        telemetry: { refreshed: telemetryRefreshed, context_pct: contextPct, note: telemetryNote },
      },
    })

    // --- 4) create the successor OpenCode session (same runtimeCore session
    // creation semantics as ensure(): create at the framework root, scope via
    // synthetic messages) ---
    let successorId: string
    try {
      const info: any = await ctx.session.create({ title: successorTitle(key, row, toGeneration) })
      successorId = info?.id ?? info?.sessionID
      if (!successorId) throw new Error("session create returned no id")
    } catch (e: any) {
      failRotation(rotationId, key, row, "SESSION_CREATE_FAILED", errMsg(e), {
        phase: "CREATE",
        checkpoint_path: cp.checkpoint_path,
        context_pct: contextPct,
      })
      return failedResult(key, rotationId, row, "SESSION_CREATE_FAILED", errMsg(e), {
        checkpoint_path: cp.checkpoint_path,
      })
    }

    // --- 5) persist successor_session_id + SUCCESSOR_CREATED BEFORE any
    // further await: this synchronous ledger write is the crash-recovery
    // anchor reconcile.ts relies on. If it fails, the successor is an
    // unrecorded orphan — fail safely; it is NEVER deleted. ---
    try {
      const persisted: any = st!.rotSetSuccessor.run(successorId, "SUCCESSOR_CREATED", nowIso(), rotationId)
      if (Number(persisted?.changes ?? 0) !== 1) {
        throw new Error(`successor persist matched ${persisted?.changes ?? 0} rotation rows`)
      }
    } catch (e: any) {
      failRotation(rotationId, key, row, "ROTATION_LEDGER_WRITE_FAILED", `cannot persist the successor id: ${errMsg(e)}`, {
        phase: "SUCCESSOR_PERSIST",
        successor_session_id: successorId,
        checkpoint_path: cp.checkpoint_path,
        context_pct: contextPct,
      })
      return failedResult(key, rotationId, row, "ROTATION_LEDGER_WRITE_FAILED", errMsg(e), {
        successor_session_id: successorId,
        checkpoint_path: cp.checkpoint_path,
        note: `successor OpenCode session ${successorId} exists but is NOT registered; kept for audit, never deleted`,
      })
    }

    // --- 6) switchAgent -> switchModel -> base scope synthetic -> restore
    // synthetic (base + restore, in this order) ---
    try {
      await ctx.session.switchAgent({ sessionID: successorId, agent: row.agent_id ?? row.role })
      const modelRef: any = { providerID: model.providerID, id: model.id }
      if (model.variant) modelRef.variant = model.variant
      await ctx.session.switchModel({ sessionID: successorId, model: modelRef })
      const baseText =
        typeof options?.buildBaseSynthetic === "function"
          ? options.buildBaseSynthetic({
              session_key: key,
              project_id: row.project_id,
              project_path: typeof row.project_path === "string" ? row.project_path : "",
              role: row.role,
              generation: toGeneration,
            })
          : defaultBaseSynthetic({
              session_key: key,
              project_id: row.project_id,
              project_path: typeof row.project_path === "string" ? row.project_path : "",
              role: row.role,
              generation: toGeneration,
            })
      await ctx.session.synthetic({ sessionID: successorId, text: baseText })
      const cpView = readCheckpointFile(cp.checkpoint_path)
      const restoreText =
        typeof options?.buildRestoreText === "function"
          ? options.buildRestoreText({
              session_key: key,
              generation: toGeneration,
              rotation_id: rotationId,
              predecessor_session_id: row.opencode_session_id,
              checkpoint_path: cp.checkpoint_path,
              checkpoint_path_absolute: absCheckpointPath(cp.checkpoint_path),
              checkpoint: cpView.checkpoint,
              checkpoint_read_error: cpView.error,
            })
          : defaultRestoreText({
              session_key: key,
              generation: toGeneration,
              rotation_id: rotationId,
              predecessor_session_id: row.opencode_session_id,
              checkpoint_path: cp.checkpoint_path,
              checkpoint_path_absolute: absCheckpointPath(cp.checkpoint_path),
              checkpoint: cpView.checkpoint,
              checkpoint_read_error: cpView.error,
            })
      await ctx.session.synthetic({ sessionID: successorId, text: restoreText })
    } catch (e: any) {
      failRotation(rotationId, key, row, "SESSION_INIT_FAILED", `${errMsg(e)} (successor ${successorId} was created but initialization failed)`, {
        phase: "INIT",
        successor_session_id: successorId,
        checkpoint_path: cp.checkpoint_path,
        context_pct: contextPct,
      })
      return failedResult(key, rotationId, row, "SESSION_INIT_FAILED", errMsg(e), {
        successor_session_id: successorId,
        checkpoint_path: cp.checkpoint_path,
        note: `successor OpenCode session ${successorId} exists but is NOT registered; kept for audit, never deleted`,
      })
    }

    // --- 7) INITIALIZED ---
    try {
      st!.rotSetStatus.run("INITIALIZED", nowIso(), rotationId)
    } catch (e: any) {
      failRotation(rotationId, key, row, "ROTATION_LEDGER_WRITE_FAILED", `cannot mark INITIALIZED: ${errMsg(e)}`, {
        phase: "INITIALIZED",
        successor_session_id: successorId,
        checkpoint_path: cp.checkpoint_path,
        context_pct: contextPct,
      })
      return failedResult(key, rotationId, row, "ROTATION_LEDGER_WRITE_FAILED", errMsg(e), {
        successor_session_id: successorId,
        checkpoint_path: cp.checkpoint_path,
      })
    }

    // --- 8) commit transaction: generation+1 ACTIVE -> old ARCHIVED /
    // replaced_by / checkpoint_path -> rotation COMMITTED -> event ---
    const commit = commitRotationTransaction({
      key,
      rotationId,
      row,
      toGeneration,
      successorId,
      runtimeId: resolved.runtimeId!,
      checkpointPath: cp.checkpoint_path,
      contextPct,
      reason,
    })
    if (!commit.ok) {
      failRotation(rotationId, key, row, commit.code, commit.detail, {
        phase: "COMMIT",
        successor_session_id: successorId,
        checkpoint_path: cp.checkpoint_path,
        context_pct: contextPct,
      })
      return failedResult(key, rotationId, row, commit.code, `${commit.detail} (successor ${successorId} initialized but registration failed; reconcileRotations will settle the ledger)`, {
        successor_session_id: successorId,
        checkpoint_path: cp.checkpoint_path,
      })
    }

    // --- 9) success ---
    return {
      ok: true,
      status: "ROTATED",
      session_key: key,
      rotation_id: rotationId,
      from_generation: row.generation,
      to_generation: toGeneration,
      from_session_id: row.opencode_session_id,
      successor_session_id: successorId,
      checkpoint_path: cp.checkpoint_path,
      context_pct: contextPct,
      telemetry_refreshed: telemetryRefreshed,
      telemetry_note: telemetryNote,
      model_runtime_id: resolved.runtimeId,
      model_runtime_id_source: resolved.source,
      reason,
      opencode_session_deleted: false,
      old_row: {
        status: "ARCHIVED",
        lifecycle_state: ROTATION_LIFECYCLE_STATES.archived,
        replaced_by: successorId,
        checkpoint_path: cp.checkpoint_path,
      },
      successor_row: {
        status: "ACTIVE",
        lifecycle_state: ROTATION_LIFECYCLE_STATES.handoffReady,
        checkpoint_path: null,
      },
    }
  }

  // Public rotate: acquires the per-session_key lock (default: the process
  // global lock shared with runtimeCore.withLock), then runs the lock-free
  // core. The lock is NON-REENTRANT — callers already inside the lock must
  // call rotateSessionLocked directly.
  async function rotateSession(input: any) {
    const g = guard()
    if (g) return g
    const key = resolveSessionKey(runtimeCore, input)
    if (!key) return failure("INVALID_INPUT", "session_key or project_id+role is required")
    return withLock(key, () => rotateSessionLocked(key, input))
  }

  return {
    root,
    diagnostics,
    rotateSession, // acquires the session_key lock
    rotateSessionLocked, // LOCK-FREE — caller must hold the lock
  }
}
