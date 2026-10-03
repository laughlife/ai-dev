import assert from "node:assert/strict"
import { REGRESSION_CHECKS } from "../../tools/regression/manifest.mjs"

assert.ok(Array.isArray(REGRESSION_CHECKS) && REGRESSION_CHECKS.length >= 10)
assert.deepEqual(REGRESSION_CHECKS.map((item) => item.id), [
  "architecture-compiler",
  "architecture-compiler-hardening",
  "lifecycle-smoke",
  "lifecycle-restore-tool-contract",
  "session-context-envelope",
  "team-execution-contract",
  "team-execution-coordinator",
  "workflow-team-worker-sessions",
  "completion-guard-hard-gate",
  "plan9-architecture-smoke",
  "plan9-final-acceptance",
  "plan10-control-plane",
  "plan11-production-acceptance",
  "plan11-recovery-rollback",
  "plan12-5-runtime-evidence-adapter",
  "production-acceptance-gate",
])
for (const item of REGRESSION_CHECKS) {
  assert.ok(typeof item.file === "string" || item.release_gate === true)
  assert.ok(Array.isArray(item.args))
}
console.log("FRAMEWORK_REGRESSION_MANIFEST_PASS")
