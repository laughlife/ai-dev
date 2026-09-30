# AI-Dev Framework Instructions

## 1. Workspace

Framework root:

`D:\ai-dev`

This repository is the management repository for the multi-project AI development framework.

It manages:

- framework architecture
- diagrams
- framework documentation
- agent governance
- agent definitions
- task templates
- framework configuration

It does NOT own the source code of business projects.

## 2. Architecture Source of Truth

The authoritative visual architecture definition is:

`diagrams/multi_agent_framework_v4_completion_guard.drawio`

Before:

- creating an Agent
- deleting an Agent
- changing an Agent model
- changing Agent lifecycle
- changing task routing
- changing DB routing
- changing API routing
- changing project/session relationships
- changing orchestration behavior

read and inspect this drawio file first.

Do not rely on memory of the architecture when the diagram is available.

The diagram is the Architecture Source of Truth for:

- roles
- models
- lifecycle
- topology
- routing
- project relationships

## 3. Governance Source of Truth

`AGENTS.md` files define execution and governance rules.

AGENTS.md is authoritative for:

- Git boundaries
- directory responsibilities
- file ownership
- safety rules
- synchronization rules
- repository policies
- modification restrictions

Do not duplicate the entire architecture from the drawio into AGENTS.md.

Reference the architecture diagram instead.

## 4. Conflict Resolution

If the diagram and AGENTS.md disagree:

Architecture topics:

- Agent existence
- model
- role
- lifecycle
- orchestration
- task routing
- DB/API routing

→ diagram wins.

Governance topics:

- Git
- directory ownership
- write permissions
- repository policy
- safety rules

→ AGENTS.md wins.

If classification is ambiguous:

STOP and report the conflict.

Do not silently choose one.

## 5. Business Project Boundaries

The following directories are independent repositories:

`D:\ai-dev\ruoyi-vue-pro`

`D:\ai-dev\yudao-ui-admin-vue3`

`D:\ai-dev\xxl-job`

`D:\ai-dev\nyamtn`

The root ai-dev repository MUST NOT track their source files.

Each project manages its own:

- .git
- branches
- commits
- remotes
- source code history

Never stage business project source files from the framework root repository.

## 6. Framework Directories

Framework-managed directories:

`diagrams/`

Visual architecture source.

`docs/`

Persistent framework documentation.

`agents/`

Future Agent definitions and role specifications.

`templates/`

Task / Result / Checkpoint and other reusable templates.

`framework-config/`

Machine-readable derived mirror of the architecture.

The drawio remains the Architecture Source of Truth.

`runtime/`

Runtime state. Not persistent architecture.

`.backups/`

Temporary backup data.

## 7. Runtime vs Persistent Knowledge

Persistent framework knowledge belongs in:

- diagrams
- docs
- agents
- templates
- framework-config
- Mem0 when appropriate

Temporary execution state belongs in:

- runtime

Do not store temporary task state in Mem0.

Do not treat Mem0 as a task queue.

## 8. Modification Rule

Before modifying framework architecture:

1. inspect the drawio
2. determine affected roles
3. determine affected AGENTS.md files
4. determine whether executable Agent definitions must later be synchronized
5. make only the requested scope of change

Do not expand a small framework task into a full framework rewrite.

## 9. Scope Discipline

Perform only the requested stage.

Do not automatically implement future stages.

## 9.1 Team Execution 并行安全（Plan 9 U3）

复杂任务（>=3 implementation nodes、multi-project、code+test+review，或多个独立 read/coding/test package）必须进入 Workflow Engine 的 Team Execution Mode。独立 READY work 在依赖满足且 resources 无冲突时必须并行；没有依赖或资源冲突理由不得串行化。DAG/resources ownership 校验与 Wave 调度由 Workflow Engine / Team Scheduler 负责，主控和 Project Main 不得手工串行等待或施工普通 read/write/test。

Examples:

If asked to initialize folders:

do not create Agents.

If asked to define AGENTS.md:

do not implement Task Bus.

If asked to define Agents:

do not redesign the entire architecture.

## 10. Git Safety

Before any root Git operation verify:

`git rev-parse --show-toplevel`

must resolve to:

`D:\ai-dev`

Never run destructive Git operations across business repositories from the root.

Do not use:

`git clean -fd`

`git reset --hard`

unless explicitly requested and reviewed.

## 11. Git Commit Language

All Git commit messages must be written in Chinese.

Rules:

- the commit title and body must be in Chinese
- use English type prefixes such as `feat:`, `fix:`, `chore:`, `docs:`
- Chinese descriptions must be summary-level; do not over-detail

Example:

`feat: 新增多 Agent 框架机器可读配置`

## 12. Framework Change Principle

The framework should be designed so that future architecture changes can be made visually.

Desired future workflow:

```text
edit drawio
    ↓
detect architecture change
    ↓
synchronize machine-readable configuration
    ↓
synchronize Agent definitions
    ↓
validate
```

Current state:

- `drawio → architecture IR`: implemented by the Plan 9 Architecture Compiler
- `drawio → framework-config`: compiler check/diff/apply is available; apply is explicit
- `framework-config/IR → executable OpenCode architecture contract`: generated blocks are synchronized explicitly
- manual Agent behavior bodies remain preserved
- runtime persistent Project Main / Project Reader: implemented in Plan 5
- unattended production apply: not implemented (apply remains explicit and transactional)
- running Agent/session hot-reload from compiler output: not implemented

Do not claim that editing drawio automatically changes running Agents; compiler apply is a controlled file synchronization step only.

## 13. Task Decomposition and Multi-Agent Execution

After receiving a task, decompose it first.

If a task maps to an Agent role already defined by the Architecture Source of Truth,
the role and model defined by the drawio / framework-config MUST be used.

Architecture-defined roles always take precedence over generic model recommendations.

Examples:

- Project Reader -> use the model defined for Project Reader
- Planner -> use the model defined for Planner
- Reviewer -> use the model defined for Reviewer
- DB Operator -> use the model defined for DB Operator

The following recommendations apply only to ad-hoc subtasks that do not map to an
existing framework role:

| Ad-hoc sub-task type | Recommended model |
| --- | --- |
| Logic analysis / reasoning | main model (current session model) |
| Reading / searching / lookup | `bailian-token-plan/qwen3.8-flash` |
| Coding / code generation | `bailian-token-plan/qwen3.8-max` |

Fallback rule:

If the architecture-defined model or the ad-hoc recommended model is unavailable,
use another suitable available model and report the fallback.

Do not override an architecture-defined Agent model merely because a generic
recommendation exists here.

## 14. Git Commit Discipline

Every modification to files in this repository must be followed by a Git commit.

Required workflow after each change:

1. `git add` the changed files
2. `git commit` with a Chinese commit message (see section 11)

Forbidden operations:

- Do NOT run `git pull`
- Do NOT run `git push`

Synchronization with remotes is handled manually by the user, not by agents.
