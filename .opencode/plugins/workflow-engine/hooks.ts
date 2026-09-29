// Workflow Engine — test-only hooks (Plan 7 Phase 4+, T7b; §84/§85)
//
// Marker-gated deterministic test hooks used by the Plan 7 smoke tests
// (Test I REWORK limit / Test J safe retry) to avoid burning real model
// calls. NEVER a production tool surface:
//
// - index.ts registers the 6th tool `workflow_test_hook` ONLY when the
//   marker file runtime/.workflow-test-hooks existed at plugin load time
//   (marker appearing later requires a plugin reload; production loads
//   expose exactly the five §33 workflow tools and no hook).
// - Hook state is purely in-memory (Maps below) and dies on plugin reload.
// - Consumption points: scheduler.ts consumes a forceFailure quota BEFORE
//   any node dispatch (the node task is persisted FAILED directly with the
//   forced execution-class error code, session_id null, zero model calls);
//   review.ts consumes one forceVerdict queue entry per review round and
//   synthesizes a valid reviewer-result JSON instead of dispatching a real
//   Reviewer (zero model calls).
//
// This module holds no db/ctx references; the only fs access is the
// existsSync marker check.

import * as fs from "node:fs"
import * as path from "node:path"

export const TEST_HOOK_MARKER_RELPATH = "runtime/.workflow-test-hooks"
export const HOOK_VERDICTS = ["PASS", "FIX", "REWORK"]

// Marker check (§84/§85): the hook tool exists only when this file is
// present at plugin load. The main controller manages the marker file;
// the plugin never creates or deletes it.
export function testHooksEnabled(root: string): boolean {
  try {
    return fs.existsSync(path.join(root, "runtime", ".workflow-test-hooks"))
  } catch {
    return false
  }
}

export interface FailureQuota {
  code: string
  remaining: number
}

export function createWorkflowTestHooks() {
  // workflow_id -> FIFO verdict queue (one entry consumed per review round)
  const verdictQueues = new Map<string, string[]>()
  // `${workflow_id}\u0000${node_id}` -> { code, remaining }
  const failureQuotas = new Map<string, FailureQuota>()
  const failureKey = (workflowId: string, nodeId: string) => `${workflowId}\u0000${nodeId}`

  return {
    // Queue synthetic reviewer verdicts; each review round consumes one.
    forceVerdict(workflowId: string, verdicts: string[]) {
      verdictQueues.set(workflowId, [...verdicts])
      return { ok: true, workflow_id: workflowId, verdicts: [...verdicts] }
    },

    // The node's next `times` executions fail directly with `code`
    // (an execution-class error code; hook-forced codes participate in the
    // §60-§62 retry decision exactly like real dispatch failures).
    forceFailure(workflowId: string, nodeId: string, code: string, times: number) {
      failureQuotas.set(failureKey(workflowId, nodeId), { code, remaining: times })
      return { ok: true, workflow_id: workflowId, node_id: nodeId, code, times }
    },

    consumeVerdict(workflowId: string): string | null {
      const q = verdictQueues.get(workflowId)
      if (!q || q.length === 0) {
        verdictQueues.delete(workflowId)
        return null
      }
      const v = q.shift() as string
      if (q.length === 0) verdictQueues.delete(workflowId)
      return v
    },

    consumeFailure(workflowId: string, nodeId: string): string | null {
      const key = failureKey(workflowId, nodeId)
      const e = failureQuotas.get(key)
      if (!e || e.remaining <= 0) {
        failureQuotas.delete(key)
        return null
      }
      e.remaining -= 1
      if (e.remaining <= 0) failureQuotas.delete(key)
      return e.code
    },

    clear(workflowId?: string | null) {
      if (typeof workflowId === "string" && workflowId) {
        verdictQueues.delete(workflowId)
        for (const k of [...failureQuotas.keys()]) {
          if (k.startsWith(`${workflowId}\u0000`)) failureQuotas.delete(k)
        }
        return { ok: true, cleared: workflowId }
      }
      verdictQueues.clear()
      failureQuotas.clear()
      return { ok: true, cleared: "all" }
    },

    list() {
      return {
        verdict_queues: [...verdictQueues.entries()].map(([workflow_id, verdicts]) => ({
          workflow_id,
          verdicts: [...verdicts],
        })),
        failure_quotas: [...failureQuotas.entries()].map(([k, v]) => {
          const i = k.indexOf("\u0000")
          return {
            workflow_id: k.slice(0, i),
            node_id: k.slice(i + 1),
            code: v.code,
            remaining: v.remaining,
          }
        }),
      }
    },
  }
}

export type WorkflowTestHooks = ReturnType<typeof createWorkflowTestHooks>
