---
description: OpenCode Runtime Adapter 目录说明（非可执行 Agent 本体）
mode: subagent
hidden: true
---

# OpenCode Runtime Adapter

Source of architecture:
../../diagrams/multi_agent_framework_v4_completion_guard.drawio

Machine-readable role source:
../../framework-config/agents.yaml

This directory:
OpenCode-specific executable adapter

Agent Profile != Runtime Session

Implemented (Plan 5):
- persistent Project Main session registry
- persistent Project Reader session reuse
- SQLite-backed Runtime Session Registry (../plugins/runtime-registry, DB: ../../runtime/tasks.db)

Implemented (Plan 6):
- Task Bus Core (../plugins/task-bus, shared DB: ../../runtime/tasks.db)
- structured Task / Result Envelopes (../../templates/*.schema.json)
- route-based dispatch (framework-config/routing.yaml)
- persistent session dispatch integration (project-main / project-reader)
- ephemeral task sessions (planner etc., sessions kept for audit)
- dependency readiness guard (BLOCKED / DEPENDENCY_NOT_READY)

Implemented (Plan 7):
- Workflow Engine (../plugins/workflow-engine, shared DB: ../../runtime/tasks.db)
- DAG Scheduler (deterministic validation, cycle reject, node → task materialization)
- safe parallel dispatch (waves, max_parallel, project/global serialization locks)
- Feature Executor project model routing (project_sessions.<project>.model.runtime_id)
- automatic Reviewer loop (fresh ephemeral reviewer session per round)
- PASS/FIX/REWORK (bounded rework cycles, descendant subgraph replay, safe retry)

Implemented (Plan 8 / Plan 9 Part A):
- lifecycle telemetry, checkpoint, rotation, restore and reload reconcile
- deterministic Completion Guard execution/delivery checks
- explicit lane scheduler and workflow resource contracts

Implemented (Plan 9 Part B):
- metadata-bearing v4 architecture source
- drawio → Architecture IR and semantic hash
- explicit compiler `check` / `diff` / transactional `apply`
- generated architecture contract blocks with manual Agent bodies preserved

Not implied:
- compiler apply does not hot-reload running sessions
- automatic lifecycle flags remain gated by final live Desktop UI evidence

Runtime model notes:
- runtime IDs come from the local OpenCode environment only (desktop 2.0.19 catalog + recorded usage); no guessing.
- Sol models resolve via provider `openai`: GPT-6 Sol Fast = gpt-6-sol-fast, GPT-5.6 Sol Fast = gpt-5.6-sol-fast, GPT-5.6 Sol = gpt-5.6-sol.
- "Sol Fast" is an OpenCode catalog alias of the base Sol model (fast mode).
- No unresolved models remain; the xxl-job project session stays unassigned by design.
