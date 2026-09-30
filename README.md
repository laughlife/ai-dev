# AI-Dev Framework

A comprehensive multi-agent development framework providing governance, architecture authority, and operational guidelines for AI-driven software development projects.

## 概述

AI-Dev Framework 是一个多智能体开发框架，旨在为 AI 驱动的软件开发项目提供治理、架构权威和操作指南。该框架定义了清晰的工作空间结构、冲突解决机制和变更管理原则。

## 真相源（Source of Truth）

- **架构真相源（Architecture Source of Truth）**：`diagrams/multi_agent_framework_v3_workspace.drawio`。Agent、模型、生命周期、路由等架构决策以该流程图为准。
- **治理真相源（Governance Source of Truth）**：`AGENTS.md`。Git 边界、目录职责、文件归属、安全规则等治理内容以 AGENTS.md 为准。
- 两者冲突时：架构问题以 drawio 为准，治理问题以 AGENTS.md 为准；无法分类时暂停并报告，不静默选择。

## 框架目录结构

```text
ai-dev/
├── AGENTS.md                    # 框架核心指令（治理真相源）
├── README.md / README.en.md     # 框架入口说明（中文 / 英文）
├── agents/                      # Agent 定义目录（人工可读、平台中立）
│   └── AGENTS.md
├── diagrams/                    # 架构图表（架构真相源）
│   ├── AGENTS.md
│   └── multi_agent_framework_v3_workspace.drawio
├── docs/                        # 持久框架文档（含 plan-status.md）
│   └── AGENTS.md
├── framework-config/            # 机器可读派生配置（drawio 的镜像，非第二真相源）
│   ├── AGENTS.md
│   ├── framework.yaml
│   ├── projects.yaml
│   ├── agents.yaml
│   ├── routing.yaml
│   ├── lifecycle.yaml
│   ├── task-bus.yaml
│   ├── workflow.yaml
│   └── sync-state.yaml
├── templates/                   # 可复用模板
│   └── AGENTS.md
├── runtime/                     # 运行时状态（根 Git 忽略）
└── .backups/                    # 临时备份（根 Git 忽略）
```

业务项目不属于根 Git，各自使用独立仓库：`ruoyi-vue-pro/`、`yudao-ui-admin-vue3/`、`xxl-job/`、`nyamtn/`。

## 核心特性

- **架构权威**: 架构决策以 drawio 流程图为唯一真相源
- **治理权威**: 治理规则与安全边界以 `AGENTS.md` 为准
- **冲突解决**: 架构与治理冲突时按分类裁决，无法分类则暂停报告
- **边界管理**: 业务项目独立 Git，根仓库只管理框架资产
- **知识管理**: 运行时知识与持久知识分离（Mem0 只存长期知识）
- **变更控制**: drawio → framework-config 当前为手工同步，自动同步未实现

## 主要组件

### 1. AGENTS.md (根目录)
框架的核心指令文档（治理真相源），包含：
- 工作空间定义
- 架构真相源与治理真相源
- 冲突解决机制
- 业务项目边界
- 框架目录结构
- 运行时 vs 持久知识
- 修改规则
- 范围约束
- Git 安全规范
- Git 提交信息规范
- 框架变更原则

### 2. agents/
Agent 定义目录（人工可读、平台中立），定义各类型 Agent 的：
- 职责范围
- 能力字段
- 限制条件
- 同步方向

### 3. diagrams/
架构图表目录（架构真相源），包含：
- 多智能体框架工作区图 (drawio 格式)
- 架构可视化文档

### 4. docs/
文档目录，用于存放：
- 项目文档
- 开发指南
- 技术规范
- 框架计划状态（plan-status.md）

### 5. framework-config/
机器可读派生配置（drawio 架构的镜像；冲突时以 drawio 为准）：
- framework.yaml
- projects.yaml
- agents.yaml
- routing.yaml
- lifecycle.yaml
- workflow.yaml
- sync-state.yaml

### 6. templates/
模板目录，提供：
- 代码模板
- 文档模板
- 项目模板

## 当前实现状态

```text
Plan 1: completed
Plan 2: completed
Plan 3: completed
Plan 4: completed
Plan 5: completed
Plan 6: completed
Plan 7: completed
Plan 8: final acceptance in progress

Next planned stage:
Plan 9 (deferred architecture synchronization and production E2E)
```

当前尚未实现：

- automatic drawio synchronization
- automatic lifecycle rotation（最终验收期间保持关闭；通过 Plan 8 Final Gate 后才启用）
- Desktop UI 透明切换（当前仅支持 checkpoint + successor + manual handoff）

## 使用指南

### 初始化框架
确保所有目录结构已正确创建：
```bash
# 验证目录结构
ls -la
```

### 遵循的原则
1. **架构权威**: 架构决策以 `diagrams/multi_agent_framework_v3_workspace.drawio` 为准；治理规则以 `AGENTS.md` 为准
2. **变更管理**: 修改框架需遵循 `Modification Rule`
3. **知识分离**: 明确区分运行时知识和持久知识
4. **边界遵守**: 严格遵守业务项目边界定义

## 许可证

当前仓库尚未声明独立 LICENSE 文件。
