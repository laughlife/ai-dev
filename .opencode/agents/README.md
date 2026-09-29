---
description: OpenCode Runtime Adapter 目录说明（非可执行 Agent 本体）
mode: subagent
hidden: true
---

# OpenCode Runtime Adapter

Source of architecture:
../../diagrams/multi_agent_framework_v3_workspace.drawio

Machine-readable role source:
../../framework-config/agents.yaml

This directory:
OpenCode-specific executable adapter

Agent Profile != Runtime Session

Implemented (Plan 5):
- persistent Project Main session registry
- persistent Project Reader session reuse
- SQLite-backed Runtime Session Registry (../plugins/runtime-registry, DB: ../../runtime/tasks.db)

Not implemented yet:
- full Task Bus runtime
- automatic lifecycle rotation
- automatic config generation

Runtime model notes:
- runtime IDs come from the local OpenCode environment only (desktop 2.0.19 catalog + recorded usage); no guessing.
- Sol models resolve via provider `openai`: GPT-6 Sol Fast = gpt-6-sol-fast, GPT-5.6 Sol Fast = gpt-5.6-sol-fast, GPT-5.6 Sol = gpt-5.6-sol.
- "Sol Fast" is an OpenCode catalog alias of the base Sol model (fast mode).
- No unresolved models remain; the xxl-job project session stays unassigned by design.
