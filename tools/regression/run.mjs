import { spawnSync } from "node:child_process"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { summarizeRegressionStatus } from "./status.mjs"

const root = new URL("../../", import.meta.url).pathname.replace(/^\/(\w):/, "$1:")
const args = process.argv.slice(2)
let manifestPath = path.join(root, "tools/regression/manifest.mjs")
if (args.length > 0) {
  if (args.length !== 2 || args[0] !== "--manifest" || !args[1]) {
    console.error("Usage: node tools/regression/run.mjs [--manifest <path>]")
    process.exit(1)
  }
  manifestPath = path.resolve(process.cwd(), args[1])
}

const { REGRESSION_CHECKS } = await import(pathToFileURL(manifestPath).href)
if (!Array.isArray(REGRESSION_CHECKS)) throw new TypeError("regression manifest must export REGRESSION_CHECKS as an array")

const results = []
let failure = false
let releaseBlocked = false

function runCheck(check) {
  const result = spawnSync(check.command, check.args, {
    cwd: root,
    encoding: "utf8",
    timeout: 120000,
    windowsHide: true,
  })
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim()
  if (check.release_gate) {
    let gate = null
    try { gate = JSON.parse(output.split(/\r?\n/).filter(Boolean).at(-1)) } catch {}
    if (result.error || result.status !== 0) {
      failure = true
      return { id: check.id, status: "FAIL", exit_code: result.status ?? null, error: String(result.error ?? "process failed") }
    }
    if (gate?.framework_v1 !== "RELEASE_READY") releaseBlocked = true
    return { id: check.id, status: gate?.framework_v1 === "RELEASE_READY" ? "PASS" : "BLOCKED", exit_code: result.status, framework_v1: gate?.framework_v1 ?? "UNKNOWN", missing: gate?.missing ?? [], output: output.slice(-1200) }
  }
  const ok = !result.error && result.status === 0
  if (!ok) failure = true
  return { id: check.id, status: ok ? "PASS" : "FAIL", exit_code: result.status ?? null, output: output.slice(-1200), error: result.error ? String(result.error) : undefined }
}

for (const check of REGRESSION_CHECKS) {
  process.stdout.write(`=== ${check.id} ===\n`)
  const result = runCheck(check)
  results.push(result)
  process.stdout.write(`${result.status}\n`)
  if (failure) break
}

const summary = summarizeRegressionStatus({ failure, releaseBlocked })
console.log(JSON.stringify({ schema_version: 1, ...summary, checks: results }))
process.exitCode = failure ? 1 : releaseBlocked ? 2 : 0
