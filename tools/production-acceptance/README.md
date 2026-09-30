# Production Acceptance Gate

`gate.mjs` is a fail-closed release gate for Plan 11. It reads framework state,
architecture compiler status, and explicit evidence records. It never writes
runtime state or business repositories and never fabricates live evidence.

The gate returns `BLOCKED` until the three user-reviewed evidence files listed
in `docs/plan11-production-acceptance.md` exist with `status: "PASS"`.
