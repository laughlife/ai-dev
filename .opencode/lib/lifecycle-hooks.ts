// Lifecycle observation hooks (Plan 8 T5C).
//
// Hooks observe model-context and compaction boundaries only. They never
// rotate, block prompts, mutate lifecycle_state, call Mem0, or write business
// repositories. The next context read after compaction re-runs the verified
// telemetry formula against the compacted context.

export async function registerLifecycleObservationHooks(ctx: any, lifecycleCore: any, runtimeCore: any) {
  const registrations: any[] = []

  async function sampleSession(sessionID: string, source: string) {
    if (!runtimeCore?.db || typeof sessionID !== "string" || !sessionID) return
    let row: any = null
    try {
      row = runtimeCore.db
        .query("SELECT session_key FROM sessions WHERE opencode_session_id = ? ORDER BY generation DESC LIMIT 1")
        .get(sessionID)
    } catch {
      return
    }
    if (!row?.session_key || typeof lifecycleCore?.refreshTelemetry !== "function") return
    try {
      await lifecycleCore.refreshTelemetry({ session_key: row.session_key, observation_source: source })
    } catch {
      // Observation hooks are best-effort and must never affect model calls.
    }
  }

  if (typeof ctx?.session?.hook !== "function") return registrations

  const contextRegistration = await ctx.session.hook("context", async (event: any) => {
    await sampleSession(event?.sessionID, "context-hook")
  })
  if (contextRegistration) registrations.push(contextRegistration)

  const compactionRegistration = await ctx.session.hook("compaction", async (event: any) => {
    // This is intentionally an observation before the compaction request. The
    // following context hook samples the post-compaction view; no stale sample
    // is used for rotation and no hook performs threshold mutation.
    await sampleSession(event?.sessionID, "compaction-boundary-hook")
  })
  if (compactionRegistration) registrations.push(compactionRegistration)

  return registrations
}

export async function disposeLifecycleObservationHooks(registrations: any[]) {
  for (const registration of Array.isArray(registrations) ? registrations : []) {
    try {
      await registration?.dispose?.()
    } catch {}
  }
}
