// Runtime Session Registry — OpenCode V2 local plugin (Plan 5, refactored by Plan 6 Phase 2)
//
// Purpose: give project-main / project-reader stable, reusable runtime sessions
// backed by a SQLite registry at runtime/tasks.db (git-ignored).
//
// Plan 6 Phase 2: all core logic (root resolution, SQLite open, schema init,
// YAML config load, project lookup, runtime_id parse, model resolve, session
// ensure/send/list/get/archive, per-session_key lock) now lives in the shared
// core at ../../lib/runtime-registry-core.ts so the future Task Bus plugin can
// reuse it. This file ONLY creates the core and registers the five `runtime`
// tools as thin wrappers. Tool names, input schemas, return structures and
// error semantics are unchanged from Plan 5.
//
// Authority boundaries:
// - Architecture source of truth: diagrams/multi_agent_framework_v3_workspace.drawio
// - Runtime data source: framework-config/projects.yaml + framework-config/agents.yaml
//   (read fresh on every call; nothing project- or model-specific is hardcoded here)
//
// Runtime facts verified on this machine (desktop 2.0.19): Bun 1.4.2,
// bun:sqlite (SQLite 3.53.2), Bun.YAML.parse. Plain-object default export is
// used because V2 reads `id` + `setup()` from the default export directly and
// the @opencode/plugin package is not installed in this environment.

import * as path from "node:path"
import { createRuntimeRegistryCore } from "../../lib/runtime-registry-core.ts"
import { createLifecycleCore } from "../../lib/lifecycle-core.ts"
import { wireLifecyclePreflight } from "../../lib/lifecycle-preflight.ts"

export default {
  id: "runtime-registry",
  async setup(ctx: any) {
    // Creates root/db/schema/config state synchronously — same init timing and
    // idempotency as the Plan 5 inline implementation (CREATE TABLE IF NOT
    // EXISTS + registry_meta upsert). schema.sql stays next to this plugin.
    const core = createRuntimeRegistryCore(ctx, {
      schemaFile: path.join(import.meta.dir, "schema.sql"),
      lifecycleSchemaFile: path.join(import.meta.dir, "..", "lifecycle-engine", "schema.sql"),
    })
    const lifecycle = createLifecycleCore(ctx, core)
    wireLifecyclePreflight(core, lifecycle)

    // --- tool registration (plan §23: exactly these five tools, namespace `runtime`) ---
    await ctx.tool.transform((editor: any) => {
      editor.namespace({
        name: "runtime",
        description:
          "Runtime Session Registry (Plan 5): persistent project-main / project-reader sessions backed by runtime/tasks.db",
      })
      editor.add({
        name: "session_ensure",
        description:
          "Ensure the persistent runtime session for a project role (project-main | project-reader). " +
          "Creates the session on first use (agent + configured model + scope context) and reuses the registered " +
          "OpenCode session afterwards. Returns MODEL_UNASSIGNED without creating a session when framework-config " +
          "has no runtime_id for that project/role. Never sends a prompt.",
        input: {
          type: "object",
          properties: {
            project_id: { type: "string", description: "Project id from framework-config/projects.yaml, e.g. ruoyi-vue-pro" },
            role: { type: "string", enum: ["project-main", "project-reader"] },
          },
          required: ["project_id", "role"],
          additionalProperties: false,
        },
        options: { namespace: "runtime" },
        execute: async (input: any) => ({
          content: JSON.stringify(await core.withLock(core.sessionKey(String(input.project_id), String(input.role)), () =>
            core.ensure(input.project_id, input.role),
          )),
        }),
      })
      editor.add({
        name: "session_send",
        description:
          "Send a durable prompt to a project's persistent runtime session (ensures it first), wait for completion " +
          "and return the last assistant result. Prefer this over disposable subagents for project-scoped reading " +
          "(role=project-reader) and project coordination (role=project-main) so context is reused across tasks.",
        input: {
          type: "object",
          properties: {
            project_id: { type: "string", description: "Project id from framework-config/projects.yaml, e.g. ruoyi-vue-pro" },
            role: { type: "string", enum: ["project-main", "project-reader"] },
            text: { type: "string", description: "The task/instruction text to send to the persistent session" },
          },
          required: ["project_id", "role", "text"],
          additionalProperties: false,
        },
        options: { namespace: "runtime" },
        execute: async (input: any) => ({
          content: JSON.stringify(await core.withLock(core.sessionKey(String(input.project_id), String(input.role)), () =>
            core.send(input.project_id, input.role, input.text),
          )),
        }),
      })
      editor.add({
        name: "session_list",
        description:
          "List the current registry sessions (latest generation per session key) with project, role, session id, " +
          "generation, agent, model, status and last_used_at. Never returns conversation content.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: "runtime" },
        execute: async () => ({ content: JSON.stringify(core.list()) }),
      })
      editor.add({
        name: "session_get",
        description:
          "Read one registry entry by project_id + role (latest generation), including status, generation, model " +
          "and replaced_by. Registry read only; never triggers a model request.",
        input: {
          type: "object",
          properties: {
            project_id: { type: "string" },
            role: { type: "string", enum: ["project-main", "project-reader"] },
          },
          required: ["project_id", "role"],
          additionalProperties: false,
        },
        options: { namespace: "runtime" },
        execute: async (input: any) => ({ content: JSON.stringify(core.get(input.project_id, input.role)) }),
      })
      editor.add({
        name: "session_archive",
        description:
          "Mark the current registry session for project_id + role as ARCHIVED. The underlying OpenCode session is " +
          "kept (not deleted) for manual inspection; the next runtime_session_ensure creates generation + 1.",
        input: {
          type: "object",
          properties: {
            project_id: { type: "string" },
            role: { type: "string", enum: ["project-main", "project-reader"] },
          },
          required: ["project_id", "role"],
          additionalProperties: false,
        },
        options: { namespace: "runtime" },
        execute: async (input: any) => ({
          content: JSON.stringify(await core.withLock(core.sessionKey(String(input.project_id), String(input.role)), () =>
            core.archive(input.project_id, input.role),
          )),
        }),
      })
    })

    console.log(`[runtime-registry] loaded root=${core.root} db=${core.db ? "ok" : "unavailable:" + core.dbError} config=${core.configReady}`)

    return () => {
      core.close()
    }
  },
}
