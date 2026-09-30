// Marker-gated lifecycle test hooks (Plan 8 T5C).
//
// This module is inert in normal loads. The plugin checks the marker once at
// setup time and registers the hook tool only when runtime/.lifecycle-test-hooks
// already exists. State is in memory and disappears on plugin reload.

import * as fs from "node:fs"
import * as path from "node:path"

export const TEST_HOOK_MARKER_RELPATH = "runtime/.lifecycle-test-hooks"
export const PHASES = ["CHECKPOINT", "CREATE", "INIT", "COMMIT"] as const

export function testHooksEnabled(root: string): boolean {
  try {
    return fs.existsSync(path.join(root, "runtime", ".lifecycle-test-hooks"))
  } catch {
    return false
  }
}

export function createLifecycleTestHooks(db: any) {
  const phaseFailures = new Map<string, { phase: string; remaining: number }>()

  function seedTelemetry(input: any) {
    const key = typeof input?.session_key === "string" ? input.session_key : ""
    if (!key) return { ok: false, status: "ERROR", code: "INVALID_INPUT", detail: "session_key is required" }
    const row: any = db?.query("SELECT generation FROM sessions WHERE session_key = ? ORDER BY generation DESC LIMIT 1").get(key)
    if (!row) return { ok: false, status: "ERROR", code: "SESSION_NOT_FOUND", detail: `no session row for '${key}'` }
    const values = [input.tokens, input.limit, input.pct].map((v: any) => (typeof v === "number" && Number.isFinite(v) ? v : null))
    if (values.some((v: number | null) => v == null)) {
      return { ok: false, status: "ERROR", code: "INVALID_INPUT", detail: "tokens, limit and pct must be finite numbers" }
    }
    const ts = new Date().toISOString()
    db.query(
      "UPDATE sessions SET context_tokens = ?, context_limit = ?, context_pct = ?, telemetry_source = ?, telemetry_at = ? WHERE session_key = ? AND generation = ?",
    ).run(values[0], values[1], values[2], "lifecycle-test-hook", ts, key, row.generation)
    return { ok: true, status: "SEEDED", session_key: key, generation: row.generation, context_pct: values[2] }
  }

  return {
    execute(input: any) {
      const action = input?.action
      if (action === "seed_telemetry") return seedTelemetry(input)
      if (action === "force_phase_failure") {
        if (typeof input?.session_key !== "string" || !input.session_key || !PHASES.includes(input.phase)) {
          return { ok: false, status: "ERROR", code: "INVALID_INPUT", detail: "session_key and phase CHECKPOINT|CREATE|INIT|COMMIT are required" }
        }
        const times = Number.isInteger(input.times) && input.times > 0 ? input.times : 1
        phaseFailures.set(input.session_key, { phase: input.phase, remaining: times })
        return { ok: true, status: "ARMED", session_key: input.session_key, phase: input.phase, times }
      }
      if (action === "clear") {
        phaseFailures.clear()
        return { ok: true, status: "CLEARED" }
      }
      if (action === "list") {
        return { ok: true, status: "OK", phase_failures: [...phaseFailures.entries()].map(([session_key, value]) => ({ session_key, ...value })) }
      }
      return { ok: false, status: "ERROR", code: "INVALID_INPUT", detail: "action must be seed_telemetry, force_phase_failure, clear or list" }
    },
    consumePhaseFailure(sessionKey: string, phase: string): boolean {
      const entry = phaseFailures.get(sessionKey)
      if (!entry || entry.phase !== phase || entry.remaining <= 0) return false
      entry.remaining -= 1
      if (entry.remaining <= 0) phaseFailures.delete(sessionKey)
      return true
    },
  }
}
