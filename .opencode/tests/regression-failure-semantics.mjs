import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { summarizeRegressionStatus } from "../../tools/regression/status.mjs"

const cases = [
  { name: "all checks pass", input: { failure: false, releaseBlocked: false }, expected: { status: "PASS", release_gate: "RELEASE_READY" } },
  { name: "required check fails", input: { failure: true, releaseBlocked: false }, expected: { status: "FAIL", release_gate: "NOT_READY" } },
  { name: "later checks are unexecuted after failure", input: { failure: true, releaseBlocked: false }, expected: { status: "FAIL", release_gate: "NOT_READY" } },
  { name: "release gate blocks", input: { failure: false, releaseBlocked: true }, expected: { status: "BLOCKED", release_gate: "NOT_READY" } },
  { name: "failure and release gate block", input: { failure: true, releaseBlocked: true }, expected: { status: "FAIL", release_gate: "NOT_READY" } },
]

for (const testCase of cases) assert.deepEqual(summarizeRegressionStatus(testCase.input), testCase.expected, testCase.name)

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const runner = path.join(repositoryRoot, "tools/regression/run.mjs")
const fixtureRoot = mkdtempSync(path.join(tmpdir(), "regression-cli-negative-"))

function writeFixture(name, contents) {
  const pathname = path.join(fixtureRoot, name)
  writeFileSync(pathname, contents, "utf8")
  return pathname
}

function runCli(manifest) {
  const result = spawnSync(process.execPath, [runner, "--manifest", manifest], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true,
  })
  assert.equal(result.error, undefined, `runner process error: ${result.error?.message ?? "unknown"}`)
  const lines = String(result.stdout ?? "").split(/\r?\n/).filter(Boolean)
  assert.ok(lines.length > 0, `runner produced no stdout: ${result.stderr ?? ""}`)
  return { result, summary: JSON.parse(lines.at(-1)) }
}

try {
  const failScript = writeFixture("fail.mjs", "console.error('intentional fixture failure'); process.exit(17)\n")
  const marker = path.join(fixtureRoot, "should-not-run.txt")
  const afterFailureScript = writeFixture(
    "after-failure.mjs",
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed");\n`,
  )
  const failureManifest = writeFixture(
    "failure-manifest.mjs",
    `export const REGRESSION_CHECKS = [
      { id: "intentional-failure", command: process.execPath, args: [${JSON.stringify(failScript)}] },
      { id: "must-not-run", command: process.execPath, args: [${JSON.stringify(afterFailureScript)}] },
    ]\n`,
  )
  const failed = runCli(failureManifest)
  assert.equal(failed.result.status, 1, "failed regression CLI must exit 1")
  assert.equal(failed.summary.schema_version, 1)
  assert.equal(failed.summary.status, "FAIL")
  assert.equal(failed.summary.release_gate, "NOT_READY")
  assert.deepEqual(failed.summary.checks.map((check) => check.id), ["intentional-failure"], "runner must fail fast")
  assert.equal(failed.summary.checks[0].exit_code, 17)
  assert.throws(() => readFileSync(marker), { code: "ENOENT" }, "a check after failure must remain unexecuted")

  const blockedGateScript = writeFixture(
    "blocked-gate.mjs",
    `console.log(JSON.stringify({ framework_v1: "NOT_READY", missing: ["NEGATIVE_FIXTURE"] }))\n`,
  )
  const blockedManifest = writeFixture(
    "blocked-manifest.mjs",
    `export const REGRESSION_CHECKS = [
      { id: "intentional-block", command: process.execPath, args: [${JSON.stringify(blockedGateScript)}], release_gate: true },
    ]\n`,
  )
  const blocked = runCli(blockedManifest)
  assert.equal(blocked.result.status, 2, "blocked regression CLI must exit 2")
  assert.equal(blocked.summary.schema_version, 1)
  assert.equal(blocked.summary.status, "BLOCKED")
  assert.equal(blocked.summary.release_gate, "NOT_READY")
  assert.deepEqual(blocked.summary.checks.map((check) => check.status), ["BLOCKED"])
  assert.deepEqual(blocked.summary.checks[0].missing, ["NEGATIVE_FIXTURE"])
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true })
}

console.log("REGRESSION_FAILURE_SEMANTICS_PASS")
