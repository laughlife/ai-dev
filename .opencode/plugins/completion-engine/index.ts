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
    })
    return () => runtime.close()
  },
}
