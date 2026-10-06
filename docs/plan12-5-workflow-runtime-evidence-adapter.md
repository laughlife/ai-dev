# Plan 12.5 Workflow Runtime Evidence Adapter

Plan 12.5 adds a sidecar adapter for complete Workflow Runtime responses. It
maps Runtime facts into the existing Plan 12 L3 envelope and calls the
append-only `ControlPlaneStore`; it does not replace the Scheduler, Ready Queue,
Lane Scheduler, resource locks, Completion Guard, or `runtime/tasks.db`.

## Boundary and provenance

The adapter accepts an explicit Runtime response containing stable identifiers,
timestamps, configuration revision, engine version, and complete run, wave,
node, lock, and execution fields. It never reads historical `waves[]` summaries
from a scheduler plan as L3 evidence. A summary without node/session/owner/
sequence facts returns `EVIDENCE_INCOMPLETE` and keeps the guard `BLOCKED`.

`source` is copied from the response. Test fixtures use
`runtime-adapter-fixture`; live Runtime evidence would use its explicit Runtime
source. Fixture rows are never presented as live evidence.

Before a new root run is admitted, the adapter requires the referenced
`config_revision` to be the single `ACTIVE` revision. Each node route is then
checked through the Plan 12.4 route admission gate, so `MODEL_UNASSIGNED`,
`UNAVAILABLE`, `REJECTED`, missing, or unprobed routes cannot become L3 node
facts. A persisted run and its retry chain may continue to use their original
snapshot after a later Apply; this preserves configuration isolation while
allowing exact replay and recovery.

The mapping preserves:

- run: `workflow_id`, stable Runtime `run_id`, `attempt`, `parent_run_id`,
  `config_revision`, plan/project/trigger, engine version, status and times;
- wave: `wave_id`, contiguous `wave_index`, ready/policy/evidence digests,
  exact parallelism, lock snapshot and times;
- node: task, route, resources, lock keys, exact `session_key`/`session_id`,
  attempt, event sequence, status, result and error;
- lock: event ID, run/wave/node, lock key, event type, owner token, sequence,
  outcome, time and error;
- execution event: event ID, run/workflow/wave/node/task, attempt, event type,
  status, sequence, payload digest/reference, time and error.

No ID, timestamp, session, lock token, sequence, or payload is invented. A
missing field returns a structured `EVIDENCE_INCOMPLETE` result. Runtime payload
digests are recomputed from the supplied payload before the payload is reduced
to the persisted digest/reference pair.

The optional adapter context is an association/envelope allowlist only:
`source`, `observed_at`, `config_revision`, and an explicit idempotency key may
be supplied by the caller when the transport envelope carries them separately.
Run, wave, node, lock, and execution fact fields (including nullable fields,
sessions, owners, sequences, and payloads) must be present in the Runtime
response itself and are never filled from context.

## Write and failure semantics

`appendRuntimeEvidenceBatch` pre-validates and appends in dependency order:
configuration snapshot, run, waves, nodes, locks, and execution events. The
existing Writer provides one SQLite transaction, foreign-key checks, sequence
checks, canonical digests, and cross-table idempotency. A failed batch is fully
rolled back and returns `EVIDENCE_WRITE_FAILED` with the original cause, stable
idempotency key, `evidence_write_status: FAILED`, `rolled_back: true`, and
`guard: BLOCKED`.

The six L3 tables are append-only. A first write that fails before a valid
run/wave/node foreign-key anchor exists cannot fabricate an
`EVIDENCE_WRITE_FAILED` execution row. When a real persisted anchor exists,
`recordEvidenceWriteFailure` appends an `EVIDENCE_WRITE_FAILED` execution event
with the next verified sequence. It never updates an existing run row or marks
an incomplete workflow complete.

Retries reuse the deterministic idempotency key derived from a canonical hash
of the Runtime source, fact type, and natural key when the required natural key
is present; this avoids delimiter and character-normalization collisions.
Otherwise the adapter returns `EVIDENCE_INCOMPLETE` instead of inventing a key. The same
digest is idempotent; a different digest is `EVIDENCE_IDEMPOTENCY_CONFLICT`.
Wave indexes, node event sequences, lock
sequences, execution sequences, attempts, revision bindings, and node/session
relationships fail closed.

For every wave the declared Runtime node set is compared by `node_id`,
`task_id`, and `attempt` with the node facts in the same batch. A mismatch is
rejected before the SQLite transaction. The first node, lock, and execution
sequence is `1`; later values must advance by one. Failure events use a stable
idempotency key and deterministic payload, so replay returns `IDEMPOTENT`.

## Verification

Fixture contract and writer test:

```text
node --experimental-strip-types .opencode/tests/plan12-5-runtime-evidence-adapter.mjs
PLAN12_WORKFLOW_RUN_ADAPTER_PASS
PLAN12_WAVE_EVIDENCE_PASS
PLAN12_WAVE_NODE_EVIDENCE_PASS
PLAN12_LOCK_EVIDENCE_PASS
PLAN12_EXECUTION_EVENT_ADAPTER_PASS
PLAN12_EVIDENCE_WRITE_FAILURE_GATE_PASS
```

Historical unauthenticated HTTP probe (kept as a fail-closed record):

```text
node --experimental-strip-types .opencode/tests/plan12-5-runtime-live.mjs
PLAN12_RUNTIME_ADAPTER_LIVE_BLOCKED
```

The earlier direct HTTP probe at `http://127.0.0.1:49374` returned HTTP 401 for
`/api/info`, plugin discovery, and all workflow RPCs. No workflow/run/wave/
node/session IDs are fabricated, no live L3 row is written, and no
`PLAN12_RUNTIME_ADAPTER_LIVE_PASS` is claimed.

The adapter uses only an explicitly supplied control-plane database path in
tests. It does not create or modify `runtime/tasks.db`, its WAL/SHM files,
business repositories, Drawio, Mem0, or the user patch.

## Plan 12.5-R2 live execution

The R2 path uses the Desktop-managed CLI `opencode v2.0.22` and its internal
authenticated session transport, rather than the stale PATH shim or the
unauthenticated HTTP RPC probe. An isolated fixture supplied
`execution_policy.mode=isolated_fixture`, `delivery=none`, a verified ACTIVE
`config_revision`, and an explicit fixture-relative Control Plane DB.

The fresh live run produced two independent `code_read` Worker sessions in one
parallel wave. `run_id`, `wave_id`, `node_id`, `task_id`, `attempt`, session IDs
and keys, UTC times, lifecycle event order, and canonical payload digests were
written during execution. The terminal batch was passed through
`appendRuntimeEvidenceBatch`, which admitted the verified `code_read` route and
persisted the immutable run/wave/node/execution facts. Reopening the isolated
DB returned the same run, eight lifecycle events, two strict node execution
events, and unchanged digest/ref pairs. No memory route or Mem0 tool call
occurred; the session-level `mem0_*`/database MCP deny rules were also applied.

The persisted live artifact is the fixture-side
`plan12-5-r2-live-evidence.json`; the raw Desktop stream is
`r2-live-output.jsonl` in the same fixture directory. These artifacts carry:

```text
PLAN12_RUNTIME_AUTH_PATH_CONFIRMED
PLAN12_RUNTIME_WORKFLOW_SMOKE_PASS
PLAN12_RUNTIME_ADAPTER_LIVE_PASS
PLAN12_RUNTIME_EVIDENCE_ROUNDTRIP_PASS
PLAN12_SMOKE_PERMISSION_GATE_PASS
```

The safe `code_read` wave had no real lock-provider acquisition, so no
`ACQUIRE`/`RELEASE` lock facts were fabricated. The current lock capability
gap remains explicit; the node facts record `lock_key_json: null`.

The Workflow Engine response remains `REVIEW_PASSED`/`DELIVERY_PENDING` because
this smoke explicitly uses `delivery=none`; the separate R2 runtime evidence
status is `COMPLETE` only after the Adapter batch and DB round-trip succeed.

## Final closeout (2026-10-06)

The current verified live run is **live v2** and uses the Desktop-managed CLI
`opencode v2.0.23`; the `v2.0.22` text above is the earlier R2-era probe and is kept
as history, not the current state. The current live v2 smoke run is
`aa97bf7f-b876-4823-952f-fc718b8b4219` (workflow
`44940f00-6ea5-41e8-95b3-e6d3eb9e80e1`, `attempt=1`, `trigger=workflow_execute`,
`status=COMPLETED`, `source=workflow-engine-live-r2`, `engine_version=workflow-engine-r2`,
`evidence_write_status=COMPLETE`) in isolated Control Plane DB
`C:/Users/Administrator/AppData/Local/Temp/opencode/plan12-final-v2-20261006-4c37812d/control-plane.db`
(sha256 `0AFFD510D39270F6ED05D8D4682C9F8FBB11BF3A2D12CC402414F6D210081EF4`,
`config_revision=plan12-final-v2-20261006-4c37812d`, `ACTIVE`). It persisted two
independent dependency-free `code_read` workers in one parallel wave (`parallelism=2`)
with distinct sessions and canonical `deepseek/deepseek-flash` (raw
`deepseek/deepseek-flash#default`): `read-architecture-fingerprints`
(`ses_eefc561bbffe1Pi7zo9NfMRVZx`) and `read-probe-summary`
(`ses_eefc561bdffelYrLNBfHMkVRUs`), overlap `2026-10-06T08:00:39.487Z →
08:00:53.575Z` ≈ 14.088s. No `ACQUIRE`/`RELEASE` lock facts were fabricated
(`lock_events_count=0`, `lock_key_json=null`).

The architecture hashes are independently recomputed and matched
(`drawio_raw_sha256=bc90b6cc…ff89c`, `drawio_semantic_sha256=e07ad943…53996`,
`ir_sha256=10b66910…a57c6`, `architecture-sync check` = `IN_SYNC`).

The Plan 12.5/12.6 scope verdict is **PASS** and the L3 evidence verification is
**PASS** for live v2. Because the run uses `delivery=none`, the overall result stays
`FINAL_REPORT_BLOCKED` / `DELIVERY_PENDING` and is **not L4**.

**History:** the previous v1 run `4bbda1c3-a807-4d58-9323-8046cd2817de` (workflow
`2d304a17-5df5-4240-81f0-c9e848f11064`, revision `plan12-final-20261006-8abc6b7c`)
is retained as historical evidence, no longer the current state.

See [`plan12-5-6-final-closeout.md`](plan12-5-6-final-closeout.md) and
[`plan12-5-6-final-readback.json`](plan12-5-6-final-readback.json).
