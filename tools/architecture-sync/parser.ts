import * as fs from "node:fs"
import * as crypto from "node:crypto"

export interface RawCell { attrs: Record<string, string>; geometry: Record<string, string> }

function decode(value: string): string {
  return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&")
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function attrs(text: string): Record<string, string> {
  const out: Record<string, string> = {}; let i = 0
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++
    const start = i; while (i < text.length && !/[\s=]/.test(text[i])) i++
    if (i === start) { i++; continue }
    const key = text.slice(start, i); while (i < text.length && /\s/.test(text[i])) i++
    if (text[i] !== "=") { out[key] = ""; continue }
    i++; while (i < text.length && /\s/.test(text[i])) i++
    const q = text[i]; if (q !== '"' && q !== "'") throw new Error(`ARCH_XML_ATTRIBUTE_QUOTE_MISSING:${key}`)
    i++; const begin = i; while (i < text.length && text[i] !== q) i++
    if (i >= text.length) throw new Error(`ARCH_XML_ATTRIBUTE_UNTERMINATED:${key}`)
    out[key] = decode(text.slice(begin, i)); i++
  }
  return out
}

function tags(xml: string): Array<{ name: string; attributes: Record<string, string>; closing: boolean; self: boolean }> {
  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) throw new Error("ARCH_XML_EXTERNAL_ENTITY_UNSUPPORTED")
  const out: any[] = []; let i = 0
  while (i < xml.length) {
    const open = xml.indexOf("<", i); if (open < 0) break
    if (xml.startsWith("<!--", open)) { const end = xml.indexOf("-->", open + 4); if (end < 0) throw new Error("ARCH_XML_COMMENT_UNTERMINATED"); i = end + 3; continue }
    let j = open + 1; let quote: string | null = null
    for (; j < xml.length; j++) { const ch = xml[j]; if ((ch === '"' || ch === "'") && (!quote || quote === ch)) quote = quote ? null : ch; if (ch === ">" && !quote) break }
    if (j >= xml.length) throw new Error("ARCH_XML_TAG_UNTERMINATED")
    let body = xml.slice(open + 1, j).trim(); const closing = body.startsWith("/"); if (closing) body = body.slice(1).trim()
    const self = !closing && body.endsWith("/"); if (self) body = body.slice(0, -1).trim()
    const m = body.match(/^([^\s]+)/); if (m) out.push({ name: m[1], attributes: attrs(body.slice(m[1].length)), closing, self })
    i = j + 1
  }
  return out
}

export function parseDrawio(file: string): any {
  const xml = fs.readFileSync(file, "utf8")
  if (/<mxfile[^>]*compressed\s*=\s*["']true["']/i.test(xml)) throw new Error("DRAWIO_COMPRESSED_UNSUPPORTED")
  const ts = tags(xml); const cells: RawCell[] = []; let current: RawCell | null = null
  for (const t of ts) {
    if (t.name === "mxCell" && !t.closing) {
      const id = t.attributes.id; if (!id) throw new Error("ARCH_CELL_ID_MISSING")
      current = { attrs: t.attributes, geometry: {} }; cells.push(current); if (t.self) current = null
    } else if (t.name === "mxGeometry" && !t.closing && current) current.geometry = t.attributes
    else if (t.name === "mxCell" && t.closing) current = null
  }
  const meta = cells.filter((c) => c.attrs["data-arch-kind"])
  if (!meta.length) throw new Error("ARCH_METADATA_MISSING")
  const entityIds = new Set<string>()
  for (const c of meta) {
    const aid = c.attrs["data-arch-id"]; if (!aid) throw new Error(`ARCH_METADATA_MISSING:${c.attrs.id}`)
    if (meta.filter((x) => x.attrs.id === c.attrs.id).length > 1) throw new Error(`ARCH_CELL_ID_DUPLICATE:${c.attrs.id}`)
    const entityKey = `${c.attrs["data-arch-kind"]}:${aid}`
    if (entityIds.has(entityKey)) throw new Error(`ARCH_METADATA_DUPLICATE:${entityKey}`); entityIds.add(entityKey)
  }
  const byKind = (kind: string) => meta.filter((c) => c.attrs["data-arch-kind"] === kind)
  const agents = byKind("agent").map((c) => ({ id: c.attrs["data-arch-id"], role: c.attrs["data-role"], model_key: c.attrs["data-model-key"], lifecycle: c.attrs["data-lifecycle"], runtime_mode: c.attrs["data-runtime-mode"] ?? "subagent" }))
  const projects = byKind("project").map((c) => ({ id: c.attrs["data-arch-id"], path: c.attrs["data-project-path"] ?? null, project_type: c.attrs["data-project-type"] ?? null }))
  const routes = byKind("route").map((c) => ({ id: c.attrs["data-route-id"], target: c.attrs["data-target"] }))
  const lifecycleCell = byKind("lifecycle")[0]
  const lifecycle = lifecycleCell ? { thresholds: { continue_reuse_below_percent: Number(lifecycleCell.attrs["data-continue-below"]), checkpoint_from_percent: Number(lifecycleCell.attrs["data-checkpoint-from"]), checkpoint_to_percent: Number(lifecycleCell.attrs["data-checkpoint-to"]), rotate_after_atomic_step_at_percent: Number(lifecycleCell.attrs["data-rotate-at"]), hard_stop_new_tasks_at_percent: Number(lifecycleCell.attrs["data-hard-stop-at"]) }, roles: Object.fromEntries(agents.map((a: any) => [a.id, { lifecycle: a.lifecycle }])) } : { thresholds: {}, roles: {} }
  const relationships = cells.filter((c) => c.attrs.source && c.attrs.target).map((c) => ({ source: c.attrs.source, target: c.attrs.target, label: decode(c.attrs.value ?? "") })).sort((a, b) => compareCodeUnits(`${a.source}|${a.target}|${a.label}`, `${b.source}|${b.target}|${b.label}`))
  const ir = { ir_version: 1, source: { file, raw_sha256: crypto.createHash("sha256").update(xml).digest("hex") }, agents, projects, routes, lifecycle, runtime_components: byKind("runtime_component").map((c) => ({ id: c.attrs["data-arch-id"], kind: c.attrs["data-component-kind"] })), completion_guards: byKind("completion_guard").map((c) => ({ id: c.attrs["data-arch-id"], stage: c.attrs["data-stage"] })), execution_lanes: byKind("execution_lane").map((c) => ({ id: c.attrs["data-arch-id"], default_parallel: Number(c.attrs["data-default-parallel"]), max_parallel: Number(c.attrs["data-max-parallel"]) })), relationships }
  return ir
}
