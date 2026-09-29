// Planner prompt construction (Plan 7 Phase 4, §35 — all rules verbatim).
//
// Pure string building: no ctx, no db, no fs. The caller (workflow-engine
// index.ts) supplies the live route/project lists read fresh from
// framework-config/routing.yaml + projects.yaml so nothing config-derived is
// hardcoded in this module. buildRepairPrompt formats §36 JSON-repair rounds:
// the validator errors go back to the SAME planner scoped session.

export interface PlannerWorkflowInput {
  workflow_id?: string | null
  primary_project_id: string
  objective: string
  constraints?: string[]
  acceptance_criteria?: string[]
  project_scope?: string[]
  /** route names currently registered in framework-config/routing.yaml */
  available_routes?: string[]
  /** project ids currently registered in framework-config/projects.yaml */
  registered_projects?: string[]
}

function bulletList(items: string[] | undefined, emptyText: string): string[] {
  if (!Array.isArray(items) || items.length === 0) return [emptyText]
  return items.map((x) => `- ${x}`)
}

export function buildPlannerPrompt(input: PlannerWorkflowInput): string {
  const routes = Array.isArray(input.available_routes) ? input.available_routes : []
  const projects = Array.isArray(input.registered_projects) ? input.registered_projects : []
  return [
    "WORKFLOW PLANNING REQUEST (Workflow Engine, Plan 7)",
    "",
    `WORKFLOW_ID: ${input.workflow_id ?? ""}`,
    `PRIMARY_PROJECT_ID: ${input.primary_project_id}`,
    "",
    "你只负责规划，不执行任何任务。",
    "你的输出将被程序自动解析：只返回一个 JSON 对象；禁止 Markdown fence（```）；禁止 JSON 之外的任何文字。",
    "JSON 必须严格符合 templates/workflow-plan.schema.json（Workflow Plan v1）。",
    "",
    "顶层字段：",
    "- schema_version: 1（必填，整数）",
    "- workflow_objective: 必填，逐字回显下方 WORKFLOW OBJECTIVE",
    "- constraints: 逐字回显下方 CONSTRAINTS（无则省略或空数组）",
    "- acceptance_criteria: 逐字回显下方 ACCEPTANCE CRITERIA（无则省略或空数组；Reviewer 将据此验收）",
    "- project_scope: 逐字回显下方 PROJECT SCOPE（无则省略或空数组）",
    "- nodes: 必填，非空数组（Task DAG 节点）",
    "",
    "node 必填字段：",
    "- node_id: 本计划内唯一的非空字符串（被 depends_on / review.target_node_id 引用）",
    "- project_id: 必须来自下方已注册项目清单",
    "- route: 必须来自下方可用 route 清单",
    "- objective: 非空字符串（该节点的最终目标）",
    "- depends_on: node_id 字符串数组（本计划内的 node_id，不是 task_id）；无依赖必须写 []",
    "",
    "node 可选字段：",
    "- constraints / expected_output / acceptance_criteria: 字符串数组",
    "- review: { \"required\": boolean, \"target_node_id\": string|null }",
    "- metadata: 对象（禁止任何凭据：密码、API key、token）",
    "",
    `可用 route 清单（framework-config/routing.yaml，node.route 只能取其一，共 ${routes.length} 个）：`,
    ...bulletList(routes, "（清单为空——配置异常，请返回错误说明而不是编造 route）"),
    "",
    `已注册项目清单（framework-config/projects.yaml，node.project_id 只能取其一，共 ${projects.length} 个）：`,
    ...bulletList(projects, "（清单为空——配置异常，请返回错误说明而不是编造 project_id）"),
    "",
    "规划规则：",
    "1. 不要直接指定 Agent；Task Bus 按 routing.yaml 从 route 解析目标角色。",
    "2. 能并行的节点不要伪造依赖。",
    "3. 真正有依赖的节点必须准确写 depends_on。",
    "4. DAG 必须无环；禁止 self-dependency。",
    "5. 代码变更后必须安排 build/test 或适当验证节点（例如 code_change 之后接 build_and_test / api_regression 等验证 route）。",
    "6. 需要最终验收的执行链：在验证节点设置 review.required=true，review.target_node_id 指向验收不通过时应返工的实现节点；不要把 Reviewer 安排在代码变更节点与其测试节点之间。",
    "7. review.required=true 时 target_node_id 必须存在、不等于 gate 节点自身、且必须是该 gate 节点沿 depends_on 可达的祖先节点。",
    "8. 校验由 Workflow Engine 确定性执行（schema / 唯一 node_id / 已注册 project+route / 无环 / review gate 祖先规则）；任何违规都会带着 validator errors 退回给你修正。",
    "",
    "WORKFLOW OBJECTIVE:",
    input.objective,
    "",
    "CONSTRAINTS:",
    ...bulletList(input.constraints, "（无）"),
    "",
    "ACCEPTANCE CRITERIA:",
    ...bulletList(input.acceptance_criteria, "（无）"),
    "",
    "PROJECT SCOPE:",
    ...bulletList(input.project_scope, "（无）"),
  ].join("\n")
}

// §36: one repair round — validator errors go back to the SAME planner
// session; the Planner must re-emit the COMPLETE plan JSON. No infinite
// repair: the caller enforces the workflow.yaml planner.json_repair_attempts
// budget and passes it here only for message wording.
export function buildRepairPrompt(errors: any[], attempt: number, maxAttempts: number): string {
  return [
    `你上一次的输出未通过 Workflow Engine 的确定性校验（修正轮次 ${attempt}/${maxAttempts}）。`,
    "",
    "VALIDATOR ERRORS (JSON):",
    JSON.stringify(errors ?? [], null, 2),
    "",
    "请修复上述全部错误，并重新输出完整的 workflow-plan JSON：",
    "- 只返回一个 JSON 对象；禁止 Markdown fence；禁止 JSON 之外的任何文字",
    "- schema_version 必须为 1；workflow_objective / constraints / acceptance_criteria / project_scope 按原请求逐字回显",
    "- node.route 必须来自可用 route 清单；node.project_id 必须来自已注册项目清单",
    "- depends_on 元素必须是本计划内的 node_id；禁止 self-dependency；DAG 必须无环",
    "- review.required=true 时 target_node_id 必须存在、不等于 gate 节点自身、且必须是 gate 节点的祖先",
    "- 输出完整计划（不是 diff、不是片段、不是解释）",
  ].join("\n")
}
