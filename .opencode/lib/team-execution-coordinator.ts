import { resolveResourceContract } from "./lane-resource-contract.ts"
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
