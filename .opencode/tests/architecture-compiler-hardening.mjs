import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"

const root = path.resolve(".")
const source = path.join(root, "diagrams", "multi_agent_framework_v4_completion_guard.drawio")
const { parseDrawio } = await import("../../tools/architecture-sync/parser.ts")
const { validateIR } = await import("../../tools/architecture-sync/validate.ts")
const { parseYaml, stringifyYaml } = await import("../../tools/architecture-sync/yaml.ts")

const ir = parseDrawio(source)
const runtimeMap = { "gpt-6-sol-fast": {}, "gpt-5.6-sol-fast": {}, "gpt-5.6-sol": {}, "deepseek-v4.1-flash": {}, "qwen3.8-max": {} }

const duplicate = structuredClone(ir)
duplicate.agents.push({ ...duplicate.agents[0] })
assert.ok(validateIR(duplicate, runtimeMap).includes("ARCH_ENTITY_DUPLICATE:agents:global-orchestrator"))

const invalidThresholds = structuredClone(ir)
invalidThresholds.lifecycle.thresholds.hard_stop_new_tasks_at_percent = 40
assert.ok(validateIR(invalidThresholds, runtimeMap).includes("ARCH_LIFECYCLE_THRESHOLD_ORDER_INVALID"))

const missingProjectMetadata = structuredClone(ir)
missingProjectMetadata.projects[0].path = null
assert.ok(validateIR(missingProjectMetadata, runtimeMap).includes("ARCH_PROJECT_METADATA_MISSING:ruoyi-vue-pro"))

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "architecture-sync-hardening-"))
  fs.mkdirSync(path.join(dir, "diagrams"), { recursive: true })
  fs.cpSync(source, path.join(dir, "diagrams", path.basename(source)))
  fs.cpSync(path.join(root, "framework-config"), path.join(dir, "framework-config"), { recursive: true })
  fs.cpSync(path.join(root, ".opencode", "agents"), path.join(dir, ".opencode", "agents"), { recursive: true })
  return dir
}

function check(dir) {
  try {
    return JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", path.join(root, "tools/architecture-sync/cli.ts"), "check", "--format=json"], {
      cwd: root,
      env: { ...process.env, AI_DEV_ROOT: dir },
      encoding: "utf8",
    }))
  } catch (error) {
    return JSON.parse(error.stdout ?? "{}")
  }
}

const extraConfig = fixture()
const agentsFile = path.join(extraConfig, "framework-config", "agents.yaml")
const agents = parseYaml(fs.readFileSync(agentsFile, "utf8"))
agents.agents.push({ id: "rogue-agent", role: "rogue", lifecycle: { type: "feature-scoped" }, model: { display_name: null }, runtime_mode: "subagent" })
fs.writeFileSync(agentsFile, stringifyYaml(agents) + "\n")
const extraResult = check(extraConfig)
assert.equal(extraResult.status, "ARCHITECTURE_DRIFT")
assert.ok(extraResult.changes.some((x) => x.path === "agents.rogue-agent"))
fs.rmSync(extraConfig, { recursive: true, force: true })

const missingProfile = fixture()
fs.rmSync(path.join(missingProfile, ".opencode", "agents", "reviewer.md"))
const missingProfileResult = check(missingProfile)
assert.equal(missingProfileResult.status, "PROFILE_DRIFT")
assert.ok(missingProfileResult.changes.some((x) => x.kind === "PROFILE_DRIFT" && x.paths.includes(".opencode/agents/reviewer.md")))
fs.rmSync(missingProfile, { recursive: true, force: true })

console.log("ARCHITECTURE_COMPILER_HARDENING_EXPECTED_PASS")
