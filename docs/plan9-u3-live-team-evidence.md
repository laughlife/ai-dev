# Plan 9 U3 — Live Team Execution Runtime Evidence

Status: `TEAM_EXECUTION_RUNTIME_BLOCKED`

This document is the collection template for the Plan 9 U3 acceptance item
(Team Execution Mode parallel safety; see root `AGENTS.md` §9.1 and
`../diagrams/multi_agent_framework_v4_completion_guard.drawio`).

It is **not** evidence by itself. It defines the exact live evidence that must
be observed on the OpenCode Runtime host, and it records the current blocker
while that evidence does not exist.

Scope: Plan 9 U3 only. U4 is explicitly out of scope for this document.

## 1. Current status

| Field | Value |
| --- | --- |
| Status | `TEAM_EXECUTION_RUNTIME_BLOCKED` |
| Live OpenCode Runtime evidence | Desktop V2 session and read-team smoke recorded; coding/negative-control evidence pending |
| Latest runtime probe | Desktop-managed OpenCode V2 `2.0.20`; the earlier PATH `1.1.53` probe is stale/non-V2 and invalid for U3 (see §2.1) |
| Deterministic harness evidence | present (implementation-level only, see §4) |
| Date of this assessment | 2026-09-30 |
| Scope | Team Execution Mode parallel safety (U3) |

## 2. Exact blocker

The Desktop V2 runtime has now executed and returned a qualifying read-team
workflow. U3 remains blocked because the complete acceptance set has not yet
been observed. The concrete remaining blockers are:

1. **Coding lane pending.** No qualifying real `code_change` workflow has yet
   proved three node-scoped Feature Executor sessions in one overlapping wave.
2. **Negative control pending.** Same-resource write serialization has not yet
   been captured from a real workflow response.
3. **Harness cannot substitute.** The available deterministic harnesses run
   under Node 24 (`--experimental-strip-types`); the DB-backed one imports the
   production `.ts` cores by remapping `bun:sqlite` to the Node `node:sqlite`
   adapter via `register-hooks.mjs`. They prove pure scheduling / contract
   correctness in isolation — not runtime-host dispatch, real scoped sessions,
   or real parallel waves.
4. **Parallel evidence needs the host.** Acceptable parallel evidence is the
   runtime-produced `waves[]` (node_ids / parallelism / `started_at` /
   `ended_at`) with genuinely overlapping timestamps between independent,
   non-conflicting lanes. An isolated harness cannot produce or reconstruct
   that observation.

Until (1) and (2) are satisfied with the facts required in §3, the U3 live gate stays
blocked and must be recorded as `TEAM_EXECUTION_RUNTIME_BLOCKED`. Do not
down-grade this to a PASS by inference, simulation, or harness output.

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
- The Desktop V2 session and tool path are healthy. A qualifying read-team run
  is recorded in §3; coding and negative-control evidence remain outstanding.

## 3. Live evidence template (fill only from a real runtime run)

One row per observed run. Leave blank while blocked. Fabricated, simulated,
dry-run, model-synthesised or harness-only results must never be entered here.

| # | workflow_id | Date | Runtime version | Qualifying signal | Waves observed | Overlapping timestamps | Scoped sessions (pid/route) | Reviewer verdict | Evidence pointer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `0d3835e2-797f-4bf4-b408-e50d3c32b8ef` | 2026-09-30 | OpenCode 2.0.20 | 3 independent non-conflicting `code_read` nodes; `TEAM_EXECUTION` | wave 0; parallelism 3 | 15:20:09.265Z–15:20:48.446Z; all three intervals overlap | 3 scoped `project-reader` workers; task/session details below | Runtime result `REVIEW_PASSED`; independent U3 Reviewer pending | Desktop V2 session record; `workflow_get` + `task_get` |
| 2 | | | | | | | | | |
| 3 | | | | | | | | | |

### 3.1 Read-team worker evidence

| node_id | task_id | session_key | session_id | started_at | ended_at |
| --- | --- | --- | --- | --- | --- |
| `read-system-module` | `957d1c5c-fa53-432e-935d-2b3471c38cac` | `workflow:0d3835e2-797f-4bf4-b408-e50d3c32b8ef:project:ruoyi-vue-pro:project-reader:node:read-system-module` | `ses_f0d192acaffe4MmlQrRPCLONVu` | `2026-09-30T15:20:09.265Z` | `2026-09-30T15:20:36.794Z` |
| `read-infra-module` | `f5e37d1b-7627-4530-a800-46fc62996f22` | `workflow:0d3835e2-797f-4bf4-b408-e50d3c32b8ef:project:ruoyi-vue-pro:project-reader:node:read-infra-module` | `ses_f0d192ac9ffebz6636TEHj4rgm` | `2026-09-30T15:20:09.267Z` | `2026-09-30T15:20:48.446Z` |
| `read-admin-vue3-source` | `8130138b-2366-431f-80f7-a72634e5ed5e` | `workflow:0d3835e2-797f-4bf4-b408-e50d3c32b8ef:project:ruoyi-vue-pro:project-reader:node:read-admin-vue3-source` | `ses_f0d192ac8ffeeurjgb9Jr2aQGt` | `2026-09-30T15:20:09.268Z` | `2026-09-30T15:20:37.357Z` |

This is real Desktop V2 runtime evidence for the **read lane only**. It does
not close U3 by itself: coding overlap, same-resource serialization, archive
verification, and independent Reviewer PASS remain required.

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

## 6. How to unblock

1. Provide a live OpenCode Runtime host with the workflow-engine plugin loaded
   and the required role models configured in `framework-config/agents.yaml`.
   Health alone is insufficient; the session / workflow tool path must actually
   accept an invocation (the 2026-09-30 probe in §2.1 failed at this step).
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
5. Obtain an independent Reviewer PASS over the filled evidence, then update
   the status field. Do not change the status before step 5.

## 7. Sign-off

| Role | Required | State |
| --- | --- | --- |
| Reviewer | independent PASS over the filled live evidence | PENDING |
| Documentation Agent | record only accepted facts | this document |
