import * as fs from "node:fs"
import * as path from "node:path"
import { parseYaml, stringifyYaml } from "../yaml.ts"

const modelDisplay: Record<string, string | null> = { "gpt-6-sol-fast": "GPT-6 Sol Fast", "gpt-5.6-sol-fast": "GPT-5.6 Sol Fast", "gpt-5.6-sol": "GPT-5.6 Sol", "deepseek-v4.1-flash": "DeepSeek-V4.1-Flash", "qwen3.8-max": "qwen3.8-max", "project-session": null }

function clone(v: any): any { return JSON.parse(JSON.stringify(v)) }
function read(root: string, file: string): any { return parseYaml(fs.readFileSync(path.join(root, "framework-config", file), "utf8")) ?? {} }

export function generateFrameworkConfig(root: string, ir: any, semantic: string, raw: string): Record<string, string> {
  const agents = read(root, "agents.yaml"); const byId = new Map((agents.agents ?? []).map((x: any) => [x.id, x]))
  for (const a of ir.agents) {
    const target: any = byId.get(a.id); if (!target) continue
    target.role = a.role; target.display_name = target.display_name ?? a.id
    target.model ??= {}
    if (modelDisplay[a.model_key] !== undefined) target.model.display_name = modelDisplay[a.model_key]
    target.lifecycle ??= {}; target.lifecycle.type = a.lifecycle
  }
  agents.agents = [...byId.values()]
  const lifecycle = read(root, "lifecycle.yaml")
  lifecycle.context_rotation = { ...lifecycle.context_rotation, ...ir.lifecycle.thresholds, continue_reuse_below_percent: ir.lifecycle.thresholds.continue_reuse_below_percent, checkpoint_prepare: { ...(lifecycle.context_rotation?.checkpoint_prepare ?? {}), from_percent: ir.lifecycle.thresholds.checkpoint_from_percent, to_percent: ir.lifecycle.thresholds.checkpoint_to_percent }, rotate_after_atomic_step_at_percent: ir.lifecycle.thresholds.rotate_after_atomic_step_at_percent, hard_stop_new_tasks_at_percent: ir.lifecycle.thresholds.hard_stop_new_tasks_at_percent }
  lifecycle.roles ??= {}; for (const a of ir.agents) lifecycle.roles[a.id] = { ...(lifecycle.roles[a.id] ?? {}), lifecycle: a.lifecycle }
  const projects = read(root, "projects.yaml")
  const sync = read(root, "sync-state.yaml")
  sync.architecture_source = { ...(sync.architecture_source ?? {}), file: "../diagrams/multi_agent_framework_v4_completion_guard.drawio", sha256: raw, raw_sha256: raw, semantic_sha256: semantic, parser_version: "architecture-sync-v1" }
  sync.sync = { ...(sync.sync ?? {}), mode: "compiler-explicit-apply", status: "synchronized" }
  sync.generated_files = [...new Set([...(sync.generated_files ?? []), "completion.yaml", "runtime-model-map.yaml"])]
  return { "framework-config/agents.yaml": stringifyYaml(agents) + "\n", "framework-config/projects.yaml": stringifyYaml(projects) + "\n", "framework-config/lifecycle.yaml": stringifyYaml(lifecycle) + "\n", "framework-config/sync-state.yaml": stringifyYaml(sync) + "\n" }
}
