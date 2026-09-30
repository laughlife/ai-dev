# Plan 9 U4 — Completion Guard Hard Gate

Status: `IMPLEMENTATION_COMPLETE_RUNTIME_ACCEPTANCE_PENDING`

U4 upgrades Completion Guard from read-only checks to the deterministic gate
that owns the final Workflow transition and final-report permission.

## Contract

1. `workflow_run` stops after execution and reviewer acceptance at
   `REVIEW_PASSED` with `DELIVERY_PENDING`; it does not announce final
   completion.
2. `completion_final_report_permission` returns `FINAL_REPORT_ALLOWED` only
   when all required nodes and child tasks are terminal-success, required
   reviewer evidence is `PASS`, and no `FIX`/`REWORK` remains unresolved.
3. `completion_finalize` performs a guarded single-statement transition from
   `REVIEW_PASSED`, `DELIVERY_PENDING`, or `DELIVERY_COMPLETE` to
   `COMPLETED`, recording `finished_at` and `updated_at`.
4. A blocked gate leaves the Workflow status unchanged and returns
   `COMPLETION_GUARD_BLOCKED`.
5. A pre-existing `COMPLETED` row without `finished_at` fails closed; this
   prevents an unverified direct status write from becoming final-report
   permission.

## Implemented files

- `.opencode/lib/completion-core.ts` — deterministic permission and guarded
  finalization methods.
- `.opencode/plugins/completion-engine/index.ts` —
  `completion_final_report_permission` and `completion_finalize` tools.
- `.opencode/tests/completion-guard-hard-gate.mjs` — blocked, allowed,
  finalization, idempotency, and fail-closed coverage.

## Acceptance

The Node harness and existing Plan 8/Plan 9 regression harnesses pass. A live
Desktop V2 runtime smoke that invokes `completion_finalize` remains required
before recording U4 as runtime `PASS`.

U5 remains out of scope until U4 runtime acceptance is independently reviewed.
