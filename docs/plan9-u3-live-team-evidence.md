# Plan 9 U3 — Live Team Execution Runtime Evidence

Status: `PASS`

This document is the collection template for the Plan 9 U3 acceptance item
(Team Execution Mode parallel safety; see root `AGENTS.md` §9.1 and
`../diagrams/multi_agent_framework_v4_completion_guard.drawio`).

It records the exact live evidence observed on the OpenCode Runtime host. The
runtime evidence and independent final review are complete.

Scope: Plan 9 U3 only. U4 is explicitly out of scope for this document.

## 1. Current status

| Field | Value |
| --- | --- |
| Status | `PASS` |
| Live OpenCode Runtime evidence | Desktop V2 session, read-team, coding-team, and negative-control evidence complete |
| Latest runtime probe | Desktop-managed OpenCode V2 `2.0.20`; the earlier PATH `1.1.53` probe is stale/non-V2 and invalid for U3 (see §2.1) |
| Deterministic harness evidence | present (implementation-level only, see §4) |
| Date of this assessment | 2026-10-01 |
| Scope | Team Execution Mode parallel safety (U3) |

## 2. Final acceptance

The Desktop V2 runtime executed qualifying read, coding, and same-resource
negative-control workflows. A fresh independent Reviewer passed the complete
evidence on 2026-10-01. U3 final acceptance is closed. U4 is tracked in
`docs/plan9-u4-completion-guard.md`.

The following evidence remains normative and must not be replaced by harness
output:

1. **Harness cannot substitute.** The available deterministic harnesses run
   under Node 24 (`--experimental-strip-types`); the DB-backed one imports the
   production `.ts` cores by remapping `bun:sqlite` to the Node `node:sqlite`
   adapter via `register-hooks.mjs`. They prove pure scheduling / contract
   correctness in isolation — not runtime-host dispatch, real scoped sessions,
   or real parallel waves.
2. **Parallel evidence needs the host.** Acceptable parallel evidence is the
   runtime-produced `waves[]` (node_ids / parallelism / `started_at` /
   `ended_at`) with genuinely overlapping timestamps between independent,
   non-conflicting lanes. An isolated harness cannot produce or reconstruct
   that observation.

The independent Reviewer verdict is recorded in §7. Do not downgrade or
replace the live evidence with inference, simulation, or harness output.

## 2.1 Runtime target correction and qualifying Desktop V2 probe (2026-09-30)

A prior probe targeted the PATH `opencode` npm shim (`1.1.53`) and is **stale,
non-V2, and invalid U3 evidence**. It must not be used to diagnose the Desktop
runtime. The qualifying probe targeted the Desktop-managed service through the
Desktop CLI and its authenticated local service endpoint. No credentials, API
keys, tokens, or private response bodies were captured or recorded.

| Probe step | Target | Observation |
| --- | --- | --- |
| Runtime identity | Desktop-managed CLI / service | OpenCode `2.0.20`; service endpoint `http://127.0.0.1:49374`; Desktop service process identity confirmed |
| API identity | `GET /api/info` via Desktop CLI | `{"version":"2.0.20", ...}` |
| Plugin load | Desktop service log, workspace `D:\\ai-dev` | `workflow-engine`, Task Bus, Runtime Registry and Lifecycle plugins loaded |
| Tool visibility | V2 session tool namespace | `workflow_plan`, `workflow_run`, `workflow_execute`, `workflow_get`, `workflow_list` visible |
| Session path | Desktop V2 `POST /api/session` + prompt + session/message read | succeeded; session `ses_f0d20cfa6ffedPAjdrI1MOxm90`, assistant returned `V2_SESSION_SMOKE_OK` |
| Stale probe | PATH `opencode --version` / old `/global/health` target | `1.1.53`; explicitly rejected as non-V2 evidence |

Interpretation:

- The earlier `1.1.53` failure (`socket connection was closed unexpectedly`) is
  not evidence about the Desktop V2 runtime.
- The Desktop V2 session and tool path are healthy. Qualifying read-team,
  coding-team, and negative-control runs are recorded in §3.

## 3. Live evidence template (fill only from a real runtime run)

One row per observed run. Leave blank while blocked. Fabricated, simulated,
dry-run, model-synthesised or harness-only results must never be entered here.

| # | workflow_id | Date | Runtime version | Qualifying signal | Waves observed | Overlapping timestamps | Scoped sessions (pid/route) | Reviewer verdict | Evidence pointer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `0d3835e2-797f-4bf4-b408-e50d3c32b8ef` | 2026-09-30 | OpenCode 2.0.20 | 3 independent non-conflicting `code_read` nodes; `TEAM_EXECUTION` | wave 0; parallelism 3 | 15:20:09.265Z–15:20:48.446Z; all three intervals overlap | 3 scoped `project-reader` workers; task/session details below | Runtime `REVIEW_PASSED`; final independent review PASS | Desktop V2 session record; `workflow_get` + `task_get` |
| 2 | `cfc83688-d03d-48ab-b1a0-377e504e1e13` | 2026-09-30 | OpenCode 2.0.20 | 3 independent non-conflicting `code_change` nodes; `TEAM_EXECUTION` | wave 0; parallelism 3 | 15:33:13.634Z–15:39:10.260Z; all three intervals overlap | 3 scoped `feature-executor` workers; details below | Runtime `REVIEW_PASSED`; V1/V2/V3 PASS; final independent review PASS | Desktop V2 workflow result |
| 3 | `9cf538e4-160c-4293-9ba3-b0285e34d4fd` | 2026-09-30 | OpenCode 2.0.20 | same-resource write negative control; `TEAM_EXECUTION` | N1 wave 0, N2 wave 1; parallelism 1 each | N1 end `15:55:02.042Z` < N2 start `15:55:02.043Z` | 2 scoped `feature-executor` workers on identical `resources.write` | Runtime `REVIEW_PASSED`; final independent review PASS | Desktop V2 negative-control result |

### 3.1 Read-team worker evidence

| node_id | task_id | session_key | session_id | started_at | ended_at |
| --- | --- | --- | --- | --- | --- |
| `read-system-module` | `957d1c5c-fa53-432e-935d-2b3471c38cac` | `workflow:0d3835e2-797f-4bf4-b408-e50d3c32b8ef:project:ruoyi-vue-pro:project-reader:node:read-system-module` | `ses_f0d192acaffe4MmlQrRPCLONVu` | `2026-09-30T15:20:09.265Z` | `2026-09-30T15:20:36.794Z` |
| `read-infra-module` | `f5e37d1b-7627-4530-a800-46fc62996f22` | `workflow:0d3835e2-797f-4bf4-b408-e50d3c32b8ef:project:ruoyi-vue-pro:project-reader:node:read-infra-module` | `ses_f0d192ac9ffebz6636TEHj4rgm` | `2026-09-30T15:20:09.267Z` | `2026-09-30T15:20:48.446Z` |
| `read-admin-vue3-source` | `8130138b-2366-431f-80f7-a72634e5ed5e` | `workflow:0d3835e2-797f-4bf4-b408-e50d3c32b8ef:project:ruoyi-vue-pro:project-reader:node:read-admin-vue3-source` | `ses_f0d192ac8ffeeurjgb9Jr2aQGt` | `2026-09-30T15:20:09.268Z` | `2026-09-30T15:20:37.357Z` |

This is real Desktop V2 runtime evidence for the **read lane**. The complete
U3 evidence set received independent Reviewer PASS on 2026-10-01.

### 3.2 Coding-team worker evidence

Workflow `cfc83688-d03d-48ab-b1a0-377e504e1e13` completed with `REVIEW_PASSED`
in the Desktop V2 runtime. The first wave contained exactly `C1`, `C2`, and
`C3`, with parallelism `3`, no dependencies, and distinct `resources.write`.
The runtime wave interval was `2026-09-30T15:33:13.634Z`–
`2026-09-30T15:39:10.260Z`; all three worker intervals overlap.

| node_id | task_id | scoped session_key | session_id | worker interval |
| --- | --- | --- | --- | --- |
| `C1` | `5536cb1c-daba-471f-853c-fcab24fb8967` | `workflow:cfc83688-d03d-48ab-b1a0-377e504e1e13:project:ruoyi-vue-pro:feature-executor:node:C1` | `ses_f0d0d32d8ffeCOqyta3wTiq81A` | `15:33:13.634Z`–`15:37:02.413Z` |
| `C2` | `f476b464-3c56-4c99-b2d7-1141cff0f923` | `workflow:cfc83688-d03d-48ab-b1a0-377e504e1e13:project:ruoyi-vue-pro:feature-executor:node:C2` | `ses_f0d0d32d7ffehLowzqTDCzlcrf` | `15:33:13.636Z`–`15:37:35.502Z` |
| `C3` | `8b0993f0-892e-416d-8a70-3c9d63f36b5b` | `workflow:cfc83688-d03d-48ab-b1a0-377e504e1e13:project:ruoyi-vue-pro:feature-executor:node:C3` | `ses_f0d0d32d6ffeLi0C46lO30GGFm` | `15:33:13.637Z`–`15:39:10.260Z` |

All six workflow-scoped worker sessions (three Feature Executors and three
validation Readers) were returned as `archived: true`. The validation nodes
V1/V2/V3 each received Reviewer `PASS`. The workers wrote only the temporary
framework fixtures under `runtime/u3-live-fixtures`; the live results reported
no business-repository tracked/source changes.

The separate same-resource negative-control workflow
`9cf538e4-160c-4293-9ba3-b0285e34d4fd` completed with runtime
`REVIEW_PASSED`. N1 and N2 were assigned to different waves and the recorded
intervals do not overlap. This document does not treat the workflow's internal
review as the independent U3 Reviewer verdict.

### 3.3 Negative-control worker evidence

Both nodes declared the identical `resources.write` value:
`D:/ai-dev/runtime/u3-live-fixtures/fixture-conflict.txt`.

| node_id | task_id | scoped session_key | session_id | wave | interval | archive status |
| --- | --- | --- | --- | --- | --- | --- |
| `N1` | `2f9c78bd-8226-499a-976a-181c799b9f7e` | `workflow:9cf538e4-160c-4293-9ba3-b0285e34d4fd:project:ruoyi-vue-pro:feature-executor:node:N1` | `ses_f0cfcbbf8ffeyyOZbW72Y5XiXi` | 0 | `2026-09-30T15:51:12.645Z`–`15:55:02.042Z` | `ARCHIVED` |
| `N2` | `c79511a4-b615-43c9-a09f-ef0a7dc9e417` | `workflow:9cf538e4-160c-4293-9ba3-b0285e34d4fd:project:ruoyi-vue-pro:feature-executor:node:N2` | `ses_f0cf93be2ffeUaSxwu6gWdvId4` | 1 | `2026-09-30T15:55:02.043Z`–`15:56:27.887Z` | `ARCHIVED` |

The runtime proof is `N1.end < N2.start`; same-resource writes were safely
serialized in separate waves.

Required per-row facts:

- **Qualifying signal** — which complexity signal admitted Team Execution Mode
  (>= 3 implementation nodes, multi-project, code + test + review, or
  independent packages).
- **Waves observed** — the runtime `waves[]` contents (node_ids and lane
  parallelism), taken from the real `workflow_run` response.
- **Overlapping timestamps** — at least two independent READY, non-conflicting
  work items in the same wave with overlapping `started_at` / `ended_at`.
- **Scoped sessions** — the project / route of each concurrently executing
  lane, showing no write-scope or resource conflict within the wave.
- **Negative control** — conflicting or same-writer items must NOT share a
  wave (serialization must hold).

## 4. What does NOT count as live runtime evidence

- Deterministic Node harness output (§5) — implementation-level only.
- `workflow_test_hook` `force_verdict` / `force_failure` / `dry_reviewer_pass`
  (TEST-ONLY, marker-gated, zero dispatch).
- Hand-written, reconstructed, or illustrative `waves[]` values.
- API / DB read agreement alone.
- Any observation produced without the OpenCode runtime host.
- A reachable runtime health endpoint or a version string alone (§2.1).
- A failed or aborted session-creation / tool-dispatch attempt (§2.1), including
  transport errors such as `UnknownError: socket connection was closed
  unexpectedly`.

## 5. Deterministic harness references (verified, but NOT live evidence)

| Harness | Command | Marker | Scope | Result source |
| --- | --- | --- | --- | --- |
| U3 contract | `node --experimental-strip-types ./.opencode/tests/u3-team-execution-contract.mjs` | `U3_TEAM_EXECUTION_CONTRACT_TEST_PASS` | Agent contract text + scheduler read-before-team-mode ordering | re-run 2026-09-30 |
| Coordinator | `node --experimental-strip-types ./.opencode/tests/team-execution-coordinator.mjs` | `TEAM_EXECUTION_COORDINATOR_TEST_PASS` | Pure lane / resource scheduling and parallelization gate | re-run 2026-09-30 |
| Plan 9 smoke | `node --experimental-strip-types --import ./.opencode/tests/register-hooks.mjs ./.opencode/tests/plan9-architecture-smoke.mjs` | `PLAN9_ARCHITECTURE_SMOKE_PASS` | Lane burst + completion guard (`node:sqlite` adapter) | recorded in `plan-status.md` |

These harnesses are valid implementation evidence. They are explicitly **not**
claimed as live OpenCode Runtime or production-session observations.

## 6. Acceptance protocol (completed)

1. A live OpenCode Runtime host with the workflow-engine plugin loaded
   and the required role models configured in `framework-config/agents.yaml`.
   has been verified in §2.1; health alone is insufficient.
2. Invoke `workflow_execute` on a plan that satisfies at least one Team
   Execution Mode complexity signal.
3. Require the **real `workflow_execute` response** as the only admissible
   source, and capture from it:
   - the returned `workflow_id`;
   - the returned `waves[]` (node_ids / parallelism / `started_at` /
     `ended_at`);
   - the scoped-session evidence for each concurrently executing lane
     (project / route);
   - the runtime version of the host that produced it.
   Nothing else substitutes for these fields. A health check, a session-creation
   attempt, a harness run, or a hand-written value is not admissible.
4. Enter each observation in the §3 template with an evidence pointer.
5. Obtain an independent Reviewer PASS over the filled evidence. Completed:
   `PASS` on 2026-10-01.

## 7. Sign-off

| Role | Required | State |
| --- | --- | --- |
| Reviewer | independent PASS over the filled live evidence | PASS — 2026-10-01 |
| Documentation Agent | record only accepted facts | this document |
