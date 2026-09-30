import assert from "node:assert/strict"

const { scheduleLaneWaves, normalizeLanePolicies } = await import("../lib/lane-scheduler.ts")
const { resourcesConflict, resolveResourceContract } = await import("../lib/lane-resource-contract.ts")
const { isComplexTeamTask, isTeamExecutionRequired, shouldMustParallelize, dispatchTeamWaves } = await import("../lib/team-execution-coordinator.ts")

const policies = normalizeLanePolicies({ scheduler: { lanes: {
  controller: { default_parallel: 1, max_parallel: 1 }, reviewer: { default_parallel: 1, max_parallel: 3 },
  read_probe: { default_parallel: 3, max_parallel: 6 }, coding: { default_parallel: 3, max_parallel: 6 },
} } })
const code = (id, resources) => ({ node_id: id, route: "code_change", project_id: "p", resources })
const read = (id, resources = { read: [`file:${id}`] }) => ({ node_id: id, route: "code_read", project_id: "p", resources })

assert.equal(isComplexTeamTask(2), false)
assert.equal(isComplexTeamTask(3), true)
assert.equal(isTeamExecutionRequired({ implementationNodeCount: 3 }), true, ">=3 implementation nodes enter team mode")
assert.equal(isTeamExecutionRequired({ multiProject: true }), true, "multi-project enters team mode")
assert.equal(isTeamExecutionRequired({ hasCodeTestReview: true }), true, "code+test+review enters team mode")
assert.equal(isTeamExecutionRequired({ hasIndependentPackages: true }), true, "independent packages enter team mode")
assert.equal(shouldMustParallelize([read("m1"), read("m2")]), true, "2 ready non-conflicting nodes must parallelize")
assert.equal(shouldMustParallelize([code("x", { write: ["same"] }), code("y", { write: ["same"] })]), false, "conflicting nodes are not forced concurrent")
assert.equal(shouldMustParallelize([{ ...read("d1"), depends_on: ["upstream"] }, read("d2")]), true, "an already-ready independent node can parallelize")
assert.equal(shouldMustParallelize([{ ...read("d1"), depends_on: ["upstream"] }, read("d2")], { completedNodeIds: [] }), false, "unsatisfied dependency is not forced concurrent")
assert.equal(scheduleLaneWaves([read("r1"), read("r2")], policies)[0].length, 2, "2 reads share a wave")
assert.equal(scheduleLaneWaves([code("c1", { write: ["a"] }), code("c2", { write: ["b"] }), code("c3", { write: ["c"] })], policies)[0].length, 3, "3 owned coding files share a wave")
assert.equal(scheduleLaneWaves(Array.from({ length: 6 }, (_, i) => code(`c${i}`, { write: [`f${i}`] })), policies)[0].length, 6, "6 coding files share one wave")
assert.equal(scheduleLaneWaves(Array.from({ length: 7 }, (_, i) => code(`c${i}`, { write: [`f${i}`] })), policies)[0].length, 6, "coding lane max is 6")
assert.equal(scheduleLaneWaves([code("a", { write: ["same"] }), code("b", { write: ["same"] })], policies).length, 2, "same writer serializes")
assert.equal(scheduleLaneWaves([code("w", { write: ["same"] }), read("r", { read: ["same"] })], policies).length, 2, "writer-reader serializes")
assert.equal(scheduleLaneWaves([code("a", { write: ["a"] }), code("b", { write: ["b"] })], policies)[0].length, 2, "different files in one project parallelize")
assert.equal(scheduleLaneWaves([code("a"), code("b")], policies).length, 2, "missing ownership falls back to project exclusive")
assert.equal(dispatchTeamWaves(Array.from({ length: 2 }, (_, i) => code(`c${i}`, { write: [`f${i}`] })), policies)[0].length, 2, "capacity follows lane backlog")
assert.equal(resourcesConflict(resolveResourceContract({ route: "code_read", project_id: "p", resources: { read: ["x"] } }), resolveResourceContract({ route: "code_read", project_id: "p", resources: { read: ["x"] } })), false, "read/read is non-conflicting")
assert.equal(resourcesConflict(resolveResourceContract({ route: "code_read", project_id: "p", resources: { read: ["x"] } }), resolveResourceContract({ route: "code_change", project_id: "p", resources: { exclusive: ["x"] } })), true, "read/exclusive conflicts")
const fallback = resolveResourceContract({ route: "code_change", project_id: "p" })
const explicitWrite = resolveResourceContract({ route: "code_change", project_id: "p", resources: { write: ["owned"] } })
const explicitExclusive = resolveResourceContract({ route: "code_read", project_id: "p", resources: { exclusive: ["lock"] } })
const projectRead = resolveResourceContract({ route: "code_read", project_id: "p", resources: { read: ["observed"] } })
for (const [label, claim] of [["read", projectRead], ["write", explicitWrite], ["exclusive", explicitExclusive]]) {
  assert.equal(resourcesConflict(fallback, claim), true, `fallback conflicts with ${label}`)
  assert.equal(resourcesConflict(claim, fallback), true, `${label} conflicts with fallback bidirectionally`)
}
assert.equal(resourcesConflict(fallback, resolveResourceContract({ route: "code_change", project_id: "other", resources: { write: ["owned"] } })), false, "different project fences do not conflict")
console.log("TEAM_EXECUTION_COORDINATOR_TEST_PASS")
