# Diagrams Directory Instructions

This directory contains visual architecture definitions.

Primary architecture file:

`multi_agent_framework_v3_workspace.drawio`

## Responsibility

This directory defines the human-readable architecture of the framework.

The primary drawio defines:

- Agent topology
- Agent roles
- model assignment
- lifecycle
- task routing
- DB/API routing
- project relationships

## Rules

Do not create alternate architecture diagrams that silently conflict with the primary architecture.

If creating a new architecture version:

preserve the previous version unless explicitly asked to replace it.

Do not convert the drawio into PNG and treat PNG as the authoritative source.

PNG/PDF exports are presentation artifacts only.

The editable `.drawio` file is authoritative.

## Change Rule

When architecture changes:

future synchronization should update:

- agents/
- framework-config/
- related docs/

Do not manually invent Agent definitions that are absent from the architecture diagram.
