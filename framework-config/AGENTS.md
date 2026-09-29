# Framework Configuration Directory Instructions

This directory contains the machine-readable framework configuration.

It is officially enabled as the derived machine-readable mirror of the architecture diagram.

Its purpose is to bridge:

`drawio`

and:

`executable Agent definitions`

Current content:

- framework.yaml
- projects.yaml
- agents.yaml
- routing.yaml
- lifecycle.yaml
- sync-state.yaml

These files describe:

- Agent registry
- models
- role mapping
- lifecycle
- routing
- project registry
- tool permissions

## Important

The architecture diagram remains the Architecture Source of Truth.

The configuration in this directory is a derived mirror, not a second source of truth.

If the drawio and these files disagree: drawio wins.

Do not modify architecture in these files independently of the drawio.

Before changing any configuration here, inspect the drawio first.

If manual edits make these files inconsistent with the drawio, report:

`OUT_OF_SYNC`

Automatic parser-based synchronization is not implemented yet.

Current sync mode is manual; the recorded state lives in `sync-state.yaml`.

The synchronization direction is:

drawio
→ framework-config
→ Agent definitions

Do not make framework-config independently authoritative unless explicitly approved.
