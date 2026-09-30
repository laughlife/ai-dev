import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"

const root = path.resolve(".")
const result = JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", "tools/production-acceptance/gate.mjs"], { cwd: root, encoding: "utf8" }))
const gateSource = fs.readFileSync(path.join(root, "tools", "production-acceptance", "gate.mjs"), "utf8")
assert.match(gateSource, /checks\.architecture\.status !== "IN_SYNC"/)
assert.match(gateSource, /checks\.recovery_drill !== "STATIC_EVIDENCE_PRESENT"/)
assert.match(gateSource, /checks\.rollback_drill !== "STATIC_EVIDENCE_PRESENT"/)
assert.equal(result.status, "BLOCKED")
assert.ok(result.missing.includes("PLAN8_DESKTOP_UI_SAMPLES"))
assert.ok(result.missing.includes("PLAN8_ROTATION_EVIDENCE"))
assert.ok(result.missing.includes("PRODUCTION_BUSINESS_FEATURE_E2E"))
assert.equal(result.checks.architecture.status, "IN_SYNC")
assert.equal(result.checks.business_repositories_isolated, true)
assert.equal(result.checks.plan9, "PASS")
assert.match(fs.readFileSync(path.join(root, "docs", "plan8-acceptance-matrix.md"), "utf8"), /MANUAL_UI_EVIDENCE_REQUIRED/)

const missingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plan11-gate-"))
try {
  const failed = JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", "tools/production-acceptance/gate.mjs"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, AI_DEV_ROOT: missingRoot },
    stdio: ["ignore", "pipe", "ignore"],
  }))
  assert.equal(failed.status, "BLOCKED")
  assert.equal(failed.framework_v1, "NOT_READY")
  assert.ok(failed.missing.includes("ARCHITECTURE_SYNC"))
  assert.ok(failed.missing.includes("BUSINESS_REPOSITORY_ISOLATION"))
  assert.ok(failed.missing.includes("RECOVERY_ROLLBACK_DRILL"))
  assert.ok(failed.missing.includes("COMPILER_ROLLBACK_DRILL"))
} finally {
  fs.rmSync(missingRoot, { recursive: true, force: true })
}
console.log("PLAN11_PRODUCTION_GATE_BLOCKED", JSON.stringify({ missing: result.missing, architecture: result.checks.architecture.status, plan9: result.checks.plan9 }))
