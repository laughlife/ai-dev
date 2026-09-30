// Minimal deterministic YAML subset parser used to stub Bun.YAML.parse in the
// offline Node test harness. It covers the structure actually present in
// framework-config/*.yaml: nested maps, sequences (scalar and map items),
// scalars (string / number / boolean / null), quoted strings, and `#`
// comments (only when `#` starts a line or follows whitespace, so
// `openai/gpt-5.6-sol-fast#high` stays intact).

export function parseYaml(text) {
  const lines = []
  for (const rawLine of String(text).split(/\r?\n/)) {
    let line = rawLine
    const hashMatch = line.match(/(^|\s)#/)
    if (hashMatch) line = line.slice(0, hashMatch.index + (hashMatch[1] ? 1 : 0))
    if (!line.trim()) continue
    lines.push({ indent: line.length - line.trimStart().length, text: line.trim() })
  }

  let pos = 0

  function scalar(value) {
    const v = value.trim()
    if (v === "") return null
    if ((v.startsWith("'" ) && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) return v.slice(1, -1)
    if (v === "true") return true
    if (v === "false") return false
    if (v === "null" || v === "~") return null
    if (/^-?\d+$/.test(v)) return Number(v)
    if (/^-?\d+\.\d+$/.test(v)) return Number(v)
    return v
  }

  function parseBlock(indent) {
    if (pos >= lines.length) return null
    if (lines[pos].indent < indent) return null
    const isSeq = lines[pos].indent === indent && lines[pos].text.startsWith("-")
    if (isSeq) {
      const arr = []
      while (pos < lines.length && lines[pos].indent === indent && lines[pos].text.startsWith("-")) {
        const itemText = lines[pos].text.replace(/^-\s*/, "")
        if (itemText.includes(":")) {
          // rewrite "- key: value" as a map line one level deeper and parse it
          lines[pos] = { indent: indent + 2, text: itemText }
          arr.push(parseBlock(indent + 2))
        } else {
          pos++
          arr.push(itemText === "" ? null : scalar(itemText))
        }
      }
      return arr
    }
    const obj = {}
    while (pos < lines.length && lines[pos].indent === indent) {
      const t = lines[pos].text
      const ci = t.indexOf(":")
      if (ci < 0) {
        pos++
        continue
      }
      const key = t.slice(0, ci).trim()
      const rest = t.slice(ci + 1).trim()
      pos++
      if (rest === "") {
        const child = pos < lines.length && lines[pos].indent > indent ? parseBlock(lines[pos].indent) : null
        obj[key] = child
      } else {
        obj[key] = scalar(rest)
      }
    }
    return obj
  }

  return lines.length ? parseBlock(lines[0].indent) : null
}

export default { parse: parseYaml }
