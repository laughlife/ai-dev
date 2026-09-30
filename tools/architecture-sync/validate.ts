const DISPLAY_MODELS: Record<string, string | null> = { "gpt-6-sol-fast": "GPT-6 Sol Fast", "gpt-5.6-sol-fast": "GPT-5.6 Sol Fast", "gpt-5.6-sol": "GPT-5.6 Sol", "deepseek-v4.1-flash": "DeepSeek-V4.1-Flash", "qwen3.8-max": "qwen3.8-max", "project-session": null }
export function validateIR(ir: any, runtimeMap: any = {}): any[] {
  const errors: string[] = []; const agents = Array.isArray(ir?.agents) ? ir.agents : []; const ids = new Set(agents.map((x: any) => x.id))
  if (ir?.ir_version !== 1) errors.push("ARCH_IR_VERSION_INVALID")
  for (const a of agents) { if (!a.id || !a.role || !a.lifecycle) errors.push(`ARCH_METADATA_MISSING:${a.id ?? "unknown"}`); if (!(a.model_key in DISPLAY_MODELS)) errors.push(`ARCH_MODEL_KEY_UNKNOWN:${a.model_key}`); if (!(a.model_key in runtimeMap) && a.model_key !== "project-session") errors.push(`MODEL_MAPPING_MISSING:${a.model_key}`) }
  for (const r of ir?.routes ?? []) { if (!r.id || !r.target) errors.push(`ARCH_ROUTE_TARGET_MISSING:${r.id ?? "unknown"}`); if (!ids.has(r.target)) errors.push(`ARCH_ROUTE_TARGET_MISSING:${r.id}:${r.target}`) }
  for (const l of ir?.execution_lanes ?? []) if (!(l.default_parallel > 0 && l.max_parallel >= l.default_parallel)) errors.push(`ARCH_LANE_INVALID:${l.id}`)
  const t = ir?.lifecycle?.thresholds ?? {}; if (![t.continue_reuse_below_percent, t.checkpoint_from_percent, t.checkpoint_to_percent, t.rotate_after_atomic_step_at_percent, t.hard_stop_new_tasks_at_percent].every(Number.isFinite)) errors.push("ARCH_LIFECYCLE_THRESHOLDS_MISSING")
  return [...new Set(errors)]
}
