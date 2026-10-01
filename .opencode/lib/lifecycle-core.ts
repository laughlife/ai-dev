// Lifecycle Core — verified telemetry, threshold evaluation, checkpoint,
// rotation, restore and reconciliation (Plan 8 T4).
//
// Shared implementation for the future lifecycle-engine plugin, following the
// Plan 6/7 shared-core pattern (createTaskBusCore / createRuntimeRegistryCore):
// createLifecycleCore(ctx, runtimeCore, options?) returns an object of
// structured-result methods; no SDK import; YAML via Bun.YAML.parse; SQLite
// via the runtime core's EXISTING db handle (this core never opens its own
// database, never ships a schema file and never ALTERs a table — the storage
// is exactly the Plan 8 T3 schema: sessions v2 columns +
// lifecycle_events / lifecycle_rotations).
//
// Authority boundaries:
// - Architecture source of truth: diagrams/multi_agent_framework_v4_completion_guard.drawio
// - Telemetry protocol (normative): docs/runtime-context-telemetry.md
//   (VERIFIED on OpenCode 2.0.20): context usage = the LATEST assistant
//   message that carries `tokens`, summed input+output+reasoning+
//   cache.read+cache.write; limit = Model.Info.limit.context from
//   ctx.model.list() for THAT message's { providerID, id }; percent =
//   Math.round(tokens/limit*100); null when usage or catalog is missing.
//   NO chars/4, NO local tokenizer, NO cumulative session totals, NO
//   model-name window tables (approximation_allowed: false).
// - Thresholds: framework-config/lifecycle.yaml, read FRESH on every
//   evaluation — the 60/70/80 bands are never hardcoded here.
// - Checkpoint contract: templates/checkpoint.schema.json (v1). Instances are
//   runtime state under runtime/checkpoints/<sanitized-session-key>/
//   gen-XXXX-<checkpoint-id>.json, written atomically (tmp + fsync + rename).
// - Locking: rotation/restore/checkpoint/reconcile run under the PROCESS-
//   GLOBAL per-session_key lock (.opencode/lib/global-lock.ts) which the
//   runtime core's withLock now shares — a rotation can therefore never
//   interrupt a running prompt/send on the same key. The lock is
//   NON-REENTRANT: every public method that acquires it has a lock-free
//   "*Locked" counterpart for callers already inside the lock.
//
// Plan 8 lifecycle_state vocabulary (sessions.lifecycle_state; kept strictly
// separate from the Plan 5 sessions.status column, which keeps its own
// ACTIVE/ARCHIVED/STALE semantics):
//   ACTIVE / CHECKPOINT_READY / ROTATE_PENDING / HARD_ROTATE / ROTATING /
//   ARCHIVED / STALE / ROTATION_FAILED / HANDOFF_READY
//
// Explicitly NOT implemented in T4 (later plugin-integration tasks):
// - automatic enablement: no hooks, no tools, no event subscriptions are
//   registered here; nothing runs unless a caller invokes a method
//   (framework.yaml automatic_rotation stays false; the lifecycle-agent
//   profile is untouched). rotateSession(force) is the MANUAL force-rotation
//   API; rotation without force requires the stored telemetry to be at or
//   above rotate_after_atomic_step_at_percent.
// - Mem0 is NEVER called: checkpoints carry mem0 restore REFERENCES only.
// - Git access is strictly read-only (rev-parse branch/HEAD, status
//   --porcelain); business repositories are never modified.
// - No new tables, no schema changes, no writes outside runtime/.
//
// Runtime facts: Bun 1.4.2, bun:sqlite, Bun.YAML.parse, node:fs, node:path.

import * as fs from "node:fs"
import * as path from "node:path"
import { globalWithLock } from "./global-lock.ts"
import { parseRuntimeId } from "./runtime-registry-core.ts"
import { extractContextMessages } from "./session-context.ts"
import { createRotationCore } from "./lifecycle/rotation.ts"
import { createReconcileCore } from "./lifecycle/reconcile.ts"
import { parseThresholds, classifyLifecycleState } from "./lifecycle/state-machine.ts"

// --- Plan 8 vocabulary (exported for the future plugin/tools & tests) ---
export const LIFECYCLE_STATES = [
  "ACTIVE",
  "CHECKPOINT_READY",
  "ROTATE_PENDING",
  "HARD_ROTATE",
  "ROTATING",
  "ARCHIVED",
  "STALE",
  "ROTATION_FAILED",
  "HANDOFF_READY",
] as const

// lifecycle_rotations.status vocabulary (T3 schema comment):
export const ROTATION_STATUSES = [
  "PREPARING",
  "SUCCESSOR_CREATED",
  "INITIALIZED",
  "COMMITTED",
  "FAILED",
] as const
const ROTATION_TERMINAL = new Set<string>(["COMMITTED", "FAILED"])

// lifecycle_events.event_type vocabulary defined by this engine (the T3
// schema deliberately does not constrain it):
export const LIFECYCLE_EVENT_TYPES = [
  "TELEMETRY_SAMPLE",
  "LIFECYCLE_STATE_CHANGED",
  "CHECKPOINT_WRITTEN",
  "CHECKPOINT_REUSED",
  "ROTATION_STARTED",
  "ROTATION_COMMITTED",
  "ROTATION_FAILED",
  "ROTATION_RECONCILED",
  "SESSION_RESTORED",
  "SESSION_RESTORE_FAILED",
] as const

// Band labels that evaluateThreshold may overwrite in sessions.lifecycle_state.
// Transitional/terminal states (ROTATING, ARCHIVED, STALE, ROTATION_FAILED,
// HANDOFF_READY) are owned exclusively by the rotation/restore flows and are
// never clobbered by a threshold evaluation.
const BAND_WRITABLE_STATES = new Set<string>(["ACTIVE", "CHECKPOINT_READY", "ROTATE_PENDING", "HARD_ROTATE"])

// tasks/workflows statuses treated as non-terminal when collecting active
// refs for a checkpoint (Task Bus Plan 6 / Workflow Engine Plan 7 states).
const TERMINAL_TASK_STATUSES = "'COMPLETED','FAILED','CANCELLED'"

// docs/runtime-context-telemetry.md is the measurement protocol; the source
// descriptor is recorded verbatim into sessions.telemetry_source /
// lifecycle_events.details_json so every stored number stays traceable.
const TELEMETRY_SOURCE_DESCRIPTOR =
  "ctx.session.context last-assistant tokens + ctx.model.list limit.context (docs/runtime-context-telemetry.md)"

// checkpoint.schema.json caps summary at 20000 chars; the synthetic
// handoff/restore message gets a slightly larger budget (checkpoint summary
// + structured refs), still bounded — never a full transcript dump.
const SUMMARY_MAX_CHARS = 20000
const HANDOFF_TEXT_MAX_CHARS = 24000
const DIGEST_BUDGET_CHARS = 16000
const DIGEST_PER_MESSAGE_CHARS = 1200
const GIT_STATUS_MAX_LINES = 200
const EVENT_DETAILS_MAX_CHARS = 20000

export interface LifecycleThresholds {
  continue_reuse_below_percent: number
  checkpoint_from_percent: number
  checkpoint_to_percent: number
  rotate_after_atomic_step_at_percent: number
  hard_stop_new_tasks_at_percent: number
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

function uid(prefix: string): string {
  const c: any = (globalThis as any).crypto
  if (typeof c?.randomUUID === "function") return `${prefix}-${c.randomUUID()}`
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function num(v: any): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

// =====================================================================
// Pure exported helpers (usable by offline harnesses/tests without a ctx)
// =====================================================================

// Windows/filesystem-safe directory name for a session_key:
// "project:ruoyi-vue-pro:main" -> "project_ruoyi-vue-pro_main".
export function sanitizeSessionKey(key: string): string {
  return String(key).replace(/[^A-Za-z0-9._-]/g, "_")
}

// TokenUsage.Info sum per the VERIFIED UI-identical formula:
// input + output + reasoning + cache.read + cache.write (disjoint counters;
// cache.write is added even though it measured 0 across the installed DB —
// docs/runtime-context-telemetry.md §3/§3.1). Returns null when the usage
// object is absent or malformed; a partial token payload is never completed
// with guessed zeroes under the no-estimation policy.
export function sumTokenUsage(tokens: any): number | null {
  if (!tokens || typeof tokens !== "object") return null
  const values = [tokens.input, tokens.output, tokens.reasoning, tokens.cache?.read, tokens.cache?.write]
  if (values.some((v) => typeof v !== "number" || !Number.isFinite(v))) return null
  return values.reduce((sum, value) => sum + value, 0)
}

// findLast(type == "assistant" && !!tokens) — the exact UI lookup
// (docs/runtime-context-telemetry.md §3). Tolerates both flat messages and
// { info, parts } pairs. Streaming assistant messages WITHOUT tokens are
// skipped, never treated as zero.
export function extractLatestAssistantUsage(
  messages: any[],
): { tokens: number; providerID: string | null; modelID: string | null } | null {
  if (!Array.isArray(messages)) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const raw = messages[i]
    const info = raw?.info ?? raw
    if (info?.type !== "assistant" && info?.role !== "assistant") continue
    const tokens = sumTokenUsage(info?.tokens)
    if (tokens == null) continue
    const model = info?.model
    const providerID = model?.providerID ?? (typeof info?.providerID === "string" ? info.providerID : null)
    const modelID = model?.id ?? model?.modelID ?? (typeof info?.modelID === "string" ? info.modelID : null)
    return { tokens, providerID, modelID }
  }
  return null
}

// context_pct = Math.round(tokens / limit * 100); null when either side is
// missing (catalog entry absent or limit.context absent) — never guessed.
export function computeContextPercent(tokens: number | null, limit: number | null): number | null {
  if (tokens == null || limit == null) return null
  if (!Number.isFinite(tokens) || !Number.isFinite(limit) || limit <= 0) return null
  return Math.round((tokens / limit) * 100)
}

// Parse framework-config/lifecycle.yaml `context_rotation` into thresholds.
// Returns null when ANY band value is missing/non-numeric — there are no
// defaults and no hardcoded 60/70/80 anywhere in this file.
export function parseLifecycleThresholds(cfg: any): LifecycleThresholds | null {
  const parsed = parseThresholds(cfg)
  if (!parsed.ok) return null
  return {
    continue_reuse_below_percent: parsed.thresholds.continue_reuse_below_percent,
    checkpoint_from_percent: parsed.thresholds.checkpoint_prepare_from_percent,
    checkpoint_to_percent: parsed.thresholds.checkpoint_prepare_to_percent,
    rotate_after_atomic_step_at_percent: parsed.thresholds.rotate_after_atomic_step_at_percent,
    hard_stop_new_tasks_at_percent: parsed.thresholds.hard_stop_new_tasks_at_percent,
  }
}

// Map a verified context_pct onto the configured bands. Pure function of
// (pct, thresholds); the returned `state` is the Plan 8 lifecycle_state
// label for the band (null when pct is unverified — an unknown measurement
// never produces a fabricated state or action).
export function resolveLifecycleBand(
  pct: number | null,
  t: LifecycleThresholds,
): { band: string; state: string | null; recommended_action: string } {
  const classification = classifyLifecycleState(pct, {
    continue_reuse_below_percent: t.continue_reuse_below_percent,
    checkpoint_prepare_from_percent: t.checkpoint_from_percent,
    checkpoint_prepare_to_percent: t.checkpoint_to_percent,
    rotate_after_atomic_step_at_percent: t.rotate_after_atomic_step_at_percent,
    hard_stop_new_tasks_at_percent: t.hard_stop_new_tasks_at_percent,
  })
  if (classification.state === null) {
    return { band: "UNKNOWN", state: null, recommended_action: "NONE_TELEMETRY_UNAVAILABLE" }
  }
  const bandByState: Record<string, string> = {
    ACTIVE: "BELOW_CHECKPOINT_BAND",
    CHECKPOINT_READY: "CHECKPOINT_PREPARE",
    ROTATE_PENDING: "ROTATE_AFTER_ATOMIC_STEP",
    HARD_ROTATE: "HARD_STOP_NEW_TASKS",
  }
  const actionByState: Record<string, string> = {
    ACTIVE: "CONTINUE_REUSE",
    CHECKPOINT_READY: "PREPARE_CHECKPOINT",
    ROTATE_PENDING: "ROTATE_AFTER_ATOMIC_STEP",
    HARD_ROTATE: "HARD_ROTATE",
  }
  return {
    band: bandByState[classification.state] ?? "UNKNOWN",
    state: classification.state,
    recommended_action: actionByState[classification.state] ?? "NONE_TELEMETRY_UNAVAILABLE",
  }
}

// Best-effort secret scrubbing for anything derived from conversation text
// before it reaches a checkpoint summary or a synthetic handoff message.
// Belt-and-braces: the digest itself already excludes tool outputs.
const SECRET_PLAIN_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /\bghp_[A-Za-z0-9]{16,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(mysql|postgres|postgresql|mongodb|redis):\/\/\S+/gi,
]
// key/value form keeps the key name and redacts only the value
const SECRET_KV_PATTERN =
  /\b(api[_-]?key|apikey|password|passwd|pwd|secret|access[_-]?token|auth[_-]?token)(\s*[:=]\s*)\S+/gi

export function redactSecrets(text: string): string {
  let out = String(text)
  for (const re of SECRET_PLAIN_PATTERNS) out = out.replace(re, "[REDACTED]")
  out = out.replace(SECRET_KV_PATTERN, (_m: string, k: string, sep: string) => `${k}${sep}[REDACTED]`)
  return out
}

// =====================================================================
// Factory
// =====================================================================
//
// options (all optional; sensible framework-root defaults):
// - lifecycleConfigFile: default <root>/framework-config/lifecycle.yaml
//   (read FRESH on every evaluation — never cached across calls)
// - checkpointsDir: default <root>/runtime/checkpoints
export function createLifecycleCore(ctx: any, runtimeCore: any, options?: any) {
  const root: string =
    typeof runtimeCore?.root === "string" && runtimeCore.root
      ? runtimeCore.root
      : (ctx?.location?.directory ?? process.cwd())
  const db: any = runtimeCore?.db ?? null
  const dbError: string | null = runtimeCore?.dbError ?? null
  const lifecycleFile: string =
    typeof options?.lifecycleConfigFile === "string" && options.lifecycleConfigFile
      ? options.lifecycleConfigFile
      : path.join(root, "framework-config", "lifecycle.yaml")
  const checkpointsDir: string =
    typeof options?.checkpointsDir === "string" && options.checkpointsDir
      ? options.checkpointsDir
      : path.join(root, "runtime", "checkpoints")

  // --- storage readiness probes (T3 schema; this core changes no schema) ---
  function tableExists(name: string): boolean {
    if (!db) return false
    try {
      return !!db
        .query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
        .get(name)
    } catch {
      return false
    }
  }
  function sessionsColumns(): Set<string> {
    if (!db) return new Set()
    try {
      return new Set(
        (db.prepare("PRAGMA table_info(sessions)").all() as any[]).map((c: any) => String(c?.name)),
      )
    } catch {
      return new Set()
    }
  }

  function columns(name: string): Set<string> {
    if (!db) return new Set()
    try {
      return new Set((db.prepare(`PRAGMA table_info(${name})`).all() as any[]).map((c: any) => String(c?.name)))
    } catch {
      return new Set()
    }
  }

  const lifecycleEventCols = columns("lifecycle_events")
  const lifecycleRotationCols = columns("lifecycle_rotations")
  const lifecycleTablesReady =
    tableExists("lifecycle_events") &&
    tableExists("lifecycle_rotations") &&
    ["event_id", "session_key", "generation", "opencode_session_id", "event_type", "context_pct", "checkpoint_path", "details_json", "created_at"].every((c) => lifecycleEventCols.has(c)) &&
    ["rotation_id", "session_key", "from_generation", "from_session_id", "to_generation", "checkpoint_path", "successor_session_id", "status", "error", "created_at", "updated_at"].every((c) => lifecycleRotationCols.has(c))
  const sessionsCols = sessionsColumns()
  const telemetryColumnsReady = [
    "context_tokens",
    "context_limit",
    "context_pct",
    "telemetry_source",
    "telemetry_at",
    "lifecycle_state",
  ].every((c) => sessionsCols.has(c))
  const tasksTableReady = tableExists("tasks")
  const workflowsTableReady = tableExists("workflows") && tableExists("workflow_nodes")

  const diagnostics = {
    root,
    db_ready: !!db,
    db_error: dbError,
    lifecycle_tables_ready: lifecycleTablesReady,
    telemetry_columns_ready: telemetryColumnsReady,
    tasks_table_ready: tasksTableReady,
    workflows_table_ready: workflowsTableReady,
    lifecycle_config_file: lifecycleFile,
    checkpoints_dir: checkpointsDir,
  }

  // --- prepared statements (best-effort; null when storage is missing) ---
  function prep(sql: string): any {
    try {
      return db ? db.query(sql) : null
    } catch {
      return null
    }
  }

  const q = db
    ? {
        // sessions reads
        latest: prep("SELECT * FROM sessions WHERE session_key = ? ORDER BY generation DESC LIMIT 1"),
        rowByGen: prep("SELECT * FROM sessions WHERE session_key = ? AND generation = ?"),
        maxGeneration: prep("SELECT MAX(generation) AS m FROM sessions WHERE session_key = ?"),
        latestCheckpoint: prep(
          "SELECT checkpoint_path FROM sessions WHERE session_key = ? AND checkpoint_path IS NOT NULL " +
            "ORDER BY generation DESC LIMIT 1",
        ),
        currentLifecycle: prep(
          "SELECT s.* FROM sessions s " +
            "JOIN (SELECT session_key, MAX(generation) AS g FROM sessions GROUP BY session_key) m " +
            "ON s.session_key = m.session_key AND s.generation = m.g " +
            "ORDER BY s.project_id, s.role, s.generation",
        ),
        // sessions writes (Plan 8 columns only; sessions.status keeps its
        // Plan 5 semantics and is touched ONLY where rotation/restore own it)
        insertSession: prep(
          "INSERT INTO sessions (session_key, project_id, role, opencode_session_id, generation, " +
            "agent_id, model_runtime_id, project_path, status, checkpoint_path, created_at, last_used_at, replaced_by) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ),
        updateTelemetry: prep(
          "UPDATE sessions SET context_tokens = ?, context_limit = ?, context_pct = ?, " +
            "telemetry_source = ?, telemetry_at = ? WHERE session_key = ? AND generation = ?",
        ),
        setLifecycleState: prep(
          "UPDATE sessions SET lifecycle_state = ? WHERE session_key = ? AND generation = ?",
        ),
        setCheckpointPath: prep(
          "UPDATE sessions SET checkpoint_path = ? WHERE session_key = ? AND generation = ?",
        ),
        markStatus: prep(
          "UPDATE sessions SET status = ?, last_used_at = ? WHERE session_key = ? AND generation = ?",
        ),
        archiveOldGeneration: prep(
          "UPDATE sessions SET status = 'ARCHIVED', lifecycle_state = 'ARCHIVED', " +
            "replaced_by = COALESCE(replaced_by, ?), checkpoint_path = COALESCE(checkpoint_path, ?), " +
            "last_used_at = ? WHERE session_key = ? AND generation = ?",
        ),
        linkReplaced: prep(
          "UPDATE sessions SET replaced_by = ?, last_used_at = ? WHERE session_key = ? AND generation = ?",
        ),
        // lifecycle_events (append-only ledger; best-effort inserts)
        insertEvent: prep(
          "INSERT INTO lifecycle_events (event_id, session_key, generation, opencode_session_id, " +
            "event_type, context_pct, checkpoint_path, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ),
        recentEvents: prep(
          "SELECT event_id, event_type, generation, context_pct, checkpoint_path, details_json, created_at " +
            "FROM lifecycle_events WHERE session_key = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
        ),
        // lifecycle_rotations (progressive phase persistence)
        rotInsert: prep(
          "INSERT INTO lifecycle_rotations (rotation_id, session_key, from_generation, from_session_id, " +
            "to_generation, checkpoint_path, successor_session_id, status, error, created_at, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ),
        rotGet: prep("SELECT * FROM lifecycle_rotations WHERE rotation_id = ?"),
        rotLatest: prep(
          "SELECT * FROM lifecycle_rotations WHERE session_key = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
        ),
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
        rotSetCheckpoint: prep(
          "UPDATE lifecycle_rotations SET checkpoint_path = ?, updated_at = ? WHERE rotation_id = ?",
        ),
        rotFail: prep(
          "UPDATE lifecycle_rotations SET status = 'FAILED', error = ?, updated_at = ? WHERE rotation_id = ?",
        ),
        // active refs for checkpoints (tables may predate Plan 6/7 plugins)
        activeTasks: prep(
          `SELECT task_id, status FROM tasks WHERE target_session_key = ? AND status NOT IN (${TERMINAL_TASK_STATUSES}) ORDER BY created_at`,
        ),
        activeWorkflows: prep(
          `SELECT workflow_id, planner_session_id, status FROM workflows WHERE status NOT IN (${TERMINAL_TASK_STATUSES}) ORDER BY created_at`,
        ),
        nodeTaskRefs: prep(
          "SELECT current_task_id, review_task_id FROM workflow_nodes WHERE workflow_id = ?",
        ),
      }
    : null

  // --- guards / input helpers ---
  function guard() {
    if (!db || !q) return failure("SQLITE_RUNTIME_UNAVAILABLE", dbError ?? "registry database unavailable")
    if (!lifecycleTablesReady) {
      return failure(
        "LIFECYCLE_SCHEMA_UNAVAILABLE",
        "lifecycle_events / lifecycle_rotations are missing or schema-diverged in runtime/tasks.db " +
          "(apply the Plan 8 lifecycle schema via the shared runtime core; non-empty incompatible tables are refused)",
      )
    }
    if (!telemetryColumnsReady) {
      return failure(
        "SESSIONS_V2_COLUMNS_MISSING",
        "sessions telemetry/lifecycle columns are missing (expected registry schema v2 — Plan 8 T3 migration)",
      )
    }
    return null
  }

  // Accepts { session_key } (verbatim, project or scoped keys) or the
  // managed-role shorthand { project_id, role } resolved through the runtime
  // core's own sessionKey() so both engines agree on the key format.
  function resolveKey(input: any): string | null {
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

  // --- thresholds: fresh read of framework-config/lifecycle.yaml EVERY time ---
  function loadThresholds(): { ok: true; thresholds: LifecycleThresholds } | { ok: false; failure: any } {
    const B = (globalThis as any).Bun
    if (typeof B?.YAML?.parse !== "function") {
      return {
        ok: false,
        failure: failure("YAML_PARSER_UNAVAILABLE", "Bun.YAML.parse is not present in this runtime"),
      }
    }
    let raw: any
    try {
      raw = B.YAML.parse(fs.readFileSync(lifecycleFile, "utf8"))
    } catch (e: any) {
      return {
        ok: false,
        failure: failure("LIFECYCLE_CONFIG_LOAD_FAILED", `${errMsg(e)} (file: ${lifecycleFile})`),
      }
    }
    const t = parseLifecycleThresholds(raw)
    if (!t) {
      return {
        ok: false,
        failure: failure(
          "LIFECYCLE_CONFIG_INVALID",
          `framework-config/lifecycle.yaml context_rotation is incomplete or non-numeric (${lifecycleFile}); ` +
            "refusing to evaluate thresholds with defaults — no band value is hardcoded in lifecycle-core",
        ),
      }
    }
    return { ok: true, thresholds: t }
  }

  // --- append-only ledger helper (best-effort: an event insert failure must
  // never abort a rotation mid-phase; the rotation row is the authority) ---
  function insertEvent(
    sessionKey: string,
    generation: number | null,
    opencodeSessionId: string | null,
    eventType: string,
    contextPct: number | null,
    checkpointPath: string | null,
    details?: Record<string, unknown> | null,
  ) {
    if (!q?.insertEvent) return
    try {
      let detailsJson: string | null = null
      if (details) {
        detailsJson = JSON.stringify(details)
        if (detailsJson.length > EVENT_DETAILS_MAX_CHARS) detailsJson = detailsJson.slice(0, EVENT_DETAILS_MAX_CHARS)
      }
      q.insertEvent.run(
        uid("evt"),
        sessionKey,
        generation ?? null,
        opencodeSessionId ?? null,
        eventType,
        typeof contextPct === "number" && Number.isFinite(contextPct) ? contextPct : null,
        checkpointPath ?? null,
        detailsJson,
        nowIso(),
      )
    } catch (e: any) {
      console.warn(`[lifecycle-core] event insert failed (${eventType}): ${errMsg(e)}`)
    }
  }

  // ===================================================================
  // Verified context telemetry (docs/runtime-context-telemetry.md)
  // ===================================================================

  // ctx.model.list() -> Map<"providerID/id", limit.context>. Tolerates the
  // flat Model.Info array shape (documented V2 plugin API), provider-grouped
  // shapes ({ id, models }) and keyed objects. Missing entries simply never
  // resolve -> context_pct stays null (never guessed by model name).
  async function loadContextLimits(): Promise<{ map: Map<string, number>; error: string | null }> {
    const map = new Map<string, number>()
    if (typeof ctx?.model?.list !== "function") {
      return { map, error: "ctx.model.list unavailable in this runtime" }
    }
    let res: any
    try {
      res = await ctx.model.list()
    } catch (e: any) {
      return { map, error: `ctx.model.list failed: ${errMsg(e)}` }
    }
    const addModel = (providerID: any, m: any) => {
      const id = m?.id ?? m?.modelID
      const c = m?.limit?.context
      if (typeof providerID === "string" && typeof id === "string" && typeof c === "number" && Number.isFinite(c) && c > 0) {
        map.set(`${providerID}/${id}`, c)
      }
    }
    const harvest = (node: any) => {
      if (!node || typeof node !== "object") return
      if (Array.isArray(node)) {
        for (const e of node) harvest(e)
        return
      }
      const pid = node.providerID ?? node.provider_id ?? node.id
      if (node.models) {
        if (Array.isArray(node.models)) for (const m of node.models) addModel(pid, m)
        else if (typeof node.models === "object")
          for (const k of Object.keys(node.models)) addModel(typeof pid === "string" ? pid : k, node.models[k])
        return
      }
      if (typeof node.id === "string" && node.limit) addModel(pid, node)
    }
    // Desktop V2 returns the catalog in an envelope (`{ location, data }`)
    // while older/plugin fixtures may return the array directly. Walk the
    // payload itself so verified limits are resolved in both shapes without
    // weakening the no-estimation policy.
    harvest(res?.data ?? res)
    return { map, error: map.size === 0 ? "model catalog returned no usable limit.context entries" : null }
  }

  // Pure observation — NO lock, NO DB write. Returns the verified measurement
  // (or explicit nulls + reason) plus the bounded context messages so callers
  // (checkpoint summary) reuse the same fetch.
  async function measureSession(sessionID: string): Promise<{
    context_tokens: number | null
    context_limit: number | null
    context_pct: number | null
    telemetry_source: string | null
    telemetry_at: string | null
    messages: any[]
    reason: string | null
    model_key: string | null
  }> {
    const none = {
      context_tokens: null,
      context_limit: null,
      context_pct: null,
      telemetry_source: null,
      telemetry_at: null,
      messages: [] as any[],
      reason: null as string | null,
      model_key: null as string | null,
    }
    if (typeof sessionID !== "string" || !sessionID) return { ...none, reason: "session id missing" }
    if (typeof ctx?.session?.context !== "function") {
      return { ...none, reason: "ctx.session.context unavailable in this runtime" }
    }
    let contextRes: any
    try {
      contextRes = await ctx.session.context({ sessionID })
    } catch (e: any) {
      return { ...none, reason: `ctx.session.context failed: ${errMsg(e)}` }
    }
    const messages: any[] = extractContextMessages(contextRes)
    const usage = extractLatestAssistantUsage(messages)
    if (!usage) {
      return { ...none, messages, reason: "no assistant message with verified tokens found (nothing measured yet or only streaming messages)" }
    }
    const limits = await loadContextLimits()
    const modelKey = usage.providerID && usage.modelID ? `${usage.providerID}/${usage.modelID}` : null
    const limit = modelKey ? (limits.map.get(modelKey) ?? null) : null
    const pct = computeContextPercent(usage.tokens, limit)
    return {
      context_tokens: usage.tokens,
      context_limit: limit,
      context_pct: pct,
      // tokens were verified even when the catalog lookup failed; the source
      // descriptor stays accurate (limit null is recorded as null)
      telemetry_source: TELEMETRY_SOURCE_DESCRIPTOR,
      telemetry_at: nowIso(),
      messages,
      model_key: modelKey,
      reason:
        limit == null
          ? `catalog limit.context missing for model '${modelKey ?? "unknown"}'${limits.error ? ` (${limits.error})` : ""}; context_pct stays null per the no-estimation policy`
          : null,
    }
  }

  // Refresh the stored verified telemetry for ONE session generation.
  //
  // LOCK-FREE by construction (pure observation + a single-row UPDATE guarded
  // by SQLite busy_timeout): safe to call from inside a session lock (e.g.
  // rotateSession) and safe to call while a prompt is running — in-flight
  // assistant messages carry no tokens and are skipped, so the measurement
  // always reflects the latest COMPLETED assistant message.
  //
  // Null policy: when no exact measurement exists the RESULT reports nulls,
  // but previously stored verified values are NOT overwritten with nulls —
  // the columns hold the LAST verified sample (telemetry_at marks its age).
  // The unavailable observation is still recorded in the event ledger.
  async function refreshTelemetry(input: any) {
    const g = guard()
    if (g) return g
    const key = resolveKey(input)
    if (!key) return failure("INVALID_INPUT", "session_key or project_id+role is required")
    const row: any = q.latest.get(key)
    if (!row) return failure("SESSION_NOT_FOUND", `no sessions row exists for session_key '${key}'`)

    const m = await measureSession(row.opencode_session_id)
    const completeSample = m.context_tokens != null && m.context_limit != null && m.context_pct != null
    if (completeSample) {
      q.updateTelemetry.run(
        m.context_tokens,
        m.context_limit,
        m.context_pct,
        m.telemetry_source,
        m.telemetry_at,
        key,
        row.generation,
      )
    }
    insertEvent(key, row.generation, row.opencode_session_id, "TELEMETRY_SAMPLE", m.context_pct, null, {
      context_tokens: m.context_tokens,
      context_limit: m.context_limit,
      telemetry_source: m.context_tokens != null ? m.telemetry_source : null,
      model_key: m.model_key,
      reason: m.reason,
      stored: completeSample,
      observation_source: typeof input?.observation_source === "string" ? input.observation_source : null,
    })
    const measured = m.context_tokens != null
    return {
      ok: true,
      status: !measured ? "TELEMETRY_UNAVAILABLE" : !completeSample ? "TELEMETRY_PARTIAL" : "TELEMETRY_REFRESHED",
      session_key: key,
      generation: row.generation,
      session_id: row.opencode_session_id,
      context_tokens: m.context_tokens,
      context_limit: m.context_limit,
      context_pct: m.context_pct,
      telemetry_source: measured ? m.telemetry_source : null,
      telemetry_at: measured ? m.telemetry_at : null,
      stored: completeSample,
      detail: m.reason,
    } as any
  }

  // ===================================================================
  // Threshold evaluation (fresh lifecycle.yaml read; band -> state label)
  // ===================================================================

  // LOCK-FREE (reads + at most two small single-row writes). `input.refresh`
  // optionally takes a fresh verified measurement first; otherwise the last
  // stored sample is evaluated. Writes sessions.lifecycle_state ONLY when the
  // current value is null or a band label — transitional/terminal states
  // owned by rotation/restore flows are never clobbered.
  async function evaluateThreshold(input: any) {
    const g = guard()
    if (g) return g
    const key = resolveKey(input)
    if (!key) return failure("INVALID_INPUT", "session_key or project_id+role is required")
    let row: any = q.latest.get(key)
    if (!row) return failure("SESSION_NOT_FOUND", `no sessions row exists for session_key '${key}'`)

    let pct: number | null = num(input?.context_pct)
    let pctSource = pct != null ? "input.context_pct" : null
    if (pct == null && input?.refresh === true) {
      const r: any = await refreshTelemetry({ session_key: key })
      if (!r.ok) return r
      pct = num(r.context_pct)
      pctSource = pct != null ? "refreshed:ctx.session.context+ctx.model.list" : null
      row = q.latest.get(key)
    }
    // A missing FRESH sample is unknown even when a previously verified
    // sample remains stored. Never rotate on a stale pre-compaction value.
    if (pct == null && input?.refresh !== true) {
      pct = num(row?.context_pct)
      pctSource = pct != null ? "sessions.context_pct (last verified sample)" : null
    }

    const cfg = loadThresholds()
    if (!cfg.ok) return cfg.failure
    const band = resolveLifecycleBand(pct, cfg.thresholds)

    const prev = typeof row?.lifecycle_state === "string" && row.lifecycle_state ? row.lifecycle_state : null
    let stateUpdated = false
    if (band.state && (prev == null || BAND_WRITABLE_STATES.has(prev)) && prev !== band.state) {
      q.setLifecycleState.run(band.state, key, row.generation)
      stateUpdated = true
      insertEvent(key, row.generation, row.opencode_session_id, "LIFECYCLE_STATE_CHANGED", pct, null, {
        from: prev,
        to: band.state,
        band: band.band,
        thresholds: cfg.thresholds,
        context_pct_source: pctSource,
      })
    }
    return {
      ok: true,
      status: pct == null ? "TELEMETRY_UNAVAILABLE" : "OK",
      session_key: key,
      generation: row.generation,
      context_pct: pct,
      context_pct_source: pctSource,
      telemetry_at: row?.telemetry_at ?? null,
      thresholds: cfg.thresholds,
      band: band.band,
      lifecycle_state: band.state ?? prev,
      previous_lifecycle_state: prev,
      state_updated: stateUpdated,
      recommended_action: band.recommended_action,
      detail:
        pct == null
          ? "no verified context_pct available (measurement missing or catalog limit unknown); no band evaluated, nothing estimated"
          : undefined,
    }
  }

  // ===================================================================
  // Git state (strictly read-only commands only)
  // ===================================================================

  function runReadonlyGit(
    args: string[],
    cwd: string,
    timeoutMs = 10000,
  ): { ok: boolean; stdout: string; stderr: string } {
    const B = (globalThis as any).Bun
    try {
      if (typeof B?.spawnSync === "function") {
        const p = B.spawnSync(["git", ...args], { cwd, timeout: timeoutMs })
        return {
          ok: p?.exitCode === 0,
          stdout: p?.stdout ? String(p.stdout.toString ? p.stdout.toString("utf8") : p.stdout) : "",
          stderr: p?.stderr ? String(p.stderr.toString ? p.stderr.toString("utf8") : p.stderr) : "",
        }
      }
    } catch {}
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const cp = require("node:child_process")
      const r = cp.spawnSync("git", args, { cwd, timeout: timeoutMs, encoding: "utf8" })
      return { ok: r?.status === 0, stdout: r?.stdout ?? "", stderr: r?.stderr ?? "" }
    } catch (e: any) {
      return { ok: false, stdout: "", stderr: errMsg(e) }
    }
  }

  // Only branch / HEAD / short status via read-only git commands
  // (rev-parse --abbrev-ref HEAD, rev-parse HEAD, status --porcelain).
  // Never writes, never stages, never runs any other git verb; a non-repo or
  // git-less machine degrades to empty strings (schema-conform) + an error
  // note for the event ledger.
  function collectGitState(repoDir: string): { git_state: any; error: string | null } {
    const gitState = { repository: repoDir, branch: "", head: "", status_short: [] as string[] }
    const errors: string[] = []
    if (!repoDir || !fs.existsSync(repoDir)) {
      return { git_state: gitState, error: `repository path does not exist: ${repoDir || "(empty)"}` }
    }
    const branch = runReadonlyGit(["rev-parse", "--abbrev-ref", "HEAD"], repoDir)
    if (branch.ok) gitState.branch = branch.stdout.trim()
    else errors.push(`rev-parse branch: ${branch.stderr.trim() || "failed"}`)
    const head = runReadonlyGit(["rev-parse", "HEAD"], repoDir)
    if (head.ok) gitState.head = head.stdout.trim()
    else errors.push(`rev-parse HEAD: ${head.stderr.trim() || "failed"}`)
    const status = runReadonlyGit(["status", "--porcelain"], repoDir)
    if (status.ok) {
      gitState.status_short = status.stdout
        .split(/\r?\n/)
        .map((l) => l.trimEnd())
        .filter((l) => l.length > 0)
        .slice(0, GIT_STATUS_MAX_LINES)
    } else errors.push(`status --porcelain: ${status.stderr.trim() || "failed"}`)
    return { git_state: gitState, error: errors.length ? errors.join("; ") : null }
  }

  // ===================================================================
  // Active task / workflow refs + restore references
  // ===================================================================

  function collectRuntimeRefs(key: string, row: any): {
    runtime_state: { active_task_ids: string[]; active_workflow_ids: string[] }
    restore_refs: { project_docs: string[]; mem0: string[]; tasks: string[]; workflows: string[] }
    error: string | null
  } {
    const activeTaskIds: string[] = []
    const activeWorkflowIds: string[] = []
    const errors: string[] = []
    try {
      if (tasksTableReady && q?.activeTasks) {
        for (const r of q.activeTasks.all(key) as any[]) {
          activeTaskIds.push(String(r.task_id))
        }
      }
    } catch (e: any) {
      errors.push(`active tasks lookup: ${errMsg(e)}`)
    }
    try {
      if (workflowsTableReady && q?.activeWorkflows) {
        const taskIdSet = new Set(activeTaskIds)
        for (const w of q.activeWorkflows.all() as any[]) {
          let related = typeof w.planner_session_id === "string" && w.planner_session_id === row?.opencode_session_id
          if (!related && taskIdSet.size > 0 && q?.nodeTaskRefs) {
            const nodes = q.nodeTaskRefs.all(w.workflow_id) as any[]
            related = nodes.some(
              (n) =>
                (typeof n.current_task_id === "string" && taskIdSet.has(n.current_task_id)) ||
                (typeof n.review_task_id === "string" && taskIdSet.has(n.review_task_id)),
            )
          }
          if (related) activeWorkflowIds.push(String(w.workflow_id))
        }
      }
    } catch (e: any) {
      errors.push(`active workflows lookup: ${errMsg(e)}`)
    }

    // project-docs refs: existing governance/docs files only (never created
    // here). mem0: REFERENCE strings only — this core never calls Mem0; the
    // restorer is instructed to search long-term memory manually.
    const projectDocs: string[] = []
    const candidates = [
      path.join(root, "AGENTS.md"),
      path.join(root, "docs", "plan-status.md"),
      path.join(root, "docs", "runtime-context-telemetry.md"),
      lifecycleFile,
    ]
    const projectPath = typeof row?.project_path === "string" && row.project_path ? row.project_path : null
    if (projectPath) {
      candidates.push(path.join(projectPath, "AGENTS.md"), path.join(projectPath, "README.md"))
    }
    for (const c of candidates) {
      try {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) projectDocs.push(c)
      } catch {}
    }
    return {
      runtime_state: { active_task_ids: activeTaskIds, active_workflow_ids: activeWorkflowIds },
      restore_refs: {
        project_docs: projectDocs,
        mem0: ["mem0:manual-search-at-restore (lifecycle core never calls Mem0; resolve required long-term context by hand)"],
        tasks: activeTaskIds,
        workflows: activeWorkflowIds,
      },
      error: errors.length ? errors.join("; ") : null,
    }
  }

  // ===================================================================
  // Checkpoint summary (transient generate if available, else structured
  // deterministic fallback; both bounded and redacted — never a full
  // transcript, never tool outputs)
  // ===================================================================

  function messageText(raw: any): string {
    const info = raw?.info ?? raw
    const parts = raw?.parts ?? raw?.content ?? info?.content
    if (typeof parts === "string") return parts
    if (!Array.isArray(parts)) return ""
    return parts
      .filter((p: any) => p?.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text)
      .join("\n")
  }

  // Deterministic bounded digest of the RECENT context (newest kept when the
  // budget is exceeded). Only user/assistant text parts and compaction
  // summaries are included; tool calls/outputs are skipped entirely (they may
  // carry secrets and are not needed for a handoff summary).
  function buildRecentDigest(messages: any[], budget: number): string {
    const header = "Recent context digest (chronological, bounded, tool output excluded, secrets redacted):"
    const lines: string[] = []
    for (let i = messages.length - 1; i >= 0; i--) {
      const raw = messages[i]
      const info = raw?.info ?? raw
      const type = info?.type ?? info?.role ?? ""
      let line: string | null = null
      if (type === "compaction" && typeof info?.summary === "string" && info.summary.trim()) {
        line = `[compaction] ${info.summary.trim().slice(0, DIGEST_PER_MESSAGE_CHARS)}`
      } else if (type === "user" || type === "assistant") {
        const text = messageText(raw).trim()
        if (text) line = `[${type}] ${text.slice(0, DIGEST_PER_MESSAGE_CHARS)}`
      }
      if (line) lines.unshift(line)
    }
    let body = redactSecrets(lines.join("\n"))
    const bodyBudget = Math.max(0, budget - header.length - 2)
    if (body.length > bodyBudget) body = body.slice(body.length - bodyBudget) // drop OLDEST, keep newest
    return `${header}\n${body}`.trim()
  }

  function extractGenerateText(res: any): string | null {
    if (typeof res === "string") return res.trim() || null
    if (!res || typeof res !== "object") return null
    for (const k of ["text", "output_text", "summary", "result", "content"]) {
      const v = res[k]
      if (typeof v === "string" && v.trim()) return v.trim()
    }
    for (const k of ["parts", "messages"]) {
      if (Array.isArray(res[k])) {
        const t = res[k]
          .map((p: any) => (typeof p === "string" ? p : p?.text ?? messageText(p)))
          .join("\n")
          .trim()
        if (t) return t
      }
    }
    return null
  }

  // Summary strategy (checkpoint.schema.json: summary <= 20000 chars,
  // summary_source recorded):
  // 1. ctx.session.generate — used TRANSIENTLY when present in this runtime
  //    (called WITHOUT a sessionID so it never pollutes the managed session's
  //    context; the API is not binary-verified per docs §6.6, so ANY error or
  //    unexpected result shape falls through to 2).
  // 2. structured-fallback — deterministic bounded digest of the recent
  //    context. Never a full transcript; secrets redacted.
  async function buildSummary(
    row: any,
    messages: any[],
  ): Promise<{ summary: string; summary_source: string; detail: string | null }> {
    const digest = buildRecentDigest(messages, DIGEST_BUDGET_CHARS)
    if (typeof ctx?.session?.generate === "function") {
      try {
        const prompt = [
          "You are producing a session rotation handoff summary. Summarize the following bounded context digest",
          "into <= 4000 characters: current objectives, decisions made, in-flight work, blockers, and what the",
          "successor session must know. Do NOT invent facts absent from the digest. Never include credentials,",
          "API keys or tokens.",
          "",
          digest,
        ].join("\n")
           const res: any = await ctx.session.generate({ prompt })
        const text = extractGenerateText(res)
        if (text) {
          const summary = redactSecrets(text).slice(0, SUMMARY_MAX_CHARS)
          if (summary.trim()) return { summary, summary_source: "ctx.session.generate", detail: null }
        }
      } catch (e: any) {
        return {
          summary: digest || `(no conversation context captured for session ${row?.opencode_session_id ?? "?"})`,
          summary_source: "structured-fallback",
          detail: `ctx.session.generate present but unusable: ${errMsg(e)}`,
        }
      }
    }
    return {
      summary: digest || `(no conversation context captured for session ${row?.opencode_session_id ?? "?"})`,
      summary_source: "structured-fallback",
      detail: null,
    }
  }

  // ===================================================================
  // Checkpoint write (atomic; templates/checkpoint.schema.json v1)
  // ===================================================================

  // sessions.checkpoint_path stores the framework-root-relative POSIX form
  // required by Plan 8 (runtime/checkpoints/<sanitized-key>/gen-XXXX-<id>.json);
  // absCheckpointPath resolves stored values against the framework root for
  // I/O (absolute paths pass through for forward compatibility).
  const checkpointsRel =
    path.relative(root, checkpointsDir).split(path.sep).join("/") || "runtime/checkpoints"
  function relCheckpointPath(sanitizedKey: string, generation: number, checkpointId: string): string {
    return `${checkpointsRel}/${sanitizedKey}/gen-${String(generation).padStart(4, "0")}-${checkpointId}.json`
  }
  function absCheckpointPath(stored: string): string {
    return path.isAbsolute(stored) ? stored : path.join(root, stored)
  }

  function atomicWriteJson(file: string, data: any) {
    const dir = path.dirname(file)
    fs.mkdirSync(dir, { recursive: true })
    const tmp = path.join(dir, `${path.basename(file)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const fd = fs.openSync(tmp, "w")
    try {
      fs.writeSync(fd, JSON.stringify(data, null, 2))
      fs.fsyncSync(fd) // durability before the rename becomes visible
    } finally {
      fs.closeSync(fd)
    }
    try {
      fs.renameSync(tmp, file) // atomic replace (Windows: MOVEFILE_REPLACE)
    } catch (e) {
      try {
        fs.unlinkSync(tmp)
      } catch {}
      throw e
    }
  }

  // Structural self-check against templates/checkpoint.schema.json v1
  // (required keys, additionalProperties:false, types/bounds). A violating
  // object is NEVER written to disk — the checkpoint fails instead.
  function validateCheckpointShape(cp: any): string[] {
    const problems: string[] = []
    const required = [
      "schema_version",
      "checkpoint_id",
      "session_key",
      "project_id",
      "role",
      "generation",
      "session_id",
      "model_runtime_id",
      "context",
      "runtime_state",
      "git_state",
      "restore_refs",
      "summary",
      "summary_source",
      "created_at",
    ]
    const allowed = new Set(required)
    for (const k of required) if (!(k in cp)) problems.push(`missing required property '${k}'`)
    for (const k of Object.keys(cp)) if (!allowed.has(k)) problems.push(`additional property '${k}' is not allowed`)
    if (cp.schema_version !== 1) problems.push("schema_version must be 1")
    for (const k of ["checkpoint_id", "session_key", "project_id", "role", "session_id", "summary_source", "created_at"]) {
      if (typeof cp[k] !== "string" || !cp[k]) problems.push(`${k} must be a non-empty string`)
    }
    if (!(cp.model_runtime_id === null || typeof cp.model_runtime_id === "string")) {
      problems.push("model_runtime_id must be a string or null")
    }
    if (!Number.isInteger(cp.generation) || cp.generation < 1) problems.push("generation must be an integer >= 1")
    const c = cp.context
    if (!c || typeof c !== "object") problems.push("context must be an object")
    else {
      for (const k of Object.keys(c)) if (!["tokens", "limit", "percent", "source"].includes(k)) problems.push(`context.${k} not allowed`)
      if (!Number.isInteger(c.tokens) || c.tokens < 0) problems.push("context.tokens must be an integer >= 0")
      if (!Number.isInteger(c.limit) || c.limit < 0) problems.push("context.limit must be an integer >= 0")
      if (typeof c.percent !== "number" || !Number.isFinite(c.percent) || c.percent < 0 || c.percent > 100) {
        problems.push("context.percent must be a number in [0, 100]")
      }
      if (typeof c.source !== "string" || !c.source) problems.push("context.source must be a non-empty string")
    }
    const rs = cp.runtime_state
    if (!rs || typeof rs !== "object") problems.push("runtime_state must be an object")
    else {
      for (const k of Object.keys(rs)) if (!["active_task_ids", "active_workflow_ids"].includes(k)) problems.push(`runtime_state.${k} not allowed`)
      for (const k of ["active_task_ids", "active_workflow_ids"]) {
        if (!Array.isArray(rs[k]) || rs[k].some((x: any) => typeof x !== "string")) problems.push(`runtime_state.${k} must be string[]`)
      }
    }
    const gs = cp.git_state
    if (!gs || typeof gs !== "object") problems.push("git_state must be an object")
    else {
      for (const k of Object.keys(gs)) if (!["repository", "branch", "head", "status_short"].includes(k)) problems.push(`git_state.${k} not allowed`)
      if (typeof gs.repository !== "string" || !gs.repository) problems.push("git_state.repository must be a non-empty string")
      for (const k of ["branch", "head"]) if (typeof gs[k] !== "string") problems.push(`git_state.${k} must be a string`)
      if (!Array.isArray(gs.status_short) || gs.status_short.some((x: any) => typeof x !== "string")) {
        problems.push("git_state.status_short must be string[]")
      }
    }
    const rr = cp.restore_refs
    if (!rr || typeof rr !== "object") problems.push("restore_refs must be an object")
    else {
      for (const k of Object.keys(rr)) if (!["project_docs", "mem0", "tasks", "workflows"].includes(k)) problems.push(`restore_refs.${k} not allowed`)
      for (const k of ["project_docs", "mem0", "tasks", "workflows"]) {
        if (!Array.isArray(rr[k]) || rr[k].some((x: any) => typeof x !== "string")) problems.push(`restore_refs.${k} must be string[]`)
      }
    }
    if (typeof cp.summary !== "string" || !cp.summary || cp.summary.length > SUMMARY_MAX_CHARS) {
      problems.push(`summary must be a string of 1..${SUMMARY_MAX_CHARS} chars`)
    }
    return problems
  }

  // ensureCheckpoint — public entry: serializes under the process-global
  // session_key lock so a checkpoint can never race a running prompt or a
  // rotation on the same key.
  async function ensureCheckpoint(input: any) {
    const g = guard()
    if (g) return g
    const key = resolveKey(input)
    if (!key) return failure("INVALID_INPUT", "session_key or project_id+role is required")
    return globalWithLock(key, () => ensureCheckpointLocked(key, { force: input?.force === true }))
  }

  // LOCK-FREE checkpoint core — callers MUST already hold
  // globalWithLock(session_key) (rotateSessionLocked does; the public
  // ensureCheckpoint wrapper acquires it).
  //
  // "ensure" semantics: an existing checkpoint file for the latest generation
  // is REUSED unless force=true (rotation always forces a fresh one because
  // the handoff must reflect the context at rotation time).
  async function ensureCheckpointLocked(key: string, opts?: { force?: boolean; row?: any }) {
    const g = guard()
    if (g) return g
    const row: any = opts?.row ?? q.latest.get(key)
    if (!row) return failure("SESSION_NOT_FOUND", `no sessions row exists for session_key '${key}'`)

    if (!opts?.force && typeof row.checkpoint_path === "string" && row.checkpoint_path) {
      const abs = absCheckpointPath(row.checkpoint_path)
      const approvedDir = path.resolve(checkpointsDir)
      const resolved = path.resolve(abs)
      let existingValid = false
      if (resolved.startsWith(approvedDir + path.sep) && fs.existsSync(abs)) {
        try {
          const existing = JSON.parse(fs.readFileSync(abs, "utf8"))
          existingValid = existing?.schema_version === 1 && existing?.session_key === key &&
            Number(existing?.generation) === Number(row.generation) && validateCheckpointShape(existing).length === 0
        } catch {
          existingValid = false
        }
      }
      if (existingValid) {
        insertEvent(key, row.generation, row.opencode_session_id, "CHECKPOINT_REUSED", num(row.context_pct), row.checkpoint_path, {
          reason: "existing v1 checkpoint validated; force=false",
        })
        return {
          ok: true,
          status: "CHECKPOINT_REUSED",
          session_key: key,
          generation: row.generation,
          checkpoint_path: row.checkpoint_path,
          context_pct: num(row.context_pct),
          reused: true,
        }
      }
      insertEvent(key, row.generation, row.opencode_session_id, "CHECKPOINT_EXISTING_INVALID", num(row.context_pct), row.checkpoint_path, {
        reason: "recorded checkpoint failed containment, JSON, session_key, generation, or v1 schema validation; writing a fresh checkpoint",
      })
    }

    // fresh verified measurement — a checkpoint NEVER stores estimated or
    // stale context numbers; when the exact measurement is unavailable the
    // checkpoint fails (and with it a non-forced rotation) instead of
    // fabricating values.
    const m = await measureSession(row.opencode_session_id)
    if (m.context_tokens == null || m.context_limit == null || m.context_pct == null) {
      return failure(
        "CHECKPOINT_TELEMETRY_UNAVAILABLE",
        `cannot build a schema-conform checkpoint without verified context telemetry: ${m.reason ?? "unknown reason"} ` +
          "(no-estimation policy, docs/runtime-context-telemetry.md §7)",
        { session_key: key, generation: row.generation, session_id: row.opencode_session_id },
      )
    }

    const refs = collectRuntimeRefs(key, row)
    const repoDir = typeof row.project_path === "string" && row.project_path ? row.project_path : root
    const git = collectGitState(repoDir)
    const summ = await buildSummary(row, m.messages)

    const checkpointId = uid("cp")
    const sanitized = sanitizeSessionKey(key)
    const relPath = relCheckpointPath(sanitized, row.generation, checkpointId)
    const absPath = absCheckpointPath(relPath)
    // schema caps percent at 100; the RAW computed value is preserved in the
    // event ledger details so the clamp is auditable and never silent.
    const rawPct = m.context_pct
    const checkpoint = {
      schema_version: 1,
      checkpoint_id: checkpointId,
      session_key: key,
      project_id: row.project_id,
      role: row.role,
      generation: row.generation,
      session_id: row.opencode_session_id,
      model_runtime_id: typeof row.model_runtime_id === "string" && row.model_runtime_id ? row.model_runtime_id : null,
      context: {
        tokens: m.context_tokens,
        limit: m.context_limit,
        percent: Math.min(100, Math.max(0, rawPct)),
        source: m.telemetry_source ?? TELEMETRY_SOURCE_DESCRIPTOR,
      },
      runtime_state: refs.runtime_state,
      git_state: git.git_state,
      restore_refs: refs.restore_refs,
      summary: summ.summary,
      summary_source: summ.summary_source,
      created_at: nowIso(),
    }
    const problems = validateCheckpointShape(checkpoint)
    if (problems.length > 0) {
      return failure(
        "CHECKPOINT_SCHEMA_VIOLATION",
        `refusing to write a checkpoint that violates templates/checkpoint.schema.json: ${problems.join("; ")}`,
        { session_key: key, generation: row.generation },
      )
    }
    try {
      atomicWriteJson(absPath, checkpoint)
    } catch (e: any) {
      return failure("CHECKPOINT_WRITE_FAILED", `${errMsg(e)} (target: ${absPath})`, {
        session_key: key,
        generation: row.generation,
      })
    }

    q.setCheckpointPath.run(relPath, key, row.generation)
    const prevState = typeof row.lifecycle_state === "string" && row.lifecycle_state ? row.lifecycle_state : null
    if (prevState == null || BAND_WRITABLE_STATES.has(prevState)) {
      q.setLifecycleState.run("CHECKPOINT_READY", key, row.generation)
    }
    insertEvent(key, row.generation, row.opencode_session_id, "CHECKPOINT_WRITTEN", rawPct, relPath, {
      checkpoint_id: checkpointId,
      context_tokens: m.context_tokens,
      context_limit: m.context_limit,
      context_pct_raw: rawPct,
      context_pct_stored: checkpoint.context.percent,
      summary_source: summ.summary_source,
      summary_detail: summ.detail,
      git_error: git.error,
      refs_error: refs.error,
      forced: opts?.force === true,
    })
    return {
      ok: true,
      status: "CHECKPOINT_WRITTEN",
      session_key: key,
      generation: row.generation,
      checkpoint_id: checkpointId,
      checkpoint_path: relPath,
      checkpoint_path_absolute: absPath,
      context_pct: rawPct,
      summary_source: summ.summary_source,
      summary_chars: summ.summary.length,
      reused: false,
      git: { branch: git.git_state.branch, head: git.git_state.head, status_short_count: git.git_state.status_short.length, error: git.error },
      runtime_state: refs.runtime_state,
    }
  }

  // ===================================================================
  // Handoff / restore synthetic message (bounded, refs + summary only)
  // ===================================================================

  function buildHandoffText(
    kind: "ROTATION_HANDOFF" | "SESSION_RESTORE",
    cp: any,
    info: { sessionKey: string; generation: number; predecessorSessionId: string | null },
  ): string {
    const lines: string[] = [
      `${kind} (Plan 8 lifecycle core — generated, not user input)`,
      "",
      `SESSION_KEY: ${info.sessionKey}`,
      `GENERATION: ${info.generation}`,
      `PREDECESSOR_SESSION: ${info.predecessorSessionId ?? "none"}`,
      `CHECKPOINT_FILE: ${absCheckpointPath(String(cp?.checkpoint_path ?? ""))}`,
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
      "",
      "Restore procedure: read the CHECKPOINT_FILE JSON for the full structured state, resume the ACTIVE tasks/workflows above,",
      "consult the listed project docs and (manually) Mem0. This message is a bounded handoff — never a full transcript.",
    ]
    return lines.join("\n").slice(0, HANDOFF_TEXT_MAX_CHARS)
  }

  // Shared successor-creation mechanics for rotate/restore: create ->
  // switchAgent -> switchModel -> synthetic handoff. Phase callbacks let the
  // rotation ledger persist SUCCESSOR_CREATED / INITIALIZED progressively.
  async function createSuccessorSession(params: {
    title: string
    agentId: string
    runtimeId: string
    syntheticText: string
    onCreated?: (sessionID: string) => void
  }): Promise<{ ok: true; sessionID: string } | { ok: false; phase: "CREATE" | "INIT"; detail: string; sessionID?: string }> {
    const model = parseRuntimeId(params.runtimeId)
    if (!model) {
      return { ok: false, phase: "INIT", detail: `cannot parse runtime_id '${params.runtimeId}'` }
    }
    let sessionID: string
    try {
      const info: any = await ctx.session.create({ title: params.title })
      sessionID = info?.id ?? info?.sessionID
      if (!sessionID) throw new Error("session create returned no id")
    } catch (e: any) {
      return { ok: false, phase: "CREATE", detail: errMsg(e) }
    }
    params.onCreated?.(sessionID)
    try {
      await ctx.session.switchAgent({ sessionID, agent: params.agentId })
      const modelRef: any = { providerID: model.providerID, id: model.id }
      if (model.variant) modelRef.variant = model.variant
      await ctx.session.switchModel({ sessionID, model: modelRef })
      await ctx.session.synthetic({ sessionID, text: params.syntheticText })
    } catch (e: any) {
      return { ok: false, phase: "INIT", detail: errMsg(e), sessionID }
    }
    return { ok: true, sessionID }
  }

  async function probeSessionAlive(sessionID: string | null): Promise<boolean> {
    if (typeof sessionID !== "string" || !sessionID) return false
    if (typeof ctx?.session?.get !== "function") return false // cannot verify -> never adopt
    try {
      await ctx.session.get({ sessionID })
      return true
    } catch {
      return false
    }
  }

  function successorTitle(key: string, row: any, generation: number): string {
    if (key.startsWith("project:")) return `[runtime] ${row.project_id} ${row.role} gen${generation}`
    return `[scoped] ${row.role} ${row.project_id} gen${generation}`
  }

  // ===================================================================
  // Rotation (manual/forced API in T4; automatic enablement is a later
  // plugin-integration task and is NOT wired here)
  // ===================================================================

  function failRotation(rotationId: string, key: string, row: any, code: string, detail: string, extra?: Record<string, unknown>) {
    try {
      q.rotFail.run(`${code}: ${detail}`.slice(0, 2000), nowIso(), rotationId)
    } catch {}
    // the OLD generation stays usable: sessions.status remains ACTIVE, only
    // the lifecycle band label flips to ROTATION_FAILED (Plan 8 vocabulary)
    try {
      q.setLifecycleState.run("ROTATION_FAILED", key, row.generation)
    } catch {}
    insertEvent(key, row.generation, row.opencode_session_id, "ROTATION_FAILED", num(row.context_pct), null, {
      rotation_id: rotationId,
      code,
      detail,
      ...(extra ?? {}),
    })
  }

  // Public rotate: acquires the process-global session_key lock — the SAME
  // lock the runtime core's withLock (ensure/send/archive/scoped) now uses —
  // so a rotation can never interrupt a running prompt on that key.
  async function rotateSession(input: any) {
    const g = guard()
    if (g) return g
    const key = resolveKey(input)
    if (!key) return failure("INVALID_INPUT", "session_key or project_id+role is required")
    const reason = typeof input?.reason === "string" && input.reason.trim() ? input.reason.trim() : "manual"
    const force = input?.force === true
    return globalWithLock(key, () => rotateSessionLocked(key, reason, force))
  }

  // LOCK-FREE rotation core — callers MUST hold globalWithLock(key).
  //
  // Order of operations (progressive lifecycle_rotations persistence):
  //   PREPARING -> checkpoint (forced) -> SUCCESSOR_CREATED -> INITIALIZED
  //   -> register successor row (ACTIVE, HANDOFF_READY) -> archive OLD row
  //   -> COMMITTED.
  // Any failure leaves the OLD row ACTIVE (sessions.status untouched) with
  // lifecycle_state ROTATION_FAILED and a FAILED rotation row; created-but-
  // uninitialized successor OpenCode sessions are recorded but NEVER deleted
  // (audit), and reconcileRotations resolves the leftovers without creating
  // a second successor.
  async function rotateSessionLocked(key: string, reason: string, force: boolean) {
    const g = guard()
    if (g) return g
    const row: any = q.latest.get(key)
    if (!row) return failure("SESSION_NOT_FOUND", `no sessions row exists for session_key '${key}'`)
    if (row.status !== "ACTIVE") {
      return failure(
        "ROTATION_NOT_ACTIVE",
        `latest generation ${row.generation} of '${key}' has status '${row.status}', not ACTIVE; ` +
          "rotation only replaces ACTIVE generations (use restoreSession for STALE/ARCHIVED keys)",
        { session_key: key, generation: row.generation },
      )
    }
    // hard guard against double successors: an unfinished rotation for this
    // key must be reconciled first (crash leftovers included)
    const inFlight = q.rotIncompleteForKey.all(key) as any[]
    if (inFlight.length > 0) {
      return failure(
        "ROTATION_IN_PROGRESS",
        `rotation ${inFlight[0].rotation_id} for '${key}' is still ${inFlight[0].status}; ` +
          "run reconcileRotations first — a second successor is never created",
        { session_key: key, rotation_id: inFlight[0].rotation_id, rotation_status: inFlight[0].status },
      )
    }
    const toGeneration = Number(row.generation) + 1
    if (q.rowByGen.get(key, toGeneration)) {
      return failure(
        "ROTATION_STATE_CONFLICT",
        `sessions row (${key}, generation ${toGeneration}) already exists; run reconcileRotations to resolve the ledger first`,
        { session_key: key, to_generation: toGeneration },
      )
    }

    const cfg = loadThresholds()
    if (!cfg.ok) return cfg.failure
    const pct = num(row.context_pct)
    const band = resolveLifecycleBand(pct, cfg.thresholds)
    if (!force) {
      if (pct == null) {
        return failure(
          "ROTATION_TELEMETRY_UNAVAILABLE",
          "no verified context_pct stored for this generation; refusing to rotate without measurement " +
            "(run refreshTelemetry first, or rotate with force=true for an explicit manual rotation)",
          { session_key: key, generation: row.generation },
        )
      }
      if (band.recommended_action !== "ROTATE_AFTER_ATOMIC_STEP" && band.recommended_action !== "HARD_ROTATE") {
        return {
          ok: false,
          status: "ROTATION_NOT_DUE",
          code: "ROTATION_NOT_DUE",
          session_key: key,
          generation: row.generation,
          context_pct: pct,
          band: band.band,
          recommended_action: band.recommended_action,
          thresholds: cfg.thresholds,
          detail:
            `context_pct ${pct} is below rotate_after_atomic_step_at_percent ` +
            `(${cfg.thresholds.rotate_after_atomic_step_at_percent}); use force=true for a manual rotation`,
        }
      }
    }

    const runtimeId = typeof row.model_runtime_id === "string" && row.model_runtime_id ? row.model_runtime_id : null
    const rotationId = uid("rot")
    const ts0 = nowIso()
    q.rotInsert.run(rotationId, key, row.generation, row.opencode_session_id, toGeneration, null, null, "PREPARING", null, ts0, ts0)
    q.setLifecycleState.run("ROTATING", key, row.generation) // sessions.status stays ACTIVE
    insertEvent(key, row.generation, row.opencode_session_id, "ROTATION_STARTED", pct, null, {
      rotation_id: rotationId,
      reason,
      force,
      band: band.band,
      recommended_action: band.recommended_action,
      thresholds: cfg.thresholds,
      to_generation: toGeneration,
    })

    // 1) forced fresh checkpoint — the handoff must reflect rotation time
    const cp: any = await ensureCheckpointLocked(key, { force: true, row })
    if (!cp.ok) {
      failRotation(rotationId, key, row, cp.code ?? "CHECKPOINT_FAILED", cp.detail ?? "checkpoint failed", {
        phase: "CHECKPOINT",
      })
      return {
        ok: false,
        status: "ROTATION_FAILED",
        code: "ROTATION_CHECKPOINT_FAILED",
        detail: cp.detail,
        session_key: key,
        rotation_id: rotationId,
        from_generation: row.generation,
        old_session_status: "ACTIVE",
        old_lifecycle_state: "ROTATION_FAILED",
      }
    }
    q.rotSetCheckpoint.run(cp.checkpoint_path, nowIso(), rotationId)

    if (!runtimeId) {
      failRotation(rotationId, key, row, "MODEL_UNASSIGNED", "rotated row has no model_runtime_id; refusing to guess a model", {
        phase: "SUCCESSOR",
      })
      return {
        ok: false,
        status: "ROTATION_FAILED",
        code: "MODEL_UNASSIGNED",
        detail: "sessions.model_runtime_id is null for the generation being rotated; never guessed, never inherited",
        session_key: key,
        rotation_id: rotationId,
        from_generation: row.generation,
      }
    }

    // 2) successor session (existing runtime semantics: create -> switchAgent
    //    -> switchModel -> synthetic scope/handoff context). The handoff text
    //    is built from the just-written checkpoint FILE (authoritative,
    //    atomic-write guaranteed) rather than duplicated in-memory state.
    const cpFile = checkpointView(cp.checkpoint_path)
    const handoffText = buildHandoffText("ROTATION_HANDOFF", { ...cpFile, checkpoint_path: cp.checkpoint_path }, {
      sessionKey: key,
      generation: toGeneration,
      predecessorSessionId: row.opencode_session_id,
    })
    const succ = await createSuccessorSession({
      title: successorTitle(key, row, toGeneration),
      agentId: row.agent_id ?? row.role,
      runtimeId,
      syntheticText: handoffText,
      onCreated: (sid) => {
        try {
          q.rotSetSuccessor.run(sid, "SUCCESSOR_CREATED", nowIso(), rotationId)
        } catch {}
      },
    })
    if (!succ.ok) {
      failRotation(rotationId, key, row, succ.phase === "CREATE" ? "SESSION_CREATE_FAILED" : "SESSION_INIT_FAILED", succ.detail, {
        phase: succ.phase,
        successor_session_id: succ.sessionID ?? null,
        note: succ.sessionID
          ? "successor OpenCode session exists but is NOT registered/initialized; kept for audit, never deleted"
          : undefined,
      })
      return {
        ok: false,
        status: "ROTATION_FAILED",
        code: succ.phase === "CREATE" ? "SESSION_CREATE_FAILED" : "SESSION_INIT_FAILED",
        detail: succ.detail,
        session_key: key,
        rotation_id: rotationId,
        from_generation: row.generation,
        successor_session_id: succ.sessionID ?? null,
        checkpoint_path: cp.checkpoint_path,
      }
    }
    q.rotSetStatus.run("INITIALIZED", nowIso(), rotationId)

    // 3) register the successor row FIRST, archive the OLD row only after the
    //    successor is initialized/registered (never the other way around)
    try {
      if (q.rowByGen.get(key, toGeneration)) {
        // cross-process race (this lock is process-global only): a concurrent
        // reconciler/rotator registered the generation first
        failRotation(rotationId, key, row, "ROTATION_STATE_CONFLICT", `generation ${toGeneration} was registered concurrently`, {
          successor_session_id: succ.sessionID,
        })
        return {
          ok: false,
          status: "ROTATION_FAILED",
          code: "ROTATION_STATE_CONFLICT",
          detail: `sessions (${key}, ${toGeneration}) appeared during rotation; reconcileRotations will settle the ledger`,
          session_key: key,
          rotation_id: rotationId,
          successor_session_id: succ.sessionID,
        }
      }
      const ts = nowIso()
       db.transaction(() => {
         q.insertSession.run(
           key,
           row.project_id,
           row.role,
           succ.sessionID,
           toGeneration,
           row.agent_id ?? row.role,
           runtimeId,
           row.project_path ?? "",
           "ACTIVE",
           null,
           ts,
           ts,
           null,
         )
         q.setLifecycleState.run("HANDOFF_READY", key, toGeneration)
         q.archiveOldGeneration.run(succ.sessionID, cp.checkpoint_path, ts, key, row.generation)
       })()
    } catch (e: any) {
      failRotation(rotationId, key, row, "ROTATION_COMMIT_FAILED", errMsg(e), {
        successor_session_id: succ.sessionID,
      })
      return {
        ok: false,
        status: "ROTATION_FAILED",
        code: "ROTATION_COMMIT_FAILED",
        detail: `${errMsg(e)} (successor ${succ.sessionID} initialized but registration failed; reconcileRotations will adopt it)`,
        session_key: key,
        rotation_id: rotationId,
        successor_session_id: succ.sessionID,
      }
    }
    q.rotSetStatus.run("COMMITTED", nowIso(), rotationId)
    insertEvent(key, toGeneration, succ.sessionID, "ROTATION_COMMITTED", pct, cp.checkpoint_path, {
      rotation_id: rotationId,
      from_generation: row.generation,
      from_session_id: row.opencode_session_id,
      reason,
      force,
      band: band.band,
    })
    return {
      ok: true,
      status: "ROTATED",
      session_key: key,
      rotation_id: rotationId,
      from_generation: row.generation,
      to_generation: toGeneration,
      from_session_id: row.opencode_session_id,
      successor_session_id: succ.sessionID,
      checkpoint_path: cp.checkpoint_path,
      context_pct: pct,
      band: band.band,
      reason,
      forced: force,
      old_row: { status: "ARCHIVED", lifecycle_state: "ARCHIVED", replaced_by: succ.sessionID },
      successor_row: { status: "ACTIVE", lifecycle_state: "HANDOFF_READY" },
    }
  }

  // The checkpoint FILE on disk is authoritative — re-read it (cheap;
  // atomic-write guaranteed) instead of duplicating schema state in memory.
  function checkpointView(checkpointPath: string): any {
    try {
      return JSON.parse(fs.readFileSync(absCheckpointPath(String(checkpointPath)), "utf8"))
    } catch {
      return {}
    }
  }

  // ===================================================================
  // Restore (reload recovery / successor from checkpoint)
  // ===================================================================

  // Public restore: same process-global session_key lock as rotation/send.
  async function restoreSession(input: any) {
    const g = guard()
    if (g) return g
    const key = resolveKey(input)
    if (!key) return failure("INVALID_INPUT", "session_key or project_id+role is required")
    return globalWithLock(key, () => restoreSessionLocked(key, input))
  }

  // LOCK-FREE restore core — callers MUST hold globalWithLock(key).
  // Creates a successor generation seeded from a checkpoint when the latest
  // generation is unusable (missing / ARCHIVED / STALE / ACTIVE-but-dead).
  // Never restores over a LIVE ACTIVE session (RESTORE_NOT_NEEDED) and never
  // fabricates restore context when no checkpoint exists.
  async function restoreSessionLocked(key: string, input: any) {
    const g = guard()
    if (g) return g
    let latest: any = q.latest.get(key)
    if (latest && latest.status === "ACTIVE") {
      const alive = await probeSessionAlive(latest.opencode_session_id)
      // Restore is a recovery path, never a replacement path.  Even an
      // explicit force request must not create a successor while the latest
      // ACTIVE OpenCode session is alive; callers that intentionally replace
      // a live generation must use rotateSession instead.  Keeping this
      // guard before checkpoint loading also guarantees no session is created
      // and no orphan can be left behind.
      if (alive) {
        return {
          ok: false,
          status: "RESTORE_NOT_NEEDED",
          code: "RESTORE_NOT_NEEDED",
          session_key: key,
          session_id: latest.opencode_session_id,
          generation: latest.generation,
          detail: "latest generation is ACTIVE and its OpenCode session is alive; restore never replaces a live generation (use lifecycle_rotate)",
        }
      }
      if (!alive) {
        // mirror registry semantics: record exists but the session is gone
        q.markStatus.run("STALE", nowIso(), key, latest.generation)
        q.setLifecycleState.run("STALE", key, latest.generation)
        latest = q.latest.get(key)
      }
    }

    // resolve the checkpoint: explicit input -> latest row -> newest recorded
    let cpPath: string | null =
      typeof input?.checkpoint_path === "string" && input.checkpoint_path ? input.checkpoint_path : null
    if (!cpPath && latest && typeof latest.checkpoint_path === "string" && latest.checkpoint_path) cpPath = latest.checkpoint_path
    if (!cpPath) {
      const r: any = q.latestCheckpoint.get(key)
      cpPath = r?.checkpoint_path ?? null
    }
    if (!cpPath) {
      return failure(
        "RESTORE_CHECKPOINT_NOT_FOUND",
        `no checkpoint_path recorded for session_key '${key}' and none supplied; refusing to restore without a checkpoint (nothing is fabricated)`,
        { session_key: key },
      )
    }
    const abs = absCheckpointPath(cpPath)
    const approvedDir = path.resolve(checkpointsDir)
    const resolvedCheckpoint = path.resolve(abs)
    if (!resolvedCheckpoint.startsWith(approvedDir + path.sep)) {
      return failure("RESTORE_CHECKPOINT_INVALID", "checkpoint path must remain inside runtime/checkpoints", {
        session_key: key, checkpoint_path: cpPath,
      })
    }
    if (!fs.existsSync(abs)) {
      return failure("RESTORE_CHECKPOINT_FILE_MISSING", `checkpoint file does not exist: ${abs}`, {
        session_key: key,
        checkpoint_path: cpPath,
      })
    }
    let cp: any
    try {
      cp = JSON.parse(fs.readFileSync(abs, "utf8"))
    } catch (e: any) {
      return failure("RESTORE_CHECKPOINT_UNPARSEABLE", `${errMsg(e)} (file: ${abs})`, { session_key: key, checkpoint_path: cpPath })
    }
    const checkpointProblems = validateCheckpointShape(cp)
    if (cp?.schema_version !== 1 || cp?.session_key !== key || checkpointProblems.length > 0) {
      return failure(
        "RESTORE_CHECKPOINT_INVALID",
        `checkpoint at ${cpPath} is not a valid v1 checkpoint for session_key '${key}': ${checkpointProblems.join("; ")}`,
        { session_key: key, checkpoint_path: cpPath },
      )
    }

    const projectId = latest?.project_id ?? cp.project_id
    const role = latest?.role ?? cp.role
    const agentId = latest?.agent_id ?? role
    const runtimeId = latest?.model_runtime_id ?? cp.model_runtime_id
    if (typeof runtimeId !== "string" || !runtimeId) {
      return failure("MODEL_UNASSIGNED", "neither the registry row nor the checkpoint carries a model_runtime_id; refusing to guess", {
        session_key: key,
      })
    }
    let projectPath = latest?.project_path ?? ""
    if (!projectPath) {
      try {
        const cfg = runtimeCore.loadConfig()
        const project = runtimeCore.findProject(cfg, projectId)
        if (project && typeof project.path === "string") projectPath = project.path
      } catch {}
    }

    // generation: always MAX(existing)+1 — a partially registered rotation
    // successor must never be collided with
    const maxRow: any = q.maxGeneration.get(key)
    const generation = Number(maxRow?.m ?? latest?.generation ?? cp.generation ?? 0) + 1
    if (q.rowByGen.get(key, generation)) {
      return failure("RESTORE_STATE_CONFLICT", `sessions (${key}, ${generation}) unexpectedly exists; run reconcileRotations`, {
        session_key: key,
      })
    }

    const succ = await createSuccessorSession({
      title: successorTitle(key, { project_id: projectId, role }, generation),
      agentId,
      runtimeId,
      syntheticText: buildHandoffText("SESSION_RESTORE", { ...cp, checkpoint_path: cpPath }, {
        sessionKey: key,
        generation,
        predecessorSessionId: latest?.opencode_session_id ?? null,
      }),
      onCreated: () => {},
    })
    if (!succ.ok) {
      insertEvent(key, latest?.generation ?? null, latest?.opencode_session_id ?? null, "SESSION_RESTORE_FAILED", num(latest?.context_pct), cpPath, {
        phase: succ.phase,
        detail: succ.detail,
        successor_session_id: succ.sessionID ?? null,
      })
      return failure(succ.phase === "CREATE" ? "SESSION_CREATE_FAILED" : "SESSION_INIT_FAILED", succ.detail, {
        session_key: key,
        successor_session_id: succ.sessionID ?? null,
        checkpoint_path: cpPath,
      })
    }

    try {
      const ts = nowIso()
      db.transaction(() => {
        const active: any = db.query("SELECT COUNT(*) AS count FROM sessions WHERE session_key = ? AND status = 'ACTIVE'").get(key)
        if (Number(active?.count ?? 0) > 0) {
          throw new Error("another ACTIVE generation exists; refusing double ACTIVE restore")
        }
        q.insertSession.run(key, projectId, role, succ.sessionID, generation, agentId, runtimeId, projectPath, "ACTIVE", null, ts, ts, null)
        q.setLifecycleState.run("HANDOFF_READY", key, generation)
        if (latest) q.linkReplaced.run(succ.sessionID, ts, key, latest.generation)
      })()
    } catch (e: any) {
      insertEvent(key, generation, succ.sessionID, "SESSION_RESTORE_FAILED", null, cpPath, {
        phase: "REGISTER",
        detail: errMsg(e),
      })
      return failure("RESTORE_REGISTER_FAILED", `${errMsg(e)} (session ${succ.sessionID} created but registration failed; kept for audit)`, {
        session_key: key,
        successor_session_id: succ.sessionID,
      })
    }
    insertEvent(key, generation, succ.sessionID, "SESSION_RESTORED", num(cp?.context?.percent), cpPath, {
      checkpoint_id: cp.checkpoint_id ?? null,
      from_generation: latest?.generation ?? null,
      summary_source: cp.summary_source ?? null,
    })
    return {
      ok: true,
      status: "RESTORED",
      session_key: key,
      generation,
      session_id: succ.sessionID,
      checkpoint_path: cpPath,
      summary_source: cp.summary_source ?? null,
      lifecycle_state: "HANDOFF_READY",
      active_task_ids: cp?.runtime_state?.active_task_ids ?? [],
      active_workflow_ids: cp?.runtime_state?.active_workflow_ids ?? [],
    }
  }

  // ===================================================================
  // Reconciliation (crash recovery without double successor / double ACTIVE)
  // ===================================================================

  // Public reconcile: resolves incomplete PREPARING / SUCCESSOR_CREATED /
  // INITIALIZED rotations. Per key it runs under the process-global lock and
  // re-reads each rotation row inside the lock. Rules:
  // - a registered successor generation row  -> COMPLETE the rotation
  //   (archive old row, COMMITTED);
  // - INITIALIZED with a LIVE successor session but missing registration
  //   -> ADOPT it (insert the row, archive old, COMMITTED) — this session was
  //   fully configured (agent+model+handoff) before the crash;
  // - anything else (PREPARING, SUCCESSOR_CREATED, dead/unverifiable
  //   successor) -> ABANDON: rotation FAILED, old row stays ACTIVE with
  //   lifecycle_state ROTATION_FAILED. A half-initialized successor is never
  //   completed and never deleted; a NEW successor is never created here.
  async function reconcileRotations(input?: any) {
    const g = guard()
    if (g) return g
    const keyFilter = typeof input?.session_key === "string" && input.session_key.trim() ? input.session_key.trim() : null
    const rows: any[] = keyFilter ? q.rotIncompleteForKey.all(keyFilter) : q.rotIncomplete.all()
    const keys: string[] = [...new Set(rows.map((r) => String(r.session_key)))]
    const results: any[] = []
    for (const k of keys) {
      await globalWithLock(k, async () => {
        const forKey = rows.filter((r) => String(r.session_key) === k)
        for (const r of forKey) {
          const fresh: any = q.rotGet.get(r.rotation_id)
          if (!fresh || ROTATION_TERMINAL.has(fresh.status)) {
            results.push({
              rotation_id: r.rotation_id,
              session_key: k,
              resolution: "SKIPPED",
              detail: fresh ? `already terminal (${fresh.status})` : "rotation row disappeared",
            })
            continue
          }
          results.push(await reconcileOneLocked(fresh))
        }
      })
    }
    return { ok: true, status: "OK", incomplete_found: rows.length, count: results.length, reconciled: results }
  }

  async function reconcileOneLocked(rot: any): Promise<any> {
    const key = String(rot.session_key)
    const base = {
      rotation_id: rot.rotation_id,
      session_key: key,
      from_generation: rot.from_generation,
      to_generation: rot.to_generation,
      status_at_reconcile: rot.status,
    }
    const oldRow: any = q.rowByGen.get(key, rot.from_generation)
    const newRow: any = q.rowByGen.get(key, rot.to_generation)

    const completeCommit = (note: string) => {
      const ts = nowIso()
      if (oldRow && oldRow.status === "ACTIVE") {
          q.archiveOldGeneration.run(
            newRow?.opencode_session_id ?? rot.successor_session_id ?? null,
            rot.checkpoint_path ?? null,
            ts,
            key,
            rot.from_generation,
          )
      } else if (oldRow && oldRow.lifecycle_state === "ROTATING") {
        q.setLifecycleState.run(oldRow.status === "STALE" ? "STALE" : "ROTATION_FAILED", key, rot.from_generation)
      }
      q.rotSetStatus.run("COMMITTED", ts, rot.rotation_id)
      insertEvent(key, rot.to_generation, newRow?.opencode_session_id ?? rot.successor_session_id, "ROTATION_RECONCILED", null, rot.checkpoint_path, {
        resolution: "COMMITTED",
        note,
        status_at_reconcile: rot.status,
      })
      return { ...base, resolution: "COMMITTED", detail: note }
    }

    // Case 1: successor generation is already registered -> the rotation
    // effectively succeeded; settle the ledger (no new session, ever).
    if (newRow) return completeCommit(`successor generation ${rot.to_generation} already registered; ledger settled`)

    // Case 2: INITIALIZED with a live successor session -> adopt (all init
    // steps provably ran before the crash: agent, model, handoff synthetic).
    const successorAlive = await probeSessionAlive(rot.successor_session_id)
    if (rot.status === "INITIALIZED" && rot.successor_session_id && successorAlive && oldRow) {
      try {
        const ts = nowIso()
        q.insertSession.run(
          key,
          oldRow.project_id,
          oldRow.role,
          rot.successor_session_id,
          rot.to_generation,
          oldRow.agent_id,
          oldRow.model_runtime_id,
          oldRow.project_path ?? "",
          "ACTIVE",
          null,
          ts,
          ts,
          null,
        )
        q.setLifecycleState.run("HANDOFF_READY", key, rot.to_generation)
        return completeCommit(`INITIALIZED successor ${rot.successor_session_id} adopted and registered`)
      } catch (e: any) {
        // fall through to abandon; the insert failure is recorded below
        return abandon(`adopting INITIALIZED successor failed: ${errMsg(e)}`)
      }
    }

    // Case 3: abandon (PREPARING / SUCCESSOR_CREATED / dead or unverifiable
    // successor). Old generation remains ACTIVE and serviceable.
    return abandon(
      `rotation incomplete at ${rot.status}; successor_session_id=${rot.successor_session_id ?? "none"}, alive=${successorAlive}; ` +
        "no registered successor generation — abandoned without creating a new successor",
    )

    function abandon(detail: string) {
      const ts = nowIso()
      try {
        q.rotFail.run(`RECONCILED_ABANDONED: ${detail}`.slice(0, 2000), ts, rot.rotation_id)
      } catch {}
      if (oldRow && oldRow.lifecycle_state === "ROTATING") {
        // back to service: status was never changed from ACTIVE
        q.setLifecycleState.run("ROTATION_FAILED", key, rot.from_generation)
      }
      insertEvent(key, rot.from_generation, rot.from_session_id, "ROTATION_RECONCILED", num(oldRow?.context_pct), rot.checkpoint_path, {
        resolution: "FAILED",
        detail,
        status_at_reconcile: rot.status,
        successor_session_id: rot.successor_session_id ?? null,
      })
      return { ...base, resolution: "FAILED", detail }
    }
  }

  // ===================================================================
  // Read-only views
  // ===================================================================

  function rowToLifecycleView(r: any) {
    return {
      session_key: r.session_key,
      project_id: r.project_id,
      role: r.role,
      session_id: r.opencode_session_id,
      generation: r.generation,
      status: r.status, // Plan 5 registry status (separate column/semantics)
      lifecycle_state: r.lifecycle_state ?? null, // Plan 8 band/state label
      agent_id: r.agent_id,
      model_runtime_id: r.model_runtime_id,
      context_tokens: r.context_tokens ?? null,
      context_limit: r.context_limit ?? null,
      context_pct: r.context_pct ?? null,
      telemetry_source: r.telemetry_source ?? null,
      telemetry_at: r.telemetry_at ?? null,
      checkpoint_path: r.checkpoint_path ?? null,
      created_at: r.created_at,
      last_used_at: r.last_used_at,
      replaced_by: r.replaced_by ?? null,
    }
  }

  function rotationView(r: any) {
    if (!r) return null
    return {
      rotation_id: r.rotation_id,
      session_key: r.session_key,
      from_generation: r.from_generation,
      from_session_id: r.from_session_id,
      to_generation: r.to_generation,
      checkpoint_path: r.checkpoint_path ?? null,
      successor_session_id: r.successor_session_id ?? null,
      status: r.status,
      error: r.error ?? null,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }
  }

  // Latest generation per session_key with telemetry + lifecycle columns +
  // last rotation. Optional filters: session_key / project_id / role.
  function listLifecycle(input?: any) {
    const g = guard()
    if (g) return g
    let rows: any[] = q.currentLifecycle.all()
    if (typeof input?.session_key === "string" && input.session_key) rows = rows.filter((r) => r.session_key === input.session_key)
    if (typeof input?.project_id === "string" && input.project_id) rows = rows.filter((r) => r.project_id === input.project_id)
    if (typeof input?.role === "string" && input.role) rows = rows.filter((r) => r.role === input.role)
    const sessions = rows.map((r) => {
      let lastRotation: any = null
      try {
        lastRotation = rotationView(q.rotLatest.get(r.session_key))
      } catch {}
      return { ...rowToLifecycleView(r), last_rotation: lastRotation }
    })
    return { ok: true, status: "OK", count: sessions.length, sessions }
  }

  // Full lifecycle status for ONE key: registry + telemetry + threshold
  // evaluation (pure — writes nothing) + checkpoint presence + rotation
  // ledger + recent events. input.refresh=true takes a fresh verified
  // measurement first (that path DOES write telemetry columns + one event).
  async function getLifecycleStatus(input: any) {
    const g = guard()
    if (g) return g
    const key = resolveKey(input)
    if (!key) return failure("INVALID_INPUT", "session_key or project_id+role is required")
    if (input?.refresh === true) {
      const r: any = await refreshTelemetry({ session_key: key })
      if (!r.ok) return r
    }
    const row: any = q.latest.get(key)
    if (!row) return failure("SESSION_NOT_FOUND", `no sessions row exists for session_key '${key}'`)

    const cfg = loadThresholds()
    const thresholds = cfg.ok ? cfg.thresholds : null
    const pct = num(row.context_pct)
    const band = thresholds ? resolveLifecycleBand(pct, thresholds) : { band: null, state: null, recommended_action: null }

    let lastRotation: any = null
    let incompleteRotation: any = null
    try {
      lastRotation = rotationView(q.rotLatest.get(key))
      const inc = q.rotIncompleteForKey.all(key) as any[]
      incompleteRotation = inc.length ? rotationView(inc[0]) : null
    } catch {}

    const requestedEvents = num(input?.events_limit)
    const eventsLimit = Math.min(Math.max(requestedEvents ?? 10, 1), 100)
    let recentEvents: any[] = []
    try {
      recentEvents = (q.recentEvents.all(key, eventsLimit) as any[]).map((e) => ({
        ...e,
        details: (() => {
          try {
            return e.details_json ? JSON.parse(e.details_json) : null
          } catch {
            return e.details_json
          }
        })(),
        details_json: undefined,
      }))
    } catch {}

    const checkpointPath = typeof row.checkpoint_path === "string" && row.checkpoint_path ? row.checkpoint_path : null
    return {
      ok: true,
      status: "OK",
      session_key: key,
      registry: rowToLifecycleView(row),
      telemetry: {
        context_tokens: row.context_tokens ?? null,
        context_limit: row.context_limit ?? null,
        context_pct: pct,
        telemetry_source: row.telemetry_source ?? null,
        telemetry_at: row.telemetry_at ?? null,
      },
      evaluation: thresholds
        ? {
            thresholds,
            band: band.band,
            recommended_action: band.recommended_action,
            band_state: band.state,
          }
        : { thresholds: null, band: null, recommended_action: null, band_state: null, config_error: (cfg as any).failure?.detail ?? null },
      lifecycle_state: row.lifecycle_state ?? null,
      checkpoint: checkpointPath
        ? { path: checkpointPath, absolute_path: absCheckpointPath(checkpointPath), exists: fs.existsSync(absCheckpointPath(checkpointPath)) }
        : null,
      last_rotation: lastRotation,
      incomplete_rotation: incompleteRotation,
      recent_events: recentEvents,
    }
  }

  // T4/T5 integration: use the dedicated rotation and reconcile engines for
  // all externally visible generation changes. The facade keeps the original
  // public method shapes, but the modular engines own the strict phase order,
  // atomic commit and reload-safe reconciliation contracts.
  const rotationEngine = createRotationCore(ctx, runtimeCore, {
    root,
    refreshTelemetry,
    ensureCheckpointLocked,
    testHooks: options?.testHooks ?? null,
    verifyRotationDue: (_key: string, pct: number | null) => {
      const config = loadThresholds()
      if (!config.ok) return { ok: false, code: config.failure.code, detail: config.failure.detail }
      const band = resolveLifecycleBand(pct, config.thresholds)
      return band.state === "ROTATE_PENDING" || band.state === "HARD_ROTATE"
        ? { ok: true }
        : { ok: false, code: "ROTATION_NOT_DUE", detail: "fresh context has fallen below the configured rotation band" }
    },
  })
  const reconcileEngine = createReconcileCore(ctx, runtimeCore, { root })

  async function rotateSessionLockedStrict(key: string, reason = "manual", force = false) {
    const g = guard()
    if (g) return g
    return rotationEngine.rotateSessionLocked(key, { reason, force })
  }

  async function rotateSessionStrict(input: any) {
    const g = guard()
    if (g) return g
    const key = resolveKey(input)
    if (!key) return failure("INVALID_INPUT", "session_key or project_id+role is required")
    const reason = typeof input?.reason === "string" && input.reason.trim() ? input.reason.trim() : "manual"
    const force = input?.force === true
    return globalWithLock(key, async () => {
      // Policy is evaluated while holding the same non-reentrant lock that the
      // modular mechanism uses. The mechanism itself refreshes once more
      // immediately before checkpointing, so a compaction drop can stand down
      // a stale threshold decision rather than rotating on an old sample.
      const evaluation: any = await evaluateThreshold({ session_key: key, refresh: true })
      if (!evaluation?.ok) return evaluation
      if (!force && evaluation.context_pct == null) {
        return failure(
          "ROTATION_TELEMETRY_UNAVAILABLE",
          "no verified context_pct is available; refusing non-forced rotation without estimation",
          { session_key: key },
        )
      }
      if (!force && evaluation.lifecycle_state !== "ROTATE_PENDING" && evaluation.lifecycle_state !== "HARD_ROTATE") {
        return {
          ok: false,
          status: "ROTATION_NOT_DUE",
          code: "ROTATION_NOT_DUE",
          session_key: key,
          generation: evaluation.generation,
          context_pct: evaluation.context_pct,
          band: evaluation.band,
          recommended_action: evaluation.recommended_action,
          thresholds: evaluation.thresholds,
          detail: "verified context_pct is below the configured rotation band",
        }
      }
      return rotateSessionLockedStrict(key, reason, force)
    })
  }

  async function reconcileRotationsStrict(input?: any) {
    const g = guard()
    if (g) return g
    const result: any = await reconcileEngine.reconcileRotations(input)
    // Older runtime databases can expose a partially prepared C3 storage
    // surface while the T4 facade remains fully usable. Reuse the compatible
    // facade reconciler in that narrow case; never hide schema/config errors.
    if (result?.ok === false && result.code === "SQLITE_RUNTIME_UNAVAILABLE") {
      return reconcileRotations(input)
    }
    return result
  }

  return {
    // diagnostics (storage readiness discovered at construction)
    root,
    diagnostics,
    // required Plan 8 T4 surface
    refreshTelemetry, // lock-free
    evaluateThreshold, // lock-free
    ensureCheckpoint, // acquires globalWithLock(session_key)
    ensureCheckpointLocked, // LOCK-FREE — caller must hold the lock
    rotateSession: rotateSessionStrict, // acquires globalWithLock(session_key)
    rotateSessionLocked: rotateSessionLockedStrict, // LOCK-FREE — caller must hold the lock
    restoreSession, // acquires globalWithLock(session_key)
    restoreSessionLocked, // LOCK-FREE — caller must hold the lock
    reconcileRotations: reconcileRotationsStrict, // acquires globalWithLock per affected key
    listLifecycle, // read-only
    getLifecycleStatus, // read-only unless input.refresh
    // pure observation helper (no lock, no DB write)
    measureSession,
    // config helper (fresh read; exposed for later plugin tool wrappers)
    loadThresholds,
    // Lock-free append-only observation hook used by admission seams to
    // record non-fatal preparation failures through the core event ledger.
    recordLifecycleEvent: insertEvent,
  }
}
