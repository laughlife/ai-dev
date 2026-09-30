import * as fs from "node:fs"
import * as path from "node:path"
import assert from "node:assert/strict"

const root = path.resolve(".")
const source = path.join(root, "diagrams", "multi_agent_framework_v4_completion_guard.drawio")
const { parseDrawio } = await import("../../tools/architecture-sync/parser.ts")
const { semanticHash } = await import("../../tools/architecture-sync/semantic-hash.ts")
const { validateIR } = await import("../../tools/architecture-sync/validate.ts")
const { generateAgentContracts } = await import("../../tools/architecture-sync/generators/opencode-agents.ts")

const xml = fs.readFileSync(source, "utf8")
const ir = parseDrawio(source)
assert.equal(ir.agents.length, 12)
assert.equal(ir.projects.length, 4)
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

const fixtureRoot = path.join("C:/Users/Administrator/AppData/Local/Temp/opencode", `arch-profile-${Date.now()}`)
fs.mkdirSync(path.join(fixtureRoot, ".opencode", "agents"), { recursive: true })
fs.writeFileSync(path.join(fixtureRoot, ".opencode", "agents", "global-orchestrator.md"), "---\ndescription: manual\nmode: subagent\n---\n\nMANUAL-BEHAVIOR-MARKER\n")
const contracts = generateAgentContracts(fixtureRoot, { agents: [ir.agents.find((x) => x.id === "global-orchestrator")] })
assert.match(contracts[".opencode/agents/global-orchestrator.md"], /MANUAL-BEHAVIOR-MARKER/)
assert.match(contracts[".opencode/agents/global-orchestrator.md"], /ARCH-GENERATED:BEGIN/)
fs.rmSync(visualFile, { force: true }); fs.rmSync(modelFile, { force: true }); fs.rmSync(fixtureRoot, { recursive: true, force: true })
console.log("ARCHITECTURE_COMPILER_PASS", JSON.stringify({ agents: ir.agents.length, projects: ir.projects.length, visual_hash_stable: true, manual_body_preserved: true }))
