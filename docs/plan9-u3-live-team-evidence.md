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
| Live OpenCode Runtime evidence | none recorded |
| Latest runtime probe | health reachable (version `1.1.53`); no usable session / workflow smoke (see §2.1) |
| Deterministic harness evidence | present (implementation-level only, see §4) |
| Date of this assessment | 2026-09-30 |
| Scope | Team Execution Mode parallel safety (U3) |

## 2. Exact blocker

Team Execution Mode (>= 3 implementation nodes / multi-project / code + test +
review / independent packages) has never been executed and observed on the live
OpenCode Runtime host. The concrete blockers are:

1. **No hosted run.** No real `workflow_execute` / `workflow_run` invocation on
   a qualifying plan has been recorded from the OpenCode runtime host. The
   parallel-safety behavior is therefore unobserved outside isolated harnesses.
2. **Harness cannot substitute.** The available deterministic harnesses run
   under Node 24 (`--experimental-strip-types`); the DB-backed one imports the
   production `.ts` cores by remapping `bun:sqlite` to the Node `node:sqlite`
   adapter via `register-hooks.mjs`. They prove pure scheduling / contract
   correctness in isolation — not runtime-host dispatch, real scoped sessions,
   or real parallel waves.
3. **Parallel evidence needs the host.** Acceptable parallel evidence is the
   runtime-produced `waves[]` (node_ids / parallelism / `started_at` /
   `ended_at`) with genuinely overlapping timestamps between independent,
   non-conflicting lanes. An isolated harness cannot produce or reconstruct
   that observation.

Until (1) is satisfied with the facts required in §3, the U3 live gate stays
blocked and must be recorded as `TEAM_EXECUTION_RUNTIME_BLOCKED`. Do not
down-grade this to a PASS by inference, simulation, or harness output.

## 2.1 Latest OpenCode Runtime probe (2026-09-30) — BLOCKED, not live evidence

A read-only probe of the local OpenCode V2 runtime host was performed on
2026-09-30. No credentials, API keys, tokens, or private response bodies were
captured or recorded.

| Probe step | Target | Observation |
| --- | --- | --- |
| Server health | `GET /global/health` on the local runtime host | reachable; reports `healthy: true` and version `1.1.53` |
| Session creation (runtime HTTP) | `POST /session` (route present in the runtime `/doc` OpenAPI listing) | no usable smoke session could be established |
| Workflow tool path | session-based `workflow_execute` tool dispatch | no usable smoke invocation could be established |
| Failure shape | — | request failed with `UnknownError`, message: `socket connection was closed unexpectedly` |

Interpretation:

- The runtime process itself is reachable, so the blocker is **not** "no runtime
  on the host". The blocker is that no usable workflow invocation could be
  established through the runtime session / tool path from this client.
- This probe is a connectivity and blocker observation only. It produced **no**
  `workflow_id`, **no** `waves[]`, and **no** scoped-session evidence.
- It therefore must **not** be entered into the §3 template and must **not** be
  reported as a live PASS. `Status` stays `TEAM_EXECUTION_RUNTIME_BLOCKED`.

## 3. Live evidence template (fill only from a real runtime run)

One row per observed run. Leave blank while blocked. Fabricated, simulated,
dry-run, model-synthesised or harness-only results must never be entered here.

| # | workflow_id | Date | Runtime version | Qualifying signal | Waves observed | Overlapping timestamps | Scoped sessions (pid/route) | Reviewer verdict | Evidence pointer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | | | | | | | | | |
| 2 | | | | | | | | | |
| 3 | | | | | | | | | |

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
