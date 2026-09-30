// Lifecycle Checkpoint Core — Plan 8 C2 (checkpoint write / read / validate / restore-context)
//
// Implements the Checkpoint v1 contract defined by the ALREADY COMMITTED
// templates/checkpoint.schema.json (exact fields, additionalProperties:false,
// summary maxLength 20000) and follows the verified telemetry protocol in
// docs/runtime-context-telemetry.md (§7 no-estimation policy: context numbers
// are recorded observations only — when no verified measurement exists they
// are recorded as zeros with an explicit "unavailable:..." source, never
// estimated, never guessed).
//
// Storage layout (runtime state, git-ignored via /runtime/ in .gitignore):
//
//   runtime/checkpoints/<safe-session-key>/gen-XXXX-<checkpoint-id>.json
//
// <safe-session-key> is a DETERMINISTIC, injective percent-encoding of the
// verbatim sessions.session_key (every byte outside [A-Za-z0-9._-] becomes
// %XX uppercase hex of its UTF-8 byte), plus Windows guards (trailing dot
// re-encoding, reserved device-name prefix, length cap with sha256 suffix).
// <generation> is zero-padded to at least 4 digits (gen-0001).
//
// Writes are ATOMIC: temp file in the SAME directory -> write -> fsync ->
// close -> rename. A partially written checkpoint can never be observed.
//
// Authority / safety boundaries (Plan 8 C2 scope):
// - This module NEVER writes to runtime/tasks.db (SELECT/PRAGMA reads only);
//   lifecycle-core owns sessions.checkpoint_path / lifecycle_events /
//   lifecycle_rotations updates. No tables are added anywhere.
// - This module NEVER calls Mem0. restore_refs.mem0 carries opaque reference
//   strings ONLY (mirrors framework-config/lifecycle.yaml
//   rotation_restore_context: required-mem0-context).
// - Git access is limited to exactly three read-only commands:
//   `git branch --show-current`, `git rev-parse HEAD`, `git status --short`.
// - No full chat dumps and no secrets: the summary prefers a TRANSIENT
//   ctx.session.generate condensation; the fallback embeds structured runtime
//   state plus a LIMITED recent-context window (<= MAX_RECENT_MESSAGES
//   messages, total summary clamped to <= 20,000 chars) with
//   summary_source = "fallback-recent-context", and every summary passes a
//   deterministic secret-redaction filter.
// - NO threshold / context-window / rotation-band logic lives here. The
//   60/70/80 bands are declared exclusively in framework-config/lifecycle.yaml
//   and evaluated by lifecycle-core. This module only records what it is told
//   or what the registry already verified.
//
// CONTRACT NOTE (shared types): `.opencode/lib/lifecycle/types.ts` does NOT
// exist yet at C2 delivery time, so this file defines the shared structural
// types locally and exports them as the stable interface for lifecycle-core:
//
//   CheckpointV1 / CheckpointContext / CheckpointRuntimeState /
//   CheckpointGitState / CheckpointRestoreRefs          — schema v1 mirrors
//   CheckpointCoreLike   — structural subset of the runtime registry core
//                          ({ root, db, dbError?, parseRuntimeId? }) returned
//                          by createRuntimeRegistryCore()
//   SessionCtxLike       — structural subset of the OpenCode V2 plugin ctx
//                          ({ session?: { generate?, context? } })
//   createCheckpoint(core, ctx, input)  -> Promise<CreateCheckpointResult>
//   loadCheckpoint(source)              -> LoadCheckpointResult
//   validateCheckpoint(value)           -> CheckpointValidationResult
//   atomicWriteCheckpoint(filePath, data) -> AtomicWriteResult
//   collectRuntimeRefs(core, input)     -> RuntimeRefsResult   (sync)
//   collectGitState(repositoryPath)     -> GitStateResult      (sync)
//   buildRestoreContext(source, opts?)  -> RestoreContextResult
//   path helpers: safeSessionKeyDir / checkpointFileName / checkpointFilePath
//                 / checkpointRelativePath / listCheckpoints /
//                 loadLatestCheckpoint
//
// If a shared types.ts is introduced later, these exported names are the
// intended shared surface and can be re-exported from there unchanged.
//
// Runtime facts: Bun 1.4.2 / bun:sqlite verified on this machine (see
// runtime-registry-core.ts header). node:crypto / node:fs / node:path /
// node:child_process are used portably; Bun.spawnSync is preferred for git
// with a node:child_process fallback.

import * as fs from "node:fs"
import * as path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"

import { parseRuntimeId as coreParseRuntimeId } from "../runtime-registry-core.ts"

// =====================================================================
// Constants (stable interface — lifecycle-core may import these)
// =====================================================================

export const CHECKPOINT_SCHEMA_VERSION = 1

/** Exact Checkpoint v1 top-level fields, in schema order (additionalProperties:false). */
export const CHECKPOINT_FIELDS = [
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
] as const

/** templates/checkpoint.schema.json: summary maxLength. */
export const MAX_SUMMARY_CHARS = 20000

/** summary_source when ctx.session.generate produced the transient summary. */
export const SUMMARY_SOURCE_GENERATE = "session-generate"
/** summary_source mandated for the structured-state + limited-recent-context fallback. */
export const SUMMARY_SOURCE_FALLBACK = "fallback-recent-context"
/** summary_source when the caller supplied a ready-made summary. */
export const SUMMARY_SOURCE_CALLER = "caller-provided"
/** context.source when the registry carries no verified telemetry (never estimated). */
export const CONTEXT_SOURCE_UNAVAILABLE = "unavailable:no-verified-telemetry"
/** context.source when telemetry came from the sessions row of runtime/tasks.db. */
export const CONTEXT_SOURCE_REGISTRY = "registry:sessions"

/** Checkpoint directory under the framework root (runtime state, git-ignored). */
export const CHECKPOINTS_DIR_PARTS = ["runtime", "checkpoints"] as const

/** Fallback recent-context window: hard message cap (never a full chat dump). */
export const MAX_RECENT_MESSAGES = 12
/** Per-message character cap inside the recent-context window. */
export const MAX_RECENT_MESSAGE_CHARS = 2000
/** Total character budget for the recent-context block. */
export const RECENT_CONTEXT_CHAR_BUDGET = 12000
/** `git status --short` lines recorded in git_state.status_short (deterministic cap). */
export const MAX_GIT_STATUS_LINES = 200
/** Default total cap for the buildRestoreContext synthetic message text. */
export const RESTORE_CONTEXT_MAX_CHARS = 24000
/** Safe-directory segment length cap before hash-suffix truncation. */
export const SAFE_DIR_MAX_CHARS = 100
/** Filename segment length cap before hash-suffix truncation. */
export const SAFE_SEGMENT_MAX_CHARS = 100

/** Task states that are NOT terminal (framework-config/task-bus.yaml state_machine). */
export const ACTIVE_TASK_STATUSES = ["READY", "RUNNING", "BLOCKED"] as const
/** Workflow states that are NOT terminal (Plan 7 workflow engine vocabulary). */
export const ACTIVE_WORKFLOW_STATUSES = ["PLANNING", "RUNNING", "REVIEWING", "REWORKING"] as const

const GIT_TIMEOUT_MS = 10000
const PER_MESSAGE_TRUNCATION_MARKER = " […per-message truncated]"
const SUMMARY_TRUNCATION_MARKER = "\n[… summary truncated to checkpoint schema maxLength 20000]"

// =====================================================================
// Types — Checkpoint v1 (exact mirror of templates/checkpoint.schema.json)
// =====================================================================

export interface CheckpointContext {
  /** Verified last-assistant-message token sum at checkpoint time (0 when unavailable). */
  tokens: number
  /** Verified catalog limit.context at checkpoint time (0 when unavailable). */
  limit: number
  /** round(tokens/limit*100) per docs/runtime-context-telemetry.md (0 when unavailable). */
  percent: number
  /** Where the numbers came from; "unavailable:no-verified-telemetry" when none existed. */
  source: string
}

export interface CheckpointRuntimeState {
  active_task_ids: string[]
  active_workflow_ids: string[]
}

export interface CheckpointGitState {
  repository: string
  branch: string
  head: string
  status_short: string[]
}

export interface CheckpointRestoreRefs {
  project_docs: string[]
  /** Opaque Mem0 reference strings ONLY — this module never calls Mem0. */
  mem0: string[]
  /** `task:<task_id>` references for active tasks. */
  tasks: string[]
  /** `workflow:<workflow_id>` references for active workflows. */
  workflows: string[]
}

export interface CheckpointV1 {
  schema_version: 1
  checkpoint_id: string
  session_key: string
  project_id: string
  role: string
  generation: number
  session_id: string
  model_runtime_id: string | null
  context: CheckpointContext
  runtime_state: CheckpointRuntimeState
  git_state: CheckpointGitState
  restore_refs: CheckpointRestoreRefs
  summary: string
  summary_source: string
  created_at: string
}

// =====================================================================
// Types — structural dependency contracts (shared types.ts not present yet)
// =====================================================================

/**
 * Structural subset of the object returned by createRuntimeRegistryCore()
 * (.opencode/lib/runtime-registry-core.ts). Checkpoint code only READS
 * core.db (SELECT/PRAGMA) and uses core.root for path resolution.
 */
export interface CheckpointCoreLike {
  /** Framework root (the directory containing framework-config/ and runtime/). */
  root: string
  /** Shared runtime/tasks.db bun:sqlite handle, or null when unavailable. */
  db: any | null
  /** Populated when db is null. */
  dbError?: string | null
  /** Exposed by the core; falls back to the module-level export when absent. */
  parseRuntimeId?: (runtimeId: unknown) => { providerID: string; id: string; variant?: string } | null
}

/**
 * Structural subset of the OpenCode V2 plugin ctx used here. Both members are
 * probed defensively at call time (docs/runtime-context-telemetry.md §6.6:
 * API surface must be verified empirically; every failure degrades to the
 * deterministic fallback summary, never to a fabricated value).
 */
export interface SessionCtxLike {
  session?: {
    /** Transient one-shot generation (preferred summary source). */
    generate?: (args: any) => Promise<any>
    /** Live model context, compaction-bounded (fallback recent-context source). */
    context?: (args: { sessionID: string }) => Promise<any>
  } | null
}

export interface CreateCheckpointInput {
  /** sessions.session_key, verbatim (stored verbatim in the checkpoint). */
  session_key: string
  project_id: string
  role: string
  /** sessions.generation being checkpointed (integer >= 1). */
  generation: number
  /** OpenCode session id of the generation being checkpointed. */
  session_id: string
  /** Defaults to the sessions row value; null when unknown. Never guessed. */
  model_runtime_id?: string | null
  /** Verified telemetry override; defaults to the sessions row; zeros when absent. */
  context?: CheckpointContext | null
  /** Repository path for git_state; defaults to sessions.project_path, then core.root. */
  repository_path?: string | null
  /** restore_refs.project_docs override; defaults to deterministic existing-doc candidates. */
  project_docs?: string[] | null
  /** restore_refs.mem0 opaque reference strings (never a Mem0 call). */
  mem0_refs?: string[] | null
  /** Pre-made summary (skips generate/fallback). */
  summary?: string | null
  /** summary_source for a pre-made summary (default "caller-provided"). */
  summary_source?: string | null
  /** Explicit checkpoint_id (default: randomUUID). */
  checkpoint_id?: string | null
  /** Explicit created_at ISO string (default: now). */
  created_at?: string | null
}

export interface CheckpointWarnings {
  warnings: string[]
}

export type CreateCheckpointResult =
  | ({
      ok: true
      status: "WRITTEN"
      checkpoint_id: string
      session_key: string
      generation: number
      /** Root-relative POSIX path for sessions.checkpoint_path / lifecycle tables. */
      checkpoint_path: string
      checkpoint_path_abs: string
      summary_source: string
      checkpoint: CheckpointV1
    } & CheckpointWarnings)
  | { ok: false; status: string; code: string; detail: string; [k: string]: unknown }

export interface RuntimeRefsResult extends CheckpointWarnings {
  ok: true
  status: "OK"
  runtime_state: CheckpointRuntimeState
  restore_refs: CheckpointRestoreRefs
}

export interface CollectRuntimeRefsInput {
  session_key: string
  project_id: string
  role: string
  /** Used for the default project-doc candidates; may be null. */
  project_path?: string | null
  /** Overrides the default project-doc candidates (existence-filtered). */
  project_docs?: string[] | null
  /** Opaque Mem0 reference strings; default []. */
  mem0_refs?: string[] | null
}

export interface GitStateResult extends CheckpointWarnings {
  ok: true
  status: "OK"
  git_state: CheckpointGitState
}

export interface CheckpointValidationResult {
  valid: boolean
  errors: string[]
}

export type LoadCheckpointSource =
  | string
  | { path: string }
  | { root: string; session_key: string; generation: number; checkpoint_id: string }

export type LoadCheckpointResult =
  | {
      ok: true
      status: "OK"
      checkpoint: CheckpointV1
      checkpoint_path_abs: string
      checkpoint_path: string | null
    }
  | { ok: false; status: string; code: string; detail: string; [k: string]: unknown }

export interface AtomicWriteResult {
  ok: boolean
  status?: "WRITTEN"
  code?: string
  detail?: string
  path?: string
  bytes?: number
}

export interface RestoreContext {
  checkpoint_id: string
  session_key: string
  project_id: string
  role: string
  generation: number
  /** Bounded synthetic-message text for the successor session (ctx.session.synthetic). */
  text: string
  truncated: boolean
  active_task_ids: string[]
  active_workflow_ids: string[]
  project_docs: string[]
  mem0_refs: string[]
}

export type RestoreContextResult =
  | { ok: true; status: "OK"; restore_context: RestoreContext }
  | { ok: false; status: string; code: string; detail: string; [k: string]: unknown }

export interface CheckpointListEntry {
  checkpoint_id: string
  generation: number
  file_name: string
  path_abs: string
  /** Root-relative POSIX path, or null when not under core.root. */
  path_relative: string | null
}

// =====================================================================
// Small utilities (same conventions as runtime-registry-core.ts)
// =====================================================================

function nowIso(): string {
  return new Date().toISOString()
}

function errMsg(e: any): string {
  return e?.message ?? String(e)
}

function failure(code: string, detail: string, extra?: Record<string, unknown>) {
  return { ok: false, status: "ERROR", code, detail, ...(extra ?? {}) }
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const it of items) {
    if (seen.has(it)) continue
    seen.add(it)
    out.push(it)
  }
  return out
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex")
}

function toPosixRelative(root: string, abs: string): string | null {
  const rel = path.relative(root, abs)
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null
  return rel.split(path.sep).join("/")
}

/**
 * Deterministic secret redaction (defense in depth for "no secrets"; the
 * primary guarantee is that checkpoints never embed raw chat dumps or
 * credentials). Replaces obvious credential shapes with [REDACTED].
 */
const SECRET_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  {
    re: /((?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?key|private[_-]?key|auth|authorization|token|credential|mysql_pass)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
    replacement: "$1[REDACTED]",
  },
  { re: /\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, replacement: "$1[REDACTED]" },
  { re: /\bsk-[A-Za-z0-9_-]{8,}\b/g, replacement: "[REDACTED]" },
  { re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/g, replacement: "[REDACTED]" },
]

export function redactSecrets(text: string): string {
  let out = text
  for (const p of SECRET_PATTERNS) out = out.replace(p.re, p.replacement)
  return out
}

/** Enforce schema summary bounds: non-empty and <= MAX_SUMMARY_CHARS. */
export function clampSummary(text: string): string {
  let out = text.trim()
  if (!out) out = "(empty summary)"
  if (out.length > MAX_SUMMARY_CHARS) {
    const keep = MAX_SUMMARY_CHARS - SUMMARY_TRUNCATION_MARKER.length
    out = out.slice(0, Math.max(0, keep)) + SUMMARY_TRUNCATION_MARKER
  }
  return out
}

// =====================================================================
// Deterministic path sanitization (Windows-safe, injective below the cap)
// =====================================================================

const SAFE_SEGMENT_ALLOWED = /[A-Za-z0-9._-]/
// Windows reserved device names (case-insensitive), bare or as "NAME.ext..."
const WINDOWS_RESERVED_STEMS = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
])

/**
 * Percent-encode every UTF-8 byte outside [A-Za-z0-9._-] as %XX (uppercase
 * hex). Deterministic and injective, so distinct session_keys can never
 * collide onto the same directory name (below the length cap; above it a
 * sha256 suffix restores uniqueness). ':' -> %3A, '\\' -> %5C, '/' -> %2F,
 * '<' -> %3C, '>' -> %3E, '"' -> %22, '|' -> %7C, '?' -> %3F, '*' -> %2A,
 * control bytes -> %00-%1F, space -> %20, and every non-ASCII character is
 * encoded byte-wise.
 */
export function safePercentEncode(value: string): string {
  let out = ""
  for (const byte of Buffer.from(value, "utf8")) {
    const ch = String.fromCharCode(byte)
    if (SAFE_SEGMENT_ALLOWED.test(ch)) out += ch
    else out += "%" + byte.toString(16).toUpperCase().padStart(2, "0")
  }
  return out
}

function fixTrailingDot(encoded: string): string {
  // A directory/file name must not END with '.' on Windows ('.' is otherwise
  // allowed and stays readable inside the segment).
  if (encoded.endsWith(".")) return encoded.slice(0, -1) + "%2E"
  return encoded
}

function capWithHash(encoded: string, original: string, maxChars: number): string {
  if (encoded.length <= maxChars) return encoded
  const suffix = "-" + sha256Hex(original).slice(0, 16)
  return fixTrailingDot(encoded.slice(0, Math.max(1, maxChars - suffix.length)) + suffix)
}

/**
 * Sanitize a filename segment (e.g. checkpoint_id) deterministically:
 * percent-encode invalid bytes, guard reserved stems and trailing dots,
 * cap length with a sha256 suffix. Never empty ("_" fallback).
 */
export function safeFileNameSegment(value: string): string {
  if (typeof value !== "string" || !value) return "_"
  let out = safePercentEncode(value)
  const stem = out.split(".")[0].toUpperCase()
  if (WINDOWS_RESERVED_STEMS.has(stem)) out = "_" + out
  out = fixTrailingDot(out)
  out = capWithHash(out, value, SAFE_SEGMENT_MAX_CHARS)
  return out || "_"
}

/**
 * Deterministic Windows-safe directory name for a verbatim session_key
 * (e.g. "project:ruoyi-vue-pro:main" -> "project%3Aruoyi-vue-pro%3Amain",
 * "workflow:wf-1:planner" -> "workflow%3Awf-1%3Aplanner"). Injective below
 * SAFE_DIR_MAX_CHARS; hash-suffixed above it.
 */
export function safeSessionKeyDir(sessionKey: string): string {
  if (typeof sessionKey !== "string" || !sessionKey) return "_empty"
  let out = safePercentEncode(sessionKey)
  const stem = out.split(".")[0].toUpperCase()
  if (WINDOWS_RESERVED_STEMS.has(stem)) out = "_" + out
  out = fixTrailingDot(out)
  out = capWithHash(out, sessionKey, SAFE_DIR_MAX_CHARS)
  return out || "_empty"
}

/** gen-XXXX-<safe-checkpoint-id>.json (generation padded to >= 4 digits). */
export function checkpointFileName(generation: number, checkpointId: string): string {
  const gen = String(Math.trunc(generation)).padStart(4, "0")
  return `gen-${gen}-${safeFileNameSegment(checkpointId)}.json`
}

export function checkpointDirPath(root: string, sessionKey: string): string {
  return path.join(root, ...CHECKPOINTS_DIR_PARTS, safeSessionKeyDir(sessionKey))
}

export function checkpointFilePath(root: string, sessionKey: string, generation: number, checkpointId: string): string {
  return path.join(checkpointDirPath(root, sessionKey), checkpointFileName(generation, checkpointId))
}

/** Root-relative POSIX form for sessions.checkpoint_path / lifecycle tables. */
export function checkpointRelativePath(root: string, sessionKey: string, generation: number, checkpointId: string): string {
  return [...CHECKPOINTS_DIR_PARTS, safeSessionKeyDir(sessionKey), checkpointFileName(generation, checkpointId)].join("/")
}

// =====================================================================
// validateCheckpoint — structural Checkpoint v1 validation (schema mirror)
// =====================================================================

const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/

function checkExactKeys(obj: Record<string, unknown>, allowed: readonly string[], label: string, errors: string[]) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) errors.push(`${label}: unexpected property '${key}' (additionalProperties:false)`)
  }
  for (const key of allowed) {
    if (!(key in obj)) errors.push(`${label}: missing required property '${key}'`)
  }
}

function checkNonEmptyString(v: unknown, label: string, errors: string[]) {
  if (!isNonEmptyString(v)) errors.push(`${label}: must be a non-empty string`)
}

function checkStringArray(v: unknown, label: string, errors: string[]) {
  if (!Array.isArray(v)) {
    errors.push(`${label}: must be an array of strings`)
    return
  }
  v.forEach((item, i) => {
    if (typeof item !== "string") errors.push(`${label}[${i}]: must be a string`)
  })
}

/**
 * Validate an arbitrary value against Checkpoint v1
 * (templates/checkpoint.schema.json). Pure and synchronous; returns ALL
 * detected problems (never throws).
 */
export function validateCheckpoint(value: unknown): CheckpointValidationResult {
  const errors: string[] = []
  if (!isPlainObject(value)) {
    return { valid: false, errors: ["checkpoint: must be a JSON object"] }
  }
  checkExactKeys(value, CHECKPOINT_FIELDS, "checkpoint", errors)

  if (value.schema_version !== CHECKPOINT_SCHEMA_VERSION) {
    errors.push(`checkpoint.schema_version: must be the constant 1, got ${JSON.stringify(value.schema_version)}`)
  }
  checkNonEmptyString(value.checkpoint_id, "checkpoint.checkpoint_id", errors)
  checkNonEmptyString(value.session_key, "checkpoint.session_key", errors)
  checkNonEmptyString(value.project_id, "checkpoint.project_id", errors)
  checkNonEmptyString(value.role, "checkpoint.role", errors)
  if (!Number.isInteger(value.generation) || (value.generation as number) < 1) {
    errors.push(`checkpoint.generation: must be an integer >= 1, got ${JSON.stringify(value.generation)}`)
  }
  checkNonEmptyString(value.session_id, "checkpoint.session_id", errors)
  if (value.model_runtime_id !== null && typeof value.model_runtime_id !== "string") {
    errors.push("checkpoint.model_runtime_id: must be a string or null")
  }

  // context
  if (!isPlainObject(value.context)) {
    errors.push("checkpoint.context: must be an object")
  } else {
    const c = value.context as Record<string, unknown>
    checkExactKeys(c, ["tokens", "limit", "percent", "source"], "checkpoint.context", errors)
    if (!Number.isInteger(c.tokens) || (c.tokens as number) < 0) {
      errors.push(`checkpoint.context.tokens: must be an integer >= 0, got ${JSON.stringify(c.tokens)}`)
    }
    if (!Number.isInteger(c.limit) || (c.limit as number) < 0) {
      errors.push(`checkpoint.context.limit: must be an integer >= 0, got ${JSON.stringify(c.limit)}`)
    }
    if (typeof c.percent !== "number" || !Number.isFinite(c.percent) || c.percent < 0 || c.percent > 100) {
      errors.push(`checkpoint.context.percent: must be a number in [0,100], got ${JSON.stringify(c.percent)}`)
    }
    checkNonEmptyString(c.source, "checkpoint.context.source", errors)
  }

  // runtime_state
  if (!isPlainObject(value.runtime_state)) {
    errors.push("checkpoint.runtime_state: must be an object")
  } else {
    const r = value.runtime_state as Record<string, unknown>
    checkExactKeys(r, ["active_task_ids", "active_workflow_ids"], "checkpoint.runtime_state", errors)
    checkStringArray(r.active_task_ids, "checkpoint.runtime_state.active_task_ids", errors)
    checkStringArray(r.active_workflow_ids, "checkpoint.runtime_state.active_workflow_ids", errors)
  }

  // git_state
  if (!isPlainObject(value.git_state)) {
    errors.push("checkpoint.git_state: must be an object")
  } else {
    const g = value.git_state as Record<string, unknown>
    checkExactKeys(g, ["repository", "branch", "head", "status_short"], "checkpoint.git_state", errors)
    checkNonEmptyString(g.repository, "checkpoint.git_state.repository", errors)
    if (typeof g.branch !== "string") errors.push("checkpoint.git_state.branch: must be a string (may be empty)")
    if (typeof g.head !== "string") errors.push("checkpoint.git_state.head: must be a string (may be empty)")
    checkStringArray(g.status_short, "checkpoint.git_state.status_short", errors)
  }

  // restore_refs
  if (!isPlainObject(value.restore_refs)) {
    errors.push("checkpoint.restore_refs: must be an object")
  } else {
    const rr = value.restore_refs as Record<string, unknown>
    checkExactKeys(rr, ["project_docs", "mem0", "tasks", "workflows"], "checkpoint.restore_refs", errors)
    checkStringArray(rr.project_docs, "checkpoint.restore_refs.project_docs", errors)
    checkStringArray(rr.mem0, "checkpoint.restore_refs.mem0", errors)
    checkStringArray(rr.tasks, "checkpoint.restore_refs.tasks", errors)
    checkStringArray(rr.workflows, "checkpoint.restore_refs.workflows", errors)
  }

  // summary / summary_source / created_at
  if (typeof value.summary !== "string" || value.summary.length < 1 || value.summary.length > MAX_SUMMARY_CHARS) {
    errors.push(
      `checkpoint.summary: must be a string with 1..${MAX_SUMMARY_CHARS} chars, got length ` +
        (typeof value.summary === "string" ? String(value.summary.length) : JSON.stringify(value.summary)),
    )
  }
  checkNonEmptyString(value.summary_source, "checkpoint.summary_source", errors)
  if (typeof value.created_at !== "string" || !ISO_DATETIME_RE.test(value.created_at) || Number.isNaN(Date.parse(value.created_at))) {
    errors.push(`checkpoint.created_at: must be an ISO 8601 date-time string, got ${JSON.stringify(value.created_at)}`)
  }

  return { valid: errors.length === 0, errors }
}

// =====================================================================
// atomicWriteCheckpoint — tmp file in same dir -> write -> fsync -> close -> rename
// =====================================================================

let tmpCounter = 0

/**
 * Atomically write JSON data to filePath: serialize, write a unique temp
 * file IN THE SAME DIRECTORY, fsync the file descriptor, close it, then
 * rename over the target (atomic commit on the same volume). The temp file
 * is removed on any failure; readers never observe a partial checkpoint.
 */
export function atomicWriteCheckpoint(filePath: string, data: unknown): AtomicWriteResult {
  if (!isNonEmptyString(filePath)) {
    return { ok: false, code: "INVALID_INPUT", detail: "filePath must be a non-empty string" }
  }
  const serialized = JSON.stringify(data, null, 2) + "\n"
  const dir = path.dirname(filePath)
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${++tmpCounter}-${randomUUID().slice(0, 8)}`
  let fd: number | null = null
  try {
    fs.mkdirSync(dir, { recursive: true })
    fd = fs.openSync(tmpPath, "w")
    fs.writeSync(fd, serialized)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    fs.renameSync(tmpPath, filePath)
    return { ok: true, status: "WRITTEN", path: filePath, bytes: Buffer.byteLength(serialized, "utf8") }
  } catch (e: any) {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {}
    }
    try {
      fs.unlinkSync(tmpPath)
    } catch {}
    return { ok: false, code: "CHECKPOINT_WRITE_FAILED", detail: `${errMsg(e)} (path: ${filePath})` }
  }
}

// =====================================================================
// SQLite read helpers (READ ONLY — this module never writes to the db)
// =====================================================================

function tableExists(db: any, name: string): boolean {
  try {
    return !!db.query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(name)
  } catch {
    return false
  }
}

function sqlInPlaceholders(values: readonly string[]): string {
  return values.map(() => "?").join(", ")
}

interface SessionRowLite {
  session_key: string
  project_id: string
  role: string
  generation: number
  opencode_session_id: string
  model_runtime_id: string | null
  project_path: string | null
  context_tokens: number | null
  context_limit: number | null
  context_pct: number | null
  telemetry_source: string | null
}

function readSessionRow(core: CheckpointCoreLike, sessionKey: string, generation: number): { row: SessionRowLite | null; warnings: string[] } {
  const warnings: string[] = []
  const db = core.db
  if (!db) {
    warnings.push(`registry db unavailable (${core.dbError ?? "no handle"}); session-row defaults skipped`)
    return { row: null, warnings }
  }
  if (!tableExists(db, "sessions")) {
    warnings.push("sessions table missing in runtime/tasks.db; session-row defaults skipped")
    return { row: null, warnings }
  }
  const cols =
    "session_key, project_id, role, generation, opencode_session_id, model_runtime_id, project_path, " +
    "context_tokens, context_limit, context_pct, telemetry_source"
  try {
    const exact: any = db.query(`SELECT ${cols} FROM sessions WHERE session_key = ? AND generation = ?`).get(sessionKey, generation)
    if (exact) return { row: exact as SessionRowLite, warnings }
    warnings.push(`no sessions row for (${sessionKey}, generation ${generation}); falling back to the latest row of the key`)
    const latest: any = db.query(`SELECT ${cols} FROM sessions WHERE session_key = ? ORDER BY generation DESC LIMIT 1`).get(sessionKey)
    return { row: (latest as SessionRowLite) ?? null, warnings }
  } catch (e: any) {
    warnings.push(`sessions row read failed: ${errMsg(e)}`)
    return { row: null, warnings }
  }
}

// =====================================================================
// collectRuntimeRefs — active tasks/workflows + restore refs from runtimeCore.db
// =====================================================================

/**
 * Collect the runtime half of a checkpoint from the SHARED runtime/tasks.db
 * (READ ONLY; no tables added):
 *
 * - active tasks: tasks.target_session_key = session_key with a non-terminal
 *   status (READY / RUNNING / BLOCKED per framework-config/task-bus.yaml);
 * - active workflows: union of (a) the workflow id embedded in a
 *   `workflow:<id>:...` session_key, (b) workflows whose current node task
 *   targets this session_key, (c) workflows with primary_project_id =
 *   project_id — each kept only when its workflows.status is non-terminal
 *   (PLANNING / RUNNING / REVIEWING / REWORKING);
 * - restore_refs.tasks / .workflows: `task:<id>` / `workflow:<id>` references;
 * - restore_refs.project_docs: input override (existence-filtered) or the
 *   deterministic candidate list [<project_path>/AGENTS.md,
 *   <project_path>/README.md, <root>/AGENTS.md, <root>/docs/plan-status.md]
 *   filtered to existing files;
 * - restore_refs.mem0: opaque reference strings from the caller ONLY —
 *   Mem0 is NEVER called from here.
 *
 * Missing tables / missing db degrade to empty arrays plus warnings: a
 * checkpoint must remain writable so rotation is never blocked by an
 * unrelated plugin's schema not being initialized yet.
 */
export function collectRuntimeRefs(core: CheckpointCoreLike, input: CollectRuntimeRefsInput): RuntimeRefsResult {
  const warnings: string[] = []
  const activeTaskIds: string[] = []
  const activeWorkflowIds: string[] = []

  const db = core.db
  if (!db) {
    warnings.push(`registry db unavailable (${core.dbError ?? "no handle"}); runtime_state recorded as empty`)
  } else {
    // --- active tasks ---
    if (!tableExists(db, "tasks")) {
      warnings.push("tasks table missing in runtime/tasks.db; active_task_ids recorded as empty")
    } else {
      try {
        const rows: any[] = db
          .query(
            "SELECT task_id FROM tasks WHERE target_session_key = ? AND status IN (" +
              sqlInPlaceholders(ACTIVE_TASK_STATUSES) +
              ") ORDER BY created_at ASC, task_id ASC",
          )
          .all(input.session_key, ...ACTIVE_TASK_STATUSES)
        for (const r of rows) if (isNonEmptyString(r?.task_id)) activeTaskIds.push(r.task_id)
      } catch (e: any) {
        warnings.push(`active task query failed: ${errMsg(e)}`)
      }
    }

    // --- active workflow candidates ---
    const candidates = new Set<string>()
    const keyParts = input.session_key.split(":")
    if (keyParts[0] === "workflow" && isNonEmptyString(keyParts[1])) {
      // session-scoped workflow key: workflow:<id>:<role...>
      candidates.add(keyParts[1])
    }
    if (tableExists(db, "workflows")) {
      try {
        if (tableExists(db, "tasks") && activeTaskIds.length > 0) {
          const linked: any[] = db
            .query(
              "SELECT DISTINCT n.workflow_id AS workflow_id FROM workflow_nodes n " +
                "JOIN tasks t ON t.task_id = n.current_task_id " +
                "WHERE t.target_session_key = ? AND t.status IN (" +
                sqlInPlaceholders(ACTIVE_TASK_STATUSES) +
                ")",
            )
            .all(input.session_key, ...ACTIVE_TASK_STATUSES)
          for (const r of linked) if (isNonEmptyString(r?.workflow_id)) candidates.add(r.workflow_id)
        }
      } catch (e: any) {
        warnings.push(`workflow-node link query failed: ${errMsg(e)}`)
      }
      try {
        const byProject: any[] = db
          .query(
            "SELECT workflow_id FROM workflows WHERE primary_project_id = ? AND status IN (" +
              sqlInPlaceholders(ACTIVE_WORKFLOW_STATUSES) +
              ") ORDER BY created_at ASC, workflow_id ASC",
          )
          .all(input.project_id, ...ACTIVE_WORKFLOW_STATUSES)
        for (const r of byProject) if (isNonEmptyString(r?.workflow_id)) candidates.add(r.workflow_id)
      } catch (e: any) {
        warnings.push(`project workflow query failed: ${errMsg(e)}`)
      }
      // keep candidates only when verified non-terminal
      for (const id of [...candidates].sort()) {
        try {
          const row: any = db.query("SELECT status FROM workflows WHERE workflow_id = ?").get(id)
          if (row && (ACTIVE_WORKFLOW_STATUSES as readonly string[]).includes(String(row.status))) activeWorkflowIds.push(id)
        } catch (e: any) {
          warnings.push(`workflow status check failed for '${id}': ${errMsg(e)}`)
        }
      }
    } else {
      warnings.push("workflows table missing in runtime/tasks.db; active_workflow_ids recorded as empty")
    }
  }

  // --- restore_refs.project_docs ---
  let projectDocs: string[] = []
  if (Array.isArray(input.project_docs)) {
    for (const doc of input.project_docs) {
      if (typeof doc !== "string" || !doc) continue
      if (fs.existsSync(doc)) projectDocs.push(doc)
      else warnings.push(`project_docs entry does not exist and was skipped: ${doc}`)
    }
  } else {
    const candidates: string[] = []
    const projectPath = isNonEmptyString(input.project_path) ? input.project_path : null
    if (projectPath) {
      candidates.push(path.join(projectPath, "AGENTS.md"), path.join(projectPath, "README.md"))
    }
    candidates.push(path.join(core.root, "AGENTS.md"), path.join(core.root, "docs", "plan-status.md"))
    for (const doc of candidates) {
      try {
        if (fs.existsSync(doc) && fs.statSync(doc).isFile()) projectDocs.push(doc)
      } catch {}
    }
  }
  projectDocs = dedupe(projectDocs)

  // --- restore_refs.mem0 (references ONLY — never a Mem0 call) ---
  const mem0Refs = dedupe(
    (Array.isArray(input.mem0_refs) ? input.mem0_refs : [])
      .filter((r): r is string => typeof r === "string" && r.length > 0)
      .slice(0, 50),
  )

  return {
    ok: true,
    status: "OK",
    runtime_state: {
      active_task_ids: dedupe(activeTaskIds),
      active_workflow_ids: dedupe(activeWorkflowIds),
    },
    restore_refs: {
      project_docs: projectDocs,
      mem0: mem0Refs,
      tasks: dedupe(activeTaskIds).map((id) => `task:${id}`),
      workflows: dedupe(activeWorkflowIds).map((id) => `workflow:${id}`),
    },
    warnings,
  }
}

// =====================================================================
// collectGitState — exactly three read-only git commands, never throws
// =====================================================================

interface GitCommandResult {
  ok: boolean
  stdout: string
  detail: string | null
}

function runGit(args: string[], cwd: string): GitCommandResult {
  try {
    const B = (globalThis as any).Bun
    if (typeof B?.spawnSync === "function") {
      const proc = B.spawnSync({ cmd: ["git", ...args], cwd, timeout: GIT_TIMEOUT_MS, stdout: "pipe", stderr: "pipe" })
      const stdout = proc?.stdout != null ? String(proc.stdout) : ""
      const stderr = proc?.stderr != null ? String(proc.stderr).trim() : ""
      if (proc?.exitCode === 0) return { ok: true, stdout, detail: null }
      return { ok: false, stdout, detail: stderr || `git exited with code ${proc?.exitCode ?? "null"}` }
    }
    const res = spawnSync("git", args, { cwd, timeout: GIT_TIMEOUT_MS, encoding: "utf8", windowsHide: true })
    if (res.error) return { ok: false, stdout: "", detail: errMsg(res.error) }
    if (res.status === 0) return { ok: true, stdout: res.stdout ?? "", detail: null }
    return { ok: false, stdout: res.stdout ?? "", detail: (res.stderr ?? "").trim() || `git exited with code ${res.status}` }
  } catch (e: any) {
    return { ok: false, stdout: "", detail: errMsg(e) }
  }
}

/**
 * Read-only git snapshot of ONE repository, limited by contract to exactly:
 *   git branch --show-current   (empty string when detached HEAD)
 *   git rev-parse HEAD          (empty string when no commit / not a repo)
 *   git status --short          (capped at MAX_GIT_STATUS_LINES entries)
 * Never throws; failures degrade to empty values plus warnings. No other
 * git command is ever executed and no git output beyond these three is
 * recorded (no diffs, no remotes, no config — no secret-bearing surfaces).
 */
export function collectGitState(repositoryPath: string, options?: { maxStatusLines?: number }): GitStateResult {
  const warnings: string[] = []
  const repository = isNonEmptyString(repositoryPath) ? path.resolve(repositoryPath) : ""
  const gitState: CheckpointGitState = { repository: repository || "(unknown)", branch: "", head: "", status_short: [] }
  if (!repository || !fs.existsSync(repository)) {
    warnings.push(`repository path does not exist: ${repository || "(empty)"}`)
    return { ok: true, status: "OK", git_state: gitState, warnings }
  }

  const branchRes = runGit(["branch", "--show-current"], repository)
  if (branchRes.ok) gitState.branch = branchRes.stdout.replace(/\r?\n$/, "").trim()
  else warnings.push(`git branch --show-current failed: ${branchRes.detail}`)

  const headRes = runGit(["rev-parse", "HEAD"], repository)
  if (headRes.ok) gitState.head = headRes.stdout.trim()
  else warnings.push(`git rev-parse HEAD failed: ${headRes.detail}`)

  const statusRes = runGit(["status", "--short"], repository)
  if (statusRes.ok) {
    const maxLines = Math.max(0, options?.maxStatusLines ?? MAX_GIT_STATUS_LINES)
    gitState.status_short = statusRes.stdout
      .split(/\r?\n/)
      .map((l) => l.replace(/\s+$/, ""))
      .filter((l) => l.length > 0)
      .slice(0, maxLines)
  } else {
    warnings.push(`git status --short failed: ${statusRes.detail}`)
  }

  return { ok: true, status: "OK", git_state: gitState, warnings }
}

// =====================================================================
// Summary construction — transient generate preferred, bounded fallback
// =====================================================================

export interface RecentContext {
  available: boolean
  /** Oldest-first, redacted, budget-bounded text block ("" when unavailable). */
  text: string
  /** Total messages visible via ctx.session.context (compaction-bounded). */
  message_count: number
  /** Messages actually included in text (<= MAX_RECENT_MESSAGES). */
  included_count: number
  truncated: boolean
  detail: string | null
}

function messageTextOf(m: any): { role: string; text: string } | null {
  if (!isPlainObject(m)) return null
  if (m.type === "compaction" && typeof (m as any).summary === "string" && (m as any).summary.trim()) {
    return { role: "compaction", text: (m as any).summary.trim() }
  }
  if (m.type !== "user" && m.type !== "assistant") return null
  const parts: any[] = Array.isArray((m as any).content) ? (m as any).content : []
  let text = parts
    .filter((p: any) => p?.type === "text" && typeof p.text === "string")
    .map((p: any) => p.text)
    .join("\n")
    .trim()
  if (!text && typeof (m as any).text === "string") text = (m as any).text.trim()
  if (!text) return null
  return { role: String(m.type), text }
}

/**
 * LIMITED recent-context window for the fallback summary (never a full chat
 * dump): the newest MAX_RECENT_MESSAGES user/assistant/compaction messages
 * from ctx.session.context({ sessionID }) — the same compaction-bounded live
 * context source verified in docs/runtime-context-telemetry.md §2.1/§5 —
 * each capped at MAX_RECENT_MESSAGE_CHARS, total capped at budgetChars,
 * oldest entries dropped first (most recent retained), secret-redacted.
 */
export async function collectRecentContext(
  ctx: SessionCtxLike | null | undefined,
  sessionID: string,
  budgetChars: number = RECENT_CONTEXT_CHAR_BUDGET,
): Promise<RecentContext> {
  const empty: RecentContext = { available: false, text: "", message_count: 0, included_count: 0, truncated: false, detail: null }
  if (typeof ctx?.session?.context !== "function" || !isNonEmptyString(sessionID)) {
    return { ...empty, detail: "ctx.session.context unavailable" }
  }
  let res: any
  try {
    res = await ctx.session.context({ sessionID })
  } catch (e: any) {
    return { ...empty, detail: `ctx.session.context failed: ${errMsg(e)}` }
  }
  const messages: any[] = Array.isArray(res) ? res : Array.isArray(res?.messages) ? res.messages : []
  const picked: string[] = []
  let used = 0
  let included = 0
  let truncated = false
  for (let i = messages.length - 1; i >= 0 && included < MAX_RECENT_MESSAGES; i--) {
    const mt = messageTextOf(messages[i])
    if (!mt) continue
    let body = mt.text
    if (body.length > MAX_RECENT_MESSAGE_CHARS) body = body.slice(0, MAX_RECENT_MESSAGE_CHARS) + PER_MESSAGE_TRUNCATION_MARKER
    const entry = `[msg ${i}] ${mt.role}: ${body}`
    if (used + entry.length + (picked.length > 0 ? 1 : 0) > budgetChars) {
      if (picked.length === 0 && budgetChars > 64) {
        // newest message alone exceeds the budget: keep its tail, marked
        picked.push("[…] " + entry.slice(-Math.max(0, budgetChars - 4)))
        included = 1
        used = budgetChars
      }
      truncated = true
      break
    }
    picked.push(entry)
    used += entry.length + (picked.length > 1 ? 1 : 0)
    included++
  }
  picked.reverse() // oldest-first reading order
  return {
    available: true,
    text: redactSecrets(picked.join("\n")),
    message_count: messages.length,
    included_count: included,
    truncated,
    detail: null,
  }
}

function formatIdList(ids: string[], prefix: string, cap = 20): string {
  if (ids.length === 0) return "(none)"
  const shown = ids.slice(0, cap).map((id) => `${prefix}${id}`)
  if (ids.length > cap) shown.push(`(+${ids.length - cap} more)`)
  return shown.join(", ")
}

export interface StructuredCheckpointState {
  session_key: string
  project_id: string
  role: string
  generation: number
  session_id: string
  model_runtime_id: string | null
  context: CheckpointContext
  runtime_state: CheckpointRuntimeState
  git_state: CheckpointGitState
  restore_refs: CheckpointRestoreRefs
}

function structuredStateLines(s: StructuredCheckpointState): string[] {
  return [
    `session_key: ${s.session_key}`,
    `project_id: ${s.project_id}`,
    `role: ${s.role}`,
    `generation: ${s.generation}`,
    `session_id: ${s.session_id}`,
    `model_runtime_id: ${s.model_runtime_id ?? "null"}`,
    `context: tokens=${s.context.tokens} limit=${s.context.limit} percent=${s.context.percent} (source: ${s.context.source})`,
    `active_task_ids: ${formatIdList(s.runtime_state.active_task_ids, "")}`,
    `active_workflow_ids: ${formatIdList(s.runtime_state.active_workflow_ids, "")}`,
    `git: repository=${s.git_state.repository} branch=${s.git_state.branch || "(none)"} head=${s.git_state.head || "(none)"} status_short_lines=${s.git_state.status_short.length}`,
    `restore_refs.project_docs: ${formatIdList(s.restore_refs.project_docs, "")}`,
    `restore_refs.mem0: ${formatIdList(s.restore_refs.mem0, "")}`,
    `restore_refs.tasks: ${formatIdList(s.restore_refs.tasks, "")}`,
    `restore_refs.workflows: ${formatIdList(s.restore_refs.workflows, "")}`,
  ]
}

/** Extract assistant text from the (runtime-unverified) shapes ctx.session.generate may return. */
export function extractGeneratedText(res: any): string | null {
  if (typeof res === "string") return res.trim() || null
  if (!isPlainObject(res)) return null
  for (const key of ["text", "output", "result"]) {
    if (typeof (res as any)[key] === "string" && (res as any)[key].trim()) return ((res as any)[key] as string).trim()
  }
  const content = (res as any).content
  if (typeof content === "string" && content.trim()) return content.trim()
  for (const parts of [content, (res as any).parts]) {
    if (Array.isArray(parts)) {
      const text = parts
        .filter((p: any) => p?.type === "text" && typeof p.text === "string")
        .map((p: any) => p.text)
        .join("\n")
        .trim()
      if (text) return text
    }
  }
  if (Array.isArray((res as any).messages)) {
    const msgs: any[] = (res as any).messages
    for (let i = msgs.length - 1; i >= 0; i--) {
      const mt = messageTextOf(msgs[i])
      if (mt && mt.role === "assistant") return mt.text
    }
  }
  return null
}

function buildSummaryPrompt(state: StructuredCheckpointState, recent: RecentContext): string {
  return [
    "You are creating a TRANSIENT handoff summary for a managed runtime session that is about to be",
    "rotated to a new generation (Plan 8 lifecycle checkpoint). The summary is persisted in a checkpoint",
    "file and injected into the successor session; this request itself must not be persisted anywhere.",
    "",
    "Write a dense handoff summary (max 3000 chars, plain text, same language as the work content) covering:",
    "1. the session's current objective and how far it progressed,",
    "2. in-flight work implied by the active tasks/workflows listed below,",
    "3. key decisions/constraints the successor must not re-derive,",
    "4. the next atomic step the successor should take.",
    "Do NOT include passwords, API keys, tokens, credentials or connection strings.",
    "Do NOT dump chat history verbatim; condense.",
    "",
    "STRUCTURED RUNTIME STATE (authoritative):",
    ...structuredStateLines(state),
    "",
    recent.available && recent.text
      ? `LIMITED RECENT CONTEXT (newest ${recent.included_count} of ${recent.message_count} messages, already truncated):`
      : "LIMITED RECENT CONTEXT: unavailable",
    recent.available && recent.text ? recent.text : "(none)",
  ].join("\n")
}

/**
 * Preferred summary path: one TRANSIENT ctx.session.generate call. The exact
 * generate signature is runtime-unverified on this machine (see
 * docs/runtime-context-telemetry.md §6.6 — probe empirically and record
 * summary_source accordingly), so a small ordered list of argument shapes is
 * attempted; any failure degrades to the deterministic fallback, never to a
 * fabricated summary. The prompt embeds the structured state (and the bounded
 * recent context), so summary quality does not depend on session-scoped
 * generate support. No model is ever guessed: the session's own
 * model_runtime_id is passed only when it parses.
 */
export async function generateTransientSummary(
  core: CheckpointCoreLike,
  ctx: SessionCtxLike | null | undefined,
  state: StructuredCheckpointState,
  recent: RecentContext,
): Promise<{ summary: string; detail: string | null }> {
  if (typeof ctx?.session?.generate !== "function") {
    return { summary: "", detail: "ctx.session.generate is not available in this runtime" }
  }
  const parse = typeof core.parseRuntimeId === "function" ? core.parseRuntimeId : coreParseRuntimeId
  const parsed = parse(state.model_runtime_id)
  const modelRef = parsed ? { providerID: parsed.providerID, id: parsed.id, ...(parsed.variant ? { variant: parsed.variant } : {}) } : null
  const prompt = buildSummaryPrompt(state, recent)

  const attempts: Array<{ label: string; args: any }> = [
    { label: "generate({sessionID,text})", args: { sessionID: state.session_id, text: prompt } },
  ]
  if (modelRef) attempts.push({ label: "generate({sessionID,model,text})", args: { sessionID: state.session_id, model: modelRef, text: prompt } })
  if (modelRef) attempts.push({ label: "generate({model,text})", args: { model: modelRef, text: prompt } })

  let lastDetail = "generate returned no usable text"
  for (const attempt of attempts) {
    try {
      const res = await (ctx!.session!.generate as any)(attempt.args)
      const text = extractGeneratedText(res)
      if (text) return { summary: text, detail: null }
      lastDetail = `${attempt.label}: no text in result`
    } catch (e: any) {
      lastDetail = `${attempt.label}: ${errMsg(e)}`
    }
  }
  return { summary: "", detail: lastDetail }
}

/**
 * Deterministic fallback summary: STRUCTURED RUNTIME STATE plus the LIMITED
 * recent-context window, total clamped to <= MAX_SUMMARY_CHARS (20,000).
 * Paired with summary_source = "fallback-recent-context". Never a full chat
 * dump; secrets redacted.
 */
export function buildFallbackSummary(state: StructuredCheckpointState, recent: RecentContext): string {
  const header = [
    `CHECKPOINT SUMMARY (fallback: structured runtime state + limited recent context)`,
    `Predecessor generation ${state.generation} of ${state.session_key} is being rotated; this summary is the`,
    `handoff state for the successor session. Structured fields below are authoritative.`,
    "",
    "STRUCTURED RUNTIME STATE:",
    ...structuredStateLines(state),
  ].join("\n")

  let summary = header
  if (recent.available && recent.text) {
    const recentHeader =
      `\n\nLIMITED RECENT CONTEXT (newest ${recent.included_count} of ${recent.message_count} messages;` +
      `${recent.truncated ? " window truncated;" : ""} secrets redacted; never a full chat dump):`
    const budget = MAX_SUMMARY_CHARS - header.length - recentHeader.length - 8
    if (budget > 200) {
      let body = recent.text
      if (body.length > budget) body = "[…] " + body.slice(-Math.max(0, budget - 4)) // keep the most recent tail
      summary = header + recentHeader + "\n" + body
    }
  } else if (recent.detail) {
    summary = header + `\n\nLIMITED RECENT CONTEXT: unavailable (${recent.detail})`
  }
  return clampSummary(summary)
}

// =====================================================================
// createCheckpoint — build, validate and atomically persist a Checkpoint v1
// =====================================================================

/**
 * Build a Checkpoint v1 instance for one session generation and atomically
 * write it to runtime/checkpoints/<safe-session-key>/gen-XXXX-<id>.json.
 *
 * Pipeline: input validation -> sessions-row defaults (model_runtime_id /
 * project_path / verified telemetry; READ ONLY) -> collectRuntimeRefs
 * (active tasks/workflows from runtimeCore.db, project docs, mem0 refs) ->
 * collectGitState (three read-only git commands) -> summary (caller >
 * transient ctx.session.generate > fallback structured state + limited
 * recent context, summary_source="fallback-recent-context") ->
 * validateCheckpoint -> atomicWriteCheckpoint.
 *
 * This function NEVER writes to the db (lifecycle-core records
 * sessions.checkpoint_path and the lifecycle_events/lifecycle_rotations
 * rows) and NEVER calls Mem0. It contains no threshold logic: whether a
 * checkpoint should be created is decided by lifecycle-core against
 * framework-config/lifecycle.yaml.
 */
export async function createCheckpoint(
  core: CheckpointCoreLike,
  ctx: SessionCtxLike | null | undefined,
  input: CreateCheckpointInput,
): Promise<CreateCheckpointResult> {
  const warnings: string[] = []

  // --- input validation ---
  if (!isPlainObject(input)) return failure("INVALID_INPUT", "input must be an object")
  if (!isNonEmptyString(input.session_key)) return failure("INVALID_INPUT", "session_key is required (non-empty string, stored verbatim)")
  if (!isNonEmptyString(input.project_id)) return failure("INVALID_INPUT", "project_id is required")
  if (!isNonEmptyString(input.role)) return failure("INVALID_INPUT", "role is required")
  if (!Number.isInteger(input.generation) || input.generation < 1) {
    return failure("INVALID_INPUT", `generation must be an integer >= 1, got ${JSON.stringify(input.generation)}`)
  }
  if (!isNonEmptyString(input.session_id)) return failure("INVALID_INPUT", "session_id is required")
  if (!isNonEmptyString(core?.root)) return failure("INVALID_INPUT", "core.root is required (framework root)")
  if (input.model_runtime_id !== undefined && input.model_runtime_id !== null && typeof input.model_runtime_id !== "string") {
    return failure("INVALID_INPUT", "model_runtime_id must be a string or null")
  }

  // --- sessions-row defaults (READ ONLY) ---
  const { row, warnings: rowWarnings } = readSessionRow(core, input.session_key, input.generation)
  warnings.push(...rowWarnings)

  const modelRuntimeId =
    typeof input.model_runtime_id === "string" && input.model_runtime_id
      ? input.model_runtime_id
      : (row?.model_runtime_id ?? null)

  // --- context telemetry: recorded observations only, NEVER estimated ---
  let context: CheckpointContext
  if (isPlainObject(input.context)) {
    const c = input.context as any
    const complete = Number.isFinite(c.tokens) && Number.isFinite(c.limit) && Number.isFinite(c.percent)
    if (!complete) {
      warnings.push("caller-provided context telemetry was incomplete; missing numeric fields recorded as 0 (never estimated)")
    }
    context = {
      tokens: Number.isFinite(c.tokens) ? Math.max(0, Math.trunc(Number(c.tokens))) : 0,
      limit: Number.isFinite(c.limit) ? Math.max(0, Math.trunc(Number(c.limit))) : 0,
      percent: Number.isFinite(c.percent) ? Math.min(100, Math.max(0, Number(c.percent))) : 0,
      source: isNonEmptyString(c.source) ? c.source : complete ? CONTEXT_SOURCE_REGISTRY : CONTEXT_SOURCE_UNAVAILABLE,
    }
  } else if (row && row.context_tokens != null && row.context_limit != null && row.context_pct != null) {
    context = {
      tokens: Math.max(0, Math.trunc(Number(row.context_tokens))),
      limit: Math.max(0, Math.trunc(Number(row.context_limit))),
      percent: Math.min(100, Math.max(0, Number(row.context_pct))),
      source: isNonEmptyString(row.telemetry_source) ? row.telemetry_source : CONTEXT_SOURCE_REGISTRY,
    }
  } else {
    // docs/runtime-context-telemetry.md §7: no verified measurement -> record
    // zeros with an explicit unavailable source; never fabricate a number.
    context = { tokens: 0, limit: 0, percent: 0, source: CONTEXT_SOURCE_UNAVAILABLE }
    warnings.push(`no verified telemetry for (${input.session_key}, generation ${input.generation}); context recorded as zeros with source '${CONTEXT_SOURCE_UNAVAILABLE}' (never estimated)`)
  }

  // --- runtime refs (active tasks/workflows + restore refs) ---
  const projectPath = row && isNonEmptyString(row.project_path) && fs.existsSync(row.project_path) ? row.project_path : null
  const refs = collectRuntimeRefs(core, {
    session_key: input.session_key,
    project_id: input.project_id,
    role: input.role,
    project_path: projectPath,
    project_docs: input.project_docs ?? null,
    mem0_refs: input.mem0_refs ?? null,
  })
  warnings.push(...refs.warnings)

  // --- git state (three read-only commands only) ---
  const repositoryPath =
    isNonEmptyString(input.repository_path)
      ? input.repository_path
      : (projectPath ?? core.root)
  const git = collectGitState(repositoryPath)
  warnings.push(...git.warnings)

  // --- identifiers / timestamp ---
  const checkpointId = isNonEmptyString(input.checkpoint_id) ? input.checkpoint_id : randomUUID()
  const createdAt = isNonEmptyString(input.created_at) ? input.created_at : nowIso()

  const state: StructuredCheckpointState = {
    session_key: input.session_key,
    project_id: input.project_id,
    role: input.role,
    generation: input.generation,
    session_id: input.session_id,
    model_runtime_id: modelRuntimeId,
    context,
    runtime_state: refs.runtime_state,
    git_state: git.git_state,
    restore_refs: refs.restore_refs,
  }

  // --- summary: caller-provided > transient generate > bounded fallback ---
  let summary: string
  let summarySource: string
  if (isNonEmptyString(input.summary)) {
    summary = clampSummary(redactSecrets(input.summary))
    summarySource = isNonEmptyString(input.summary_source) ? input.summary_source : SUMMARY_SOURCE_CALLER
  } else {
    const recent = await collectRecentContext(ctx, input.session_id)
    if (!recent.available && recent.detail) warnings.push(`recent context unavailable: ${recent.detail}`)
    const generated = await generateTransientSummary(core, ctx, state, recent)
    if (generated.summary) {
      summary = clampSummary(redactSecrets(generated.summary))
      summarySource = SUMMARY_SOURCE_GENERATE
    } else {
      if (generated.detail) warnings.push(`transient summary via ctx.session.generate failed (${generated.detail}); using ${SUMMARY_SOURCE_FALLBACK}`)
      summary = buildFallbackSummary(state, recent)
      summarySource = SUMMARY_SOURCE_FALLBACK
    }
  }

  // --- assemble EXACT Checkpoint v1 fields, in schema order ---
  const checkpoint: CheckpointV1 = {
    schema_version: CHECKPOINT_SCHEMA_VERSION,
    checkpoint_id: checkpointId,
    session_key: input.session_key,
    project_id: input.project_id,
    role: input.role,
    generation: input.generation,
    session_id: input.session_id,
    model_runtime_id: modelRuntimeId,
    context,
    runtime_state: refs.runtime_state,
    git_state: git.git_state,
    restore_refs: refs.restore_refs,
    summary,
    summary_source: summarySource,
    created_at: createdAt,
  }

  // --- validate BEFORE writing: an invalid checkpoint is never persisted ---
  const validation = validateCheckpoint(checkpoint)
  if (!validation.valid) {
    return failure("CHECKPOINT_BUILD_INVALID", `assembled checkpoint failed Checkpoint v1 validation: ${validation.errors.join("; ")}`, {
      session_key: input.session_key,
      generation: input.generation,
      validation_errors: validation.errors,
    })
  }

  // --- atomic write ---
  const absPath = checkpointFilePath(core.root, input.session_key, input.generation, checkpointId)
  const written = atomicWriteCheckpoint(absPath, checkpoint)
  if (!written.ok) {
    return failure(written.code ?? "CHECKPOINT_WRITE_FAILED", written.detail ?? "atomic checkpoint write failed", {
      session_key: input.session_key,
      generation: input.generation,
      checkpoint_id: checkpointId,
    })
  }

  return {
    ok: true,
    status: "WRITTEN",
    checkpoint_id: checkpointId,
    session_key: input.session_key,
    generation: input.generation,
    checkpoint_path: toPosixRelative(core.root, absPath) ?? checkpointRelativePath(core.root, input.session_key, input.generation, checkpointId),
    checkpoint_path_abs: absPath,
    summary_source: summarySource,
    checkpoint,
    warnings,
  }
}

// =====================================================================
// loadCheckpoint / listCheckpoints / loadLatestCheckpoint
// =====================================================================

function resolveLoadSource(source: LoadCheckpointSource): { pathAbs: string | null; code: string | null; detail: string | null } {
  if (typeof source === "string") {
    if (!source) return { pathAbs: null, code: "INVALID_INPUT", detail: "checkpoint path must be a non-empty string" }
    return { pathAbs: path.resolve(source), code: null, detail: null }
  }
  if (isPlainObject(source) && typeof (source as any).path === "string" && (source as any).path) {
    return { pathAbs: path.resolve((source as any).path), code: null, detail: null }
  }
  if (
    isPlainObject(source) &&
    isNonEmptyString((source as any).root) &&
    isNonEmptyString((source as any).session_key) &&
    Number.isInteger((source as any).generation) &&
    isNonEmptyString((source as any).checkpoint_id)
  ) {
    const s = source as { root: string; session_key: string; generation: number; checkpoint_id: string }
    return { pathAbs: checkpointFilePath(s.root, s.session_key, s.generation, s.checkpoint_id), code: null, detail: null }
  }
  return {
    pathAbs: null,
    code: "INVALID_INPUT",
    detail: "source must be a path string, { path }, or { root, session_key, generation, checkpoint_id }",
  }
}

/**
 * Read + parse + validate one checkpoint file. Never mutates anything.
 * Returns the checkpoint plus its absolute path; `checkpoint_path` carries
 * the root-relative POSIX form only when options.root is given and the file
 * lives under it (use checkpointRelativePath() to compute it otherwise).
 */
export function loadCheckpoint(source: LoadCheckpointSource, options?: { root?: string }): LoadCheckpointResult {
  const resolved = resolveLoadSource(source)
  if (!resolved.pathAbs) return failure(resolved.code!, resolved.detail!)
  if (!fs.existsSync(resolved.pathAbs)) {
    return { ok: false, status: "NOT_FOUND", code: "CHECKPOINT_NOT_FOUND", detail: `checkpoint file not found: ${resolved.pathAbs}` }
  }
  let raw: string
  try {
    raw = fs.readFileSync(resolved.pathAbs, "utf8")
  } catch (e: any) {
    return failure("CHECKPOINT_READ_FAILED", `${errMsg(e)} (path: ${resolved.pathAbs})`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e: any) {
    return failure("CHECKPOINT_PARSE_FAILED", `${errMsg(e)} (path: ${resolved.pathAbs})`)
  }
  const validation = validateCheckpoint(parsed)
  if (!validation.valid) {
    return failure("CHECKPOINT_INVALID", `checkpoint failed Checkpoint v1 validation: ${validation.errors.join("; ")}`, {
      path: resolved.pathAbs,
      validation_errors: validation.errors,
    })
  }
  return {
    ok: true,
    status: "OK",
    checkpoint: parsed as CheckpointV1,
    checkpoint_path_abs: resolved.pathAbs,
    checkpoint_path: options?.root ? toPosixRelative(options.root, resolved.pathAbs) : null,
  }
}

const CHECKPOINT_FILE_RE = /^gen-(\d+)-(.+)\.json$/

/** List checkpoint files of one session_key directory, oldest generation first. */
export function listCheckpoints(core: CheckpointCoreLike, sessionKey: string): { ok: true; status: "OK"; count: number; checkpoints: CheckpointListEntry[] } {
  const dir = checkpointDirPath(core.root, sessionKey)
  const entries: CheckpointListEntry[] = []
  try {
    if (fs.existsSync(dir)) {
      for (const name of fs.readdirSync(dir)) {
        const m = CHECKPOINT_FILE_RE.exec(name)
        if (!m) continue
        entries.push({
          checkpoint_id: m[2],
          generation: Number(m[1]),
          file_name: name,
          path_abs: path.join(dir, name),
          path_relative: toPosixRelative(core.root, path.join(dir, name)),
        })
      }
    }
  } catch {}
  entries.sort((a, b) => a.generation - b.generation || a.file_name.localeCompare(b.file_name))
  return { ok: true, status: "OK", count: entries.length, checkpoints: entries }
}

/** Load the newest checkpoint file of one session_key (highest gen, then name). */
export function loadLatestCheckpoint(core: CheckpointCoreLike, sessionKey: string): LoadCheckpointResult {
  const listed = listCheckpoints(core, sessionKey)
  const last = listed.checkpoints[listed.checkpoints.length - 1]
  if (!last) {
    return {
      ok: false,
      status: "NOT_FOUND",
      code: "CHECKPOINT_NOT_FOUND",
      detail: `no checkpoint files under ${checkpointDirPath(core.root, sessionKey)}`,
    }
  }
  return loadCheckpoint(last.path_abs, { root: core.root })
}

// =====================================================================
// buildRestoreContext — successor-session restore text (rotation_restore_context)
// =====================================================================

function buildRestoreText(cp: CheckpointV1, maxChars: number): { text: string; truncated: boolean } {
  const docCap = 20
  const statusCap = 20
  const docsShown = cp.restore_refs.project_docs.slice(0, docCap)
  const statusShown = cp.git_state.status_short.slice(0, statusCap)
  let listTruncated =
    cp.restore_refs.project_docs.length > docCap ||
    cp.git_state.status_short.length > statusCap

  const fixed = [
    "RESTORE CONTEXT — Runtime Session Checkpoint v1",
    `CHECKPOINT: ${cp.checkpoint_id} (created_at ${cp.created_at})`,
    `PREDECESSOR: session_key=${cp.session_key} project_id=${cp.project_id} role=${cp.role} generation=${cp.generation} session_id=${cp.session_id} model_runtime_id=${cp.model_runtime_id ?? "null"}`,
    `CONTEXT AT CHECKPOINT: tokens=${cp.context.tokens} limit=${cp.context.limit} percent=${cp.context.percent} (source: ${cp.context.source})`,
    "",
    "ACTIVE TASKS (non-terminal in runtime/tasks.db at checkpoint time — re-read their current state before acting):",
    ...(cp.runtime_state.active_task_ids.length > 0
      ? cp.runtime_state.active_task_ids.map((id) => `- task:${id}`)
      : ["(none)"]),
    "",
    "ACTIVE WORKFLOWS:",
    ...(cp.runtime_state.active_workflow_ids.length > 0
      ? cp.runtime_state.active_workflow_ids.map((id) => `- workflow:${id}`)
      : ["(none)"]),
    "",
    "PROJECT DOCS (read these first):",
    ...(docsShown.length > 0 ? docsShown.map((d) => `- ${d}`) : ["(none)"]),
    "",
    "GIT STATE:",
    `repository: ${cp.git_state.repository}`,
    `branch: ${cp.git_state.branch || "(none/detached)"}`,
    `head: ${cp.git_state.head || "(unknown)"}`,
    `status --short (${cp.git_state.status_short.length} line(s)${listTruncated ? ", display-capped" : ""}):`,
    ...(statusShown.length > 0 ? statusShown.map((l) => `  ${l}`) : ["  (clean)"]),
    "",
    "MEM0 REFS (references ONLY — query Mem0 yourself through the proper tools when needed; this checkpoint never embeds memory content):",
    ...(cp.restore_refs.mem0.length > 0 ? cp.restore_refs.mem0.map((r) => `- ${r}`) : ["(none)"]),
    "",
    `PREDECESSOR SUMMARY (summary_source: ${cp.summary_source}):`,
  ].join("\n")

  const footer =
    "\n(Synthetic restore context generated by .opencode/lib/lifecycle/checkpoint.ts, Plan 8. Mirrors " +
    "framework-config/lifecycle.yaml rotation_restore_context: active-task / checkpoint / project-docs / " +
    "git-state / required-mem0-context. Contains no secrets.)"

  const summaryBudget = maxChars - fixed.length - footer.length - 2
  let summaryBlock = cp.summary
  let summaryTruncated = false
  if (summaryBudget < 200) {
    summaryBlock = "(summary omitted: restore-context size limit)"
    summaryTruncated = cp.summary.length > 0
  } else if (summaryBlock.length > summaryBudget) {
    summaryBlock = summaryBlock.slice(0, summaryBudget - 40) + "\n[… summary truncated for restore-context size limit]"
    summaryTruncated = true
  }

  return { text: fixed + "\n" + summaryBlock + footer, truncated: summaryTruncated || listTruncated }
}

/**
 * Build the bounded restore-context payload for a successor session from a
 * Checkpoint v1 (object, checkpoint file path, or { path }). The `text` field
 * is ready for ctx.session.synthetic injection by lifecycle-core and mirrors
 * framework-config/lifecycle.yaml `rotation_restore_context`
 * (active-task / checkpoint / project-docs / git-state / required-mem0-context).
 * Pure: reads at most one file, touches neither the db nor Mem0 nor git.
 */
export function buildRestoreContext(
  source: CheckpointV1 | LoadCheckpointSource,
  options?: { max_chars?: number },
): RestoreContextResult {
  const maxChars = Math.max(2000, options?.max_chars ?? RESTORE_CONTEXT_MAX_CHARS)

  let cp: CheckpointV1
  if (typeof source === "string" || (isPlainObject(source) && !("schema_version" in (source as any)))) {
    const loaded = loadCheckpoint(source as LoadCheckpointSource)
    if (!loaded.ok) return loaded
    cp = loaded.checkpoint
  } else {
    const validation = validateCheckpoint(source)
    if (!validation.valid) {
      return failure("CHECKPOINT_INVALID", `checkpoint failed Checkpoint v1 validation: ${validation.errors.join("; ")}`, {
        validation_errors: validation.errors,
      })
    }
    cp = source as CheckpointV1
  }

  const { text, truncated } = buildRestoreText(cp, maxChars)
  return {
    ok: true,
    status: "OK",
    restore_context: {
      checkpoint_id: cp.checkpoint_id,
      session_key: cp.session_key,
      project_id: cp.project_id,
      role: cp.role,
      generation: cp.generation,
      text,
      truncated,
      active_task_ids: [...cp.runtime_state.active_task_ids],
      active_workflow_ids: [...cp.runtime_state.active_workflow_ids],
      project_docs: [...cp.restore_refs.project_docs],
      mem0_refs: [...cp.restore_refs.mem0],
    },
  }
}
