import assert from "node:assert/strict"
import fs from "node:fs"

const root = new URL("../../", import.meta.url)
const read = (name) => fs.readFileSync(new URL(name, root), "utf8")
const orchestrator = read(".opencode/agents/global-orchestrator.md")
const projectMain = read(".opencode/agents/project-main.md")
const coordinator = read(".opencode/lib/team-execution-coordinator.ts")
const scheduler = read(".opencode/plugins/workflow-engine/scheduler.ts")

for (const text of [orchestrator, projectMain]) {
  assert.match(text, /workflow_execute/)
  assert.match(text, /Team Scheduler/)
  assert.match(text, /MUST_PARALLELIZE/)
  assert.match(text, /不得.*施工普通 read\/write\/test/)
}
assert.match(coordinator, /export function isTeamExecutionRequired/)
assert.match(coordinator, /export function shouldMustParallelize/)
assert.match(orchestrator, /workflow_plan -> validate DAG \/ resources ownership -> workflow_run/)
const planRead = scheduler.indexOf("const plan = safeParse(row0?.plan_json)")
const teamMode = scheduler.indexOf("const teamMode = isTeamExecutionRequired")
assert.ok(planRead >= 0 && teamMode > planRead, "scheduler reads and validates plan before team mode evaluation")
console.log("U3_TEAM_EXECUTION_CONTRACT_TEST_PASS")
