import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"

const root = path.resolve(process.env.AI_DEV_ROOT ?? process.cwd())

function run(command, args) {
  try { return execFileSync(command, args, { cwd: root, encoding: "utf8", timeout: 30000 }).trim() } catch { return "" }
}

function architecture() {
  try { return JSON.parse(run(process.execPath, ["--experimental-strip-types", "tools/architecture-sync/cli.ts", "check", "--format=json"])) } catch { return { status: "ERROR", errors: ["ARCHITECTURE_CHECK_FAILED"], changes: [] } }
}

function file(pathname) { return path.join(root, pathname) }

function businessRepositoriesIsolated() {
  return ["ruoyi-vue-pro", "yudao-ui-admin-vue3", "xxl-job", "nyamtn"].every((project) => run("git", ["ls-files", project]) === "")
}

function evidenceFile(name) {
  const pathname = file(`docs/${name}`)
  if (!fs.existsSync(pathname)) return null
  try {
    const value = JSON.parse(fs.readFileSync(pathname, "utf8"))
    return value?.status === "PASS" ? value : null
  } catch { return null }
}

const statusDoc = fs.existsSync(file("docs/plan-status.md")) ? fs.readFileSync(file("docs/plan-status.md"), "utf8") : ""
const checks = {
  architecture: architecture(),
  plan9: /Status: U3_PASS \/ U4_PASS \/ U5_PASS \/ U6_PASS/.test(statusDoc) ? "PASS" : "NOT_READY",
  business_repositories_isolated: businessRepositoriesIsolated(),
  recovery_drill: fs.existsSync(file(".opencode/tests/lifecycle-smoke.mjs")) && fs.existsSync(file(".opencode/tests/plan9-final-acceptance.mjs")) && fs.existsSync(file(".opencode/tests/plan11-recovery-rollback.mjs")) ? "STATIC_EVIDENCE_PRESENT" : "MISSING",
  rollback_drill: fs.existsSync(file(".opencode/tests/architecture-compiler-hardening.mjs")) ? "STATIC_EVIDENCE_PRESENT" : "MISSING",
}
const missing = []
if (!evidenceFile("plan8-live-ui-evidence.json")) missing.push("PLAN8_DESKTOP_UI_SAMPLES")
if (!evidenceFile("plan8-rotation-evidence.json")) missing.push("PLAN8_ROTATION_EVIDENCE")
if (!evidenceFile("plan11-business-feature-e2e.json")) missing.push("PRODUCTION_BUSINESS_FEATURE_E2E")
if (checks.plan9 !== "PASS") missing.push("PLAN9_FINAL_ACCEPTANCE")
if (!checks.business_repositories_isolated) missing.push("BUSINESS_REPOSITORY_ISOLATION")

console.log(JSON.stringify({ schema_version: 1, status: missing.length ? "BLOCKED" : "PASS", checks, missing, framework_v1: missing.length ? "NOT_READY" : "RELEASE_READY" }))
