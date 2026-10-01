import assert from "node:assert/strict"

const { extractContextMessages } = await import("../lib/session-context.ts")

assert.deepEqual(
  extractContextMessages({
    data: [
      { type: "user", content: [{ type: "text", text: "prompt" }] },
      { type: "assistant", content: [{ type: "text", text: "result" }] },
    ],
  }),
  [
    { type: "user", content: [{ type: "text", text: "prompt" }] },
    { type: "assistant", content: [{ type: "text", text: "result" }] },
  ],
  "Desktop V2 context responses expose messages under data",
)

assert.deepEqual(
  extractContextMessages({ messages: [{ type: "assistant", content: [] }] }),
  [{ type: "assistant", content: [] }],
  "legacy context envelope remains supported",
)

console.log("SESSION_CONTEXT_ENVELOPE_PASS")
