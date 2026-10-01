const node = process.execPath
const stripTypes = "--experimental-strip-types"
const test = (id, file, extra = []) => ({ id, file, command: node, args: [stripTypes, ...extra, file] })

export const REGRESSION_CHECKS = [
  test("architecture-compiler", ".opencode/tests/architecture-compiler.mjs"),
  test("architecture-compiler-hardening", ".opencode/tests/architecture-compiler-hardening.mjs"),
  test("lifecycle-smoke", ".opencode/tests/lifecycle-smoke.mjs", ["--import", "./.opencode/tests/register-hooks.mjs"]),
  test("lifecycle-restore-tool-contract", ".opencode/tests/lifecycle-restore-tool-contract.mjs"),
  test("session-context-envelope", ".opencode/tests/session-context-envelope.mjs"),
  test("team-execution-contract", ".opencode/tests/u3-team-execution-contract.mjs"),
  test("team-execution-coordinator", ".opencode/tests/team-execution-coordinator.mjs"),
  test("workflow-team-worker-sessions", ".opencode/tests/workflow-team-worker-sessions.mjs"),
  test("completion-guard-hard-gate", ".opencode/tests/completion-guard-hard-gate.mjs"),
  test("plan9-architecture-smoke", ".opencode/tests/plan9-architecture-smoke.mjs"),
  test("plan9-final-acceptance", ".opencode/tests/plan9-final-acceptance.mjs"),
  test("plan10-control-plane", ".opencode/tests/plan10-control-plane.mjs"),
  test("plan11-production-acceptance", ".opencode/tests/plan11-production-acceptance.mjs"),
  test("plan11-recovery-rollback", ".opencode/tests/plan11-recovery-rollback.mjs"),
  {
    id: "production-acceptance-gate",
    command: node,
    args: [stripTypes, "tools/production-acceptance/gate.mjs"],
    release_gate: true,
  },
]
