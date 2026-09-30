import * as fs from "node:fs"
import * as path from "node:path"

function modelDisplay(key: string): string | null { return ({ "gpt-6-sol-fast": "GPT-6 Sol Fast", "gpt-5.6-sol-fast": "GPT-5.6 Sol Fast", "gpt-5.6-sol": "GPT-5.6 Sol", "deepseek-v4.1-flash": "DeepSeek-V4.1-Flash", "qwen3.8-max": "qwen3.8-max", "project-session": null } as any)[key] ?? null }
function replaceFrontmatter(text: string, agent: any): string {
  const begin = text.indexOf("---"); const end = text.indexOf("---", begin + 3)
  if (begin !== 0 || end < 0) throw new Error(`PROFILE_FRONTMATTER_INVALID:${agent.id}`)
  const fm = text.slice(3, end).replace(/^\r?\n/, "")
  const generated = [`description: ${agent.id} architecture contract`, "mode: subagent", `architecture_id: ${agent.id}`, `architecture_role: ${agent.role}`, `architecture_model_key: ${agent.model_key}`, `architecture_lifecycle: ${agent.lifecycle}`].join("\n")
  const marker = /<!-- ARCH-GENERATED:BEGIN -->[\s\S]*?<!-- ARCH-GENERATED:END -->/m
  const body = text.slice(end + 3)
  const block = `\n\n<!-- ARCH-GENERATED:BEGIN -->\n${generated}\n<!-- ARCH-GENERATED:END -->`
  return `---\n${fm}\n---${marker.test(body) ? body.replace(marker, block.trimStart()) : block}${marker.test(body) ? "" : body}`
}

export function generateAgentContracts(root: string, ir: any): Record<string, string> {
  const out: Record<string, string> = {}
  for (const a of ir.agents) {
    const file = path.join(root, ".opencode", "agents", `${a.id}.md`)
    if (!fs.existsSync(file)) continue
    // Candidate generation is explicit; apply still preserves the manual body.
    out[`.opencode/agents/${a.id}.md`] = replaceFrontmatter(fs.readFileSync(file, "utf8"), a)
  }
  return out
}
