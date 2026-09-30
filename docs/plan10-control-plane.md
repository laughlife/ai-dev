# Plan 10 — AI-Dev Control Plane / UI

Status: `PASS` for the local v1 read-only and guarded control surface.

Plan 10 adds a localhost Control Plane around the frozen Execution Kernel. The
surface aggregates existing runtime and compiler state; it does not become a
second source of truth.

## Delivered surface

- `tools/control-plane/server.mjs` serves a localhost HTTP API and a static
  responsive dashboard.
- Dashboard cards cover OpenCode/runtime health, Git HEAD, workflow/task/session
  counts, architecture hashes and drift, Agent inventory, lifecycle state, and
  evidence export.
- Workflow and session endpoints are read-only projections of the shared
  `runtime/tasks.db`; workflow detail includes current nodes and task links.
- Architecture status is obtained from the existing compiler. Architecture Apply
  requires the literal `APPLY_ARCHITECTURE` confirmation and still executes the
  compiler's transactional `apply --yes` path.
- Workflow mutations are refused by the facade with
  `CONTROL_RUNTIME_REQUIRED`; they must be dispatched through the Workflow
  Engine. Automatic lifecycle rotation returns `LIFECYCLE_LOCKED` until the
  Plan 8 final evidence gate is closed.

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

The acceptance harness verifies the dashboard, health, workflow, session,
architecture, evidence, explicit-apply confirmation, workflow action refusal,
and lifecycle lock routes against an isolated runtime fixture.

Start it locally with:

```text
node --experimental-strip-types tools/control-plane/server.mjs
```

Then open `http://127.0.0.1:4310/`. Plan 11 remains responsible for production
authentication, browser-level evidence, failure recovery, and the Framework v1
release gate.
