-- Plan 12.2 Control Plane evidence ledger schema v1.
-- This file is applied only to an explicitly selected control-plane.db path.
-- It never touches runtime/tasks.db.

CREATE TABLE IF NOT EXISTS control_plane_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence_idempotency (
    idempotency_key TEXT PRIMARY KEY,
    payload_sha256 TEXT NOT NULL,
    fact_type TEXT NOT NULL,
    table_name TEXT NOT NULL,
    record_key TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_config_snapshots (
    config_revision TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL,
    source TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    payload_sha256 TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    evidence_level TEXT NOT NULL CHECK (evidence_level = 'L3'),
    fact_type TEXT NOT NULL CHECK (fact_type = 'workflow_config_snapshot'),
    parent_revision TEXT,
    source_kind TEXT NOT NULL,
    drawio_raw_sha256 TEXT NOT NULL,
    drawio_semantic_sha256 TEXT NOT NULL,
    ir_sha256 TEXT NOT NULL,
    config_digest TEXT NOT NULL,
    model_catalog_digest TEXT NOT NULL,
    route_bindings_digest TEXT NOT NULL,
    canonical_json TEXT NOT NULL,
    state TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    activated_at TEXT,
    rollback_of TEXT,
    FOREIGN KEY (parent_revision) REFERENCES workflow_config_snapshots(config_revision)
);

CREATE TABLE IF NOT EXISTS workflow_runs (
    run_id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL,
    config_revision TEXT NOT NULL,
    source TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    payload_sha256 TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    evidence_level TEXT NOT NULL CHECK (evidence_level = 'L3'),
    fact_type TEXT NOT NULL CHECK (fact_type = 'workflow_run'),
    workflow_id TEXT NOT NULL,
    parent_run_id TEXT,
    plan_digest TEXT NOT NULL,
    attempt INTEGER NOT NULL CHECK (attempt >= 1),
    trigger TEXT NOT NULL,
    project_id TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    outcome_digest TEXT,
    evidence_write_status TEXT NOT NULL,
    error_code TEXT,
    error_detail TEXT,
    engine_version TEXT NOT NULL,
    FOREIGN KEY (config_revision) REFERENCES workflow_config_snapshots(config_revision),
    FOREIGN KEY (parent_run_id) REFERENCES workflow_runs(run_id)
);

CREATE TABLE IF NOT EXISTS workflow_waves (
    run_id TEXT NOT NULL,
    wave_id TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    config_revision TEXT NOT NULL,
    source TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    payload_sha256 TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    evidence_level TEXT NOT NULL CHECK (evidence_level = 'L3'),
    fact_type TEXT NOT NULL CHECK (fact_type = 'workflow_wave'),
    workflow_id TEXT NOT NULL,
    wave_index INTEGER NOT NULL CHECK (wave_index >= 0),
    ready_set_digest TEXT NOT NULL,
    policy_digest TEXT NOT NULL,
    parallelism INTEGER NOT NULL CHECK (parallelism >= 1),
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    lock_snapshot_json TEXT,
    evidence_digest TEXT NOT NULL,
    PRIMARY KEY (run_id, wave_id),
    UNIQUE (run_id, wave_index),
    FOREIGN KEY (run_id) REFERENCES workflow_runs(run_id),
    FOREIGN KEY (config_revision) REFERENCES workflow_config_snapshots(config_revision)
);

CREATE TABLE IF NOT EXISTS workflow_wave_nodes (
    run_id TEXT NOT NULL,
    wave_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    attempt INTEGER NOT NULL CHECK (attempt >= 1),
    schema_version INTEGER NOT NULL,
    config_revision TEXT NOT NULL,
    source TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    payload_sha256 TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    evidence_level TEXT NOT NULL CHECK (evidence_level = 'L3'),
    fact_type TEXT NOT NULL CHECK (fact_type = 'workflow_wave_node'),
    workflow_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    route TEXT NOT NULL,
    resource_digest TEXT NOT NULL,
    lock_key_json TEXT NOT NULL,
    session_key TEXT,
    session_id TEXT NOT NULL,
    status TEXT NOT NULL,
    event_seq INTEGER NOT NULL CHECK (event_seq >= 1),
    started_at TEXT NOT NULL,
    ended_at TEXT,
    result_digest TEXT,
    error_code TEXT,
    PRIMARY KEY (run_id, wave_id, node_id, attempt),
    FOREIGN KEY (run_id, wave_id) REFERENCES workflow_waves(run_id, wave_id),
    FOREIGN KEY (config_revision) REFERENCES workflow_config_snapshots(config_revision)
);

CREATE TABLE IF NOT EXISTS workflow_lock_events (
    event_id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL,
    config_revision TEXT NOT NULL,
    source TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    payload_sha256 TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    evidence_level TEXT NOT NULL CHECK (evidence_level = 'L3'),
    fact_type TEXT NOT NULL CHECK (fact_type = 'workflow_lock_event'),
    run_id TEXT NOT NULL,
    wave_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    lock_key TEXT NOT NULL,
    event_type TEXT NOT NULL,
    owner_token TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence >= 1),
    occurred_at TEXT NOT NULL,
    outcome TEXT NOT NULL,
    error_code TEXT,
    UNIQUE (run_id, lock_key, sequence),
    FOREIGN KEY (run_id, wave_id) REFERENCES workflow_waves(run_id, wave_id),
    FOREIGN KEY (config_revision) REFERENCES workflow_config_snapshots(config_revision)
);

CREATE TABLE IF NOT EXISTS execution_events (
    event_id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL,
    config_revision TEXT NOT NULL,
    source TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    payload_sha256 TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    evidence_level TEXT NOT NULL CHECK (evidence_level = 'L3'),
    fact_type TEXT NOT NULL CHECK (fact_type = 'execution_event'),
    run_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    wave_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    attempt INTEGER NOT NULL CHECK (attempt >= 1),
    event_type TEXT NOT NULL,
    status TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence >= 1),
    payload_digest TEXT NOT NULL,
    payload_ref TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    error_code TEXT,
    UNIQUE (run_id, sequence),
    FOREIGN KEY (run_id, wave_id) REFERENCES workflow_waves(run_id, wave_id),
    FOREIGN KEY (config_revision) REFERENCES workflow_config_snapshots(config_revision)
);

CREATE INDEX IF NOT EXISTS idx_cp_runs_workflow ON workflow_runs(workflow_id, started_at);
CREATE INDEX IF NOT EXISTS idx_cp_waves_run_index ON workflow_waves(run_id, wave_index);
CREATE INDEX IF NOT EXISTS idx_cp_nodes_run_node ON workflow_wave_nodes(run_id, node_id, event_seq);
CREATE INDEX IF NOT EXISTS idx_cp_locks_run_key_seq ON workflow_lock_events(run_id, lock_key, sequence);
CREATE INDEX IF NOT EXISTS idx_cp_events_run_seq ON execution_events(run_id, sequence);

CREATE TRIGGER IF NOT EXISTS trg_cp_meta_no_update
BEFORE UPDATE ON control_plane_meta
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY_UPDATE_FORBIDDEN'); END;
CREATE TRIGGER IF NOT EXISTS trg_cp_meta_no_delete
BEFORE DELETE ON control_plane_meta
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY_DELETE_FORBIDDEN'); END;

CREATE TRIGGER IF NOT EXISTS trg_cp_idempotency_no_update
BEFORE UPDATE ON evidence_idempotency
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY_UPDATE_FORBIDDEN'); END;
CREATE TRIGGER IF NOT EXISTS trg_cp_idempotency_no_delete
BEFORE DELETE ON evidence_idempotency
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY_DELETE_FORBIDDEN'); END;

CREATE TRIGGER IF NOT EXISTS trg_cp_snapshot_no_update
BEFORE UPDATE ON workflow_config_snapshots
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY_UPDATE_FORBIDDEN'); END;
CREATE TRIGGER IF NOT EXISTS trg_cp_snapshot_no_delete
BEFORE DELETE ON workflow_config_snapshots
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY_DELETE_FORBIDDEN'); END;

CREATE TRIGGER IF NOT EXISTS trg_cp_run_no_update
BEFORE UPDATE ON workflow_runs
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY_UPDATE_FORBIDDEN'); END;
CREATE TRIGGER IF NOT EXISTS trg_cp_run_no_delete
BEFORE DELETE ON workflow_runs
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY_DELETE_FORBIDDEN'); END;

CREATE TRIGGER IF NOT EXISTS trg_cp_wave_no_update
BEFORE UPDATE ON workflow_waves
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY_UPDATE_FORBIDDEN'); END;
CREATE TRIGGER IF NOT EXISTS trg_cp_wave_no_delete
BEFORE DELETE ON workflow_waves
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY_DELETE_FORBIDDEN'); END;

CREATE TRIGGER IF NOT EXISTS trg_cp_node_no_update
BEFORE UPDATE ON workflow_wave_nodes
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY_UPDATE_FORBIDDEN'); END;
CREATE TRIGGER IF NOT EXISTS trg_cp_node_no_delete
BEFORE DELETE ON workflow_wave_nodes
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY_DELETE_FORBIDDEN'); END;

CREATE TRIGGER IF NOT EXISTS trg_cp_lock_no_update
BEFORE UPDATE ON workflow_lock_events
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY_UPDATE_FORBIDDEN'); END;
CREATE TRIGGER IF NOT EXISTS trg_cp_lock_no_delete
BEFORE DELETE ON workflow_lock_events
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY_DELETE_FORBIDDEN'); END;

CREATE TRIGGER IF NOT EXISTS trg_cp_execution_no_update
BEFORE UPDATE ON execution_events
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY_UPDATE_FORBIDDEN'); END;
CREATE TRIGGER IF NOT EXISTS trg_cp_execution_no_delete
BEFORE DELETE ON execution_events
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY_DELETE_FORBIDDEN'); END;
