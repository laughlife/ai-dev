const DISPLAY_MODELS: Record<string, string | null> = { "gpt-6-sol-fast": "GPT-6 Sol Fast", "gpt-5.6-sol-fast": "GPT-5.6 Sol Fast", "gpt-5.6-sol": "GPT-5.6 Sol", "deepseek-v4.1-flash": "DeepSeek-V4.1-Flash", "qwen3.8-max": "qwen3.8-max", "project-session": null }
export function validateIR(ir: any, runtimeMap: any = {}): any[] {
  const errors: string[] = []
  const list = (name: string): any[] => Array.isArray(ir?.[name]) ? ir[name] : []
  const duplicateIds = (name: string, items: any[], field = "id") => {
    const seen = new Set<string>()
    for (const item of items) {
      const id = item?.[field]
      if (id && seen.has(id)) errors.push(`ARCH_ENTITY_DUPLICATE:${name}:${id}`)
      if (id) seen.add(id)
    }
  }
  const agents = list("agents"); const projects = list("projects"); const routes = list("routes")
  const runtimeComponents = list("runtime_components"); const completionGuards = list("completion_guards"); const lanes = list("execution_lanes")
  if (ir?.ir_version !== 1) errors.push("ARCH_IR_VERSION_INVALID")
  duplicateIds("agents", agents); duplicateIds("projects", projects); duplicateIds("routes", routes)
  duplicateIds("runtime_components", runtimeComponents); duplicateIds("completion_guards", completionGuards); duplicateIds("execution_lanes", lanes)
  const ids = new Set(agents.map((x: any) => x.id).filter(Boolean))
  for (const a of agents) {
    if (!a.id || !a.role || !a.lifecycle) errors.push(`ARCH_METADATA_MISSING:${a.id ?? "unknown"}`)
    if (!(a.model_key in DISPLAY_MODELS)) errors.push(`ARCH_MODEL_KEY_UNKNOWN:${a.model_key}`)
    if (!(a.model_key in runtimeMap) && a.model_key !== "project-session") errors.push(`MODEL_MAPPING_MISSING:${a.model_key}`)
    if (!["primary", "all", "subagent"].includes(a.runtime_mode)) errors.push(`ARCH_RUNTIME_MODE_INVALID:${a.id ?? "unknown"}:${a.runtime_mode}`)
  }
  for (const p of projects) if (!p.id || !p.path) errors.push(`ARCH_PROJECT_METADATA_MISSING:${p.id ?? "unknown"}`)
  for (const r of routes) { if (!r.id || !r.target) errors.push(`ARCH_ROUTE_TARGET_MISSING:${r.id ?? "unknown"}`); if (r.target && !ids.has(r.target)) errors.push(`ARCH_ROUTE_TARGET_MISSING:${r.id}:${r.target}`) }
  for (const c of runtimeComponents) if (!c.id || !c.kind) errors.push(`ARCH_RUNTIME_COMPONENT_METADATA_MISSING:${c.id ?? "unknown"}`)
  for (const g of completionGuards) if (!g.id || !g.stage) errors.push(`ARCH_COMPLETION_GUARD_METADATA_MISSING:${g.id ?? "unknown"}`)
  for (const l of lanes) { if (!l.id || !(l.default_parallel > 0 && l.max_parallel >= l.default_parallel)) errors.push(`ARCH_LANE_INVALID:${l.id ?? "unknown"}`) }
  const t = ir?.lifecycle?.thresholds ?? {}
  const thresholds = [t.continue_reuse_below_percent, t.checkpoint_from_percent, t.checkpoint_to_percent, t.rotate_after_atomic_step_at_percent, t.hard_stop_new_tasks_at_percent]
  if (!thresholds.every(Number.isFinite)) errors.push("ARCH_LIFECYCLE_THRESHOLDS_MISSING")
  else if (!thresholds.every((value: number) => value >= 0 && value <= 100)) errors.push("ARCH_LIFECYCLE_THRESHOLD_RANGE_INVALID")
  else if (!(t.continue_reuse_below_percent <= t.checkpoint_from_percent && t.checkpoint_from_percent < t.checkpoint_to_percent && t.checkpoint_to_percent <= t.rotate_after_atomic_step_at_percent && t.rotate_after_atomic_step_at_percent <= t.hard_stop_new_tasks_at_percent)) errors.push("ARCH_LIFECYCLE_THRESHOLD_ORDER_INVALID")
  return [...new Set(errors)]
}
