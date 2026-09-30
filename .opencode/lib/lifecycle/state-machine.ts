// Lifecycle State Machine — threshold loading + band classification (Plan 8 C1)
//
// Classifies one VERIFIED context_pct (from telemetry.ts, protocol normative
// in docs/runtime-context-telemetry.md) into the exact lifecycle states of the
// drawio rotation bands ("02-会话生命周期与调用路由"):
//
//   ACTIVE            below the reuse band          -> continue reuse (Reader especially)
//   CHECKPOINT_READY  checkpoint band               -> prepare checkpoint; no large new tasks
//   ROTATE_PENDING    at/above the rotate band      -> rotate after the current atomic step; old gen -> ARCHIVED
//   HARD_ROTATE       at/above the hard band        -> no new task dispatch; forced rotation
//
// Hard rules implemented here:
//
// 1. THRESHOLDS COME FROM CONFIG, NEVER FROM CODE. The band edges are declared
//    exclusively in framework-config/lifecycle.yaml (drawio mirror) and are
//    re-read FRESH from disk on every load (no caching, no defaults, no
//    fallback values). This file contains NO numeric band literal — if the
//    YAML is missing, unreadable or invalid the result is a structured
//    failure, never a built-in 60/70/80-style default.
// 2. context_pct === null (no verified measurement) classifies to
//    state null + action NONE: no automatic action may ever be derived from
//    an unknown context (docs/runtime-context-telemetry.md §7 — never
//    estimate; framework.yaml keeps automatic rotation disabled).
// 3. COMPACTION DOWNGRADE IS SUPPORTED BY CONSTRUCTION. classify is a pure,
//    stateless function of the newest verified sample — no hysteresis, no
//    latching, no memory of a previously higher band. After a compaction the
//    context (and therefore the next sample) drops by construction
//    (docs §5), and re-classification immediately yields the LOWER state,
//    as long as no rotation has been committed yet. isLifecycleDowngrade()
//    lets the facade detect this explicitly; a facade intending to rotate
//    MUST re-sample and re-classify immediately before executing and must
//    stand down when the fresh classification is lower.
// 4. Classification is ADVISORY: it executes nothing. Whether an action runs
//    automatically is gated by the framework.yaml flags and the lifecycle-core
//    facade, not by this module.
//
// Style follows the shared cores: no SDK import, YAML via Bun.YAML.parse
// (globalThis lookup), fs via node:fs, structured { ok:false, status:"ERROR",
// code, detail } failures from ./types.ts. No SQLite access here — the state
// machine is pure config+math; persistence belongs to the facade.

import * as fs from "node:fs"
import * as path from "node:path"

import {
  errMsg,
  lifecycleFailure,
  nowIso,
  type LifecycleAction,
  type LifecycleClassification,
  type LifecycleState,
  type LifecycleThresholds,
  type ThresholdsLoadResult,
} from "./types.ts"

// Percent domain bounds (percentage points — NOT a rotation band edge; band
// edges exist only in framework-config/lifecycle.yaml).
export const PERCENT_MIN = 0
export const PERCENT_MAX = 100

// Default thresholds_source label when the caller does not pass the absolute
// path it loaded from.
export const DEFAULT_THRESHOLDS_SOURCE = "framework-config/lifecycle.yaml"

// Relative location of the threshold declaration (drawio mirror).
export const LIFECYCLE_CONFIG_RELATIVE_PATH = path.join("framework-config", "lifecycle.yaml")

// Band ordering used ONLY for downgrade detection (ordinals, not percents).
export const LIFECYCLE_STATE_SEVERITY: Record<LifecycleState, number> = {
  ACTIVE: 0,
  CHECKPOINT_READY: 1,
  ROTATE_PENDING: 2,
  HARD_ROTATE: 3,
}

// Severity of a possibly-null state; null (unknown context) sorts below every
// real state so "unknown -> ACTIVE" is not misreported as a downgrade of a
// known band, while any real band -> lower real band is.
export function lifecycleStateSeverity(state: LifecycleState | null): number {
  return state === null ? -1 : LIFECYCLE_STATE_SEVERITY[state]
}

// True when `next` sits in a strictly lower band than `previous`. This is the
// compaction-downgrade predicate: before a rotation is committed, a fresh
// verified sample that classifies lower ALWAYS wins (rule 3 above).
export function isLifecycleDowngrade(previous: LifecycleState | null, next: LifecycleState | null): boolean {
  return lifecycleStateSeverity(next) < lifecycleStateSeverity(previous)
}

// ---------------------------------------------------------------------------
// Threshold loading + validation (fresh on every call)
// ---------------------------------------------------------------------------

function finitePercent(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= PERCENT_MIN && v <= PERCENT_MAX
}

// Pure validation of an already-parsed lifecycle.yaml document. Returns the
// flattened, FROZEN threshold mirror or a detail string listing EVERY
// violation found (config diagnostics should not require one reload per
// error). No default value is ever substituted for a missing/invalid field.
export function parseThresholds(raw: any): { ok: true; thresholds: LifecycleThresholds } | { ok: false; detail: string } {
  const violations: string[] = []
  const cr = raw?.context_rotation
  if (!cr || typeof cr !== "object" || Array.isArray(cr)) {
    return {
      ok: false,
      detail:
        "context_rotation block is missing or not an object in framework-config/lifecycle.yaml " +
        "(no built-in default thresholds exist; refusing to classify)",
    }
  }

  const cont = cr.continue_reuse_below_percent
  const from = cr.checkpoint_prepare?.from_percent
  const to = cr.checkpoint_prepare?.to_percent
  const rotate = cr.rotate_after_atomic_step_at_percent
  const hard = cr.hard_stop_new_tasks_at_percent

  if (!finitePercent(cont)) violations.push(`context_rotation.continue_reuse_below_percent must be a finite number in [${PERCENT_MIN}, ${PERCENT_MAX}] (got ${JSON.stringify(cont ?? null)})`)
  if (!finitePercent(from)) violations.push(`context_rotation.checkpoint_prepare.from_percent must be a finite number in [${PERCENT_MIN}, ${PERCENT_MAX}] (got ${JSON.stringify(from ?? null)})`)
  if (!finitePercent(to)) violations.push(`context_rotation.checkpoint_prepare.to_percent must be a finite number in [${PERCENT_MIN}, ${PERCENT_MAX}] (got ${JSON.stringify(to ?? null)})`)
  if (!finitePercent(rotate)) violations.push(`context_rotation.rotate_after_atomic_step_at_percent must be a finite number in [${PERCENT_MIN}, ${PERCENT_MAX}] (got ${JSON.stringify(rotate ?? null)})`)
  if (!finitePercent(hard)) violations.push(`context_rotation.hard_stop_new_tasks_at_percent must be a finite number in [${PERCENT_MIN}, ${PERCENT_MAX}] (got ${JSON.stringify(hard ?? null)})`)

  // cross-field consistency with the drawio bands (checked only when every
  // field is individually valid, so the detail stays readable)
  if (violations.length === 0) {
    if (cont !== from) {
      violations.push(`continue_reuse_below_percent (${cont}) must equal checkpoint_prepare.from_percent (${from}) — one reuse/checkpoint boundary`)
    }
    if (from >= to) {
      violations.push(`checkpoint_prepare.from_percent (${from}) must be < to_percent (${to}) — empty checkpoint band`)
    }
    if (to !== rotate) {
      violations.push(`checkpoint_prepare.to_percent (${to}) must equal rotate_after_atomic_step_at_percent (${rotate}) — one checkpoint/rotate boundary`)
    }
    if (rotate >= hard) {
      violations.push(`rotate_after_atomic_step_at_percent (${rotate}) must be < hard_stop_new_tasks_at_percent (${hard}) — empty rotate-pending band`)
    }
  }

  if (violations.length > 0) return { ok: false, detail: violations.join("; ") }

  // frozen: "no threshold mutation" is enforced structurally, not by comment
  const thresholds: LifecycleThresholds = Object.freeze({
    continue_reuse_below_percent: cont as number,
    checkpoint_prepare_from_percent: from as number,
    checkpoint_prepare_to_percent: to as number,
    rotate_after_atomic_step_at_percent: rotate as number,
    hard_stop_new_tasks_at_percent: hard as number,
  })
  return { ok: true, thresholds }
}

// Read + parse + validate framework-config/lifecycle.yaml FRESH from disk.
// Never cached: every lifecycle decision observes the current drawio mirror.
export function loadLifecycleThresholds(root: any): ThresholdsLoadResult {
  if (typeof root !== "string" || !root.trim()) {
    return lifecycleFailure("INVALID_INPUT", "root must be a non-empty string (the framework root containing framework-config/)")
  }
  const sourceFile = path.join(root, LIFECYCLE_CONFIG_RELATIVE_PATH)
  let parsed: any
  try {
    const B = (globalThis as any).Bun
    if (typeof B?.YAML?.parse !== "function") {
      throw new Error("YAML_PARSER_UNAVAILABLE: Bun.YAML.parse is not present in this runtime")
    }
    parsed = B.YAML.parse(fs.readFileSync(sourceFile, "utf8"))
  } catch (e: any) {
    return lifecycleFailure("CONFIG_LOAD_FAILED", `${errMsg(e)} (file: ${sourceFile})`)
  }
  const check = parseThresholds(parsed)
  if (!check.ok) {
    return lifecycleFailure("THRESHOLDS_INVALID", check.detail, { source_file: sourceFile })
  }
  return { ok: true, thresholds: check.thresholds, source_file: sourceFile, loaded_at: nowIso() }
}

// Convenience wrapper for callers holding a runtime registry core (uses
// runtimeCore.root, the resolved framework root).
export function loadLifecycleThresholdsFromCore(runtimeCore: any): ThresholdsLoadResult {
  if (!runtimeCore || typeof runtimeCore.root !== "string" || !runtimeCore.root) {
    return lifecycleFailure("CONFIG_ROOT_NOT_FOUND", "runtimeCore.root is unavailable; cannot locate framework-config/lifecycle.yaml")
  }
  return loadLifecycleThresholds(runtimeCore.root)
}

// ---------------------------------------------------------------------------
// Classification (pure)
// ---------------------------------------------------------------------------

// Defensive runtime check so a hand-built/partial thresholds object can never
// silently classify against undefined edges (programmer error -> throw; the
// structured-failure path is loadLifecycleThresholds, which validates first).
function assertThresholds(thresholds: any): asserts thresholds is LifecycleThresholds {
  const fields: Array<keyof LifecycleThresholds> = [
    "continue_reuse_below_percent",
    "checkpoint_prepare_from_percent",
    "checkpoint_prepare_to_percent",
    "rotate_after_atomic_step_at_percent",
    "hard_stop_new_tasks_at_percent",
  ]
  for (const f of fields) {
    if (!finitePercent(thresholds?.[f])) {
      throw new Error(
        `classifyLifecycleState: thresholds.${String(f)} is not a finite percent — thresholds must come from ` +
          "loadLifecycleThresholds()/parseThresholds() (framework-config/lifecycle.yaml), never be hand-built",
      )
    }
  }
}

// Classify one verified context_pct against one loaded threshold set.
//
// Pure and stateless: same (pct, thresholds) -> same result, always. The
// highest matching band wins (hard band checked first), which reproduces the
// drawio semantics (>= hard beats >= rotate beats checkpoint band) and makes
// compaction downgrades automatic (rule 3): re-running this function on the
// post-compaction sample simply returns the lower band.
//
// context_pct null / non-finite / negative -> state null, action NONE: an
// unknown context never produces a state and never authorizes an automatic
// action (docs/runtime-context-telemetry.md §7).
export function classifyLifecycleState(
  contextPct: number | null | undefined,
  thresholds: LifecycleThresholds,
  options?: { thresholds_source?: string },
): LifecycleClassification {
  assertThresholds(thresholds)
  const source =
    typeof options?.thresholds_source === "string" && options.thresholds_source
      ? options.thresholds_source
      : DEFAULT_THRESHOLDS_SOURCE

  const unknown = (detail: string): LifecycleClassification => ({
    state: null,
    action: "NONE",
    context_pct: null,
    reason: `${detail} — no lifecycle state can be classified and no automatic action may be taken (never estimate; see docs/runtime-context-telemetry.md §7)`,
    thresholds_source: source,
  })

  if (contextPct === null || contextPct === undefined) {
    return unknown("context_pct is null (no verified telemetry sample)")
  }
  if (typeof contextPct !== "number" || !Number.isFinite(contextPct)) {
    return unknown(`context_pct is not a finite number (got ${JSON.stringify(contextPct)})`)
  }
  if (contextPct < PERCENT_MIN) {
    return unknown(`context_pct is negative (got ${contextPct})`)
  }

  const hard = thresholds.hard_stop_new_tasks_at_percent
  const rotate = thresholds.rotate_after_atomic_step_at_percent
  const from = thresholds.checkpoint_prepare_from_percent

  let state: LifecycleState
  let action: LifecycleAction
  let reason: string
  if (contextPct >= hard) {
    state = "HARD_ROTATE"
    action = "STOP_NEW_TASKS_AND_FORCE_ROTATE"
    reason = `context_pct ${contextPct} >= hard_stop_new_tasks_at_percent (${hard}): no new task dispatch; forced rotation`
  } else if (contextPct >= rotate) {
    state = "ROTATE_PENDING"
    action = "ROTATE_AFTER_ATOMIC_STEP"
    reason = `context_pct ${contextPct} >= rotate_after_atomic_step_at_percent (${rotate}) and < hard_stop_new_tasks_at_percent (${hard}): rotate after the current atomic step; old generation -> ARCHIVED`
  } else if (contextPct >= from) {
    state = "CHECKPOINT_READY"
    action = "PREPARE_CHECKPOINT"
    reason = `context_pct ${contextPct} >= checkpoint_prepare.from_percent (${from}) and < rotate_after_atomic_step_at_percent (${rotate}): prepare checkpoint; do not dispatch large new tasks`
  } else {
    state = "ACTIVE"
    action = "NONE"
    reason = `context_pct ${contextPct} < continue_reuse_below_percent (${thresholds.continue_reuse_below_percent}): continue reuse (Reader especially)`
  }
  return { state, action, context_pct: contextPct, reason, thresholds_source: source }
}

// Load-fresh + classify in one call (the facade's standard entry when it has
// no thresholds at hand). Returns the structured load failure unchanged when
// the YAML is missing/invalid — classification NEVER falls back to built-in
// band values.
export function classifyFromRoot(
  root: string,
  contextPct: number | null | undefined,
): LifecycleClassification | ThresholdsLoadResult {
  const loaded = loadLifecycleThresholds(root)
  if (!loaded.ok) return loaded
  return classifyLifecycleState(contextPct, loaded.thresholds, { thresholds_source: loaded.source_file })
}
