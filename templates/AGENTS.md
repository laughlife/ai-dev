# Templates Directory Instructions

This directory contains reusable framework contracts and templates.

Future examples:

- Task Envelope
- Result Envelope
- Checkpoint
- Reviewer Result
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
