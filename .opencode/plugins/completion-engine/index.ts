import { createRuntimeRegistryCore } from "../../lib/runtime-registry-core.ts"
import { createCompletionCore } from "../../lib/completion-core.ts"

export default {
  id: "completion-engine",
  async setup(ctx: any) {
    const runtime = createRuntimeRegistryCore(ctx)
    const completion = createCompletionCore(runtime)
    await ctx.tool.transform((editor: any) => {
      editor.namespace({ name: "completion", description: "Deterministic execution and delivery completion gates" })
      editor.add({
        name: "completion_execution_check",
        description: "Read-only deterministic execution completion gate for a workflow",
        input: { type: "object", properties: { workflow_id: { type: "string" } }, required: ["workflow_id"], additionalProperties: false },
        options: { namespace: "completion" },
        execute: async (input: any) => ({ content: JSON.stringify(completion.executionCheck(input)) }),
      })
      editor.add({
        name: "completion_delivery_check",
        description: "Read-only deterministic delivery completion gate for a workflow",
        input: { type: "object", properties: { workflow_id: { type: "string" } }, required: ["workflow_id"], additionalProperties: false },
        options: { namespace: "completion" },
        execute: async (input: any) => ({ content: JSON.stringify(completion.deliveryCheck(input)) }),
      })
      editor.add({
        name: "completion_status",
        description: "Read-only combined execution and delivery gate status",
        input: { type: "object", properties: { workflow_id: { type: "string" } }, required: ["workflow_id"], additionalProperties: false },
        options: { namespace: "completion" },
        execute: async (input: any) => ({ content: JSON.stringify(completion.status(input)) }),
      })
      editor.add({
        name: "completion_final_report_permission",
        description:
          "Deterministic final-report pre-authorization gate. Evidence-required workflows return " +
          "FINAL_REPORT_PREAUTHORIZED with L3 evidence; legacy workflows retain FINAL_REPORT_ALLOWED. " +
          "Only a successful completion_finalize transaction emits the L4 final-report result.",
        input: { type: "object", properties: { workflow_id: { type: "string" }, run_id: { type: "string" }, control_plane_db: { type: "string" } }, required: ["workflow_id"], additionalProperties: false },
        options: { namespace: "completion" },
        execute: async (input: any) => ({ content: JSON.stringify(completion.finalReportPermission(input)) }),
      })
      editor.add({
        name: "completion_finalize",
        description:
          "Hard Completion Guard transition. Atomically changes a workflow to COMPLETED only after " +
          "completion_final_report_permission passes, including Plan 12 L3 evidence when required; otherwise the workflow state is left unchanged.",
        input: { type: "object", properties: { workflow_id: { type: "string" }, run_id: { type: "string" }, control_plane_db: { type: "string" } }, required: ["workflow_id"], additionalProperties: false },
        options: { namespace: "completion" },
        execute: async (input: any) => ({ content: JSON.stringify(completion.finalize(input)) }),
      })
    })
    return () => runtime.close()
  },
}
