// Lifecycle Engine — OpenCode V2 local plugin (Plan 8 T5A)
//
// Purpose: expose the shared lifecycle core (.opencode/lib/lifecycle-core.ts,
// Plan 8 T4) as EXACTLY five production tools under the `lifecycle`
// namespace:
//
//   lifecycle_status     — per-session lifecycle + telemetry + rotation view
//   lifecycle_list       — latest-generation lifecycle overview (read-only)
//   lifecycle_checkpoint — ensure a v1 checkpoint file (atomic write)
//   lifecycle_rotate     — manual/forced session generation rotation
//   lifecycle_reconcile  — crash resolution of incomplete rotations
//
// Follows the Plan 6/7 shared-core plugin pattern (task-bus/index.ts,
// workflow-engine/index.ts): this file creates ONE runtime core (canonical
// runtime-registry/schema.sql + this plugin's lifecycle schema.sql, both
// applied idempotently by the core on the shared runtime/tasks.db), creates
// the lifecycle core on top of it, and registers thin tool wrappers. ALL
// lifecycle logic lives in the core; nothing is re-implemented here and no
// tool is a test hook.
//
// Authority boundaries (inherited from lifecycle-core — do not claim more):
// - Architecture source of truth: diagrams/multi_agent_framework_v3_workspace.drawio
// - Telemetry protocol (normative): docs/runtime-context-telemetry.md —
//   verified measurements only (ctx.session.context last-assistant tokens +
//   ctx.model.list limit.context); NO estimation, NO defaults. Missing
//   measurements surface as nulls, never as fabricated numbers.
// - Threshold bands: framework-config/lifecycle.yaml, read FRESH by the core
//   on every evaluation (the 60/70/80 bands are never hardcoded here).
// - Checkpoint contract: templates/checkpoint.schema.json v1; instances live
//   under runtime/checkpoints/<sanitized-session-key>/gen-XXXX-<id>.json.
// - Manual lifecycle API plus observation-only context/compaction hooks (T5C):
//   hooks never rotate or block prompts; automatic rotation remains disabled.
// - Mem0 is never called (checkpoints carry mem0 restore REFERENCES only);
//   git access inside the core is strictly read-only.
//
// Locking: ensureCheckpoint / rotateSession / reconcileRotations acquire the
// PROCESS-GLOBAL per-session_key lock (.opencode/lib/global-lock.ts) INSIDE
// the core, and that lock is NON-REENTRANT — the wrappers below therefore
// never call core.withLock(...) around them (that would deadlock). The shared
// lock chain is the same one the runtime/task/workflow plugins use, so a
// rotation can never interrupt a running prompt/send on the same key.
//
// Runtime facts verified on this machine: Bun 1.4.2, bun:sqlite, Bun.YAML.parse.
// Plain-object default export (V2 reads `id` + `setup()` directly; no SDK
// import — the @opencode/plugin package is not installed in this environment).

import * as fs from "node:fs"
import * as path from "node:path"
import { createRuntimeRegistryCore } from "../../lib/runtime-registry-core.ts"
import { createLifecycleCore } from "../../lib/lifecycle-core.ts"
import { registerLifecycleObservationHooks, disposeLifecycleObservationHooks } from "../../lib/lifecycle-hooks.ts"
import { createLifecycleTestHooks, testHooksEnabled, PHASES } from "./hooks.ts"

// Managed registry roles addressable via the project_id + role -> session_key
// shorthand (runtime-registry-core ROLE_KEYS: project:<pid>:main|reader).
// Scoped sessions (e.g. workflow:<id>:planner) are addressed by passing their
// session_key verbatim instead.
const MANAGED_ROLES = ["project-main", "project-reader"]

const REASON_MAX_CHARS = 200 // rotation reason recorded in the ledger/events
const EVENTS_LIMIT_DEFAULT = 10 // lifecycle_status recent_events default
const EVENTS_LIMIT_MAX = 100 // never unbounded (the core clamps too)

function str(v: any): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null
}

// Mirrors the shared cores' failure(...) shape so every tool result carries
// ONE consistent error contract, whether produced here or in the core.
function invalidInput(detail: string) {
  return { ok: false, status: "ERROR", code: "INVALID_INPUT", detail }
}

export default {
  id: "lifecycle-engine",
  async setup(ctx: any) {
    // --- ONE runtime core, canonical schemas (Plan 8 T3 storage) ---
    // schemaFile: the canonical runtime-registry/schema.sql (registry_meta /
    //   sessions v2 / tasks). The sibling copy is passed only when it actually
    //   exists; otherwise the core falls back to its own root-resolved
    //   canonical path — the same file in a normal install.
    // lifecycleSchemaFile: THIS plugin's schema.sql (lifecycle_events /
    //   lifecycle_rotations, all CREATE ... IF NOT EXISTS), applied
    //   idempotently by the core on the same runtime/tasks.db handle. The
    //   lifecycle core itself never opens a database and never ALTERs a table.
    const registrySchemaFile = path.join(import.meta.dir, "..", "runtime-registry", "schema.sql")
    const core = createRuntimeRegistryCore(ctx, {
      ...(fs.existsSync(registrySchemaFile) ? { schemaFile: registrySchemaFile } : {}),
      lifecycleSchemaFile: path.join(import.meta.dir, "schema.sql"),
    })
    // --- lifecycle core (Plan 8 T4): all telemetry / threshold / checkpoint /
    // rotation / reconcile logic. Shares core.db (one handle, one lifecycle).
    const lifecycleTestHooks = testHooksEnabled(core.root) ? createLifecycleTestHooks(core.db) : null
    const lifecycle = createLifecycleCore(ctx, core, { testHooks: lifecycleTestHooks })
    const observationHooks = await registerLifecycleObservationHooks(ctx, lifecycle, core)

    // ===================================================================
    // Wrapper-side safe validation (defense in depth: the core re-validates
    // everything; these checks only fail fast with the same error contract
    // and never coerce ambiguous input).
    // ===================================================================

    // session_key (verbatim, project or scoped) OR project_id+role managed
    // shorthand — same resolution precedence as the core's resolveKey().
    function selectSession(input: any): { ok: true; value: Record<string, any> } | { ok: false; value: any } {
      const sessionKey = str(input?.session_key)
      const projectId = str(input?.project_id)
      const role = str(input?.role)
      if (sessionKey) return { ok: true, value: { session_key: sessionKey } }
      if (projectId && role) {
        if (!MANAGED_ROLES.includes(role)) {
          return {
            ok: false,
            value: invalidInput(
              `role '${role}' is not a managed registry role (${MANAGED_ROLES.join(" | ")}); ` +
                "scoped sessions must be addressed by their session_key verbatim",
            ),
          }
        }
        return { ok: true, value: { project_id: projectId, role } }
      }
      if (projectId || role) {
        return {
          ok: false,
          value: invalidInput("project_id and role must be provided together (managed-role shorthand), or provide session_key"),
        }
      }
      return { ok: false, value: invalidInput("either session_key (verbatim) or project_id + role is required") }
    }

    // force is honored ONLY as literal true — no truthy coercion.
    function bool(v: any): boolean {
      return v === true
    }

    // events_limit: integer in [1, EVENTS_LIMIT_MAX]; absent -> core default.
    function eventsLimit(v: any): number | undefined {
      if (v == null || v === "") return undefined
      const n = typeof v === "number" ? v : Number.parseInt(String(v), 10)
      if (!Number.isFinite(n)) return EVENTS_LIMIT_DEFAULT
      return Math.min(Math.max(Math.trunc(n), 1), EVENTS_LIMIT_MAX)
    }

    // Every wrapper returns { content: JSON.stringify(result) }; an unexpected
    // throw degrades to the shared failure contract instead of surfacing a
    // raw tool exception.
    async function result(fn: () => any): Promise<{ content: string }> {
      try {
        return { content: JSON.stringify(await fn()) }
      } catch (e: any) {
        return {
          content: JSON.stringify({
            ok: false,
            status: "ERROR",
            code: "PLUGIN_UNEXPECTED_ERROR",
            detail: e?.message ?? String(e),
          }),
        }
      }
    }

    // Shared strict JSON Schema fragments (additionalProperties:false on every
    // tool input below; no free-form objects anywhere).
    const sessionKeyProp = {
      type: "string",
      description:
        "sessions.session_key verbatim (e.g. 'project:ruoyi-vue-pro:main', or a scoped key such as " +
        "'workflow:<id>:planner'). Takes precedence over project_id+role.",
    }
    const projectIdProp = {
      type: "string",
      description:
        "Project id from framework-config/projects.yaml (managed-role shorthand; resolved with role to " +
        "project:<id>:main|reader). Alternative selector to session_key.",
    }
    const roleProp = {
      type: "string",
      enum: MANAGED_ROLES,
      description: "Managed registry role for the project_id shorthand (project-main | project-reader).",
    }

    // ===================================================================
    // Tool registration: EXACTLY five production tools, namespace
    // `lifecycle` — no more, no less, no test hook tool.
    // ===================================================================
    await ctx.tool.transform((editor: any) => {
      editor.namespace({
        name: "lifecycle",
        description:
          "Lifecycle Engine (Plan 8): verified context telemetry (never estimated), threshold bands from " +
          "framework-config/lifecycle.yaml, atomic v1 checkpoints, manual session generation rotation with " +
          "synthetic handoff, and crash reconciliation of incomplete rotations — on the shared runtime/tasks.db. " +
          "Manual API only: nothing rotates automatically (framework.yaml automatic_lifecycle_rotation stays false).",
      })

      editor.add({
        name: "lifecycle_status",
        description:
          "Full lifecycle status of ONE session's latest registered generation: registry row (status + " +
          "lifecycle_state), stored verified telemetry (context_tokens/limit/pct, source, timestamp), threshold " +
          "band evaluation against a FRESH read of framework-config/lifecycle.yaml (band, recommended_action, " +
          "band_state — no hardcoded bands), checkpoint presence (path + exists), last and incomplete rotation " +
          "from the lifecycle_rotations ledger, and recent lifecycle_events. Read-only by default; refresh=true " +
          "first takes a fresh verified measurement via ctx.session.context + ctx.model.list (that path writes " +
          "the telemetry columns and one TELEMETRY_SAMPLE event). Unverified context values are returned as " +
          "null — never estimated. Target the session by session_key (verbatim) or by project_id+role.",
        input: {
          type: "object",
          properties: {
            session_key: sessionKeyProp,
            project_id: projectIdProp,
            role: roleProp,
            refresh: {
              type: "boolean",
              description:
                "true = take a fresh verified telemetry measurement first (writes telemetry columns + one " +
                "TELEMETRY_SAMPLE event); false/omitted = pure read of the last stored verified sample",
            },
            events_limit: {
              type: "integer",
              minimum: 1,
              maximum: EVENTS_LIMIT_MAX,
              description: `Maximum recent lifecycle_events to include (default ${EVENTS_LIMIT_DEFAULT}, max ${EVENTS_LIMIT_MAX})`,
            },
          },
          additionalProperties: false,
        },
        options: { namespace: "lifecycle" },
        execute: (input: any) =>
          result(() => {
            const sel = selectSession(input)
            if (!sel.ok) return sel.value
            const args: any = { ...sel.value, refresh: bool(input?.refresh) }
            const limit = eventsLimit(input?.events_limit)
            if (limit != null) args.events_limit = limit
            return lifecycle.getLifecycleStatus(args)
          }),
      })

      editor.add({
        name: "lifecycle_list",
        description:
          "List the latest generation per session_key with the Plan 8 lifecycle view: registry status, " +
          "lifecycle_state, verified telemetry (context_tokens/limit/pct, telemetry_source, telemetry_at), " +
          "checkpoint_path, replaced_by, and the last rotation summary from lifecycle_rotations. Pure read-only " +
          "database view — never writes, never triggers a model request, never returns conversation content. " +
          "Optional equality filters: session_key / project_id / role (role matches the stored sessions.role " +
          "value, including scoped roles such as planner or feature-executor).",
        input: {
          type: "object",
          properties: {
            session_key: { type: "string", description: "Filter: exact sessions.session_key (verbatim)" },
            project_id: { type: "string", description: "Filter: exact project id" },
            role: {
              type: "string",
              description:
                "Filter: exact stored sessions.role value (project-main, project-reader, or a scoped role " +
                "like planner / feature-executor)",
            },
          },
          additionalProperties: false,
        },
        options: { namespace: "lifecycle" },
        execute: (input: any) =>
          result(() => {
            const filters: any = {}
            const sk = str(input?.session_key)
            if (sk) filters.session_key = sk
            const pid = str(input?.project_id)
            if (pid) filters.project_id = pid
            const role = str(input?.role)
            if (role) filters.role = role
            return lifecycle.listLifecycle(filters)
          }),
      })

      editor.add({
        name: "lifecycle_checkpoint",
        description:
          "Ensure a checkpoint file exists for a session's latest generation (templates/checkpoint.schema.json " +
          "v1, atomic tmp+fsync+rename write to runtime/checkpoints/<sanitized-key>/gen-XXXX-<id>.json). " +
          "'Ensure' semantics: an existing checkpoint file for the latest generation is REUSED unless " +
          "force=true. A fresh checkpoint requires verified context telemetry (ctx.session.context + " +
          "ctx.model.list) and fails with CHECKPOINT_TELEMETRY_UNAVAILABLE instead of estimating; it contains a " +
          "bounded redacted summary (never a full transcript, never tool outputs), active task/workflow refs, " +
          "read-only git state (branch/HEAD/status --porcelain) and restore refs (project docs + mem0 REFERENCE " +
          "strings only — Mem0 is never called). On success records sessions.checkpoint_path, sets " +
          "lifecycle_state CHECKPOINT_READY (band-writable states only) and appends a CHECKPOINT_WRITTEN event. " +
          "Serialized under the process-global session_key lock; target by session_key or project_id+role.",
        input: {
          type: "object",
          properties: {
            session_key: sessionKeyProp,
            project_id: projectIdProp,
            role: roleProp,
            force: {
              type: "boolean",
              description: "true = always write a fresh checkpoint (rotation does this internally); false/omitted = reuse an existing one",
            },
          },
          additionalProperties: false,
        },
        options: { namespace: "lifecycle" },
        execute: (input: any) =>
          result(() => {
            const sel = selectSession(input)
            if (!sel.ok) return sel.value
            return lifecycle.ensureCheckpoint({ ...sel.value, force: bool(input?.force) })
          }),
      })

      editor.add({
        name: "lifecycle_rotate",
        description:
          "Rotate a session generation (the MANUAL Plan 8 rotation API): forced fresh checkpoint -> successor " +
          "OpenCode session (create -> switchAgent -> resolve the configured runtime model, falling back to the stored " +
          "model_runtime_id -> synthetic " +
          "ROTATION_HANDOFF message built from the checkpoint file) -> register the successor row (status " +
          "ACTIVE, lifecycle_state HANDOFF_READY) -> archive the old generation (replaced_by + checkpoint_path " +
          "set) -> rotation COMMITTED. Progress is persisted phase-by-phase in lifecycle_rotations " +
          "(PREPARING/SUCCESSOR_CREATED/INITIALIZED/COMMITTED/FAILED). Without force=true the rotation is " +
          "refused unless the stored verified context_pct is at or above rotate_after_atomic_step_at_percent " +
          "(ROTATION_NOT_DUE / ROTATION_TELEMETRY_UNAVAILABLE); force=true is an explicit manual rotation. " +
          "Never creates a second successor while an incomplete rotation exists (ROTATION_IN_PROGRESS -> run " +
          "lifecycle_reconcile first). On ANY failure the old generation stays ACTIVE and serviceable " +
          "(lifecycle_state ROTATION_FAILED); a created-but-uninitialized successor is kept for audit and never " +
          "deleted. Runs under the process-global session_key lock, so it can never interrupt a running " +
          "prompt/send on the same key. The optional reason string (max " +
          `${REASON_MAX_CHARS} chars) is recorded in the rotation ledger/events.`,
        input: {
          type: "object",
          properties: {
            session_key: sessionKeyProp,
            project_id: projectIdProp,
            role: roleProp,
            force: {
              type: "boolean",
              description:
                "true = explicit manual rotation regardless of the stored context band; false/omitted = rotate " +
                "only when verified context_pct >= rotate_after_atomic_step_at_percent",
            },
            reason: {
              type: "string",
              description: `Optional human-readable rotation reason recorded in the ledger (max ${REASON_MAX_CHARS} chars; default 'manual')`,
            },
          },
          additionalProperties: false,
        },
        options: { namespace: "lifecycle" },
        execute: (input: any) =>
          result(() => {
            const sel = selectSession(input)
            if (!sel.ok) return sel.value
            const args: any = { ...sel.value, force: bool(input?.force) }
            const reason = str(input?.reason)
            if (reason) args.reason = reason.slice(0, REASON_MAX_CHARS)
            return lifecycle.rotateSession(args)
          }),
      })

      editor.add({
        name: "lifecycle_reconcile",
        description:
          "Crash recovery for the rotation ledger: resolves every incomplete rotation (status PREPARING / " +
          "SUCCESSOR_CREATED / INITIALIZED). Rules: COMMIT only when the successor generation row is already " +
          "registered and matches the ledger's successor session id; otherwise ABANDON safely " +
          "(rotation FAILED, old generation stays ACTIVE with lifecycle_state ROTATION_FAILED). Never creates a " +
          "new successor and never deletes a session — half-initialized successors are kept for audit. Each " +
          "affected session_key is processed under the process-global lock and every rotation row is re-read " +
          "inside the lock. Without session_key ALL incomplete rotations are scanned; returns per-rotation " +
          "resolutions (COMMITTED / FAILED / SKIPPED) plus counts.",
        input: {
          type: "object",
          properties: {
            session_key: {
              type: "string",
              description: "Optional sessions.session_key (verbatim) to restrict reconciliation to one key; omitted = scan all",
            },
          },
          additionalProperties: false,
        },
        options: { namespace: "lifecycle" },
        execute: (input: any) =>
          result(() => {
            const sk = str(input?.session_key)
            return lifecycle.reconcileRotations(sk ? { session_key: sk } : {})
          }),
      })

      // Test-only surface. The marker is checked once during setup; normal
      // production loads register exactly the five tools above.
      if (lifecycleTestHooks) {
        editor.add({
          name: "lifecycle_test_hook",
          description: "TEST-ONLY marker-gated lifecycle fixture hook; never available without runtime/.lifecycle-test-hooks.",
          input: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["seed_telemetry", "force_phase_failure", "clear", "list"] },
              session_key: { type: "string" },
              tokens: { type: "number" },
              limit: { type: "number" },
              pct: { type: "number" },
              phase: { type: "string", enum: [...PHASES] },
              times: { type: "integer", minimum: 1 },
            },
            required: ["action"],
            additionalProperties: false,
          },
          options: { namespace: "lifecycle" },
          execute: (input: any) => result(() => lifecycleTestHooks.execute(input)),
        })
      }
    })

    const d = lifecycle.diagnostics
    console.log(
      `[lifecycle-engine] loaded root=${core.root} db=${core.db ? "ok" : "unavailable:" + core.dbError} ` +
        `lifecycle-schema=${core.schemaMigration?.lifecycle_schema_applied ? "applied" : "skipped:" + (core.schemaMigration?.lifecycle_schema_skipped_reason ?? "unknown")} ` +
        `lifecycle-tables=${d.lifecycle_tables_ready} telemetry-columns=${d.telemetry_columns_ready} ` +
      `tasks-table=${d.tasks_table_ready} workflows-table=${d.workflows_table_ready} config=${core.configReady} tools=${lifecycleTestHooks ? 6 : 5}`,
    )

    // Teardown: close the ONE shared runtime core (it owns the runtime/tasks.db
    // handle). The lifecycle core never opens its own database, so there is
    // nothing else to close.
    return async () => {
      await disposeLifecycleObservationHooks(observationHooks)
      core.close()
    }
  },
}
