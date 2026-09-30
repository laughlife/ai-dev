# Plan 9 U4 — Completion Guard Hard Gate

Status: `PASS`

U4 upgrades Completion Guard from read-only checks to the deterministic gate
that owns the final Workflow transition and final-report permission.

## Contract

1. `workflow_run` stops after execution and reviewer acceptance at
   `REVIEW_PASSED` with `DELIVERY_PENDING`; it does not announce final
   completion.
2. `completion_final_report_permission` returns `FINAL_REPORT_ALLOWED` only
   when all required nodes and child tasks are terminal-success, required
   reviewer evidence is `PASS`, and no `FIX`/`REWORK` remains unresolved.
3. `completion_finalize` performs the permission check and guarded transition
   in one SQLite transaction. It moves `REVIEW_PASSED`, `DELIVERY_PENDING`, or
   `DELIVERY_COMPLETE` to `COMPLETED`, recording matching `finished_at` and
   `completion_guard_finalized_at` provenance markers.
4. A blocked gate leaves the Workflow status unchanged and returns
   `COMPLETION_GUARD_BLOCKED`.
5. A pre-existing `COMPLETED` row without matching Completion Guard provenance
   fails closed; an arbitrary `finished_at` value is not accepted.
6. All descendants of workflow node tasks are checked recursively, and a
   Reviewer PASS must be backed by matching history, a completed independent
   review task, and a PASS result envelope.

## Implemented files

- `.opencode/lib/completion-core.ts` — deterministic permission and guarded
  finalization methods.
- `.opencode/plugins/completion-engine/index.ts` —
  `completion_final_report_permission` and `completion_finalize` tools.
- `.opencode/tests/completion-guard-hard-gate.mjs` — blocked, allowed,
  finalization, idempotency, and fail-closed coverage.

## Acceptance

The Node harness and existing Plan 8/Plan 9 regression harnesses pass. A live
Desktop V2 `2.0.20` runtime smoke completed on workflow
`cfc83688-d03d-48ab-b1a0-377e504e1e13` in session
`ses_f0c85c8afffeP8NdLw9yCS3Aab`:

- `completion_final_report_permission` returned `FINAL_REPORT_ALLOWED` with
  `EXECUTION_COMPLETE`, `DELIVERY_COMPLETE`, and no missing evidence.
- `completion_finalize` returned `COMPLETED` with
  `final_report_permission: true`.
- The runtime row records matching `finished_at` and
  `completion_guard_finalized_at` values:
  `2026-09-30T18:01:41.595Z`.
- A fresh independent Reviewer session (`ses_f0c83473affeJajCq8vyqDfCMD`)
  returned `{"schema_version":1,"verdict":"PASS","findings":[]}`.

U5 may begin only after this accepted U4 evidence is carried into the next
planned stage.
