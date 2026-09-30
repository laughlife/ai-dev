-- Workflow Engine schema (Plan 7 Phase 4, §31 — SQL verbatim from the plan)
--
-- Shares ONE SQLite database with the runtime-registry and task-bus plugins:
-- runtime/tasks.db. Executed idempotently (CREATE TABLE/INDEX IF NOT EXISTS)
-- by the workflow-engine plugin setup() on the shared runtime core db handle.
--
-- The existing `sessions` and `tasks` tables are NOT modified here (§31):
-- workflow nodes reference tasks.db rows via current_task_id /
-- task_history_json / review_task_id only.

CREATE TABLE IF NOT EXISTS workflows (
    workflow_id TEXT PRIMARY KEY,
    primary_project_id TEXT NOT NULL,
    objective TEXT NOT NULL,
    status TEXT NOT NULL,
    planner_task_id TEXT,
    planner_session_id TEXT,
    plan_json TEXT,
    rework_cycle INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT,
    completion_guard_finalized_at TEXT
);

CREATE TABLE IF NOT EXISTS workflow_nodes (
    workflow_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    current_task_id TEXT,
    attempt INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL,
    review_task_id TEXT,
    last_verdict TEXT,
    task_history_json TEXT NOT NULL DEFAULT '[]',
    review_history_json TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workflow_id, node_id)
);

CREATE INDEX IF NOT EXISTS idx_workflow_nodes_workflow
ON workflow_nodes(workflow_id);
