import * as fs from "node:fs"
import * as path from "node:path"
import * as crypto from "node:crypto"
import { parseDrawio } from "./parser.ts"
import { semanticHash } from "./semantic-hash.ts"
import { validateIR } from "./validate.ts"
import { parseYaml } from "./yaml.ts"
import { generateFrameworkConfig } from "./generators/framework-config.ts"
import { generateAgentContracts } from "./generators/opencode-agents.ts"

const root = path.resolve(process.env.AI_DEV_ROOT ?? process.cwd())
const source = path.join(root, "diagrams", "multi_agent_framework_v4_completion_guard.drawio")
const configDir = path.join(root, "framework-config")

function sha(file: string): string { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") }
function readYaml(file: string): any { return parseYaml(fs.readFileSync(file, "utf8")) ?? {} }
function modelDisplay(key: string): string | null { return ({ "gpt-6-sol-fast": "GPT-6 Sol Fast", "gpt-5.6-sol-fast": "GPT-5.6 Sol Fast", "gpt-5.6-sol": "GPT-5.6 Sol", "deepseek-v4.1-flash": "DeepSeek-V4.1-Flash", "qwen3.8-max": "qwen3.8-max", "project-session": null } as any)[key] ?? null }

function analyze() {
  const ir: any = parseDrawio(source)
  const runtime = readYaml(path.join(configDir, "runtime-model-map.yaml"))
  const errors = validateIR(ir, runtime.models ?? {})
  const semantic = semanticHash(ir); const raw = sha(source)
  const sync = readYaml(path.join(configDir, "sync-state.yaml"))
  const changes: any[] = []
  const agents: any = readYaml(path.join(configDir, "agents.yaml"))
  for (const a of ir.agents) {
    const c = (agents.agents ?? []).find((x: any) => x.id === a.id)
    if (!c) changes.push({ path: `agents.${a.id}`, kind: "ARCHITECTURE_DRIFT", old: null, new: a })
    else {
      if (c.role !== a.role) changes.push({ path: `agents.${a.id}.role`, kind: "ARCHITECTURE_DRIFT", old: c.role, new: a.role })
      if ((c.model?.display_name ?? null) !== modelDisplay(a.model_key)) changes.push({ path: `agents.${a.id}.model.display_name`, kind: "ARCHITECTURE_DRIFT", old: c.model?.display_name ?? null, new: modelDisplay(a.model_key) })
      if (c.lifecycle?.type !== a.lifecycle) changes.push({ path: `agents.${a.id}.lifecycle.type`, kind: "ARCHITECTURE_DRIFT", old: c.lifecycle?.type, new: a.lifecycle })
    }
  }
  const routing: any = readYaml(path.join(configDir, "routing.yaml"))
  for (const r of ir.routes) if (routing.routes?.[r.id]?.target !== r.target) changes.push({ path: `routing.routes.${r.id}.target`, kind: "ARCHITECTURE_DRIFT", old: routing.routes?.[r.id]?.target ?? null, new: r.target })
  const workflow: any = readYaml(path.join(configDir, "workflow.yaml"))
  for (const lane of ir.execution_lanes) {
    const current = workflow.scheduler?.lanes?.[lane.id]
    if (current?.default_parallel !== lane.default_parallel || current?.max_parallel !== lane.max_parallel) changes.push({ path: `workflow.scheduler.lanes.${lane.id}`, kind: "ARCHITECTURE_DRIFT", old: current ?? null, new: { default_parallel: lane.default_parallel, max_parallel: lane.max_parallel } })
  }
  const completion: any = readYaml(path.join(configDir, "completion.yaml"))
  const componentIds = JSON.stringify((completion.runtime_components ?? []).slice().sort())
  const irComponentIds = JSON.stringify(ir.runtime_components.map((x: any) => x.id).sort())
  if (componentIds !== irComponentIds) changes.push({ path: "completion.runtime_components", kind: "ARCHITECTURE_DRIFT", old: completion.runtime_components ?? null, new: ir.runtime_components.map((x: any) => x.id) })
  const framework: any = readYaml(path.join(configDir, "framework.yaml"))
  if (framework.architecture?.source_of_truth !== "../diagrams/multi_agent_framework_v4_completion_guard.drawio") changes.push({ path: "framework.architecture.source_of_truth", kind: "ARCHITECTURE_DRIFT", old: framework.architecture?.source_of_truth ?? null, new: "../diagrams/multi_agent_framework_v4_completion_guard.drawio" })
  const oldSemantic = sync.architecture_source?.semantic_sha256
  if (oldSemantic && oldSemantic !== semantic) changes.push({ path: "architecture_source.semantic_sha256", kind: "ARCHITECTURE_DRIFT", old: oldSemantic, new: semantic })
  if (!oldSemantic) changes.push({ path: "architecture_source.semantic_sha256", kind: "ARCHITECTURE_DRIFT", old: null, new: semantic })
  const profileDrift: string[] = []
  for (const a of ir.agents) {
    const file = path.join(root, ".opencode", "agents", `${a.id}.md`)
    if (fs.existsSync(file) && !fs.readFileSync(file, "utf8").includes("ARCH-GENERATED:BEGIN")) profileDrift.push(`.opencode/agents/${a.id}.md`)
  }
  if (profileDrift.length) changes.push({ kind: "PROFILE_DRIFT", paths: profileDrift })
  let status = errors.length ? "PARSE_ERROR" : (changes.length ? "ARCHITECTURE_DRIFT" : "IN_SYNC")
  if (!errors.length && oldSemantic === semantic && sync.architecture_source?.raw_sha256 !== raw) status = "VISUAL_ONLY_CHANGE"
  return { status, source: path.relative(root, source), raw_sha256: raw, semantic_sha256: semantic, errors, changes, ir }
}

function output(result: any, json: boolean) { console.log(json ? JSON.stringify({ ...result, ir: undefined }) : `${result.status}\nsemantic_sha256=${result.semantic_sha256}\n${result.errors.map((x: string) => `ERROR ${x}`).join("\n")}\n${result.changes.map((x: any) => `CHANGE ${x.kind} ${x.path ?? (x.paths ?? []).join(",")}`).join("\n")}`) }

function apply(result: any, target: string, yes: boolean) {
  if (!yes) { output(result, false); return 3 }
  if (result.errors.length) { output(result, false); return 2 }
  const files: Record<string, string> = {}
  if (target === "config" || target === "all") Object.assign(files, generateFrameworkConfig(root, result.ir, result.semantic_sha256, result.raw_sha256))
  if (target === "profiles" || target === "all") Object.assign(files, generateAgentContracts(root, result.ir))
  const run = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const staging = path.join(root, "runtime", "architecture-sync-staging", run); fs.mkdirSync(staging, { recursive: true })
  const backups = path.join(root, ".backups", "architecture-sync", run); fs.mkdirSync(backups, { recursive: true })
  const originals: string[] = []
  const written: string[] = []
  try {
    for (const [rel, text] of Object.entries(files)) { const out = path.join(staging, rel); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, text); const dst = path.join(root, rel); if (fs.existsSync(dst)) { const b = path.join(backups, rel); fs.mkdirSync(path.dirname(b), { recursive: true }); fs.copyFileSync(dst, b); originals.push(rel) } }
    for (const rel of Object.keys(files)) { const dst = path.join(root, rel); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.renameSync(path.join(staging, rel), dst); written.push(rel) }
    console.log(JSON.stringify({ status: "APPLIED", targets: Object.keys(files), semantic_sha256: result.semantic_sha256, backup: path.relative(root, backups) }))
    return 0
  } catch (e: any) {
    for (const rel of written) if (!originals.includes(rel)) { try { fs.rmSync(path.join(root, rel), { force: true }) } catch {} }
    for (const rel of originals) fs.copyFileSync(path.join(backups, rel), path.join(root, rel))
    console.error(`APPLY_ABORTED ${e?.message ?? e}`); return 3
  }
}

const args = process.argv.slice(2); const command = args[0] ?? "check"; const json = args.includes("--format=json"); const target = args.includes("--target=profiles") ? "profiles" : args.includes("--target=config") ? "config" : "all"
try {
  const result = analyze()
  if (command === "apply") process.exitCode = apply(result, target, args.includes("--yes"))
  else { output(result, json); process.exitCode = command === "check" && (result.errors.length || result.changes.length) ? 1 : 0 }
} catch (e: any) { console.error(`ARCHITECTURE_SYNC_ERROR ${e?.message ?? e}`); process.exitCode = 2 }
