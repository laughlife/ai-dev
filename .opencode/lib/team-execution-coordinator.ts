import { resolveResourceContract, resourcesConflict } from "./lane-resource-contract.ts"
import { normalizeLanePolicies, scheduleLaneWaves } from "./lane-scheduler.ts"
import type { LanePolicies, LaneWorkItem, ScheduledLaneItem } from "./lane-scheduler.ts"

export interface TeamExecutionPolicy {
  complex: { min_nodes: number }
  must_parallelize: { min_ready_non_conflicting: number }
  ownership: { write_scope_required_for_parallel_write: boolean; fallback: "project-exclusive" }
  scaling: { strategy: "per-lane-ready-backlog"; auto_scale: boolean }
  controller: { max_parallel: number }
}

export const DEFAULT_TEAM_EXECUTION_POLICY: TeamExecutionPolicy = {
  complex: { min_nodes: 3 },
  must_parallelize: { min_ready_non_conflicting: 2 },
  ownership: { write_scope_required_for_parallel_write: true, fallback: "project-exclusive" },
  scaling: { strategy: "per-lane-ready-backlog", auto_scale: true },
  controller: { max_parallel: 1 },
}

export interface TeamExecutionAssessment {
  nodeCount?: number
  implementationNodeCount?: number
  projectCount?: number
  multiProject?: boolean
  hasCodeTestReview?: boolean
  hasIndependentPackages?: boolean
  nodes?: Array<{ route?: string; project_id?: string; depends_on?: string[]; resources?: any; ready?: boolean; package?: string }>
}

export function normalizeTeamExecutionPolicy(raw: any): TeamExecutionPolicy {
  const x = raw?.team_execution ?? raw ?? {}
  return {
    complex: { min_nodes: Number.isInteger(x?.complex?.min_nodes) && x.complex.min_nodes > 0 ? x.complex.min_nodes : 3 },
    must_parallelize: { min_ready_non_conflicting: Number.isInteger(x?.must_parallelize?.min_ready_non_conflicting) && x.must_parallelize.min_ready_non_conflicting > 0 ? x.must_parallelize.min_ready_non_conflicting : 2 },
    ownership: { write_scope_required_for_parallel_write: x?.ownership?.write_scope_required_for_parallel_write !== false, fallback: "project-exclusive" },
    scaling: { strategy: "per-lane-ready-backlog", auto_scale: x?.scaling?.auto_scale !== false },
    controller: { max_parallel: 1 },
  }
}

export function isComplexTeamTask(nodeCount: number, policy: TeamExecutionPolicy = DEFAULT_TEAM_EXECUTION_POLICY): boolean {
  return Number.isFinite(nodeCount) && nodeCount >= policy.complex.min_nodes
}

/**
 * Pure Team Execution Mode gate.  This deliberately accepts either the
 * planner's node summary or explicit summary flags so it can be tested
 * without a runtime/session.  Any one of the four complexity signals is
 * sufficient; the scheduler remains the sole owner of the DAG.
 */
export function isTeamExecutionRequired(
  assessment: TeamExecutionAssessment | number,
  policy: TeamExecutionPolicy = DEFAULT_TEAM_EXECUTION_POLICY,
): boolean {
  if (typeof assessment === "number") return isComplexTeamTask(assessment, policy)
  const nodes = Array.isArray(assessment?.nodes) ? assessment.nodes : []
  const implementationNodeCount = assessment?.implementationNodeCount ?? nodes.filter((n) => ["code_change", "api_code_change"].includes(String(n?.route))).length
  const projectCount = assessment?.projectCount ?? new Set(nodes.map((n) => n?.project_id).filter(Boolean)).size
  const routes = new Set(nodes.map((n) => String(n?.route ?? "")))
  const codeTestReview = assessment?.hasCodeTestReview ?? ((routes.has("code_change") || routes.has("api_code_change")) && routes.has("build_and_test") && routes.has("independent_review"))
  const independentPackages = assessment?.hasIndependentPackages ?? (() => {
    const packages = new Set(nodes.map((n) => n?.package).filter(Boolean))
    if (packages.size >= 2) return true
    const relevant = nodes.filter((n) => ["code_read", "code_change", "api_code_change", "build_and_test"].includes(String(n?.route)))
    return relevant.length >= 2 && relevant.every((n) => !Array.isArray(n?.depends_on) || n.depends_on.length === 0)
  })()
  return implementationNodeCount >= policy.complex.min_nodes || assessment?.multiProject === true || projectCount > 1 || codeTestReview || independentPackages
}

/**
 * Returns true only when the supplied ready queue contains the configured
 * number of dependency-satisfied, pairwise resource-safe nodes.  Callers
 * may pass completedNodeIds when checking a raw DAG slice; ordinary
 * scheduler input is already dependency-ready.
 */
export function shouldMustParallelize(
  items: Array<any>,
  options: { completedNodeIds?: Iterable<string>; policy?: TeamExecutionPolicy } | TeamExecutionPolicy = {},
): boolean {
  const policy = (options as any)?.must_parallelize ? options as TeamExecutionPolicy : (options as any).policy ?? DEFAULT_TEAM_EXECUTION_POLICY
  const completed = (options as any).completedNodeIds ? new Set((options as any).completedNodeIds) : null
  const ready = (Array.isArray(items) ? items : []).filter((item) => {
    if (item?.ready === false || item?.dependencies_satisfied === false) return false
    const deps = Array.isArray(item?.depends_on) ? item.depends_on : []
    return !completed || deps.every((dep: string) => completed.has(dep))
  }).map((item) => ({ ...item, resources: resolveResourceContract(item) }))
  const independent: any[] = []
  for (const item of ready) {
    if (independent.every((other) => !resourcesConflict(item.resources, other.resources))) independent.push(item)
  }
  return independent.length >= policy.must_parallelize.min_ready_non_conflicting
}

export function readyQueue<T extends LaneWorkItem>(items: T[]): T[] {
  return (Array.isArray(items) ? items : []).slice()
}

export function dispatchTeamWaves(items: LaneWorkItem[], lanePolicies: LanePolicies, policy: TeamExecutionPolicy = DEFAULT_TEAM_EXECUTION_POLICY): ScheduledLaneItem[][] {
  const normalized = readyQueue(items).map((item) => {
    const contract = resolveResourceContract(item)
    const lane = contract.lane === "controller" || contract.lane === "reviewer" ? contract.lane : item.lane
    return lane ? { ...item, lane } : item
  })
  const constrained = { ...lanePolicies }
  for (const lane of ["controller", "reviewer"]) {
    const current = constrained[lane]
    if (current) constrained[lane] = { ...current, max_parallel: Math.min(current.max_parallel, policy.controller.max_parallel) }
  }
  return scheduleLaneWaves(normalized, constrained)
}
