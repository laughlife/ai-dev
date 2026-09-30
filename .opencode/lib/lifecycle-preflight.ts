// Lifecycle admission wiring (Plan 8 T6).
//
// This module is deliberately a small dependency seam: runtime-registry-core
// must not import lifecycle-core because lifecycle-core imports runtime-registry
// helpers. Plugin setup code creates both cores, then calls this function.
// The callback runs while the caller already owns the process-global
// session_key lock, so it may use only lock-free lifecycle methods.

import * as fs from "node:fs"
import * as path from "node:path"

function errMsg(e: any): string {
  return e?.message ?? String(e)
}

function readFrameworkConfig(root: string): any {
  const file = path.join(root, "framework-config", "framework.yaml")
  const BunRuntime = (globalThis as any).Bun
  if (typeof BunRuntime?.YAML?.parse !== "function") {
    throw new Error("Bun.YAML.parse is unavailable")
  }
  return BunRuntime.YAML.parse(fs.readFileSync(file, "utf8"))
}

/** Read the gate fresh for every admission; no cached or inferred default. */
export function automaticRotationEnabled(root: string): boolean {
  try {
    const config = readFrameworkConfig(root)
    return config?.lifecycle_engine?.automatic_rotation === true
  } catch {
    return false
  }
}

/**
 * Wire persistent project-main/project-reader admission to lifecycle-core.
 * The returned callback is never installed as a tool and never creates a
 * session by itself. When the gate is false it still records fresh verified
 * telemetry and evaluates the current lifecycle band, but does not rotate.
 */
export function wireLifecyclePreflight(runtimeCore: any, lifecycleCore: any) {
  if (typeof runtimeCore?.setLifecyclePreflight !== "function") {
    return { ok: false, status: "ERROR", code: "LIFECYCLE_PREFLIGHT_UNAVAILABLE", detail: "runtime core has no preflight seam" }
  }
  const result = runtimeCore.setLifecyclePreflight(async (info: any) => {
    try {
      const evaluation: any = await lifecycleCore.evaluateThreshold({ session_key: info.session_key, refresh: true })
      if (!evaluation?.ok) {
        return { ok: false, code: evaluation?.code ?? "LIFECYCLE_EVALUATION_FAILED", detail: evaluation?.detail ?? "lifecycle evaluation failed" }
      }
      const due = evaluation.lifecycle_state === "ROTATE_PENDING" || evaluation.lifecycle_state === "HARD_ROTATE"
      if (!due || !automaticRotationEnabled(runtimeCore.root)) {
        return {
          ok: true,
          rotated: false,
          lifecycle_state: evaluation.lifecycle_state ?? null,
          context_pct: evaluation.context_pct ?? null,
          recommended_action: evaluation.recommended_action ?? null,
        }
      }
      // The runtime core already owns the key lock. Calling the public
      // rotateSession here would re-acquire that non-reentrant lock and
      // deadlock; the facade exposes this lock-free variant specifically for
      // admission and scoped workflow callers.
      const rotation: any = await lifecycleCore.rotateSessionLocked(info.session_key, "admission:auto", false)
      if (!rotation?.ok) {
        return { ok: false, code: rotation?.code ?? "LIFECYCLE_ROTATION_FAILED", detail: rotation?.detail ?? "automatic rotation failed" }
      }
      return {
        ok: true,
        rotated: true,
        lifecycle_state: "HANDOFF_READY",
        context_pct: rotation.context_pct ?? evaluation.context_pct ?? null,
        rotation_id: rotation.rotation_id ?? null,
        successor_session_id: rotation.successor_session_id ?? null,
      }
    } catch (e: any) {
      return { ok: false, code: "LIFECYCLE_PREFLIGHT_ERROR", detail: errMsg(e) }
    }
  })
  return result
}
