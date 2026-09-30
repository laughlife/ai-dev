// Lifecycle Telemetry — verified context usage capture (Plan 8 C1)
//
// Implements the normative measurement protocol of
// docs/runtime-context-telemetry.md (T1, VERIFIED against the live OpenCode
// 2.0.20 service) for the Plan 8 lifecycle engine:
//
//   usage source : the LATEST assistant message that actually carries
//                  `tokens` in ctx.session.context({ sessionID }) — the
//                  unpaginated, compaction-bounded live context view.
//                  In-flight/streaming assistant messages have no `tokens`
//                  and are SKIPPED, never treated as zero (§2.1/§6.2).
//   total        : tokens.input + tokens.output + tokens.reasoning
//                  + tokens.cache.read + tokens.cache.write
//                  (input and cache.read are disjoint counters; nothing is
//                  subtracted or replaced — §3.1)
//   limit source : Model.Info.limit.context of THAT message's own
//                  { providerID, id } from the ctx.model.list() catalog.
//                  No name-based window hardcoding, no guessing (§2.2/§6.5).
//   percent      : Math.round(total / limit * 100) — byte-for-byte the same
//                  formula the Desktop UI renders (§3), so the measurement is
//                  IDENTICAL to the UI, not an approximation.
//   null policy  : streaming / no usage / no catalog entry / no limit.context
//                  -> the result is null, never a fabricated number (§7).
//
// Persistence (shared runtime/tasks.db via runtimeCore.db — this module NEVER
// opens its own database and NEVER alters a schema):
// - sessions (Plan 8 registry schema v2): updates EXACTLY the five committed
//   telemetry columns context_tokens / context_limit / context_pct /
//   telemetry_source / telemetry_at of the target (session_key, generation)
//   row — and only when a real observation exists. lifecycle_state and every
//   other column are untouched. An UNAVAILABLE measurement NEVER clears or
//   overwrites the last verified sample (schema comment: "when no exact
//   measurement exists the columns stay NULL" — NULL means unknown, not
//   stale-and-erased).
// - lifecycle_events (Plan 8 T3 schema): appends one ledger row per refresh
//   (TELEMETRY_SAMPLE / TELEMETRY_UNAVAILABLE) using EXACTLY the committed
//   columns event_id / session_key / generation / opencode_session_id /
//   event_type / context_pct / checkpoint_path / details_json / created_at.
//   Append-only: rows are inserted, never updated.
//
// Compaction (§5): ctx.session.context() is bounded by the newest compaction
// message, so after a compaction the next assistant message's usage naturally
// reflects the reduced context and the sample drops by construction. No
// compaction-specific handling exists here and none is needed — consumers
// must treat a sudden drop as expected behavior, not a measurement fault.
//
// NO threshold logic lives here (Plan 8 boundary): this module never reads
// framework-config/lifecycle.yaml, never classifies a lifecycle state, never
// mutates a threshold and never writes sessions.lifecycle_state. Band
// classification is state-machine.ts; execution decisions belong to the
// lifecycle-core facade.
//
// Concurrency: refreshTelemetry is a LOCK-FREE building block (same convention
// as the "*Locked" helpers referenced by .opencode/lib/global-lock.ts). The
// calling facade must serialize it per session_key (globalWithLock) so a
// rotation can never interleave with a telemetry write.
//
// Style follows the Plan 5/6/7 shared cores: no SDK import (ctx stays `any`),
// SQLite via the runtime core db handle, structured { ok, status, code,
// detail } results, ISO 8601 timestamps.

import {
  errMsg,
  lifecycleFailure,
  nowIso,
  sessionRefFromRow,
  TELEMETRY_SOURCE_DESCRIPTOR,
  type AssistantModelRef,
  type ContextTelemetrySample,
  type LifecycleEventRecord,
  type LifecycleEventType,
  type TelemetryRefreshInput,
  type TelemetryRefreshResult,
  type TokenUsage,
} from "./types.ts"

// ---------------------------------------------------------------------------
// Pure helpers (no ctx, no fs, no DB) — exported for the lifecycle-core
// facade and for offline verification harnesses.
// ---------------------------------------------------------------------------

// True when `tokens` is a complete TokenUsage.Info payload with five finite
// numbers. A message whose usage is present but malformed is NOT silently
// coerced (no-estimation policy): it makes the sample unavailable instead.
export function isValidTokenUsage(tokens: any): tokens is TokenUsage {
  if (!tokens || typeof tokens !== "object") return false
  const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v)
  return (
    finite(tokens.input) &&
    finite(tokens.output) &&
    finite(tokens.reasoning) &&
    !!tokens.cache &&
    typeof tokens.cache === "object" &&
    finite(tokens.cache.read) &&
    finite(tokens.cache.write)
  )
}

// verified_context_tokens: the exact UI sum (§3). input and cache.read are
// disjoint counters — both are added, never substituted for one another.
export function sumTokenUsage(tokens: TokenUsage): number {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

// UI-identical selection: findLast(type === "assistant" && !!tokens).
// Streaming/in-flight assistant messages carry no `tokens` and are skipped —
// never treated as zero (§2.1/§6.2).
export function findLatestAssistantWithTokens(messages: any): any | null {
  const list: any[] = Array.isArray(messages) ? messages : []
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    if (m?.type === "assistant" && !!m.tokens) return m
  }
  return null
}

// The measured message's OWN model identity — the only allowed catalog lookup
// key (§2.2). Handles both the nested `model: { providerID, id }` shape the
// UI formula reads and the flat providerID/modelID fields of the SDK
// AssistantMessage type. Returns null when identity is absent (the sample
// then degrades to MODEL_NOT_IN_CATALOG — never a name-based guess).
export function assistantModelRef(message: any): AssistantModelRef | null {
  const providerID = message?.model?.providerID ?? message?.providerID
  const id = message?.model?.id ?? message?.model?.modelID ?? message?.modelID
  if (typeof providerID !== "string" || !providerID) return null
  if (typeof id !== "string" || !id) return null
  return { providerID, id }
}

// limit.context extraction with the UI's truthiness semantics
// (`t?.limit.context ? ... : null`): only a positive finite number counts;
// 0 / missing / malformed all mean "no limit" -> pct null (§6.5).
export function validLimitContext(entry: any): number | null {
  const v = entry?.limit?.context
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null
}

// Catalog lookup for one { providerID, id } against the raw ctx.model.list()
// result. Shape-tolerant because the plugin surface is `any`-typed in this
// repo (no SDK import convention): flat Model.Info arrays, provider-grouped
// arrays ({ id|providerID, models: Record|Array }) and object maps keyed by
// providerID are all resolved the same way. Returns:
//   entry_found=false -> no catalog entry for that exact model (MODEL_NOT_IN_CATALOG)
//   entry_found=true  -> entry returned; limit validity is checked separately
export function resolveCatalogEntry(catalog: any, providerID: string, modelID: string): { entry_found: boolean; entry: any | null } {
  const modelMatches = (m: any): boolean => !!m && typeof m === "object" && (m.id ?? m.modelID) === modelID

  const inModels = (models: any): any | null => {
    if (Array.isArray(models)) return models.find(modelMatches) ?? null
    if (models && typeof models === "object") {
      const direct = (models as any)[modelID]
      if (direct && typeof direct === "object") return direct
      return Object.values(models).find(modelMatches) ?? null
    }
    return null
  }

  const inProvider = (provider: any): any | null => {
    if (!provider || typeof provider !== "object") return null
    const pid = provider.providerID ?? provider.id
    if (pid !== providerID) return null
    if (provider.models !== undefined) return inModels(provider.models)
    return null
  }

  // shape 1/2: array of flat model entries and/or provider-grouped entries
  if (Array.isArray(catalog)) {
    for (const item of catalog) {
      if (item && typeof item === "object" && (item.providerID ?? item.id) === providerID && item.models === undefined && modelMatches(item)) {
        return { entry_found: true, entry: item }
      }
      const hit = inProvider(item)
      if (hit) return { entry_found: true, entry: hit }
    }
    return { entry_found: false, entry: null }
  }

  if (catalog && typeof catalog === "object") {
    // shape 3: { providers: [...] } wrapper
    if (Array.isArray((catalog as any).providers)) {
      return resolveCatalogEntry((catalog as any).providers, providerID, modelID)
    }
    // shape 4: object map keyed by providerID -> { models } | models-record
    for (const [key, value] of Object.entries(catalog)) {
      if (key !== providerID) continue
      const v: any = value
      if (v && typeof v === "object") {
        const hit = v.models !== undefined ? inModels(v.models) : inModels(v)
        if (hit) return { entry_found: true, entry: hit }
      }
    }
  }
  return { entry_found: false, entry: null }
}

// context_pct with the EXACT UI formula (§3): Math.round(total / limit * 100),
// null whenever either side is unknown. Never clamped, never approximated.
export function computeContextPct(tokens: number | null, limit: number | null): number | null {
  if (tokens === null) return null
  if (limit === null) return null // validLimitContext already applied UI truthiness
  return Math.round((tokens / limit) * 100)
}

// Pure sample construction from already-fetched raw data (the two ctx reads
// happen outside, so this function is fully deterministic and testable).
// `catalog` may be null when no assistant message with tokens exists (the
// catalog read is skipped in that case — same as the UI, which returns
// before the lookup).
export function buildTelemetrySample(params: {
  sessionID: string
  messages: any
  catalog: any
  sampled_at: string
}): ContextTelemetrySample {
  const { sessionID, messages, catalog, sampled_at } = params
  const base: ContextTelemetrySample = {
    session_id: sessionID,
    tokens: null,
    limit: null,
    pct: null,
    source: null,
    sampled_at,
    model: null,
    message_id: null,
    unavailable_reason: null,
  }

  const last = findLatestAssistantWithTokens(messages)
  if (!last) {
    // fresh session, or the newest assistant message is still streaming:
    // no usage exists yet -> null, never zero (§2.1/§6.2)
    return { ...base, unavailable_reason: "NO_ASSISTANT_MESSAGE_WITH_TOKENS" }
  }

  const model = assistantModelRef(last)
  const messageID = typeof last.id === "string" && last.id ? last.id : null
  if (!isValidTokenUsage(last.tokens)) {
    return { ...base, model, message_id: messageID, unavailable_reason: "TOKEN_USAGE_MALFORMED" }
  }

  // an exact observation exists from here on
  const tokens = sumTokenUsage(last.tokens)
  const observed: ContextTelemetrySample = {
    ...base,
    tokens,
    source: TELEMETRY_SOURCE_DESCRIPTOR,
    model,
    message_id: messageID,
  }

  if (!model) {
    // identity absent -> catalog lookup impossible; tokens stay recorded,
    // limit/pct stay null (never a name-based window guess)
    return { ...observed, unavailable_reason: "MODEL_NOT_IN_CATALOG" }
  }
  const found = resolveCatalogEntry(catalog, model.providerID, model.id)
  if (!found.entry_found) {
    return { ...observed, unavailable_reason: "MODEL_NOT_IN_CATALOG" }
  }
  const limit = validLimitContext(found.entry)
  if (limit === null) {
    return { ...observed, unavailable_reason: "MODEL_LIMIT_CONTEXT_MISSING" }
  }
  return { ...observed, limit, pct: computeContextPct(tokens, limit), unavailable_reason: null }
}

// ---------------------------------------------------------------------------
// ctx reads (thin, separately exported so the facade can reuse them)
// ---------------------------------------------------------------------------

// ctx.session.context() normalization — same tolerance as
// runtime-registry-core.promptAndExtract (array or { messages }). This is the
// unpaginated, compaction-bounded live context view (§2.1/§5/§6.4).
export async function readSessionContextMessages(ctx: any, sessionID: string): Promise<any[]> {
  const res: any = await ctx.session.context({ sessionID })
  return Array.isArray(res) ? res : (res?.messages ?? [])
}

// Raw model catalog (Model.Info entries with limit.context — §2.2).
export async function readModelCatalog(ctx: any): Promise<any> {
  return await ctx.model.list()
}

// Convenience composite: one exact measurement of one session. Throws when a
// ctx read fails (callers map that to CONTEXT_READ_FAILED /
// MODEL_CATALOG_READ_FAILED); data-side unavailability is expressed as null
// fields + unavailable_reason, never as an exception.
export async function measureContextUsage(ctx: any, sessionID: string): Promise<ContextTelemetrySample> {
  const sampled_at = nowIso()
  const messages = await readSessionContextMessages(ctx, sessionID)
  // the UI returns before the catalog lookup when no assistant message with
  // tokens exists — skip the (large) catalog read in that case
  const catalog = findLatestAssistantWithTokens(messages) ? await readModelCatalog(ctx) : null
  return buildTelemetrySample({ sessionID, messages, catalog, sampled_at })
}

// ---------------------------------------------------------------------------
// refreshTelemetry — measure one registry session generation and persist
// ---------------------------------------------------------------------------

function detailsJson(sample: ContextTelemetrySample): string {
  return JSON.stringify({
    context_tokens: sample.tokens,
    context_limit: sample.limit,
    telemetry_source: sample.source,
    model: sample.model,
    message_id: sample.message_id,
    unavailable_reason: sample.unavailable_reason,
  })
}

// Measure the session behind `input.session_key` (latest generation row) and
// persist the observation. Contract:
//
// - verified sample (tokens observed):
//     UPDATE sessions SET context_tokens, context_limit, context_pct,
//            telemetry_source, telemetry_at      <- EXACTLY the five Plan 8
//            telemetry columns, nothing else (lifecycle_state untouched)
//     + append lifecycle_events TELEMETRY_SAMPLE (context_pct may be null
//       when the catalog side was unavailable — unavailable_reason says why).
// - unavailable sample (streaming / no usage):
//     NO sessions write at all — the five columns keep the last verified
//     sample (or stay NULL when none ever existed); the null is recorded as
//     a lifecycle_events TELEMETRY_UNAVAILABLE ledger row for audit.
//
// Both writes happen inside ONE BEGIN IMMEDIATE transaction (busy_timeout is
// already set by the runtime core, so concurrent plugin cores serialize
// instead of failing with SQLITE_BUSY).
//
// LOCK-FREE: the facade must hold the per-session_key lock (globalWithLock)
// around this call; see the header note.
export async function refreshTelemetry(
  ctx: any,
  runtimeCore: any,
  input: TelemetryRefreshInput,
): Promise<TelemetryRefreshResult> {
  const db = runtimeCore?.db
  if (!db) {
    return lifecycleFailure(
      "SQLITE_RUNTIME_UNAVAILABLE",
      runtimeCore?.dbError ?? "registry database unavailable (runtimeCore.db is null)",
    )
  }
  const sessionKey = input?.session_key
  if (typeof sessionKey !== "string" || !sessionKey.trim()) {
    return lifecycleFailure("INVALID_INPUT", "session_key is required (non-empty string, stored verbatim)")
  }
  const override = input?.opencode_session_id
  if (override !== undefined && (typeof override !== "string" || !override.trim())) {
    return lifecycleFailure("INVALID_INPUT", "opencode_session_id must be a non-empty string when provided")
  }
  if (!ctx?.session?.context || typeof ctx.session.context !== "function") {
    return lifecycleFailure("INVALID_INPUT", "ctx.session.context is not available in this runtime")
  }

  // latest generation row for this session_key (same selection as the core's
  // `latest` query); telemetry always targets the newest generation
  const row: any = db
    .query("SELECT * FROM sessions WHERE session_key = ? ORDER BY generation DESC LIMIT 1")
    .get(sessionKey)
  if (!row) {
    return lifecycleFailure("SESSION_NOT_FOUND", `no session row exists for session_key '${sessionKey}'`, {
      session_key: sessionKey,
    })
  }
  const ref = sessionRefFromRow(row)
  if (!ref) {
    return lifecycleFailure("SESSION_NOT_FOUND", `sessions row for session_key '${sessionKey}' is malformed`, {
      session_key: sessionKey,
    })
  }
  const sessionID = override ?? ref.opencode_session_id

  // --- exact measurement (verified protocol; errors map to failure codes) ---
  const sampled_at = nowIso()
  let messages: any[]
  try {
    messages = await readSessionContextMessages(ctx, sessionID)
  } catch (e: any) {
    return lifecycleFailure("CONTEXT_READ_FAILED", `ctx.session.context failed: ${errMsg(e)}`, {
      session_key: sessionKey,
      session_id: sessionID,
      generation: ref.generation,
    })
  }
  let catalog: any = null
  const needsCatalog = !!findLatestAssistantWithTokens(messages)
  if (needsCatalog) {
    if (!ctx?.model?.list || typeof ctx.model.list !== "function") {
      return lifecycleFailure("MODEL_CATALOG_READ_FAILED", "ctx.model.list is not available in this runtime", {
        session_key: sessionKey,
        session_id: sessionID,
        generation: ref.generation,
      })
    }
    try {
      catalog = await readModelCatalog(ctx)
    } catch (e: any) {
      return lifecycleFailure("MODEL_CATALOG_READ_FAILED", `ctx.model.list failed: ${errMsg(e)}`, {
        session_key: sessionKey,
        session_id: sessionID,
        generation: ref.generation,
      })
    }
  }
  const sample = buildTelemetrySample({ sessionID, messages, catalog, sampled_at })

  // collision-resistant event id (same rule as Task Bus §9: no timestamp-only ids)
  const c: any = (globalThis as any).crypto
  if (typeof c?.randomUUID !== "function") {
    return lifecycleFailure("UUID_UNAVAILABLE", "crypto.randomUUID is not available in this runtime", {
      session_key: sessionKey,
    })
  }
  const eventID: string = c.randomUUID()

  const observed = sample.tokens !== null
  const eventType: LifecycleEventType = observed ? "TELEMETRY_SAMPLE" : "TELEMETRY_UNAVAILABLE"
  const event: LifecycleEventRecord = {
    event_id: eventID,
    session_key: ref.session_key, // verbatim
    generation: ref.generation,
    opencode_session_id: sessionID,
    event_type: eventType,
    context_pct: sample.pct, // REAL column; null stays null
    checkpoint_path: null, // telemetry events never reference a checkpoint
    details_json: detailsJson(sample),
    created_at: sampled_at,
  }

  // --- one transaction: (optional) sessions column update + ledger append ---
  try {
    db.exec("BEGIN IMMEDIATE")
    try {
      if (observed) {
        // EXACTLY the five Plan 8 telemetry columns of the committed schema;
        // values are the recorded observation only (never estimated). When the
        // catalog side was unavailable, context_limit/context_pct persist as
        // NULL alongside the verified context_tokens.
        db.query(
          "UPDATE sessions SET context_tokens = ?, context_limit = ?, context_pct = ?, " +
            "telemetry_source = ?, telemetry_at = ? WHERE session_key = ? AND generation = ?",
        ).run(sample.tokens, sample.limit, sample.pct, sample.source, sample.sampled_at, ref.session_key, ref.generation)
      }
      db.query(
        "INSERT INTO lifecycle_events (event_id, session_key, generation, opencode_session_id, " +
          "event_type, context_pct, checkpoint_path, details_json, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        event.event_id,
        event.session_key,
        event.generation,
        event.opencode_session_id,
        event.event_type,
        event.context_pct,
        event.checkpoint_path,
        event.details_json,
        event.created_at,
      )
      db.exec("COMMIT")
    } catch (e: any) {
      try {
        db.exec("ROLLBACK")
      } catch {}
      throw e
    }
  } catch (e: any) {
    return lifecycleFailure("TELEMETRY_PERSIST_FAILED", errMsg(e), {
      session_key: ref.session_key,
      session_id: sessionID,
      generation: ref.generation,
      event_id: eventID,
    })
  }

  return {
    ok: true,
    status: observed ? "SAMPLED" : "UNAVAILABLE",
    session_key: ref.session_key,
    session_id: sessionID,
    generation: ref.generation,
    project_id: ref.project_id,
    role: ref.role,
    context_tokens: sample.tokens,
    context_limit: sample.limit,
    context_pct: sample.pct,
    telemetry_source: sample.source,
    telemetry_at: observed ? sample.sampled_at : null,
    persisted: observed,
    event_id: eventID,
    event_type: eventType,
    unavailable_reason: sample.unavailable_reason,
    ...(observed
      ? sample.unavailable_reason
        ? {
            detail:
              `context_tokens verified, but context_pct is null (${sample.unavailable_reason}); ` +
              "no window size was guessed (docs/runtime-context-telemetry.md §6.5/§7)",
          }
        : {}
      : {
          detail:
            `no exact measurement available (${sample.unavailable_reason}); sessions telemetry columns were ` +
            "left untouched (last verified sample, if any, is preserved) and the null was recorded in lifecycle_events",
        }),
  }
}
