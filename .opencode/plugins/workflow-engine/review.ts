// Workflow Engine — automatic Reviewer loop (Plan 7 Phase 4+, T7b; §50-§59)
//
// Deterministic reviewer closed loop consumed by the scheduler:
//
// - Trigger (§50): a node whose plan review.required=true reached task
//   COMPLETED => node status REVIEWING => runReview() creates a real
//   `independent_review` Reviewer task (§51 five-element objective) and
//   dispatches it via bus.dispatchTask (ephemeral FRESH reviewer session
//   every round — §52 forbids reviewer session reuse; the task bus already
//   guarantees this because `reviewer` is an ephemeral role).
// - Verdict parse (§53): parseReviewerResultText (shared task-bus-core
//   module export) — strict reviewer-result JSON, never an LLM.
// - Invalid result (§54): exactly ONE re-review with a NEW reviewer task
//   (fresh session, old task untouched, review_history round+1); a second
//   invalid result => caller marks the workflow FAILED / REVIEW_RESULT_INVALID.
// - PASS (§55): node.last_verdict=PASS, node.status=REVIEW_PASSED. The
//   caller detects "all nodes done" and archives the scoped feature-executor
//   sessions (§49) before marking the workflow COMPLETED.
// - FIX/REWORK (§56-§58): applyRework() bumps rework_cycle (over
//   workflow.yaml review.max_rework_cycles => REWORK_LIMIT, §59), computes
//   the affected set with the deterministic computeDescendantSubgraph
//   (target..gate only — unrelated parallel branches keep their COMPLETED
//   state), and materializes ONE new task per affected node (findings
//   appended to the objective, parent = previous task, attempt+1, node back
//   to READY). The feature-executor scoped session is reused naturally by
//   the scheduler (same session_key, §45/§56.6).
//
// Test hooks (§84/§85): when a forceVerdict quota exists for the workflow,
// NO reviewer is dispatched — a real reviewer task row is still created
// (audit) and completed with a synthetic valid reviewer-result JSON
// (session_id null, "forced by test hook"), zero model consumption.
//
// All policy values (review.max_rework_cycles) are read fresh from
// framework-config/workflow.yaml via the injected loader — nothing hardcoded.

import { computeDescendantSubgraph } from "./dag.ts"
import { parseReviewerResultText } from "../../lib/task-bus-core.ts"

function nowIso(): string {
  return new Date().toISOString()
}

function errMsg(e: any): string {
  return e?.message ?? String(e)
}

function safeParse(json: any): any {
  if (typeof json !== "string" || !json) return null
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

function dedupStrings(items: any[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const x of items) {
    if (typeof x !== "string" || !x || seen.has(x)) continue
    seen.add(x)
    out.push(x)
  }
  return out
}

// =====================================================================
// Pure decision: rework budget (§59). nextCycle = current + 1; allowed
// only while nextCycle <= max_rework_cycles (config integer >= 0).
// Boundaries with max=2: 0->1 allowed, 1->2 allowed, 2->3 REWORK_LIMIT.
// =====================================================================
export function decideRework(reworkCycle: any, maxReworkCycles: any): { nextCycle: number; allowed: boolean } {
  const current = Number.isInteger(reworkCycle) && (reworkCycle as number) >= 0 ? (reworkCycle as number) : 0
  const max = Number.isInteger(maxReworkCycles) && (maxReworkCycles as number) >= 0 ? (maxReworkCycles as number) : 0
  const nextCycle = current + 1
  return { nextCycle, allowed: nextCycle <= max }
}

// =====================================================================
// Pure prompt builders (string assembly only — no db, no fs, no ctx).
// =====================================================================

export interface ReviewerObjectiveInput {
  workflow_id: string
  workflow_objective: string
  acceptance_criteria: string[]
  target: {
    node_id: string
    project_id: string
    project_path: string
    route: string
    objective: string
    tasks: Array<{ task_id: string; attempt: number; status: string }>
  }
  gate: {
    node_id: string
    project_id: string
    route: string
    task_id: string
  }
  relevant_task_ids: string[]
}

// §51: the reviewer objective carries exactly the five elements (workflow
// objective / workflow acceptance criteria / review target node / review
// gate node / relevant task IDs). Evidence gathering stays with the
// reviewer (task_get + git diff); big diffs never go into the envelope.
export function buildReviewerObjective(input: ReviewerObjectiveInput): string {
  const ac = Array.isArray(input.acceptance_criteria) ? input.acceptance_criteria : []
  const tasks = Array.isArray(input.target?.tasks) ? input.target.tasks : []
  const relevant = Array.isArray(input.relevant_task_ids) ? input.relevant_task_ids : []
  return [
    "REVIEW REQUEST (Workflow Engine independent review, Plan 7 §50-§53)",
    "",
    `WORKFLOW_ID: ${input.workflow_id}`,
    "",
    "WORKFLOW OBJECTIVE:",
    input.workflow_objective,
    "",
    "WORKFLOW ACCEPTANCE CRITERIA (验收依据):",
    ...(ac.length > 0 ? ac.map((x) => `- ${x}`) : ["（无——以 workflow objective 与 target node 验收标准为准）"]),
    "",
    "REVIEW TARGET NODE (verdict 为 FIX/REWORK 时的返工目标):",
    `- node_id: ${input.target?.node_id ?? ""}`,
    `- project_id: ${input.target?.project_id ?? ""}`,
    `- project_path: ${input.target?.project_path ?? ""}`,
    `- route: ${input.target?.route ?? ""}`,
    `- objective: ${input.target?.objective ?? ""}`,
    "- task 历史:",
    ...(tasks.length > 0
      ? tasks.map((t) => `  - ${t.task_id} (attempt ${t.attempt}, ${t.status})`)
      : ["  （无）"]),
    "",
    "REVIEW GATE NODE (触发本轮 review 的验证节点):",
    `- node_id: ${input.gate?.node_id ?? ""}`,
    `- project_id: ${input.gate?.project_id ?? ""}`,
    `- route: ${input.gate?.route ?? ""}`,
    `- current task_id: ${input.gate?.task_id ?? ""}`,
    "",
    "RELEVANT TASK IDs (自行用 task_get 读取详情):",
    ...(relevant.length > 0 ? relevant.map((id) => `- task:${id}`) : ["（无）"]),
    "",
    "证据收集（必须自行完成，本 prompt 不内嵌大体积内容）:",
    "- 用 task_get 读取上述任务的 Task Envelope / Result Envelope",
    `- 用 git -C ${input.target?.project_path ?? "<project_path>"} diff 查看代码变更（如适用）`,
    "- 读取必要的测试 / 构建结果",
    "",
    "输出要求（严格）:",
    "- 最终回复只输出一个 JSON 对象，严格符合 templates/reviewer-result.schema.json（schema_version=1）",
    "- verdict 只能是 PASS / FIX / REWORK；findings[] 每项 {severity, file, reason, required_fix}",
    "- 禁止 Markdown fence；禁止 JSON 之外的任何文字；不要把大体积 diff 或源码全文塞进回复",
  ].join("\n")
}

// §56/§57: rework task objective = original objective + full reviewer
// findings JSON + the FIX (local minimal repair) / REWORK (structural
// rework, re-check original acceptance criteria) note.
export function buildReworkObjective(originalObjective: string, verdict: string, reviewerResult: any): string {
  const note =
    verdict === "FIX"
      ? "本次为 Reviewer FIX：目标基本正确，只做局部修复，保持最小改动，不要扩大范围。"
      : "本次为 Reviewer REWORK：这是结构性返工，不是局部 patch；必须重新核对原始 acceptance criteria 后重新实现。"
  return [
    originalObjective,
    "",
    `REVIEW FINDINGS (verdict=${verdict}):`,
    JSON.stringify(reviewerResult ?? {}, null, 2),
    "",
    note,
  ].join("\n")
}

// =====================================================================
// Reviewer loop factory. deps: shared runtime core + task bus core + the
// marker-gated test hooks (null in production) + the workflow.yaml loader.
// =====================================================================
export interface ReviewerDeps {
  core: any
  bus: any
  hooks: any | null
  loadWorkflowConfig: () => any
}

export function createReviewer(deps: ReviewerDeps) {
  const { core, bus, hooks, loadWorkflowConfig } = deps
  const db = core?.db
  const q = db
    ? {
        wfGet: db.query("SELECT * FROM workflows WHERE workflow_id = ?"),
        wfRework: db.query("UPDATE workflows SET rework_cycle = ?, status = ?, updated_at = ? WHERE workflow_id = ?"),
        wfFinish: db.query("UPDATE workflows SET status = ?, updated_at = ?, finished_at = ? WHERE workflow_id = ?"),
        nodeGet: db.query("SELECT * FROM workflow_nodes WHERE workflow_id = ? AND node_id = ?"),
        nodesGet: db.query("SELECT * FROM workflow_nodes WHERE workflow_id = ? ORDER BY rowid"),
        nodeReviewSet: db.query(
          "UPDATE workflow_nodes SET status = ?, last_verdict = ?, review_task_id = ?, review_history_json = ?, " +
            "updated_at = ? WHERE workflow_id = ? AND node_id = ?",
        ),
        nodeReworkSet: db.query(
          "UPDATE workflow_nodes SET current_task_id = ?, attempt = ?, status = ?, last_verdict = ?, " +
            "task_history_json = ?, updated_at = ? WHERE workflow_id = ? AND node_id = ?",
        ),
        taskGet: db.query("SELECT * FROM tasks WHERE task_id = ?"),
      }
    : null

  function guard() {
    if (!db || !q) return { ok: false, code: "SQLITE_RUNTIME_UNAVAILABLE", detail: "workflow database unavailable" }
    return null
  }

  // One reviewer round: create the independent_review task (§51), run it
  // (real dispatch OR synthetic hook verdict), parse the verdict (§53),
  // append the review_history entry. Returns a structured outcome; node
  // review fields are persisted here, workflow-level consequences (FAILED /
  // REWORK_LIMIT / rework reset) belong to the caller + applyRework.
  async function attemptReviewRound(state: any, round: number): Promise<any> {
    const { workflowId, wfRow, plan, nodeRow, planNode, targetId, targetPlanNode, targetRow } = state

    // affected subgraph target..gate = the execution chain under review
    const affected: string[] = computeDescendantSubgraph(plan, targetId, nodeRow.node_id)
    const relevantTaskIds: string[] = []
    const targetTasks: Array<{ task_id: string; attempt: number; status: string }> = []
    for (const nid of affected) {
      const nRow: any = q!.nodeGet.get(workflowId, nid)
      if (!nRow) continue
      const hist: any[] = Array.isArray(safeParse(nRow.task_history_json)) ? safeParse(nRow.task_history_json) : []
      for (const h of hist) {
        if (h && typeof h.task_id === "string") relevantTaskIds.push(h.task_id)
      }
      if (nRow.current_task_id && !relevantTaskIds.includes(nRow.current_task_id)) relevantTaskIds.push(nRow.current_task_id)
      if (nid === targetId) {
        for (const h of hist) {
          if (!h || typeof h.task_id !== "string") continue
          const tRow: any = q!.taskGet.get(h.task_id)
          targetTasks.push({ task_id: h.task_id, attempt: h.attempt ?? 0, status: tRow ? String(tRow.status) : "UNKNOWN" })
        }
      }
    }

    let cfg: any = null
    try {
      cfg = bus.loadBusConfig()
    } catch {}
    const targetProject = cfg ? core.findProject(cfg, targetPlanNode?.project_id ?? targetRow?.project_id) : null
    const projectPath = typeof targetProject?.path === "string" ? targetProject.path : ""

    const objective = buildReviewerObjective({
      workflow_id: workflowId,
      workflow_objective: typeof plan?.workflow_objective === "string" ? plan.workflow_objective : String(wfRow.objective ?? ""),
      acceptance_criteria: Array.isArray(plan?.acceptance_criteria) ? plan.acceptance_criteria : [],
      target: {
        node_id: targetId,
        project_id: String(targetPlanNode?.project_id ?? targetRow?.project_id ?? ""),
        project_path: projectPath,
        route: String(targetPlanNode?.route ?? ""),
        objective: String(targetPlanNode?.objective ?? ""),
        tasks: targetTasks,
      },
      gate: {
        node_id: nodeRow.node_id,
        project_id: String(planNode?.project_id ?? nodeRow.project_id ?? ""),
        route: String(planNode?.route ?? ""),
        task_id: String(nodeRow.current_task_id ?? ""),
      },
      relevant_task_ids: relevantTaskIds,
    })

    const created: any = bus.createTask({
      project_id: planNode?.project_id ?? nodeRow.project_id,
      route: "independent_review",
      objective,
      parent_task_id: nodeRow.current_task_id ?? null,
      constraints: [
        "自行 task_get 读取任务详情",
        `自行 git -C ${projectPath || "<project_path>"} diff 查看变更`,
        "不要把大体积 diff 或源码全文塞进回复",
        "最终回复只输出 reviewer-result JSON",
      ],
      expected_output: [
        "严格符合 templates/reviewer-result.schema.json 的 reviewer-result JSON（schema_version=1，verdict ∈ PASS/FIX/REWORK）",
      ],
      acceptance_criteria: [],
      context_refs: dedupStrings([`workflow:${workflowId}`, ...relevantTaskIds.map((id) => `task:${id}`)]),
      metadata: {
        workflow_id: workflowId,
        workflow_node_id: nodeRow.node_id,
        workflow_review_round: round,
        workflow_review_target_node_id: targetId,
      },
    })
    if (!created?.ok) {
      return { kind: "infra", code: created?.code ?? "REVIEW_TASK_CREATE_FAILED", detail: created?.detail ?? "bus.createTask failed" }
    }
    const reviewTaskId: string = created.envelope.task_id
    const startedAt = nowIso()

    // §84/§85 test hook: a forced verdict skips the real dispatch entirely
    // (the task row above stays for audit; result is synthetic, session null).
    const forced: string | null = hooks ? hooks.consumeVerdict(workflowId) : null
    let outputText = ""
    let sessionId: string | null = null
    if (forced) {
      const synthetic = {
        schema_version: 1,
        verdict: forced,
        summary: `reviewer verdict forced by test hook (workflow_test_hook force_verdict); no model was invoked`,
        findings:
          forced === "PASS"
            ? []
            : [
                {
                  severity: "medium",
                  file: null,
                  reason: `forced ${forced} verdict by test hook (synthetic finding)`,
                  required_fix: "address the synthetic test-hook finding",
                },
              ],
      }
      outputText = JSON.stringify(synthetic)
      const result = bus.buildResult({
        taskId: reviewTaskId,
        projectId: String(planNode?.project_id ?? nodeRow.project_id ?? ""),
        route: "independent_review",
        targetRole: "reviewer",
        status: "COMPLETED",
        sessionId: null,
        sessionGeneration: null,
        outputText,
        error: null,
        startedAt,
        finishedAt: nowIso(),
      })
      bus.persistResult(reviewTaskId, "COMPLETED", null, result)
    } else {
      // §52: bus.dispatchTask gives the reviewer role a FRESH ephemeral
      // session every round (task-bus.yaml ephemeral_roles) — never reused.
      const dispatched: any = await bus.dispatchTask(reviewTaskId)
      if (dispatched?.status !== "COMPLETED") {
        const code = String(dispatched?.code ?? dispatched?.status ?? "REVIEW_DISPATCH_FAILED")
        if (dispatched?.status === "BLOCKED") {
          return { kind: "blocked", code, detail: dispatched?.detail ?? "reviewer task BLOCKED", review_task_id: reviewTaskId }
        }
        if (dispatched?.status === "FAILED") {
          return { kind: "failed", code, detail: dispatched?.detail ?? "reviewer task FAILED", review_task_id: reviewTaskId }
        }
        return { kind: "infra", code, detail: dispatched?.detail ?? "reviewer dispatch infrastructure failure", review_task_id: reviewTaskId }
      }
      outputText = String(dispatched.result?.output_text ?? "")
      sessionId = dispatched.result?.session_id ?? null
    }

    // §53: strict deterministic verdict parse (shared task-bus-core export)
    const parsed = parseReviewerResultText(outputText)
    const entry = {
      task_id: reviewTaskId,
      round,
      session_id: sessionId,
      verdict: parsed.ok ? String(parsed.value.verdict) : "INVALID",
      ts: nowIso(),
      ...(parsed.ok ? {} : { invalid_reason: parsed.reason }),
      ...(forced ? { forced_by_hook: true } : {}),
    }
    return { kind: "reviewed", entry, parsed, review_task_id: reviewTaskId, session_id: sessionId, forced: !!forced }
  }

  // ===================================================================
  // runReview: full §53/§54 flow for ONE gate node in REVIEWING state.
  // Returns { type: PASS | FIX | REWORK | INVALID | BLOCKED | FAILED |
  // INFRA, ... } and persists review_task_id / review_history_json /
  // (on PASS) last_verdict + node status REVIEW_PASSED.
  // ===================================================================
  async function runReview(input: { workflow_id: string; node_id: string }): Promise<any> {
    const g = guard()
    if (g) return { type: "INFRA", code: g.code, detail: g.detail }
    const workflowId = input?.workflow_id
    const nodeId = input?.node_id
    const wfRow: any = q!.wfGet.get(workflowId)
    if (!wfRow) return { type: "INFRA", code: "WORKFLOW_NOT_FOUND", detail: `workflow '${workflowId}' not found` }
    const plan = safeParse(wfRow.plan_json)
    if (!plan || !Array.isArray(plan.nodes)) {
      return { type: "INFRA", code: "PLAN_MISSING", detail: "workflows.plan_json is missing or has no nodes" }
    }
    const nodeRow: any = q!.nodeGet.get(workflowId, nodeId)
    if (!nodeRow || nodeRow.status !== "REVIEWING") {
      return { type: "INFRA", code: "NODE_STATE_INVALID", detail: `node '${nodeId}' is not in REVIEWING state` }
    }
    const planNode = plan.nodes.find((n: any) => n?.node_id === nodeId)
    const targetId = planNode?.review?.target_node_id
    const targetPlanNode = plan.nodes.find((n: any) => n?.node_id === targetId)
    const targetRow: any = targetId ? q!.nodeGet.get(workflowId, targetId) : null
    if (typeof targetId !== "string" || !targetId || !targetRow) {
      // validated at plan time (§17); reaching here means data drift
      return { type: "INFRA", code: "REVIEW_TARGET_MISSING", detail: `review target node '${targetId}' of gate '${nodeId}' not found` }
    }

    const state = { workflowId, wfRow, plan, nodeRow, planNode, targetId, targetPlanNode, targetRow }
    let history: any[] = Array.isArray(safeParse(nodeRow.review_history_json)) ? safeParse(nodeRow.review_history_json) : []
    const newEntries: any[] = []

    let att: any = await attemptReviewRound(state, history.length + 1)
    if (att.kind !== "reviewed") {
      return { type: att.kind.toUpperCase(), code: att.code, detail: att.detail, review_task_id: att.review_task_id ?? null }
    }
    history.push(att.entry)
    newEntries.push(att.entry)

    // §54: invalid reviewer JSON => exactly ONE re-review with a NEW
    // reviewer task + fresh session (the old task is never modified).
    if (!att.parsed.ok && !att.forced) {
      const att2: any = await attemptReviewRound(state, history.length + 1)
      if (att2.kind !== "reviewed") {
        persistNodeReview(nodeRow, workflowId, history, null, null)
        return {
          type: att2.kind.toUpperCase(),
          code: att2.code,
          detail: `first review round was INVALID (${att.parsed.reason}); re-review failed: ${att2.detail}`,
          review_task_id: att2.review_task_id ?? att.review_task_id,
          history_entries: newEntries,
        }
      }
      history.push(att2.entry)
      newEntries.push(att2.entry)
      att = att2
    }

    if (!att.parsed.ok) {
      // second invalid result => caller marks workflow FAILED / REVIEW_RESULT_INVALID (§54)
      persistNodeReview(nodeRow, workflowId, history, null, att.review_task_id)
      return {
        type: "INVALID",
        code: "REVIEW_RESULT_INVALID",
        detail: `reviewer result invalid twice (§54): ${att.parsed.reason}`,
        review_task_id: att.review_task_id,
        session_id: att.session_id,
        history_entries: newEntries,
      }
    }

    const verdict = String(att.parsed.value.verdict)
    if (verdict === "PASS") {
      // §55: gate node passes; REVIEW_PASSED is the node-level done state
      persistNodeReview(nodeRow, workflowId, history, "PASS", att.review_task_id, "REVIEW_PASSED")
      return {
        type: "PASS",
        verdict,
        reviewer_result: att.parsed.value,
        review_task_id: att.review_task_id,
        session_id: att.session_id,
        round: att.entry.round,
        forced_by_hook: !!att.forced,
        history_entries: newEntries,
      }
    }

    // FIX / REWORK: keep node REVIEWING (applyRework resets the subgraph to
    // READY); record verdict + history for audit.
    persistNodeReview(nodeRow, workflowId, history, verdict, att.review_task_id, "REVIEWING")
    return {
      type: verdict,
      verdict,
      reviewer_result: att.parsed.value,
      review_task_id: att.review_task_id,
      session_id: att.session_id,
      round: att.entry.round,
      forced_by_hook: !!att.forced,
      history_entries: newEntries,
    }
  }

  function persistNodeReview(
    nodeRow: any,
    workflowId: string,
    history: any[],
    lastVerdict: string | null,
    reviewTaskId: string | null,
    status?: string,
  ) {
    q!.nodeReviewSet.run(
      status ?? nodeRow.status,
      lastVerdict ?? nodeRow.last_verdict ?? null,
      reviewTaskId ?? nodeRow.review_task_id ?? null,
      JSON.stringify(history),
      nowIso(),
      workflowId,
      nodeRow.node_id,
    )
  }

  // ===================================================================
  // applyRework (§56-§59): rework budget check, deterministic affected
  // subgraph, one new task per affected node, node attempt+1 / READY.
  // ===================================================================
  async function applyRework(input: {
    workflow_id: string
    node_id: string
    verdict: string
    reviewer_result: any
    review_task_id: string | null
  }): Promise<any> {
    const g = guard()
    if (g) return { status: "FAILED", code: g.code, detail: g.detail }
    const workflowId = input.workflow_id
    const wfRow: any = q!.wfGet.get(workflowId)
    if (!wfRow) return { status: "FAILED", code: "WORKFLOW_NOT_FOUND", detail: `workflow '${workflowId}' not found` }
    const plan = safeParse(wfRow.plan_json)
    const gateNodeId = input.node_id
    const planNode = Array.isArray(plan?.nodes) ? plan.nodes.find((n: any) => n?.node_id === gateNodeId) : null
    const targetId = planNode?.review?.target_node_id
    if (!planNode || typeof targetId !== "string" || !targetId) {
      return { status: "FAILED", code: "REVIEW_TARGET_MISSING", detail: `gate node '${gateNodeId}' has no usable review.target_node_id` }
    }

    let wfCfg: any
    try {
      wfCfg = loadWorkflowConfig()
    } catch (e: any) {
      return { status: "FAILED", code: "WORKFLOW_CONFIG_LOAD_FAILED", detail: errMsg(e) }
    }
    // §59: budget from workflow.yaml review.max_rework_cycles only
    const decision = decideRework(wfRow.rework_cycle, wfCfg?.review?.max_rework_cycles)
    if (!decision.allowed) {
      const ts = nowIso()
      q!.wfFinish.run("REWORK_LIMIT", ts, ts, workflowId)
      return {
        status: "REWORK_LIMIT",
        code: "REWORK_LIMIT",
        rework_cycle: wfRow.rework_cycle,
        max_rework_cycles: wfCfg?.review?.max_rework_cycles ?? null,
        detail:
          `verdict ${input.verdict} would raise rework_cycle to ${decision.nextCycle} which exceeds ` +
          `review.max_rework_cycles=${wfCfg?.review?.max_rework_cycles}; workflow stopped (§59, no unbounded model burn)`,
      }
    }

    const affected: string[] = computeDescendantSubgraph(plan, targetId, gateNodeId)
    if (affected.length === 0) {
      const ts = nowIso()
      q!.wfFinish.run("FAILED", ts, ts, workflowId)
      return { status: "FAILED", code: "REWORK_SUBGRAPH_EMPTY", detail: `computeDescendantSubgraph('${targetId}','${gateNodeId}') returned no nodes` }
    }

    const ts0 = nowIso()
    q!.wfRework.run(decision.nextCycle, "REWORKING", ts0, workflowId)

    const nodeRows: any[] = q!.nodesGet.all(workflowId)
    const nodeById = new Map<string, any>(nodeRows.map((r) => [r.node_id, r]))
    const newTaskMap: Record<string, string> = {}
    // affected is in deterministic topological order => when a node is
    // recreated, every in-set dependency already has its NEW task id;
    // out-of-set dependencies keep their old (COMPLETED) task id (§58).
    for (const nid of affected) {
      const nRow: any = nodeById.get(nid)
      const pNode = plan.nodes.find((n: any) => n?.node_id === nid)
      if (!nRow || !pNode) {
        const ts = nowIso()
        q!.wfFinish.run("FAILED", ts, ts, workflowId)
        return {
          status: "FAILED",
          code: "REWORK_NODE_MISSING",
          detail: `affected node '${nid}' vanished from plan/workflow_nodes during rework`,
          rework_cycle: decision.nextCycle,
          affected,
          partial_new_tasks: newTaskMap,
        }
      }
      const oldTaskId: string | null = nRow.current_task_id
      const oldRow: any = oldTaskId ? q!.taskGet.get(oldTaskId) : null
      const oldEnv = safeParse(oldRow?.input_json)
      const ts = nowIso()
      const attempt = (Number.isInteger(nRow.attempt) ? nRow.attempt : 1) + 1
      const created: any = bus.createTask({
        project_id: pNode.project_id,
        route: pNode.route, // §56.2: original route, never re-chosen
        objective: buildReworkObjective(String(pNode.objective ?? ""), input.verdict, input.reviewer_result),
        parent_task_id: oldTaskId, // §56.5: parent = previous version of this node's task
        constraints: Array.isArray(pNode.constraints) ? pNode.constraints : [],
        dependencies: (Array.isArray(pNode.depends_on) ? pNode.depends_on : [])
          .map((d: string) => newTaskMap[d] ?? nodeById.get(d)?.current_task_id)
          .filter((x: any) => typeof x === "string" && x),
        expected_output: Array.isArray(pNode.expected_output) ? pNode.expected_output : [],
        acceptance_criteria: Array.isArray(pNode.acceptance_criteria) ? pNode.acceptance_criteria : [],
        context_refs: dedupStrings([
          ...(Array.isArray(oldEnv?.context_refs) ? oldEnv.context_refs : []),
          `workflow:${workflowId}`,
          ...(input.review_task_id ? [`task:${input.review_task_id}`] : []),
        ]),
        metadata: {
          ...(oldEnv?.metadata && typeof oldEnv.metadata === "object" ? oldEnv.metadata : {}),
          workflow_id: workflowId,
          workflow_node_id: nid,
          attempt,
          rework: { verdict: input.verdict, review_task_id: input.review_task_id, rework_cycle: decision.nextCycle },
        },
      })
      if (!created?.ok) {
        q!.wfFinish.run("FAILED", ts, ts, workflowId)
        return {
          status: "FAILED",
          code: created?.code ?? "REWORK_TASK_CREATE_FAILED",
          detail: `rework task creation failed for node '${nid}': ${created?.detail ?? "bus.createTask failed"} ` +
            "(already-created rework tasks of earlier affected nodes stay READY for audit; old tasks keep their history)",
          rework_cycle: decision.nextCycle,
          affected,
          partial_new_tasks: newTaskMap,
        }
      }
      const newTaskId: string = created.envelope.task_id
      newTaskMap[nid] = newTaskId
      const history: any[] = Array.isArray(safeParse(nRow.task_history_json)) ? safeParse(nRow.task_history_json) : []
      history.push({
        task_id: newTaskId,
        attempt,
        created_at: ts,
        rework: true,
        verdict: input.verdict,
        review_task_id: input.review_task_id,
      })
      q!.nodeReworkSet.run(newTaskId, attempt, "READY", input.verdict, JSON.stringify(history), ts, workflowId, nid)
    }

    return {
      status: "REWORKING",
      rework_cycle: decision.nextCycle,
      verdict: input.verdict,
      target_node_id: targetId,
      gate_node_id: gateNodeId,
      affected,
      new_tasks: newTaskMap,
      review_task_id: input.review_task_id,
    }
  }

  return { runReview, applyRework }
}

export type WorkflowReviewer = ReturnType<typeof createReviewer>
