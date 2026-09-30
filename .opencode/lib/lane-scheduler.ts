import { resolveResourceContract, resourcesConflict } from "./lane-resource-contract.ts"
import type { ResourceContract } from "./lane-resource-contract.ts"

export interface LanePolicy {
  default_parallel: number
  max_parallel: number
}

export type LanePolicies = Record<string, LanePolicy>

export interface LaneWorkItem {
  node_id: string
  route: string
  project_id: string
  resources?: Partial<ResourceContract>
  lane?: string
}

export interface ScheduledLaneItem extends LaneWorkItem {
  lane: string
  contract: ResourceContract
}

export function normalizeLanePolicies(raw: any): LanePolicies {
  const lanes = raw?.scheduler?.lanes ?? raw?.lanes ?? {}
  const out: LanePolicies = {}
  for (const [lane, value] of Object.entries(lanes)) {
    const v: any = value
    const d = Number.isInteger(v?.default_parallel) && v.default_parallel > 0 ? v.default_parallel : 1
    const m = Number.isInteger(v?.max_parallel) && v.max_parallel >= d ? v.max_parallel : d
    out[lane] = { default_parallel: d, max_parallel: m }
  }
  if (!out.controller) out.controller = { default_parallel: 1, max_parallel: 1 }
  return out
}

/**
 * Deterministic greedy lane scheduler. There is deliberately no global cap:
 * each lane owns its budget and resource conflicts are the only cross-lane
 * exclusion. A ready queue of four or more permits the configured burst max.
 */
export function scheduleLaneWaves(items: LaneWorkItem[], policies: LanePolicies): ScheduledLaneItem[][] {
  const list = Array.isArray(items) ? items : []
  const burst = list.length >= 4
  const waves: ScheduledLaneItem[][] = []
  for (const item of list) {
    const contract = resolveResourceContract(item)
    const lane = contract.lane
    const p = policies?.[lane] ?? { default_parallel: 1, max_parallel: 1 }
    const budget = burst ? p.max_parallel : p.default_parallel
    const scheduled = { ...item, lane, contract }
    let placed = false
    for (const wave of waves) {
      const sameLane = wave.filter((x) => x.lane === lane).length
      if (sameLane >= budget) continue
      if (wave.some((x) => resourcesConflict(x.contract, contract))) continue
      wave.push(scheduled)
      placed = true
      break
    }
    if (!placed) waves.push([scheduled])
  }
  return waves
}
