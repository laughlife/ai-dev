# AI-Dev Framework

A comprehensive multi-agent development framework providing governance, architecture authority, and operational guidelines for AI-driven software development projects.

## Overview

The AI-Dev Framework is a multi-agent development framework designed to provide governance, architecture authority, and operational guidelines for AI-driven software development projects. The framework defines clear workspace structures, conflict resolution mechanisms, and change management principles.

## Sources of Truth

- **Architecture Source of Truth**: `diagrams/multi_agent_framework_v3_workspace.drawio`. Architecture decisions (agents, models, lifecycle, routing) follow this diagram.
- **Governance Source of Truth**: `AGENTS.md`. Git boundaries, directory responsibilities, file ownership, and safety rules follow AGENTS.md.
- On conflict: architecture topics follow the drawio; governance topics follow AGENTS.md; when classification is ambiguous, stop and report instead of silently choosing.

## Framework Directory Structure

```text
ai-dev/
├── AGENTS.md                    # Core framework instructions (Governance Source of Truth)
├── README.md / README.en.md     # Framework entry documentation (Chinese / English)
├── agents/                      # Agent definitions (human-readable, platform-neutral)
│   └── AGENTS.md
├── diagrams/                    # Architecture diagrams (Architecture Source of Truth)
│   ├── AGENTS.md
│   └── multi_agent_framework_v3_workspace.drawio
├── docs/                        # Persistent framework documentation (incl. plan-status.md)
│   └── AGENTS.md
├── framework-config/            # Machine-readable derived mirror of the architecture
│   ├── AGENTS.md
│   ├── framework.yaml
│   ├── projects.yaml
│   ├── agents.yaml
│   ├── routing.yaml
│   ├── lifecycle.yaml
│   └── sync-state.yaml
├── templates/                   # Reusable templates
│   └── AGENTS.md
├── runtime/                     # Runtime state (ignored by root Git)
└── .backups/                    # Temporary backups (ignored by root Git)
```

Business projects are not part of the root Git repository; each uses its own repository: `ruoyi-vue-pro/`, `yudao-ui-admin-vue3/`, `xxl-job/`, `nyamtn/`.

## Core Features

- **Architecture Authority**: Architecture decisions follow the drawio diagram as the single source of truth
- **Governance Authority**: Governance rules and safety boundaries follow `AGENTS.md`
- **Conflict Resolution**: Architecture/governance conflicts are classified; ambiguous cases stop and report
- **Boundary Management**: Business projects use independent Git; the root repository manages framework assets only
- **Knowledge Management**: Runtime knowledge is separated from persistent knowledge (Mem0 stores long-term knowledge only)
- **Change Control**: drawio → framework-config is currently manual; automatic synchronization is not implemented

## Main Components

### 1. AGENTS.md (Root Directory)
The core instruction document for the framework (Governance Source of Truth), containing:
- Workspace definition
- Architecture and governance sources of truth
- Conflict resolution mechanism
- Business project boundaries
- Framework directory structure
- Runtime vs. persistent knowledge
- Modification rules
- Scope constraints
- Git safety rules
- Git commit message rules
- Framework change principles

### 2. agents/
Agent definitions (human-readable, platform-neutral), defining for each type of Agent:
- Scope of responsibility
- Capability fields
- Constraints
- Synchronization direction

### 3. diagrams/
Architecture diagrams (Architecture Source of Truth), containing:
- Multi-agent framework workspace diagram (drawio format)
- Architecture visualization documentation

### 4. docs/
Documentation directory, used to store:
- Project documentation
- Development guides
- Technical specifications
- Framework plan status (plan-status.md)

### 5. framework-config/
Machine-readable derived configuration (mirror of the drawio architecture; the drawio wins on conflict):
- framework.yaml
- projects.yaml
- agents.yaml
- routing.yaml
- lifecycle.yaml
- sync-state.yaml

### 6. templates/
Templates directory, providing:
- Code templates
- Documentation templates
- Project templates

## Implementation Status

```text
Plan 1: completed
Plan 2: completed
Plan 3: completed
Plan 4: in progress
```

Not implemented yet:

- automatic drawio synchronization
- runtime session registry
- automatic lifecycle rotation
- full Task Bus runtime

## Usage Guide

### Initialize Framework
Ensure all directory structures have been correctly created:
```bash
# Verify directory structure
ls -la
```

### Guiding Principles
1. **Architecture Authority**: Architecture decisions follow `diagrams/multi_agent_framework_v3_workspace.drawio`; governance rules follow `AGENTS.md`
2. **Change Management**: Modifying the framework must follow the `Modification Rule`
3. **Knowledge Separation**: Clearly distinguish between runtime knowledge and persistent knowledge
4. **Boundary Adherence**: Strictly comply with business project boundary definitions

## License

This repository does not currently declare a standalone LICENSE file.
