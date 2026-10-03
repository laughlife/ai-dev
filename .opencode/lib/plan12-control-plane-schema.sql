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

-- Plan 12.3 mutable lifecycle projection.  The snapshot row above remains
-- immutable; this projection is the CAS-protected current state and carries
-- lifecycle timestamps that must not be written back into the snapshot.
CREATE TABLE IF NOT EXISTS config_revision_state (
    config_revision TEXT PRIMARY KEY,
    workflow_scope TEXT NOT NULL DEFAULT 'global',
    current_state TEXT NOT NULL CHECK (current_state IN ('DRAFT','VALIDATED','STAGED','APPLIED','ACTIVE','SUPERSEDED','REJECTED','ROLLED_BACK')),
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    parent_revision TEXT,
    created_at TEXT NOT NULL,
    validated_at TEXT,
    staged_at TEXT,
    applied_at TEXT,
    activated_at TEXT,
    superseded_at TEXT,
    rejected_at TEXT,
    rolled_back_at TEXT,
    reason TEXT,
    correlation_id TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (config_revision) REFERENCES workflow_config_snapshots(config_revision),
    FOREIGN KEY (parent_revision) REFERENCES workflow_config_snapshots(config_revision)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cp_revision_one_active
ON config_revision_state(current_state)
WHERE current_state = 'ACTIVE';

CREATE TABLE IF NOT EXISTS config_active_head (
    head_key TEXT PRIMARY KEY CHECK (head_key = 'global'),
    active_revision TEXT,
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    updated_at TEXT NOT NULL,
    FOREIGN KEY (active_revision) REFERENCES workflow_config_snapshots(config_revision)
);

INSERT OR IGNORE INTO config_active_head(head_key, active_revision, version, updated_at)
VALUES ('global', NULL, 0, '1970-01-01T00:00:00.000Z');

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

-- Plan 12.5-R2 lifecycle facts.  Run-level events are intentionally kept in
-- a separate append-only table because RUN_STARTED is observed before any
-- wave/node exists.  Nullable wave/node/task references are therefore data,
-- not fabricated foreign keys; the existing execution_events table remains
-- strict for node-scoped payloads.
CREATE TABLE IF NOT EXISTS workflow_run_events (
    event_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    wave_id TEXT,
    node_id TEXT,
    task_id TEXT,
    attempt INTEGER,
    event_type TEXT NOT NULL CHECK (event_type IN ('ACQUIRE','WAIT','RELEASE','CONFLICT','EXPIRE','RUN_STARTED','WAVE_STARTED','NODE_STARTED','NODE_FINISHED','WAVE_FINISHED','RUN_FINISHED','EVIDENCE_WRITE_FAILED')),
    status TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence >= 1),
    schema_version INTEGER NOT NULL,
    config_revision TEXT NOT NULL,
    source TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    payload_sha256 TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    evidence_level TEXT NOT NULL CHECK (evidence_level = 'L3'),
    fact_type TEXT NOT NULL CHECK (fact_type = 'workflow_run_event'),
    payload_digest TEXT NOT NULL,
    payload_ref TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    error_code TEXT,
    UNIQUE (run_id, sequence),
    FOREIGN KEY (config_revision) REFERENCES workflow_config_snapshots(config_revision)
);

CREATE INDEX IF NOT EXISTS idx_cp_run_events_run_seq ON workflow_run_events(run_id, sequence);
CREATE TRIGGER IF NOT EXISTS trg_cp_run_event_no_update
BEFORE UPDATE ON workflow_run_events
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY_UPDATE_FORBIDDEN'); END;
CREATE TRIGGER IF NOT EXISTS trg_cp_run_event_no_delete
BEFORE DELETE ON workflow_run_events
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY_DELETE_FORBIDDEN'); END;

-- Plan 12.3 configuration lifecycle journal.  Revision payloads remain
-- immutable in workflow_config_snapshots; lifecycle state is reconstructed
-- from successful append-only journal entries.
CREATE TABLE IF NOT EXISTS config_operation_idempotency (
    idempotency_key TEXT PRIMARY KEY,
    request_digest TEXT NOT NULL,
    operation TEXT NOT NULL,
    config_revision TEXT NOT NULL,
    target_revision TEXT,
    correlation_id TEXT NOT NULL,
    result TEXT NOT NULL,
    error_code TEXT,
    error_detail TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS config_revision_journal (
    journal_seq INTEGER PRIMARY KEY AUTOINCREMENT,
    journal_id TEXT NOT NULL UNIQUE,
    config_revision TEXT NOT NULL,
    operation TEXT NOT NULL,
    from_state TEXT,
    to_state TEXT,
    expected_revision TEXT,
    actual_revision TEXT,
    actor TEXT NOT NULL,
    reason TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    payload_sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL,
    result TEXT NOT NULL,
    error_code TEXT,
    error_detail TEXT,
    FOREIGN KEY (actual_revision) REFERENCES workflow_config_snapshots(config_revision)
);

CREATE INDEX IF NOT EXISTS idx_cp_revision_journal_revision ON config_revision_journal(config_revision, journal_seq);
CREATE INDEX IF NOT EXISTS idx_cp_revision_journal_correlation ON config_revision_journal(correlation_id, journal_seq);
CREATE INDEX IF NOT EXISTS idx_cp_revision_journal_idempotency ON config_revision_journal(idempotency_key, journal_seq);
CREATE TRIGGER IF NOT EXISTS trg_cp_operation_no_update
BEFORE UPDATE ON config_operation_idempotency
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY_UPDATE_FORBIDDEN'); END;
CREATE TRIGGER IF NOT EXISTS trg_cp_operation_no_delete
BEFORE DELETE ON config_operation_idempotency
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY_DELETE_FORBIDDEN'); END;
CREATE TRIGGER IF NOT EXISTS trg_cp_revision_journal_no_update
BEFORE UPDATE ON config_revision_journal
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY_UPDATE_FORBIDDEN'); END;
CREATE TRIGGER IF NOT EXISTS trg_cp_revision_journal_no_delete
BEFORE DELETE ON config_revision_journal
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY_DELETE_FORBIDDEN'); END;

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

CREATE TRIGGER IF NOT EXISTS trg_cp_snapshot_lifecycle_state
AFTER INSERT ON workflow_config_snapshots
BEGIN
    INSERT OR IGNORE INTO config_revision_state
      (config_revision, workflow_scope, current_state, version, parent_revision,
       created_at, activated_at, updated_at)
    VALUES
      (NEW.config_revision, 'global', NEW.state, 0, NEW.parent_revision,
       NEW.created_at, NEW.activated_at, NEW.created_at);
    UPDATE config_active_head
       SET active_revision = NEW.config_revision,
           version = version + 1,
           updated_at = NEW.created_at
     WHERE NEW.state = 'ACTIVE'
       AND head_key = 'global'
       AND active_revision IS NULL;
END;

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

-- Plan 12.4 model catalog, route bindings, runtime probes and admission audit.
-- Model identity is always the exact provider/model[/variant] value; display_name is presentation only.
CREATE TABLE IF NOT EXISTS model_catalog (
    catalog_entry_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    variant TEXT,
    exact_model_ref TEXT NOT NULL,
    display_name TEXT NOT NULL,
    capability_json TEXT NOT NULL,
    availability_state TEXT NOT NULL CHECK (availability_state IN ('AVAILABLE','UNAVAILABLE','UNKNOWN','REJECTED')),
    runtime_source TEXT NOT NULL,
    runtime_version TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    probe_status TEXT NOT NULL,
    probe_error TEXT,
    probe_id TEXT,
    metadata_sha256 TEXT NOT NULL,
    config_revision TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    payload_sha256 TEXT NOT NULL,
    FOREIGN KEY (config_revision) REFERENCES workflow_config_snapshots(config_revision),
    FOREIGN KEY (probe_id) REFERENCES runtime_model_probes(probe_id)
);

CREATE TABLE IF NOT EXISTS route_bindings (
    route_binding_id TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    workflow_scope TEXT NOT NULL,
    project_scope TEXT,
    lane TEXT NOT NULL,
    provider TEXT,
    provider_id TEXT,
    model_id TEXT,
    variant TEXT,
    exact_model_ref TEXT,
    binding_state TEXT NOT NULL CHECK (binding_state IN ('BOUND','MODEL_UNASSIGNED','UNAVAILABLE','REJECTED')),
    config_revision TEXT NOT NULL,
    source TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    payload_sha256 TEXT NOT NULL,
    FOREIGN KEY (config_revision) REFERENCES workflow_config_snapshots(config_revision)
);

CREATE TABLE IF NOT EXISTS runtime_model_probes (
    probe_id TEXT PRIMARY KEY,
    endpoint TEXT NOT NULL,
    runtime_version TEXT,
    workflow_plugin_loaded INTEGER NOT NULL CHECK (workflow_plugin_loaded IN (0,1)),
    tools_json TEXT NOT NULL,
    provider TEXT,
    provider_id TEXT,
    model_id TEXT,
    exact_model_ref TEXT,
    probe_status TEXT NOT NULL CHECK (probe_status IN ('AVAILABLE','UNAVAILABLE','UNKNOWN','REJECTED','BLOCKED')),
    availability_state TEXT NOT NULL CHECK (availability_state IN ('AVAILABLE','UNAVAILABLE','UNKNOWN','REJECTED')),
    probe_error TEXT,
    observed_at TEXT NOT NULL,
    config_revision TEXT,
    metadata_json TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    payload_sha256 TEXT NOT NULL,
    FOREIGN KEY (config_revision) REFERENCES workflow_config_snapshots(config_revision)
);

CREATE TABLE IF NOT EXISTS model_route_audit_events (
    event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    catalog_entry_id TEXT,
    route_binding_id TEXT,
    probe_id TEXT,
    config_revision TEXT,
    provider TEXT,
    model_id TEXT,
    exact_model_ref TEXT,
    status TEXT NOT NULL,
    endpoint TEXT,
    runtime_version TEXT,
    reason TEXT NOT NULL,
    detail_json TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    payload_sha256 TEXT NOT NULL,
    FOREIGN KEY (config_revision) REFERENCES workflow_config_snapshots(config_revision),
    FOREIGN KEY (catalog_entry_id) REFERENCES model_catalog(catalog_entry_id),
    FOREIGN KEY (route_binding_id) REFERENCES route_bindings(route_binding_id),
    FOREIGN KEY (probe_id) REFERENCES runtime_model_probes(probe_id)
);

CREATE INDEX IF NOT EXISTS idx_cp_model_catalog_ref ON model_catalog(exact_model_ref, config_revision, updated_at);
CREATE INDEX IF NOT EXISTS idx_cp_model_catalog_state ON model_catalog(availability_state, config_revision);
CREATE INDEX IF NOT EXISTS idx_cp_route_role_scope ON route_bindings(role, workflow_scope, project_scope, config_revision);
CREATE INDEX IF NOT EXISTS idx_cp_probe_ref ON runtime_model_probes(exact_model_ref, observed_at);
CREATE INDEX IF NOT EXISTS idx_cp_model_audit_revision ON model_route_audit_events(config_revision, observed_at);
CREATE INDEX IF NOT EXISTS idx_cp_model_audit_route ON model_route_audit_events(route_binding_id, observed_at);

CREATE TRIGGER IF NOT EXISTS trg_cp_model_catalog_no_update
BEFORE UPDATE ON model_catalog
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY_UPDATE_FORBIDDEN'); END;
CREATE TRIGGER IF NOT EXISTS trg_cp_model_catalog_no_delete
BEFORE DELETE ON model_catalog
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY_DELETE_FORBIDDEN'); END;
CREATE TRIGGER IF NOT EXISTS trg_cp_route_bindings_no_update
BEFORE UPDATE ON route_bindings
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY_UPDATE_FORBIDDEN'); END;
CREATE TRIGGER IF NOT EXISTS trg_cp_route_bindings_no_delete
BEFORE DELETE ON route_bindings
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY_DELETE_FORBIDDEN'); END;
CREATE TRIGGER IF NOT EXISTS trg_cp_runtime_probe_no_update
BEFORE UPDATE ON runtime_model_probes
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY_UPDATE_FORBIDDEN'); END;
CREATE TRIGGER IF NOT EXISTS trg_cp_runtime_probe_no_delete
BEFORE DELETE ON runtime_model_probes
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY_DELETE_FORBIDDEN'); END;
CREATE TRIGGER IF NOT EXISTS trg_cp_model_audit_no_update
BEFORE UPDATE ON model_route_audit_events
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY_UPDATE_FORBIDDEN'); END;
CREATE TRIGGER IF NOT EXISTS trg_cp_model_audit_no_delete
BEFORE DELETE ON model_route_audit_events
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY_DELETE_FORBIDDEN'); END;
