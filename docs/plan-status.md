# Framework Plan Status

## Plan 1

Status: COMPLETED

Commit:
e0bc30c

Scope:
- workspace skeleton
- root Git
- root .gitignore
- business repository isolation

## Plan 2

Status: COMPLETED

Commit:
271cab2

Scope:
- AGENTS governance
- drawio added
- Architecture Source of Truth
- framework governance

## README Merge

Commit:
a3e2243

Note:
README was added through a remote Gitee pull request and later normalized by Plan 4.

## Plan 3

Status: COMPLETED

Commit:
e777e89

Scope:
- framework-config derived mirror
- agents
- projects
- routing
- lifecycle
- sync state

Synchronization:
manual

## Plan 4

Status: COMPLETED

Commits:
- 142a87a  Phase 0 closure
- 0fce293  OpenCode Runtime Adapter

Additional governance commit:
- f6ed4d0  task decomposition / model fallback / Git discipline

Delivered:
- OpenCode V2 Agent profiles
- runtime model mapping
- OpenCode Runtime Adapter represented in drawio
- smoke tests

Explicitly deferred:
- persistent Project Main runtime
- persistent Reader session reuse
- Runtime Registry
- Task Bus runtime
- automatic lifecycle rotation

## Plan 5

Status: IN_PROGRESS

Scope:
- Project Main runtime role normalization
- Project Reader runtime mode support
- SQLite Runtime Session Registry
- persistent Project Main / Project Reader session reuse
- runtime session ensure/send/list/get/archive tools

## History Note

Commit messages were rewritten to Chinese on 2026-09-29. Hashes after e0bc30c differ from the original plan documents.

## Deferred

- persistent Session Registry: being implemented in Plan 5
- full Task Bus runtime: Plan 6 (not issued yet)
- SQLite runtime registry
- automatic lifecycle actions
- automatic drawio parser
- automatic drawio → framework-config sync
- automatic framework-config → Agent generation
