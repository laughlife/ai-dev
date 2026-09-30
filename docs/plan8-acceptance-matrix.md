# Plan 8 Final Acceptance Matrix

This is the deterministic evidence index for the reopened Plan 8 gate. It
does not replace the required live Desktop UI observation.

| ID | Evidence | State |
| --- | --- | --- |
| A | Schema migration and legacy lifecycle-table repair in `lifecycle-smoke.mjs` | PASS |
| B | Three live Desktop UI side-by-side samples | `MANUAL_UI_EVIDENCE_REQUIRED` |
| C | Below-60 reuse policy | PASS (state-machine/runtime coverage) |
| D | 60–70 checkpoint preparation and retry path | PASS (preflight implementation; isolated runtime proof pending) |
| E | >=70 automatic rotation admission | PASS (fail-closed implementation; automatic flag remains gated) |
| F | >=80 hard-stop admission | PASS (fail-closed implementation; automatic flag remains gated) |
| G | Restore marker and live-active `force` protection | PASS |
| H | Read-only git state in checkpoint | PASS |
| I | Project Reader lifecycle path | PASS (shared persistent seam) |
| J | Feature Executor scoped rotation path | PASS (shared workflow seam) |
| K | Planner scoped rotation path | PASS (shared workflow seam) |
| L | Reviewer fresh-session invariant | PASS (existing workflow/task-bus contract) |
| M | Reload/reconcile idempotence | PASS |
| N | Compaction telemetry drop to unknown/no-estimation | PASS |
| O | Workflow successor prompt routing | PASS (implementation and scoped scheduler smoke) |
| P | Global Orchestrator primary handoff | `MANUAL_UI_EVIDENCE_REQUIRED` |

## Current gate

Plan 8 automatic flags remain `false` until the user supplies the three live
Desktop UI samples and the dedicated runtime rotation evidence. The runtime
implementation is fail-closed where rotation is mandatory; this is a safety
gate, not an inferred PASS.

Required manual evidence format:

```text
session | UI pct | runtime pct | delta pp
small   |         |             |
medium  |         |             |
high    |         |             |
```

The existing isolated Node smoke is valid implementation evidence but is not
claimed as a live Desktop UI or production-session observation.
