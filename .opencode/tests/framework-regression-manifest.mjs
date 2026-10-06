import assert from "node:assert/strict"
import { REGRESSION_CHECKS } from "../../tools/regression/manifest.mjs"

assert.ok(Array.isArray(REGRESSION_CHECKS) && REGRESSION_CHECKS.length >= 10)
assert.deepEqual(REGRESSION_CHECKS.map((item) => item.id), [
  "architecture-compiler",
  "architecture-compiler-hardening",
  "regression-failure-semantics",
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
  "plan12-boundary-contract",
  "plan12-control-plane-migration",
  "plan12-evidence-writer",
  "plan12-restart-recovery",
  "plan12-config-revision",
  "plan12-apply-cas",
  "plan12-rollback-journal",
  "plan12-model-route-contract",
  "plan12-model-route-gates",
  "plan12-runtime-fixture-contract",
  "plan12-default-identity-chain",
  "plan12-5-runtime-evidence-adapter",
  "plan12-5-r2-runtime-evidence-contract",
  "plan12-6-completion-guard-evidence",
  "production-acceptance-gate",
])
for (const item of REGRESSION_CHECKS) {
  assert.ok(typeof item.file === "string" || item.release_gate === true)
  assert.ok(Array.isArray(item.args))
}
console.log("FRAMEWORK_REGRESSION_MANIFEST_PASS")
