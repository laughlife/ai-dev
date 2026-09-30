-- Runtime Session Registry schema (Plan 5)
--
-- Plan 5 minimum tables: registry_meta / sessions / tasks.
-- Extension note (allowed by plan "最少包含"): sessions uses composite
-- PRIMARY KEY (session_key, generation) so archived/stale generations remain
-- auditable and replaced_by can point from the old generation to its successor.
--
-- Plan 8 T3 (registry schema v2): `sessions` gains six additive nullable
-- telemetry/lifecycle columns (see the inline note below). Existing v1
-- databases are migrated idempotently by
-- .opencode/lib/runtime-registry-core.ts (PRAGMA table_info + BEGIN
-- IMMEDIATE + ALTER TABLE ADD COLUMN for missing columns only, metadata-only,
-- row data untouched). The lifecycle tables (lifecycle_events /
-- lifecycle_rotations) live in .opencode/plugins/lifecycle-engine/schema.sql
-- and share this same runtime/tasks.db.
--
-- The `tasks` table is SCHEMA-ONLY in Plan 5.
-- The full Task Bus (DAG / dispatch / retry / reviewer loop) is NOT implemented.

CREATE TABLE IF NOT EXISTS registry_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    session_key TEXT NOT NULL,
    project_id TEXT NOT NULL,
    role TEXT NOT NULL,
    opencode_session_id TEXT NOT NULL UNIQUE,
    generation INTEGER NOT NULL DEFAULT 1,
    agent_id TEXT NOT NULL,
    model_runtime_id TEXT,
    project_path TEXT NOT NULL,
    status TEXT NOT NULL,
    checkpoint_path TEXT,
    created_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL,
    replaced_by TEXT,
    -- Plan 8 T3 (schema v2) additive columns — STORAGE ONLY. Declared last so
    -- fresh installs and ALTER-migrated v1 databases share the same column
    -- order. Nullable with no default: existing rows simply read NULL and are
    -- never rewritten. No threshold / context-window logic is encoded here or
    -- in the core; the 60/70/80 rotation bands are declared exclusively in
    -- framework-config/lifecycle.yaml and evaluated by later Plan 8 tasks.
    -- Verified context telemetry — measurement protocol is normative in
    -- docs/runtime-context-telemetry.md (T1, verified against OpenCode
    -- 2.0.20): values are recorded observations, never estimated; when no
    -- exact measurement exists the columns stay NULL.
    context_tokens INTEGER,                 -- last-assistant-message token sum at sample time (verified_context_tokens)
    context_limit INTEGER,                  -- catalog limit.context observed at sample time (verified_context_limit)
    context_pct REAL,                       -- round(used/window*100) per the verified formula; NULL when unknown (drawio: context_pct)
    telemetry_source TEXT,                  -- verified runtime source descriptor
    telemetry_at TEXT,                      -- ISO 8601 time of the last verified telemetry sample
    -- Lifecycle state of this generation (written by the future lifecycle engine):
    lifecycle_state TEXT,                   -- lifecycle band/state label per framework-config/lifecycle.yaml
    PRIMARY KEY (session_key, generation)
);

CREATE INDEX IF NOT EXISTS idx_sessions_project_role
ON sessions(project_id, role);

CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT PRIMARY KEY,
    parent_task_id TEXT,
    project_id TEXT,
    target_role TEXT,
    target_session_key TEXT,
    status TEXT NOT NULL,
    input_json TEXT,
    result_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
