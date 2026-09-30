import fs from "node:fs"
import path from "node:path"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"

const root = path.resolve(".")
const statusDoc = fs.readFileSync(path.join(root, "docs", "plan-status.md"), "utf8")
const acceptanceDoc = fs.readFileSync(path.join(root, "docs", "plan9-u6-final-acceptance.md"), "utf8")

assert.match(statusDoc, /Status: U3_PASS \/ U4_PASS \/ U5_PASS \/ U6_PASS/)
assert.match(acceptanceDoc, /Status: `PASS`/)
assert.match(acceptanceDoc, /Execution Kernel v1 Frozen/)

const compiler = execFileSync(process.execPath, ["--experimental-strip-types", "tools/architecture-sync/cli.ts", "check", "--format=json"], { cwd: root, encoding: "utf8" })
const compilerResult = JSON.parse(compiler)
assert.equal(compilerResult.status, "IN_SYNC")
assert.deepEqual(compilerResult.errors, [])
assert.deepEqual(compilerResult.changes, [])
const diff = execFileSync(process.execPath, ["--experimental-strip-types", "tools/architecture-sync/cli.ts", "diff", "--format=json"], { cwd: root, encoding: "utf8" })
const diffResult = JSON.parse(diff)
assert.equal(diffResult.status, "IN_SYNC")
assert.deepEqual(diffResult.errors, [])
assert.deepEqual(diffResult.changes, [])

const hardening = execFileSync(process.execPath, ["--experimental-strip-types", ".opencode/tests/architecture-compiler-hardening.mjs"], { cwd: root, encoding: "utf8" })
assert.match(hardening, /ARCHITECTURE_COMPILER_HARDENING_EXPECTED_PASS/)
const compilerTest = execFileSync(process.execPath, ["--experimental-strip-types", ".opencode/tests/architecture-compiler.mjs"], { cwd: root, encoding: "utf8" })
assert.match(compilerTest, /ARCHITECTURE_COMPILER_PASS/)

const harnesses = [
  [["--experimental-strip-types", "--test", ".opencode/tests/completion-guard-hard-gate.mjs"], /COMPLETION_GUARD_HARD_GATE_TEST_PASS/],
  [["--experimental-strip-types", "--import", "./.opencode/tests/register-hooks.mjs", ".opencode/tests/plan9-architecture-smoke.mjs"], /PLAN9_ARCHITECTURE_SMOKE_PASS/],
  [["--experimental-strip-types", "--import", "./.opencode/tests/register-hooks.mjs", ".opencode/tests/lifecycle-smoke.mjs"], /PLAN8_LIFECYCLE_SMOKE_PASS/],
  [["--experimental-strip-types", ".opencode/tests/team-execution-coordinator.mjs"], /TEAM_EXECUTION_COORDINATOR_TEST_PASS/],
  [["--experimental-strip-types", ".opencode/tests/u3-team-execution-contract.mjs"], /U3_TEAM_EXECUTION_CONTRACT_TEST_PASS/],
  [["--experimental-strip-types", ".opencode/tests/workflow-team-worker-sessions.mjs"], /WORKFLOW_TEAM_WORKER_SESSIONS_TEST_PASS/],
]
for (const [args, marker] of harnesses) assert.match(execFileSync(process.execPath, args, { cwd: root, encoding: "utf8" }), marker)

for (const file of [
  ".opencode/tests/completion-guard-hard-gate.mjs",
  ".opencode/tests/plan9-architecture-smoke.mjs",
  ".opencode/tests/lifecycle-smoke.mjs",
  ".opencode/tests/team-execution-coordinator.mjs",
  ".opencode/tests/u3-team-execution-contract.mjs",
  ".opencode/tests/workflow-team-worker-sessions.mjs",
]) assert.ok(fs.existsSync(path.join(root, file)), `missing acceptance harness: ${file}`)

for (const project of ["ruoyi-vue-pro", "yudao-ui-admin-vue3", "xxl-job", "nyamtn"]) {
  const tracked = execFileSync("git", ["ls-files", project], { cwd: root, encoding: "utf8" }).trim()
  assert.equal(tracked, "", `business repository leaked into framework index: ${project}`)
}

console.log("PLAN9_FINAL_ACCEPTANCE_PASS", JSON.stringify({ compiler: "IN_SYNC", u3: "PASS", u4: "PASS", u5: "PASS", business_repos_isolated: true }))
