# Templates Directory Instructions

This directory contains reusable framework contracts and templates.

Current content:

- task-envelope.schema.json
- result-envelope.schema.json
- workflow-plan.schema.json
- reviewer-result.schema.json
- checkpoint.schema.json

These two schema files define the stable JSON contract of the Runtime Task Bus:

- `task-envelope.schema.json` is the standard input contract (Task Envelope v1).
- `result-envelope.schema.json` is the standard output contract (Result Envelope v1).

These two schema files define the stable JSON contract of the Workflow Engine (Plan 7):

- `workflow-plan.schema.json` is the Planner output contract (Workflow Plan v1).
- `reviewer-result.schema.json` is the Reviewer output contract (Reviewer Result v1).

This schema file defines the stable JSON contract of the session lifecycle (Plan 8):

- `checkpoint.schema.json` is the Checkpoint v1 contract written before a
  session generation is archived/rotated, mirroring
  `framework-config/lifecycle.yaml` `rotation_restore_context`
  (active-task / project-docs / git-state / required-mem0-context).
  Checkpoint instances are runtime state: they live under
  `runtime/checkpoints/` (git-ignored) and are referenced by
  `sessions.checkpoint_path` in `runtime/tasks.db` — never stored here.
  The contract embeds no threshold or context-window logic; the 60/70/80
  rotation bands are declared only in `framework-config/lifecycle.yaml`.

Templates are structure definitions only. They never store active task data;
runtime task state lives in `runtime/tasks.db`, not here.

Any breaking schema change must:

1. modify the drawio (if the change belongs to architecture semantics)
2. bump `schema_version`
3. update the Task Bus / Workflow Engine
4. update the documentation

Future examples:

- Agent Handoff
- Project Session State
- Reader Checkpoint

## Rules

Templates define structure, not runtime state.

Never store actual active task data here.

Templates must remain generic across projects unless explicitly project-specific.

Do not embed passwords, API keys, database credentials, tokens, or secrets.

When changing a template:

identify which Agents or runtime components depend on it.

Do not silently introduce incompatible schema changes.
