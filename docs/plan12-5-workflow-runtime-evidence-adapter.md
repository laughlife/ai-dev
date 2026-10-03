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

Live read-only probe:

```text
node --experimental-strip-types .opencode/tests/plan12-5-runtime-live.mjs
PLAN12_RUNTIME_ADAPTER_LIVE_BLOCKED
```

The current Desktop Runtime at `http://127.0.0.1:49374` returns HTTP 401 for
`/api/info`, plugin discovery, and all workflow RPCs. No workflow/run/wave/
node/session IDs are fabricated, no live L3 row is written, and no
`PLAN12_RUNTIME_ADAPTER_LIVE_PASS` is claimed.

The adapter uses only an explicitly supplied control-plane database path in
tests. It does not create or modify `runtime/tasks.db`, its WAL/SHM files,
business repositories, Drawio, Mem0, or the user patch.
