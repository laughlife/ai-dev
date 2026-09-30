import * as crypto from "node:crypto"

function sorted(value: any): any {
  if (Array.isArray(value)) return value.map(sorted).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sorted(value[k])]))
  return value
}

export function canonicalArchitecture(ir: any): any {
  const clone = JSON.parse(JSON.stringify(ir)); if (clone.source) delete clone.source
  return sorted(clone)
}

export function canonicalJson(value: any): string { return JSON.stringify(sorted(value)) }
export function semanticHash(ir: any): string { return crypto.createHash("sha256").update(canonicalJson(canonicalArchitecture(ir))).digest("hex") }
