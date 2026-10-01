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
PLAN11_PRODUCTION_GATE_BLOCKED {"missing":["PLAN8_DESKTOP_UI_SAMPLES","PLAN8_ROTATION_EVIDENCE","PRODUCTION_BUSINESS_FEATURE_E2E"],"architecture":"IN_SYNC","plan9":"PASS"}
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
