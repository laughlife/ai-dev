# Framework Plan Status

## Plan 1

Status: COMPLETED

Commit:
e0bc30c

Scope:
- workspace skeleton
- root Git
- root .gitignore
- business repository isolation

## Plan 2

Status: COMPLETED

Commit:
271cab2

Scope:
- AGENTS governance
- drawio added
- Architecture Source of Truth
- framework governance

## README Merge

Commit:
a3e2243

Note:
README was added through a remote Gitee pull request and later normalized by Plan 4.

## Plan 3

Status: COMPLETED

Commit:
e777e89

Scope:
- framework-config derived mirror
- agents
- projects
- routing
- lifecycle
- sync state

Synchronization:
manual

## Plan 4

Status: COMPLETED

Commits:
- 142a87a  Phase 0 closure
- 0fce293  OpenCode Runtime Adapter

Additional governance commit:
- f6ed4d0  task decomposition / model fallback / Git discipline

Delivered:
- OpenCode V2 Agent profiles
- runtime model mapping
- OpenCode Runtime Adapter represented in drawio
- smoke tests

Explicitly deferred:
- persistent Project Main runtime
- persistent Reader session reuse
- Runtime Registry
- Task Bus runtime
- automatic lifecycle rotation

## Plan 5

Status: COMPLETED

Commits:
- 66c48b9  Plan 4 closure + governance model rule fix
- c60c9bb  project-main runtime role
- dbfa15c  SQLite runtime session registry plugin
- ab2741e  orchestrator persistent session routing
- 1e1ef93  acceptance documentation

Scope:
- Project Main runtime role normalization
- Project Reader runtime mode support
- SQLite Runtime Session Registry
- persistent Project Main session reuse
- persistent Project Reader session reuse
- runtime session ensure/send/list/get/archive tools

Deferred to Plan 6:
- full Task Bus
- Task Envelope / Result Envelope
- DAG dependency scheduler
- parallel task execution orchestration
- automatic Reviewer loop
- automatic lifecycle rotation

## Plan 6

Status: COMPLETED

Commits:
- e714f59  Plan 5 closure + Task Bus phase start
- da069d0  structured Task/Result Envelope protocol + task-bus.yaml
- 0bbc53d  shared runtime session core extraction
- b147835  Task Bus core plugin (create/dispatch/execute/get/list)
- d80061a  orchestrator + project-main Task Bus routing
- 300d071  acceptance documentation

Scope:
- Task Envelope v1
- Result Envelope v1
- Task Bus Core
- route-based dispatch
- persistent Project Main/Reader integration
- ephemeral Agent dispatch
- dependency readiness guard
- task state persistence
- Orchestrator Task Bus integration

Deferred to Plan 7:
- Planner DAG → tasks automatic materialization
- automatic DAG scheduler
- parallel task execution
- Feature Executor model assignment/routing
- automatic Reviewer dispatch
- PASS/FIX/REWORK loop
- retry policy

Deferred to Plan 8:
- context telemetry
- automatic 60/70/80 lifecycle rotation
- automatic checkpoint

## Plan 7

Status: COMPLETED

Commits:
- ac4d33b  Plan 6 closure + workflow phase start
- b1b4409  project-level Feature Executor model routing
- e4a72ee  workflow DAG + Reviewer protocol contracts
- 777379f  shared Task Bus core extraction
- f282130  scoped session extension + strict Reviewer PASS verification
- ac9e719  workflow planning + deterministic DAG validation
- 9e26e0e  DAG parallel scheduler + Reviewer rework loop
- 2062007  orchestrator/project-main automatic workflow entry
- 97575e0  reviewer-pass dry-run test hook
- 389ffc6  acceptance documentation
- ba00a11  acceptance commit hash recorded

Scope:
- Planner DAG contract
- workflow materialization
- dependency scheduler
- safe parallel execution
- project-scoped Feature Executor model routing
- Reviewer automatic dispatch
- PASS/FIX/REWORK loop
- bounded safe retry

Delivered:
- Workflow Plan v1
- Reviewer Result v1
- Workflow Engine
- DAG validation
- automatic materialization
- safe parallel scheduler
- project model Feature Executor routing
- feature-scoped Executor reuse
- automatic Reviewer dispatch
- PASS/FIX/REWORK
- bounded rework
- safe retry policy
- strict reviewer-pass verification

Deferred to Plan 8:
- context telemetry
- 60/70/80 automatic lifecycle rotation
- checkpoint
- session generation rotation
- restore

Deferred to Plan 9:
- drawio parser
- automatic architecture synchronization
- automatic Agent generation
- Documentation/Memory final PASS event chain
- production E2E

## Plan 8

Status: FINAL_ACCEPTANCE_BLOCKED

Scope:
- verified context telemetry
- checkpoint and restore
- 60/70/80 session lifecycle (automatic admission implementation complete; final live evidence gated)
- session generation rotation and reload recovery

Acceptance evidence:
- `node --experimental-strip-types --import ./.opencode/tests/register-hooks.mjs ./.opencode/tests/lifecycle-smoke.mjs`
  → `PLAN8_LIFECYCLE_SMOKE_PASS`
- same harness with `_probe2.mjs` → `PROBE2 OK`
- Plan 8 implementation reviewer evidence: isolated runtime and full Node harness PASS
- A–P matrix: code paths covered; Desktop UI and dedicated real-runtime samples remain `MANUAL_UI_EVIDENCE_REQUIRED`
- automatic rotation remains disabled until the final live evidence gate passes; Desktop UI handoff remains manual and is not claimed as transparent

## Plan 9 Part A + Part B (upper half)

Status: U3_PASS / U4_PASS / U5_PASS / U6_PASS

Scope:
- v4 Completion Guard architecture and deterministic execution/delivery checks
- independent lane scheduler and workflow resource contracts
- drawio metadata parser, normalized Architecture IR and semantic hash
- explicit compiler `check` / `diff` / transactional `apply`
- framework-config and OpenCode architecture contract synchronization with manual bodies preserved

Evidence:
- `architecture-sync check` → `IN_SYNC`
- `architecture-compiler.mjs` → `ARCHITECTURE_COMPILER_PASS`
- `plan9-architecture-smoke.mjs` → `PLAN9_ARCHITECTURE_SMOKE_PASS`
- Desktop V2 `completion_final_report_permission` → `FINAL_REPORT_ALLOWED`
- Desktop V2 `completion_finalize` → `COMPLETED` with matching
  `finished_at` / `completion_guard_finalized_at`

Current acceptance:
- U2 code layer: PASS
- U3 implementation: PASS
- U3 static tests: PASS
- U3 live read runtime evidence: PASS (Desktop V2 `2.0.20`)
- U3 live coding runtime evidence: PASS (three node-scoped workers with overlap)
- U3 conflict serialization runtime evidence: PASS (same-resource negative control)
- U3 final acceptance: PASS (independent Reviewer PASS on 2026-10-01)
- U4 implementation: PASS (deterministic Completion Guard hard gate)
- U4 live runtime acceptance: PASS (Desktop V2 `2.0.20`; workflow
  `cfc83688-d03d-48ab-b1a0-377e504e1e13`; session
  `ses_f0c85c8afffeP8NdLw9yCS3Aab`; finalized at
  `2026-09-30T18:01:41.595Z`)
- U4 independent Reviewer acceptance: PASS (fresh Reviewer session
  `ses_f0c83473affeJajCq8vyqDfCMD`)
- U5 implementation: PASS (Architecture Compiler Final Hardening)
- U5 hardening tests: PASS (`architecture-compiler-hardening.mjs`)
- U5 independent read-only review: PASS (fallback model used because the
  architecture-defined Reviewer provider was unavailable in the local CLI)
- U6 final acceptance: PASS (`PLAN9_FINAL_ACCEPTANCE_PASS`)
- Execution Kernel v1: FROZEN

## History Note

Commit messages were rewritten to Chinese on 2026-09-29. Hashes after e0bc30c differ from the original plan documents.

## Deferred

- persistent Session Registry: implemented in Plan 5
- full Task Bus runtime: implemented in Plan 6 (core; DAG scheduler implemented in Plan 7 Workflow Engine)
- Plan 8 live Desktop UI evidence and dedicated real-runtime rotation evidence
- Plan 10: Control Plane/UI
- Plan 11: production acceptance and Framework v1 release gate
