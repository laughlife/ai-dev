import fs from "node:fs"
import assert from "node:assert/strict"

const source = fs.readFileSync(new URL("../plugins/lifecycle-engine/index.ts", import.meta.url), "utf8")
assert.match(source, /name:\s*"lifecycle_restore"/)
assert.match(source, /lifecycle\.restoreSession\(/)
assert.match(source, /checkpoint_path/)
console.log("PLAN8_LIFECYCLE_RESTORE_TOOL_CONTRACT_PASS")
