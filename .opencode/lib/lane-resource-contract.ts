// Deterministic lane/resource contract helpers (Plan 9 Part A).
// This module has no runtime or model dependencies. It is shared by the
// workflow scheduler and offline architecture/scheduler tests.

export const ROUTE_LANES: Record<string, string> = {
  code_read: "read_probe",
  database_read: "read_probe",
  project_analysis: "read_probe",
  project_coordination: "controller",
  code_change: "coding",
  api_code_change: "coding",
  database_write: "coding",
  database_ddl: "coding",
  database_backup: "coding",
  build_and_test: "test_validation",
  api_runtime_call: "api_integration",
  api_regression: "api_integration",
  documentation_update: "documentation",
  independent_review: "reviewer",
  session_lifecycle: "controller",
  long_term_memory_write: "documentation",
}

const WRITE_ROUTES = new Set([
  "code_change", "api_code_change", "database_write", "database_ddl",
  "database_backup", "documentation_update", "long_term_memory_write",
])

export function laneForRoute(route: string): string {
  return ROUTE_LANES[route] ?? "coding"
}

function stringList(value: any): string[] {
  return Array.isArray(value) ? value.filter((x) => typeof x === "string" && x.length > 0) : []
}

export interface ResourceContract {
  lane: string
  project_id: string
  read: string[]
  write: string[]
  exclusive: string[]
}

/** Missing write scope is intentionally conservative per Plan 9 §5. */
export function resolveResourceContract(input: any): ResourceContract {
  const route = String(input?.route ?? "")
  const project = String(input?.project_id ?? "")
  const raw = input?.resources ?? {}
  const write = stringList(raw.write)
  if (WRITE_ROUTES.has(route) && write.length === 0) write.push(`project:${project}:write`)
  return {
    lane: typeof input?.lane === "string" && input.lane ? input.lane : laneForRoute(route),
    project_id: project,
    read: stringList(raw.read),
    write,
    exclusive: stringList(raw.exclusive),
  }
}

function intersects(a: string[], b: string[]): boolean {
  const set = new Set(a)
  return b.some((x) => set.has(x))
}

export function resourcesConflict(a: ResourceContract, b: ResourceContract): boolean {
  return intersects(a.write, b.write) || intersects(a.write, b.exclusive) ||
    intersects(a.exclusive, b.write) || intersects(a.exclusive, b.exclusive)
}

export function validateResourceContract(value: any): { ok: true } | { ok: false; code: string; detail: string } {
  if (!value || typeof value !== "object") return { ok: false, code: "RESOURCE_CONTRACT_INVALID", detail: "resource contract must be an object" }
  for (const key of ["read", "write", "exclusive"]) {
    if (!Array.isArray(value[key]) || value[key].some((x: any) => typeof x !== "string" || !x)) {
      return { ok: false, code: "RESOURCE_CONTRACT_INVALID", detail: `${key} must be a string[]` }
    }
  }
  if (typeof value.project_id !== "string" || !value.project_id) return { ok: false, code: "RESOURCE_CONTRACT_INVALID", detail: "project_id is required" }
  return { ok: true }
}
