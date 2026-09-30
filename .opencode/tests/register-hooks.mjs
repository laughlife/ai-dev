// Node module hooks: redirect the Bun-only `bun:sqlite` specifier to the
// node:sqlite adapter so the production TypeScript cores can be imported
// unmodified under Node 24.
//
// Usage: node --import ./.opencode/tests/register-hooks.mjs <entry.mjs>

import { registerHooks } from "node:module"
import * as path from "node:path"
import { pathToFileURL } from "node:url"

const shimUrl = pathToFileURL(path.join(import.meta.dirname, "bun-sqlite-shim.mjs")).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "bun:sqlite") {
      return { url: shimUrl, format: "module", shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})
