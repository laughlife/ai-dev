# AI-Dev Framework

A comprehensive multi-agent development framework providing governance, architecture authority, and operational guidelines for AI-driven software development projects.

## 概述

AI-Dev Framework 是一个多智能体开发框架，旨在为 AI 驱动的软件开发项目提供治理、架构权威和操作指南。该框架定义了清晰的工作空间结构、冲突解决机制和变更管理原则。

## 框架目录结构

```
ai-dev/
├── AGENTS.md                    # 框架核心指令
├── agents/                      # Agent 定义目录
│   └── AGENTS.md               # Agent 字段和约束定义
├── diagrams/                    # 架构图表
│   ├── AGENTS.md               # 图表责任和规则
│   └── multi_agent_framework_v3_workspace.drawio
├── docs/                        # 文档目录
│   └── AGENTS.md               # 文档规范
├── framework-config/            # 框架配置
│   └── AGENTS.md               # 配置说明
└── templates/                   # 模板目录
    └── AGENTS.md               # 模板规则
```

## 核心特性

- **架构权威**: 明确的架构决策来源和治理机制
- **冲突解决**: 完善的冲突解决策略
- **边界管理**: 清晰的业务项目边界定义
- **知识管理**: 运行时知识与持久知识的分离
- **变更控制**: 严格的框架修改规则和范围约束
- **Git 安全**: 版本控制安全规范

## 主要组件

### 1. AGENTS.md (根目录)
框架的核心指令文档，包含：
- 工作空间定义
- 架构权威来源
- 治理权威来源
- 冲突解决机制
- 业务项目边界
- 框架目录结构
- 运行时 vs 持久知识
- 修改规则
- 范围约束
- Git 安全规范
- 框架变更原则

### 2. agents/ 
Agent 定义目录，定义各类型 Agent 的：
- 职责范围
- 能力字段
- 限制条件
- 同步方向

### 3. diagrams/
架构图表目录，包含：
- 多智能体框架工作区图 (drawio 格式)
- 架构可视化文档

### 4. docs/
文档目录，用于存放：
- 项目文档
- 开发指南
- 技术规范

### 5. framework-config/
框架配置文件，包含：
- 框架级配置
- 运行时参数

### 6. templates/
模板目录，提供：
- 代码模板
- 文档模板
- 项目模板

## 使用指南

### 初始化框架
确保所有目录结构已正确创建：
```bash
# 验证目录结构
ls -la
```

### 遵循的原则
1. **架构权威**: 所有架构决策应基于 `AGENTS.md` 中的定义
2. **变更管理**: 修改框架需遵循 `Modification Rule`
3. **知识分离**: 明确区分运行时知识和持久知识
4. **边界遵守**: 严格遵守业务项目边界定义

## 许可证

本项目遵循框架内定义的治理规则。具体许可证信息请参考项目文档。