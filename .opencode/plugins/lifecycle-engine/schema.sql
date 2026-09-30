-- Lifecycle Engine schema (Plan 8 T3 — schema-only delivery)
--
-- Shares ONE SQLite database with the runtime-registry / task-bus /
-- workflow-engine plugins: runtime/tasks.db. Executed idempotently by the
-- shared runtime core (.opencode/lib/runtime-registry-core.ts) on every
-- plugin core construction: every statement below is CREATE TABLE / INDEX
-- IF NOT EXISTS, so repeated execution is a no-op and existing row data is
-- never altered.
--
-- T3 delivers STORAGE ONLY. No lifecycle rotation, telemetry capture,
-- checkpoint writing, hooks or tools are implemented yet. Nothing here
-- encodes the 60/70/80 context thresholds or any model context window:
-- the rotation bands are declared exclusively in
-- framework-config/lifecycle.yaml (drawio mirror) and the event_type /
-- status vocabularies are defined by the later Plan 8 lifecycle-engine
-- tasks that will write these tables.

-- Append-only ledger of lifecycle observations and actions per session
-- generation (telemetry samples, threshold crossings, checkpoint writes,
-- rotation decisions). Rows are inserted, never updated in place.
CREATE TABLE IF NOT EXISTS lifecycle_events (
    event_id TEXT PRIMARY KEY,
    session_key TEXT NOT NULL,          -- sessions.session_key, stored verbatim
    generation INTEGER,                 -- sessions.generation the event belongs to
    opencode_session_id TEXT,           -- source OpenCode session, when available
    event_type TEXT NOT NULL,           -- vocabulary defined by the lifecycle engine (not constrained here)
    context_pct REAL,                   -- verified context usage percent at event time
    checkpoint_path TEXT,               -- related checkpoint file (runtime/checkpoints/...), when applicable
    details_json TEXT,                  -- optional structured detail (JSON text)
    created_at TEXT NOT NULL            -- ISO 8601
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_events_session
ON lifecycle_events(session_key, generation);

CREATE INDEX IF NOT EXISTS idx_lifecycle_events_created
ON lifecycle_events(created_at);

-- One row per session generation rotation (old generation -> successor),
-- kept as an auditable chain alongside sessions.replaced_by.
CREATE TABLE IF NOT EXISTS lifecycle_rotations (
    rotation_id TEXT PRIMARY KEY,
    session_key TEXT NOT NULL,          -- sessions.session_key, stored verbatim
    from_generation INTEGER NOT NULL,   -- generation being archived/replaced
    from_session_id TEXT NOT NULL,      -- predecessor OpenCode session id
    to_generation INTEGER NOT NULL,     -- successor generation
    checkpoint_path TEXT,               -- checkpoint written before rotation (templates/checkpoint.schema.json instance)
    successor_session_id TEXT,          -- successor OpenCode session id
    status TEXT NOT NULL,               -- PREPARING / SUCCESSOR_CREATED / INITIALIZED / COMMITTED / FAILED
    error TEXT,                         -- terminal failure detail
    created_at TEXT NOT NULL,           -- ISO 8601
    updated_at TEXT NOT NULL            -- ISO 8601, when the row last changed
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_rotations_session
ON lifecycle_rotations(session_key);
