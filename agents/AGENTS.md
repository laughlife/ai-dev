# Agent Definitions Directory Instructions

This directory will contain executable or declarative Agent definitions.

## Architecture Authority

Before creating or modifying any Agent definition:

read:

`../diagrams/multi_agent_framework_v3_workspace.drawio`

Agent definitions must correspond to the architecture declared by the diagram.

## Agent Fields

Future Agent definitions should explicitly define:

- id
- role
- description
- model
- reasoning level
- lifecycle
- parent / caller
- allowed tools
- denied tools
- input contract
- output contract
- project scope
- write permissions
- memory permissions
- DB permissions
- API permissions

## Restrictions

Do not create Agents because they seem useful.

An Agent should exist only when:

1. the architecture diagram defines it, or
2. the user explicitly approves adding it.

Do not silently change models.

Do not silently change lifecycle.

Do not merge two roles without updating the architecture diagram.

Do not split one role into multiple roles without updating the architecture diagram.

## Synchronization Direction

Current state:

drawio
→ framework-config
implemented manually

framework-config
→ executable OpenCode Agent definitions
not implemented yet

automatic synchronization
not implemented yet

drawio remains the Architecture Source of Truth.

Until automatic synchronization exists, manually verify Agent definitions against the diagram.
