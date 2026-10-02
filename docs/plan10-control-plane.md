# Plan 10 — AI-Dev Control Plane / UI

Status: `PASS` for the local v1 read-only and guarded control surface.

Plan 10 adds a localhost Control Plane around the frozen Execution Kernel. The
surface aggregates existing runtime and compiler state; it does not become a
second source of truth.

## Delivered surface

- `tools/control-plane/server.mjs` serves a localhost HTTP API and a static
  responsive dashboard.
- Dashboard cards cover OpenCode/runtime health, Git HEAD, workflow/task/session
  counts, architecture hashes and drift, Agent inventory, lifecycle state, lane
  utilization, blocked/failed counts, ready queue, DAG/resource reasons, and
  evidence export.
- Workflow and session endpoints are read-only projections of the shared
  `runtime/tasks.db`; workflow detail includes the parsed DAG, dependency
  readiness, resource contract, task/reviewer history, ready queue, and wave
  evidence. Lifecycle events and rotation ledger rows are exposed alongside
  session rows.
- Architecture status is obtained from the existing compiler. Architecture Apply
  requires the literal `APPLY_ARCHITECTURE` confirmation and still executes the
  compiler's transactional `apply --yes` path.
- Workflow mutations are refused by the facade with
  `CONTROL_RUNTIME_REQUIRED`; they must be dispatched through the Workflow
  Engine. The workflow control projection reports the run/resume/retry boundary
  for each status. Checkpoint and reconcile controls are similarly routed to the
  Lifecycle Agent, while automatic lifecycle rotation remains `LIFECYCLE_LOCKED`
  by policy; accepted isolated fixture evidence does not enable unattended
  automatic rotation.
- Evidence is available as JSON at `/api/evidence` and Markdown at
  `/api/evidence?format=markdown` (or `/api/evidence.md`). The export includes
  wave timing records when the runtime result contains them, reviewer/completion
  gate state, lifecycle records, and architecture evidence.

## Contract and boundaries

The server binds to `127.0.0.1` by default. It never writes `runtime/tasks.db`,
framework YAML, or Agent profiles directly. The drawio/compiler chain remains
the architecture path, and the Workflow Engine and Completion Guard remain the
workflow mutation paths. The UI is a view and guarded adapter, not a new
runtime authority.

## Acceptance evidence

```text
PLAN10_CONTROL_PLANE_PASS {"health":"OK","architecture":"IN_SYNC","rotation":"LOCKED"}
```

The acceptance harness verifies the dashboard, health, workflow, ready queue,
lane projection, session/lifecycle projection, architecture, JSON/Markdown
evidence, explicit-apply confirmation, workflow action refusal, and lifecycle
lock routes against an isolated runtime fixture. This is a localhost API/static
fixture test; it does not claim a real browser/Desktop E2E run or production
telemetry. Plan 11 remains responsible for browser-level and production
evidence.

An independent read-only review returned `PASS` after checking localhost
binding, SQLite read-only access, compiler confirmation, workflow mutation
boundaries, lifecycle locking, and the static UI/API syntax.

Start it locally with:

```text
node --experimental-strip-types tools/control-plane/server.mjs
```

Then open `http://127.0.0.1:4310/`. Plan 11 remains responsible for production
authentication, browser-level evidence, failure recovery, and the Framework v1
release gate.
