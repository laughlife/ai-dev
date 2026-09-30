import * as fs from "node:fs"
import * as path from "node:path"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"

const root = path.resolve(".")
const source = path.join(root, "diagrams", "multi_agent_framework_v4_completion_guard.drawio")
const { parseDrawio } = await import("../../tools/architecture-sync/parser.ts")
const { semanticHash } = await import("../../tools/architecture-sync/semantic-hash.ts")
const { validateIR } = await import("../../tools/architecture-sync/validate.ts")
const { generateAgentContracts } = await import("../../tools/architecture-sync/generators/opencode-agents.ts")
const { generatedAgentBlock } = await import("../../tools/architecture-sync/generators/opencode-agents.ts")
const { generateFrameworkConfig } = await import("../../tools/architecture-sync/generators/framework-config.ts")
const { parseYaml } = await import("../../tools/architecture-sync/yaml.ts")

const xml = fs.readFileSync(source, "utf8")
const ir = parseDrawio(source)
assert.equal(ir.agents.length, 12)
assert.equal(ir.projects.length, 4)
assert.equal(ir.agents.find((x) => x.id === "global-orchestrator").runtime_mode, "primary")
assert.equal(ir.agents.find((x) => x.id === "project-main").runtime_mode, "all")
assert.equal(ir.agents.find((x) => x.id === "planner").runtime_mode, "subagent")
const runtimeModeChanged = JSON.parse(JSON.stringify(ir)); runtimeModeChanged.agents.find((x) => x.id === "planner").runtime_mode = "all"
assert.notEqual(semanticHash(ir), semanticHash(runtimeModeChanged))
assert.ok(validateIR({ ...ir, agents: [{ ...ir.agents[0], runtime_mode: "invalid" }] }, { models: { "gpt-6-sol-fast": {} } }).includes("ARCH_RUNTIME_MODE_INVALID:global-orchestrator:invalid"))
assert.equal(ir.execution_lanes.find((x) => x.id === "controller").max_parallel, 1)
assert.equal(validateIR(ir, { models: { "gpt-6-sol-fast": {} } }).some((x) => x.startsWith("MODEL_MAPPING_MISSING")), true)

const visual = parseDrawio(source)
visual.source.raw_sha256 = "different"
assert.equal(semanticHash(ir), semanticHash(visual), "raw/provenance changes do not affect semantic hash")
const geometryOnly = xml.replace('x="20" y="10000"', 'x="920" y="19000"')
const visualFile = path.join("C:/Users/Administrator/AppData/Local/Temp/opencode", `arch-visual-${Date.now()}.drawio`)
fs.writeFileSync(visualFile, geometryOnly)
assert.equal(semanticHash(ir), semanticHash(parseDrawio(visualFile)))

const modelChanged = xml.replace('data-model-key="gpt-6-sol-fast"', 'data-model-key="unknown-model"')
const modelFile = path.join("C:/Users/Administrator/AppData/Local/Temp/opencode", `arch-model-${Date.now()}.drawio`)
fs.writeFileSync(modelFile, modelChanged)
const changedIr = parseDrawio(modelFile)
assert.notEqual(semanticHash(ir), semanticHash(changedIr))
assert.ok(validateIR(changedIr, { models: {} }).includes("MODEL_MAPPING_MISSING:unknown-model"))
const pathChanged = JSON.parse(JSON.stringify(ir))
pathChanged.projects[0].path = "D:\\ai-dev\\path-changed"
const generatedConfig = generateFrameworkConfig(root, pathChanged, "semantic-test", "raw-test")
assert.equal(parseYaml(generatedConfig["framework-config/projects.yaml"]).projects[0].path, "D:\\ai-dev\\path-changed")

const fixtureRoot = path.join("C:/Users/Administrator/AppData/Local/Temp/opencode", `arch-profile-${Date.now()}`)
fs.mkdirSync(path.join(fixtureRoot, ".opencode", "agents"), { recursive: true })
fs.writeFileSync(path.join(fixtureRoot, ".opencode", "agents", "global-orchestrator.md"), "---\ndescription: manual\nmode: subagent\n---\n\nMANUAL-BEHAVIOR-MARKER\n")
const contracts = generateAgentContracts(fixtureRoot, { agents: [ir.agents.find((x) => x.id === "global-orchestrator")] })
assert.match(contracts[".opencode/agents/global-orchestrator.md"], /MANUAL-BEHAVIOR-MARKER/)
assert.match(contracts[".opencode/agents/global-orchestrator.md"], /ARCH-GENERATED:BEGIN/)
assert.match(contracts[".opencode/agents/global-orchestrator.md"], /architecture_runtime_mode: primary/)
assert.doesNotMatch(contracts[".opencode/agents/global-orchestrator.md"], /\nmode: subagent\n/)
assert.equal(generatedAgentBlock(ir.agents.find((x) => x.id === "project-reader")).includes("architecture_runtime_mode: all"), true)
const profilePath = path.join(root, ".opencode", "agents", "global-orchestrator.md")
const profileOriginal = fs.readFileSync(profilePath, "utf8")
fs.writeFileSync(profilePath, profileOriginal.replace("architecture_runtime_mode: primary", "architecture_runtime_mode: subagent"))
try {
  let driftOutput = ""
  try { execFileSync(process.execPath, ["--experimental-strip-types", "tools/architecture-sync/cli.ts", "check", "--format=json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) } catch (error) { driftOutput = error.stdout ?? "" }
  assert.match(driftOutput, /PROFILE_DRIFT/)
} finally {
  fs.writeFileSync(profilePath, profileOriginal)
}
fs.rmSync(visualFile, { force: true }); fs.rmSync(modelFile, { force: true }); fs.rmSync(fixtureRoot, { recursive: true, force: true })
console.log("ARCHITECTURE_COMPILER_PASS", JSON.stringify({ agents: ir.agents.length, projects: ir.projects.length, visual_hash_stable: true, manual_body_preserved: true }))
