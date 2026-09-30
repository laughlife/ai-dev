import * as path from "node:path"
import { parseYaml } from "./yaml.ts"

export function safePath(rootDir: string, relative: string): string {
  if (path.isAbsolute(relative)) throw new Error(`ARCHITECTURE_SYNC_PATH_ABSOLUTE:${relative}`)
  const resolved = path.resolve(rootDir, relative)
  const boundary = rootDir.endsWith(path.sep) ? rootDir : `${rootDir}${path.sep}`
  if (resolved !== rootDir && !resolved.startsWith(boundary)) throw new Error(`ARCHITECTURE_SYNC_PATH_ESCAPE:${relative}`)
  return resolved
}

export function preflightGeneratedFiles(rootDir: string, files: Record<string, string>) {
  for (const [relative, text] of Object.entries(files)) {
    const destination = safePath(rootDir, relative)
    if (!text.trim()) throw new Error(`ARCHITECTURE_SYNC_EMPTY_OUTPUT:${relative}`)
    if (!(relative.startsWith("framework-config/") || relative.startsWith(".opencode/agents/"))) throw new Error(`ARCHITECTURE_SYNC_OUTPUT_SCOPE:${relative}`)
    if (relative.endsWith(".yaml") && parseYaml(text) === null) throw new Error(`ARCHITECTURE_SYNC_INVALID_YAML:${relative}`)
    if (relative.startsWith(".opencode/agents/") && !text.includes("ARCH-GENERATED:BEGIN")) throw new Error(`ARCHITECTURE_SYNC_GENERATED_BLOCK_MISSING:${relative}`)
    safePath(rootDir, path.relative(rootDir, destination))
  }
}
