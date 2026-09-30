// Lifecycle Types — shared type/constant module for the Plan 8 lifecycle engine
//
// Plan 8 C1 deliverable. This file defines the shared vocabulary used by ALL
// lifecycle modules (telemetry.ts, state-machine.ts and the future
// lifecycle-core.ts facade):
//
//   verified context telemetry sample / refresh result   (docs/runtime-context-telemetry.md)
//   lifecycle states + actions                            (drawio "02-会话生命周期与调用路由" bands)
//   lifecycle thresholds                                  (framework-config/lifecycle.yaml mirror shape)
//   session reference                                     (runtime/tasks.db `sessions` row identity)
//   lifecycle event record                                (runtime/tasks.db `lifecycle_events` columns)
//   structured errors                                     (same { ok:false, status:"ERROR", code, detail } style
//                                                          as runtime-registry-core.ts / task-bus-core.ts)
//
// Authority boundaries:
// - Architecture source of truth: diagrams/multi_agent_framework_v3_workspace.drawio
// - Telemetry measurement protocol (normative): docs/runtime-context-telemetry.md
//   (T1 verified, OpenCode 2.0.20): values are RECORDED observations, never
//   estimated; when no exact measurement exists the value is null.
// - Rotation bands are declared EXCLUSIVELY in framework-config/lifecycle.yaml
//   (drawio mirror). NO numeric threshold appears in this module or any
//   lifecycle TS file; the state machine loads and validates them fresh from
//   the YAML on every call.
//
// This module is dependency-free (no Bun, no fs, no SQLite, no plugin ctx) and
// is safe to import from any core/plugin file — same policy as
// .opencode/lib/global-lock.ts.

// ---------------------------------------------------------------------------
// Structured errors (house style: runtime-registry-core.ts failure())
// ---------------------------------------------------------------------------

export const LIFECYCLE_ERROR_CODES = [
  "INVALID_INPUT",
  "SQLITE_RUNTIME_UNAVAILABLE",
  "CONFIG_ROOT_NOT_FOUND",
  "CONFIG_LOAD_FAILED",
  "THRESHOLDS_INVALID",
  "SESSION_NOT_FOUND",
  "CONTEXT_READ_FAILED",
  "MODEL_CATALOG_READ_FAILED",
  "UUID_UNAVAILABLE",
  "TELEMETRY_PERSIST_FAILED",
] as const

export type LifecycleErrorCode = (typeof LIFECYCLE_ERROR_CODES)[number]

export interface LifecycleFailure {
  ok: false
  status: "ERROR"
  code: LifecycleErrorCode
  detail: string
  [key: string]: unknown
}

// Canonical structured-failure builder for every lifecycle module. Mirrors the
// private failure() helpers in runtime-registry-core.ts / task-bus-core.ts so
// all lifecycle results serialize identically for tools and logs.
export function lifecycleFailure(
  code: LifecycleErrorCode,
  detail: string,
  extra?: Record<string, unknown>,
): LifecycleFailure {
  return { ok: false, status: "ERROR", code, detail, ...(extra ?? {}) }
}

export function isLifecycleFailure(value: unknown): value is LifecycleFailure {
  const v = value as any
  return !!v && v.ok === false && v.status === "ERROR" && typeof v.code === "string"
}

// Shared trivial helpers (kept here so lifecycle modules never diverge):
export function nowIso(): string {
  return new Date().toISOString()
}

export function errMsg(e: any): string {
  return e?.message ?? String(e)
}

// ---------------------------------------------------------------------------
// Verified context telemetry (docs/runtime-context-telemetry.md §2/§3)
// ---------------------------------------------------------------------------

// TokenUsage.Info exactly as the runtime reports it on an assistant message
// (OpenAPI-confirmed shape; no extra fields). `input` and `cache.read` are
// DISJOINT counters — both are summed, never subtracted (§3.1).
export interface TokenCacheUsage {
  read: number
  write: number
}

export interface TokenUsage {
  input: number
  output: number
  reasoning: number
  cache: TokenCacheUsage
}

// The message's OWN model identity — the catalog lookup key (§2.2).
export interface AssistantModelRef {
  providerID: string
  id: string
}

// Why an exact measurement could not be produced. Every one of these yields
// null (never a fabricated number) per the no-estimation policy (§7).
export const TELEMETRY_UNAVAILABLE_REASONS = [
  // no assistant message carries `tokens` yet (fresh session, or the latest
  // assistant message is still streaming — skipped, never treated as zero)
  "NO_ASSISTANT_MESSAGE_WITH_TOKENS",
  // an assistant message with truthy `tokens` was found but the usage fields
  // are not all finite numbers (malformed payload; never guessed around)
  "TOKEN_USAGE_MALFORMED",
  // the message's own { providerID, id } has no model-catalog entry (§6.5)
  "MODEL_NOT_IN_CATALOG",
  // catalog entry exists but limit.context is missing / not a positive finite
  // number — the UI shows usage:null in this case, so telemetry must too
  "MODEL_LIMIT_CONTEXT_MISSING",
] as const

export type TelemetryUnavailableReason = (typeof TELEMETRY_UNAVAILABLE_REASONS)[number]

// Stable descriptor persisted into sessions.telemetry_source ("verified
// runtime source descriptor" per the Plan 8 T3 schema comment). Names the two
// verified sources of the T1 protocol; contains no version pin (§6.1).
export const TELEMETRY_SOURCE_DESCRIPTOR =
  "last-assistant-message TokenUsage via ctx.session.context() + Model.Info.limit.context via ctx.model.list() (docs/runtime-context-telemetry.md verified protocol)"

// One exact measurement of one session at one point in time.
// tokens !== null  -> a real observation exists (limit/pct may still be null
//                     when the catalog side is unavailable).
// tokens === null  -> nothing was observable; nothing may be persisted as a
//                     measurement and unavailable_reason explains why.
export interface ContextTelemetrySample {
  session_id: string
  tokens: number | null // verified_context_tokens (sum of the five usage fields)
  limit: number | null // verified_context_limit (catalog limit.context of THAT message's model)
  pct: number | null // round(tokens / limit * 100) — UI-identical; null when limit unknown
  source: string | null // TELEMETRY_SOURCE_DESCRIPTOR when tokens were observed, else null
  sampled_at: string // ISO 8601
  model: AssistantModelRef | null // the measured assistant message's own model, when known
  message_id: string | null // the measured assistant message id, when known
  unavailable_reason: TelemetryUnavailableReason | null
}

// The five Plan 8 (registry schema v2) telemetry columns of `sessions`,
// EXACTLY as committed in .opencode/plugins/runtime-registry/schema.sql.
// lifecycle_state is deliberately NOT part of this record: telemetry never
// classifies and never mutates thresholds or state.
export interface SessionTelemetryColumns {
  context_tokens: number | null
  context_limit: number | null
  context_pct: number | null
  telemetry_source: string | null
  telemetry_at: string | null
}

export interface TelemetryRefreshInput {
  session_key: string // sessions.session_key, verbatim (project:<pid>:main|reader or scoped key)
  opencode_session_id?: string // optional override; defaults to the latest registry row's session
}

export interface TelemetryRefreshSuccess {
  ok: true
  // SAMPLED    -> an exact observation existed and was persisted
  //               (context_pct may still be null when the catalog side was
  //               unavailable; unavailable_reason then explains it)
  // UNAVAILABLE -> nothing observable (streaming / no usage); the sessions
  //               telemetry columns were left UNTOUCHED (never cleared,
  //               never fabricated) and the null was recorded in the ledger
  status: "SAMPLED" | "UNAVAILABLE"
  session_key: string
  session_id: string
  generation: number
  project_id: string
  role: string
  context_tokens: number | null
  context_limit: number | null
  context_pct: number | null
  telemetry_source: string | null
  telemetry_at: string | null
  persisted: boolean // true when the five sessions columns were updated
  event_id: string // lifecycle_events.event_id of the appended ledger row
  event_type: LifecycleEventType
  unavailable_reason: TelemetryUnavailableReason | null
  detail?: string
}

export type TelemetryRefreshResult = TelemetryRefreshSuccess | LifecycleFailure

// ---------------------------------------------------------------------------
// Registry session reference (identity of one `sessions` generation row)
// ---------------------------------------------------------------------------

export interface SessionRef {
  session_key: string
  generation: number
  opencode_session_id: string
  project_id: string
  role: string
  status: string // ACTIVE / STALE / ARCHIVED (registry vocabulary, unchanged)
  lifecycle_state: string | null // Plan 8 v2 column; written only by the lifecycle engine
}

// Pure projection from a raw `sessions` row (bun:sqlite row object).
export function sessionRefFromRow(row: any): SessionRef | null {
  if (!row || typeof row !== "object") return null
  return {
    session_key: String(row.session_key),
    generation: Number(row.generation),
    opencode_session_id: String(row.opencode_session_id),
    project_id: String(row.project_id),
    role: String(row.role),
    status: String(row.status),
    lifecycle_state: row.lifecycle_state == null ? null : String(row.lifecycle_state),
  }
}

// ---------------------------------------------------------------------------
// lifecycle_events ledger (EXACT committed columns,
// .opencode/plugins/lifecycle-engine/schema.sql — append-only)
// ---------------------------------------------------------------------------

// Event vocabulary defined by the lifecycle engine (the schema intentionally
// does not constrain event_type). C1 defines the telemetry events; later
// Plan 8 tasks (checkpoint / rotation) extend this list.
export const LIFECYCLE_EVENT_TYPES = [
  "TELEMETRY_SAMPLE", // an exact observation was taken (and, when tokens existed, persisted)
  "TELEMETRY_UNAVAILABLE", // measurement returned null; recorded for audit, columns untouched
] as const

export type LifecycleEventType = (typeof LIFECYCLE_EVENT_TYPES)[number]

// One lifecycle_events row, field-for-field the committed schema columns.
export interface LifecycleEventRecord {
  event_id: string // TEXT PRIMARY KEY
  session_key: string // TEXT NOT NULL, sessions.session_key verbatim
  generation: number | null // INTEGER, the generation the event belongs to
  opencode_session_id: string | null // TEXT, source OpenCode session when available
  event_type: string // TEXT NOT NULL (vocabulary above)
  context_pct: number | null // REAL, verified percent at event time
  checkpoint_path: string | null // TEXT, related checkpoint file when applicable
  details_json: string | null // TEXT, optional structured detail (JSON text)
  created_at: string // TEXT NOT NULL, ISO 8601
}

// ---------------------------------------------------------------------------
// Lifecycle states / actions (drawio rotation bands; thresholds live ONLY in
// framework-config/lifecycle.yaml — no numeric band edge appears here)
// ---------------------------------------------------------------------------

export const LIFECYCLE_STATES = [
  "ACTIVE", // below the reuse band — continue reuse (Reader especially)
  "CHECKPOINT_READY", // checkpoint band — prepare checkpoint; no large new tasks
  "ROTATE_PENDING", // at/above the rotate band — rotate after the current atomic step; old gen -> ARCHIVED
  "HARD_ROTATE", // at/above the hard band — no new task dispatch; forced rotation
] as const

export type LifecycleState = (typeof LIFECYCLE_STATES)[number]

// Advisory action each state maps to. Classification NEVER executes anything:
// automatic rotation stays disabled by the framework.yaml flags until the
// Plan 8 smoke phase; the facade decides if/when an action runs.
export const LIFECYCLE_ACTIONS = [
  "NONE",
  "PREPARE_CHECKPOINT",
  "ROTATE_AFTER_ATOMIC_STEP",
  "STOP_NEW_TASKS_AND_FORCE_ROTATE",
] as const

export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number]

// Validated, flattened mirror of the framework-config/lifecycle.yaml
// context_rotation block. Field names follow the YAML keys so any mismatch
// with the drawio mirror is traceable. Populated ONLY by
// state-machine.ts loadLifecycleThresholds()/parseThresholds() — never by
// hand and never from a TS literal.
export interface LifecycleThresholds {
  continue_reuse_below_percent: number
  checkpoint_prepare_from_percent: number
  checkpoint_prepare_to_percent: number
  rotate_after_atomic_step_at_percent: number
  hard_stop_new_tasks_at_percent: number
}

export interface ThresholdsLoadSuccess {
  ok: true
  thresholds: LifecycleThresholds // frozen; consumers must never mutate
  source_file: string // absolute path actually read
  loaded_at: string // ISO 8601 (thresholds are re-read fresh on every call)
}

export type ThresholdsLoadResult = ThresholdsLoadSuccess | LifecycleFailure

// Result of classifying one verified context_pct against one loaded threshold
// set. state === null (with action NONE) is the mandated behavior when
// context_pct is unknown: no verified measurement -> no state, no automatic
// action, ever (docs/runtime-context-telemetry.md §7).
export interface LifecycleClassification {
  state: LifecycleState | null
  action: LifecycleAction
  context_pct: number | null // echoed input (null stays null; never estimated)
  reason: string // human-readable band explanation naming the YAML fields
  thresholds_source: string // where the thresholds came from
}
