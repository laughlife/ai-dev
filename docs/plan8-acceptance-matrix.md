# Plan 8 Final Acceptance Matrix

This is the deterministic evidence index for the completed Plan 8 gate. It
does not replace the required live Desktop UI observation.

| ID | Evidence | State |
| --- | --- | --- |
| A | Schema migration and legacy lifecycle-table repair in `lifecycle-smoke.mjs` | PASS |
| B | Three live Desktop UI side-by-side samples | PASS (`docs/plan8-live-ui-evidence.json`) |
| C | Below-60 reuse policy | PASS (state-machine/runtime coverage) |
| D | 60–70 checkpoint preparation and retry path | PASS (preflight/retry implementation; isolated checkpoint/rotation evidence supplied) |
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

The dedicated runtime rotation evidence is supplied by
`docs/plan8-rotation-evidence.json`. It records verified telemetry,
checkpoint, a committed isolated rotation with a successor generation,
restore, two idempotent reconcile calls, and a fresh Reviewer PASS. Automatic
rotation remains disabled by policy; the evidence is for the explicit isolated
fixture path.

P remains `MANUAL_UI_EVIDENCE_REQUIRED`: the supplied UI samples do not directly
prove Global Orchestrator primary handoff. This is a non-blocking manual
observation item for the current Plan 11 release gate; it is not a reason to
change P to PASS or to mark `framework_v1` blocked.

The recorded manual UI evidence contains:

```text
session | UI pct | runtime pct | delta pp
audit-plan8  | 5%  | 5%  | 0pp |
audit-plan10 | 5%  | 5%  | 0pp |
audit-plan11 | 12% | 12% | 0pp |
```

The existing isolated **Node 24** smoke uses
`--import ./.opencode/tests/register-hooks.mjs` to map the production
`bun:sqlite` import to the Node adapter. It is valid implementation evidence
but is not claimed as a live Desktop UI or production-session observation.
