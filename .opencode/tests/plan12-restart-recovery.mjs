import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { initializeControlPlaneDatabase, appendWorkflowConfigSnapshot, appendWorkflowRun, appendWorkflowWave, appendWorkflowWaveNode } from "../lib/plan12-control-plane.ts"
import { makeFacts } from "./plan12-control-plane-fixtures.mjs"

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "plan12-2-restart-"))
const dbPath = path.join(fixture, "runtime", "control-plane.db")

try {
  const facts = makeFacts("restart")
  const first = initializeControlPlaneDatabase({ dbPath, runtimeRoot: fixture, allowedRoots: [fixture] })
  assert.equal(appendWorkflowConfigSnapshot(first, facts.snapshot).ok, true)
  assert.equal(appendWorkflowRun(first, facts.run).ok, true)
  assert.equal(appendWorkflowWave(first, facts.wave).ok, true)
  first.close()

  const child = spawnSync(process.execPath, [
    "--experimental-strip-types",
    "--input-type=module",
    "-e",
    "import path from 'node:path'; import { initializeControlPlaneDatabase } from './.opencode/lib/plan12-control-plane.ts'; const root=path.dirname(path.dirname(process.env.PLAN12_DB)); const store=initializeControlPlaneDatabase({dbPath:process.env.PLAN12_DB,runtimeRoot:root,allowedRoots:[root]}); const run=store.getWorkflowRun(process.env.PLAN12_RUN); const waves=store.listWorkflowWaves({run_id:process.env.PLAN12_RUN}); console.log(JSON.stringify({run_id:run?.run_id,waves:waves.length})); store.close()",
  ], {
    cwd: path.resolve("."),
    env: { ...process.env, PLAN12_DB: dbPath, PLAN12_RUN: facts.run.run_id },
    encoding: "utf8",
  })
  assert.equal(child.status, 0, child.stderr)
  assert.deepEqual(JSON.parse(child.stdout.trim()), { run_id: facts.run.run_id, waves: 1 })

  const second = initializeControlPlaneDatabase({ dbPath, runtimeRoot: fixture, allowedRoots: [fixture] })
  assert.equal(appendWorkflowWaveNode(second, facts.node).ok, true)
  assert.equal(second.listWorkflowWaveNodes({ run_id: facts.run.run_id }).length, 1)
  second.close()
  console.log("PLAN12_RESTART_RECOVERY_PASS")
} finally {
  try { fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }) } catch {}
}
