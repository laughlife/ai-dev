# Plan 11 — Production Acceptance + Framework v1

Status: `PASS`

The deterministic release gate is implemented and currently fails closed. It
does not treat local Node harnesses or the Control Plane screenshot as live
production evidence.

## Gate checks

Run:

```text
node --experimental-strip-types tools/production-acceptance/gate.mjs
```

Final result:

```text
{"status":"PASS","missing":[],"framework_v1":"RELEASE_READY"}
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

The three Desktop UI/runtime samples are recorded in
`docs/plan8-live-ui-evidence.json`; each was inspected in the connected
OpenCode Desktop context panel and has a 0pp UI/runtime delta. The dedicated
rotation/restore/reconcile record is `docs/plan8-rotation-evidence.json`, and
the real business Feature E2E record is
`docs/plan11-business-feature-e2e.json`; both include fresh Reviewer PASS.

The local recovery/rollback drill is executable and currently passes:

```text
PLAN11_RECOVERY_ROLLBACK_PASS {"restart":"IN_SYNC","rollback":"PASS"}
```

An independent Reviewer returned `PASS` after verifying architecture, Git
isolation, recovery, compiler rollback, and the supplied production evidence.
The acceptance test also runs the gate against an invalid temporary root and
expects `BLOCKED` with the corresponding failure markers.

Those records now exist and the gate returns `RELEASE_READY`; the full
regression suite is rerun as part of this closeout.

The reproducible full regression command is:

```text
node --experimental-strip-types tools/regression/run.mjs
```

It keeps the deterministic harness checks separate from the production gate;
the final result is now `RELEASE_READY` because all required evidence is
structurally valid.
