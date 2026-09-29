-- Runtime Session Registry schema (Plan 5)
--
-- Plan 5 minimum tables: registry_meta / sessions / tasks.
-- Extension note (allowed by plan "最少包含"): sessions uses composite
-- PRIMARY KEY (session_key, generation) so archived/stale generations remain
-- auditable and replaced_by can point from the old generation to its successor.
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
