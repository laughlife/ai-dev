# AI-Dev Framework

A comprehensive multi-agent development framework providing governance, architecture authority, and operational guidelines for AI-driven software development projects.

## Overview

The AI-Dev Framework is a multi-agent development framework designed to provide governance, architecture authority, and operational guidelines for AI-driven software development projects. The framework defines clear workspace structures, conflict resolution mechanisms, and change management principles.

## Framework Directory Structure

```
ai-dev/
├── AGENTS.md                    # Core Framework Instructions
├── agents/                      # Agent Definition Directory
│   └── AGENTS.md               # Agent Fields and Constraints Definition
├── diagrams/                    # Architecture Diagrams
│   ├── AGENTS.md               # Diagram Responsibilities and Rules
│   └── multi_agent_framework_v3_workspace.drawio
├── docs/                        # Documentation Directory
│   └── AGENTS.md               # Documentation Standards
├── framework-config/            # Framework Configuration
│   └── AGENTS.md               # Configuration Instructions
└── templates/                   # Templates Directory
    └── AGENTS.md               # Template Rules
```

## Core Features

- **Architecture Authority**: Clear sources of architectural decisions and governance mechanisms
- **Conflict Resolution**: Comprehensive conflict resolution strategies
- **Boundary Management**: Clear definitions of business project boundaries
- **Knowledge Management**: Separation of runtime knowledge and persistent knowledge
- **Change Control**: Strict framework modification rules and scope constraints
- **Git Security**: Version control security specifications

## Main Components

### 1. AGENTS.md (Root Directory)
The core instruction document for the framework, containing:
- Workspace definition
- Sources of architectural authority
- Sources of governance authority
- Conflict resolution mechanism
- Business project boundaries
- Framework directory structure
- Runtime vs. Persistent knowledge
- Modification rules
- Scope constraints
- Git security specifications
- Framework change principles

### 2. agents/ 
Agent definition directory, defining for each type of Agent:
- Scope of responsibility
- Capability fields
- Constraints
- Synchronization direction

### 3. diagrams/
Architecture diagrams directory, containing:
- Multi-agent framework workspace diagram (drawio format)
- Architecture visualization documentation

### 4. docs/
Documentation directory, used to store:
- Project documentation
- Development guides
- Technical specifications

### 5. framework-config/
Framework configuration files, containing:
- Framework-level configuration
- Runtime parameters

### 6. templates/
Templates directory, providing:
- Code templates
- Documentation templates
- Project templates

## Usage Guide

### Initialize Framework
Ensure all directory structures have been correctly created:
```bash
# Verify directory structure
ls -la
```

### Guiding Principles
1. **Architecture Authority**: All architectural decisions should be based on definitions in `AGENTS.md`
2. **Change Management**: Modifying the framework must follow the `Modification Rule`
3. **Knowledge Separation**: Clearly distinguish between runtime knowledge and persistent knowledge
4. **Boundary Adherence**: Strictly comply with business project boundary definitions

## License

This project follows the governance rules defined within the framework. For specific license information, please refer to the project documentation.