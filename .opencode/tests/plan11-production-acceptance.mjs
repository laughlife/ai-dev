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

function runEvidenceGate(evidence) {
  const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plan11-evidence-"))
  try {
    fs.mkdirSync(path.join(evidenceRoot, "docs"), { recursive: true })
    for (const [name, value] of Object.entries(evidence)) {
      fs.writeFileSync(path.join(evidenceRoot, "docs", name), JSON.stringify(value))
    }
    return JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", "tools/production-acceptance/gate.mjs"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, AI_DEV_ROOT: evidenceRoot },
      stdio: ["ignore", "pipe", "ignore"],
    }))
  } finally {
    fs.rmSync(evidenceRoot, { recursive: true, force: true })
  }
}

const shellPass = {
  "plan8-live-ui-evidence.json": { status: "PASS" },
  "plan8-rotation-evidence.json": { status: "PASS" },
  "plan11-business-feature-e2e.json": { status: "PASS" },
}
const shellPassResult = runEvidenceGate(shellPass)
assert.ok(shellPassResult.missing.includes("PLAN8_DESKTOP_UI_SAMPLES"))
assert.ok(shellPassResult.missing.includes("PLAN8_ROTATION_EVIDENCE"))
assert.ok(shellPassResult.missing.includes("PRODUCTION_BUSINESS_FEATURE_E2E"))

const validSamples = Array.from({ length: 3 }, (_, index) => ({
  session: `session-${index + 1}`,
  workflow: `workflow-${index + 1}`,
  runtime_version: "OpenCode 2.0.20",
  ui_pct: 40 + index,
  runtime_pct: 40 + index,
  delta_pp: 0,
  timestamp: `2026-10-01T00:0${index}:00Z`,
}))
const validEvidenceResult = runEvidenceGate({
  "plan8-live-ui-evidence.json": { status: "PASS", samples: validSamples },
  "plan8-rotation-evidence.json": {
    status: "PASS",
    workflow: "workflow-rotation-1",
    session: "session-rotation-1",
    rotation: "COMMITTED",
    restore: "RESTORED",
    reconcile: "IDEMPOTENT",
    reviewer: "PASS",
  },
  "plan11-business-feature-e2e.json": {
    status: "PASS",
    independent_repo: "ruoyi-vue-pro",
    feature: "production-feature",
    test: "PASS",
    reviewer: "PASS",
    commit: "abc1234",
  },
})
assert.ok(!validEvidenceResult.missing.includes("PLAN8_DESKTOP_UI_SAMPLES"))
assert.ok(!validEvidenceResult.missing.includes("PLAN8_ROTATION_EVIDENCE"))
assert.ok(!validEvidenceResult.missing.includes("PRODUCTION_BUSINESS_FEATURE_E2E"))
console.log("PLAN11_PRODUCTION_GATE_BLOCKED", JSON.stringify({ missing: result.missing, architecture: result.checks.architecture.status, plan9: result.checks.plan9 }))
