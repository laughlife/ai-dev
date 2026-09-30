// Small dependency-free YAML subset reader/writer for framework-config.
// It intentionally rejects no data silently and is only used for staging and
// deterministic projection; runtime configuration continues to use Bun.YAML.

function scalar(value: string): any {
  const v = value.trim()
  if (!v) return null
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) return v.slice(1, -1)
  if (v === "true") return true
  if (v === "false") return false
  if (v === "null" || v === "~") return null
  if (/^-?\d+$/.test(v)) return Number(v)
  if (/^-?\d+\.\d+$/.test(v)) return Number(v)
  if (v.startsWith("[") && v.endsWith("]")) return v.slice(1, -1).split(",").map((x) => scalar(x)).filter((x) => x !== null || x === "null")
  return v
}

export function parseYaml(text: string): any {
  const lines: any[] = []
  for (const raw of String(text).split(/\r?\n/)) {
    let line = raw
    let quote: string | null = null
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if ((ch === "'" || ch === '"') && (!quote || quote === ch)) quote = quote ? null : ch
      if (ch === "#" && !quote && (i === 0 || /\s/.test(line[i - 1]))) { line = line.slice(0, i); break }
    }
    if (!line.trim()) continue
    lines.push({ indent: line.length - line.trimStart().length, text: line.trim() })
  }
  let pos = 0
  function block(indent: number): any {
    if (pos >= lines.length || lines[pos].indent < indent) return null
    const seq = lines[pos].indent === indent && lines[pos].text.startsWith("-")
    if (seq) {
      const out: any[] = []
      while (pos < lines.length && lines[pos].indent === indent && lines[pos].text.startsWith("-")) {
        const rest = lines[pos].text.replace(/^[-]\s*/, ""); pos++
        if (!rest) out.push(block(lines[pos]?.indent ?? indent + 2))
        else if (rest.includes(":")) {
          const fake = { indent: indent + 2, text: rest }; lines.splice(pos, 0, fake)
          out.push(block(indent + 2))
        } else out.push(scalar(rest))
      }
      return out
    }
    const out: any = {}
    while (pos < lines.length && lines[pos].indent === indent) {
      const idx = lines[pos].text.indexOf(":"); if (idx < 0) { pos++; continue }
      const key = lines[pos].text.slice(0, idx).trim(); const rest = lines[pos].text.slice(idx + 1).trim(); pos++
      out[key] = rest ? scalar(rest) : (pos < lines.length && lines[pos].indent > indent ? block(lines[pos].indent) : null)
    }
    return out
  }
  return lines.length ? block(lines[0].indent) : null
}

function quote(value: any): string {
  if (value === null || value === undefined) return "null"
  if (typeof value === "boolean" || typeof value === "number") return String(value)
  const s = String(value)
  return /^[A-Za-z0-9_.\-/]+$/.test(s) ? s : `'${s.replaceAll("'", "''")}'`
}

export function stringifyYaml(value: any, indent = 0): string {
  const pad = " ".repeat(indent)
  if (Array.isArray(value)) return value.map((x) => typeof x === "object" && x !== null ? `${pad}-\n${stringifyYaml(x, indent + 2)}` : `${pad}- ${quote(x)}`).join("\n")
  if (value && typeof value === "object") return Object.keys(value).sort().map((k) => {
    const v = value[k]
    return v && typeof v === "object" ? `${pad}${k}:\n${stringifyYaml(v, indent + 2)}` : `${pad}${k}: ${quote(v)}`
  }).join("\n")
  return `${pad}${quote(value)}`
}
