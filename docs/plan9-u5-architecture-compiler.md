# Plan 9 U5 — Architecture Compiler Final Hardening

Status: `PASS`

U5 hardens the explicit drawio-to-framework synchronization path while keeping
the drawio file as the architecture source of truth and preserving manual Agent
behavior bodies.

## Implemented safeguards

- Architecture IR validation rejects duplicate entity IDs, missing required
  metadata, invalid execution lanes, and lifecycle thresholds that are missing,
  outside `0..100`, or out of order.
- `check` and `diff` detect drift in both directions for Agents, projects,
  routes, execution lanes, and OpenCode Agent profiles, including missing and
  orphaned profiles.
- `apply` preflights every generated output for a non-empty body, valid YAML,
  generated contract markers, and an allowed output scope. Every staging,
  backup, and destination path is checked against the repository root.
- Transactional staging, backups, and rollback remain in place, and manual
  Agent behavior text remains preserved by the existing generators.

## Acceptance evidence

The following checks pass from `D:\ai-dev`:

```text
ARCHITECTURE_COMPILER_HARDENING_EXPECTED_PASS
ARCHITECTURE_COMPILER_PASS {"agents":12,"projects":4,"visual_hash_stable":true,"manual_body_preserved":true}
COMPLETION_GUARD_HARD_GATE_TEST_PASS
PLAN9_ARCHITECTURE_SMOKE_PASS {"lane_burst":9,"resource_serial":2,"completion_guard":true}
PLAN8_LIFECYCLE_SMOKE_PASS {"telemetry":75,"rotation":"COMMITTED","reconcile":"IDEMPOTENT","legacy_schema":"REPAIRED","hook_failures":"ISOLATED"}
TEAM_EXECUTION_COORDINATOR_TEST_PASS
U3_TEAM_EXECUTION_CONTRACT_TEST_PASS
WORKFLOW_TEAM_WORKER_SESSIONS_TEST_PASS
architecture-sync check → IN_SYNC
architecture-sync diff --format=json → IN_SYNC
git diff --check → clean
```

An independent read-only review returned `PASS` after inspecting the hardening
implementation and its fixtures. The architecture-defined `gpt-5.6-sol`
Reviewer provider was unavailable in the local CLI, so the repository fallback
model was used under the governance fallback rule.

U6 remains the next planned stage. This compiler still requires an explicit
`apply --yes` and does not hot-reload running sessions.
