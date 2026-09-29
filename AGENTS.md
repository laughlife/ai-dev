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

`diagrams/multi_agent_framework_v3_workspace.drawio`

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

Future machine-readable framework configuration.

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

## 11. Framework Change Principle

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

The synchronization mechanism is NOT implemented yet.

Until it exists:

do not claim that editing drawio automatically changes running Agents.
