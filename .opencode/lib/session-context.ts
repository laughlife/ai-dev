// Normalize OpenCode V2 session context responses at the runtime boundary.
// Desktop V2 returns { data: Message[] }; older adapters returned either the
// array directly or { messages: Message[] }.
export function extractContextMessages(contextRes: any): any[] {
  if (Array.isArray(contextRes)) return contextRes
  if (Array.isArray(contextRes?.data)) return contextRes.data
  if (Array.isArray(contextRes?.messages)) return contextRes.messages
  return []
}
