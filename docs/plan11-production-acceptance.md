# Plan 11 — Production Acceptance + Framework v1

Status: `BLOCKED`

The deterministic release gate is implemented and currently fails closed. It
does not treat local Node harnesses or the Control Plane screenshot as live
production evidence.

## Gate checks

Run:

```text
node --experimental-strip-types tools/production-acceptance/gate.mjs
```

Current result:

```text
PLAN11_PRODUCTION_GATE_BLOCKED {"missing":["PLAN8_ROTATION_EVIDENCE","PRODUCTION_BUSINESS_FEATURE_E2E"],"architecture":"IN_SYNC","plan9":"PASS"}
```

The gate verifies the Plan 9 close, architecture synchronization, business
repository isolation, lifecycle/recovery harness presence, and compiler
rollback harness presence. It requires three explicit evidence files before it
can return `RELEASE_READY`:

- `docs/plan8-live-ui-evidence.json` — three Desktop UI/runtime samples with
  session, UI percentage, runtime percentage, and delta.
- `docs/plan8-rotation-evidence.json` — dedicated real-runtime rotation,
  restore, and reconcile evidence.
- `docs/plan11-business-feature-e2e.json` — a real feature execution in an
  independent business repository, with test and Reviewer evidence.

Each file must be a user-reviewed JSON object with `status: "PASS"`; the gate
does not synthesize or infer these records. This preserves the Plan 8 matrix's
manual evidence requirement and prevents a static harness from being presented
as a production observation.

The minimum accepted fields are:

```json
{
  "status": "PASS",
  "samples": [
    {
      "session": "ses_...",
      "workflow": "wf_...",
      "runtime_version": "2.0.20",
      "ui_pct": 2,
      "runtime_pct": 2,
      "delta_pp": 0,
      "timestamp": "2026-10-01T00:00:00.000Z"
    }
  ]
}
```

The rotation record must include workflow/session identifiers, non-empty
rotation, restore, and reconcile results, plus a Reviewer `PASS`. The business
record must include the independent repository, feature name, test `PASS`,
Reviewer `PASS`, and either a commit or an ISO timestamp. Empty placeholder
records are rejected as missing evidence.

The three Desktop UI/runtime samples are now recorded in
`docs/plan8-live-ui-evidence.json`; each was inspected in the connected
OpenCode Desktop context panel and has a 0pp UI/runtime delta. The dedicated
rotation/restore/reconcile record and real business Feature E2E remain open.

The local recovery/rollback drill is executable and currently passes:

```text
PLAN11_RECOVERY_ROLLBACK_PASS {"restart":"IN_SYNC","rollback":"PASS"}
```

An independent Reviewer returned `PASS` after verifying that architecture,
Git isolation, recovery, compiler rollback, and missing evidence all fail closed.
The acceptance test also runs the gate against an invalid temporary root and
expects `BLOCKED` with the corresponding failure markers.

Once those records exist, rerun the gate and the full regression suite. A
`RELEASE_READY` result is the final Framework v1 release gate.

The reproducible full regression command is:

```text
node --experimental-strip-types tools/regression/run.mjs
```

It keeps the deterministic harness checks separate from the production gate:
local harnesses may all pass while the final result remains `BLOCKED` until
the three user-reviewed evidence records are present and structurally valid.
