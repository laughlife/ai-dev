// Runtime Session Registry — OpenCode V2 local plugin (Plan 5)
//
// Purpose: give project-main / project-reader stable, reusable runtime sessions
// backed by a SQLite registry at runtime/tasks.db (git-ignored).
//
// Authority boundaries:
// - Architecture source of truth: diagrams/multi_agent_framework_v3_workspace.drawio
// - Runtime data source: framework-config/projects.yaml + framework-config/agents.yaml
//   (read fresh on every call; nothing project- or model-specific is hardcoded here)
//
// Plan 5 scope: ensure / send / list / get / archive only.
// NOT implemented: full Task Bus, DAG scheduling, automatic lifecycle rotation,
// automatic checkpointing, drawio parsing. The `tasks` table is schema-only.
//
// Runtime facts verified on this machine (desktop 2.0.19): Bun 1.4.2,
// bun:sqlite (SQLite 3.53.2), Bun.YAML.parse. Plain-object default export is
// used because V2 reads `id` + `setup()` from the default export directly and
// the @opencode/plugin package is not installed in this environment.

import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import * as path from "node:path"

const SCHEMA_VERSION = "1"
const WAIT_TIMEOUT_MS = 15 * 60 * 1000

// role -> session_key suffix (plan §16: project:<project-id>:main|reader)
const ROLE_KEYS: Record<string, string> = {
  "project-main": "main",
  "project-reader": "reader",
}

function nowIso(): string {
  return new Date().toISOString()
}

function errMsg(e: any): string {
  return e?.message ?? String(e)
}

function failure(code: string, detail: string, extra?: Record<string, unknown>) {
  return { ok: false, status: "ERROR", code, detail, ...(extra ?? {}) }
}

// "openai/gpt-5.6-sol-fast#high" -> { providerID: "openai", id: "gpt-5.6-sol-fast", variant: "high" }
// Only parses already-validated runtime_id values from framework-config; never guesses models.
function parseRuntimeId(runtimeId: unknown): { providerID: string; id: string; variant?: string } | null {
  if (typeof runtimeId !== "string" || !runtimeId.includes("/")) return null
  const slash = runtimeId.indexOf("/")
  const providerID = runtimeId.slice(0, slash)
  const rest = runtimeId.slice(slash + 1)
  const hash = rest.indexOf("#")
  if (hash < 0) return { providerID, id: rest }
  const variant = rest.slice(hash + 1)
  return variant ? { providerID, id: rest.slice(0, hash), variant } : { providerID, id: rest.slice(0, hash) }
}

export default {
  id: "runtime-registry",
  async setup(ctx: any) {
    // --- resolve framework root (the directory containing framework-config/) ---
    let root: string = ctx?.location?.directory ?? process.cwd()
    for (let i = 0; i < 6; i++) {
      if (fs.existsSync(path.join(root, "framework-config", "projects.yaml"))) break
      const parent = path.dirname(root)
      if (parent === root) break
      root = parent
    }
    const projectsFile = path.join(root, "framework-config", "projects.yaml")
    const agentsFile = path.join(root, "framework-config", "agents.yaml")
    const configReady = fs.existsSync(projectsFile) && fs.existsSync(agentsFile)

    // --- SQLite registry via Bun built-in (plan §14: no third-party sqlite package) ---
    const runtimeDir = path.join(root, "runtime")
    let db: any = null
    let dbError: string | null = null
    try {
      fs.mkdirSync(runtimeDir, { recursive: true })
      db = new Database(path.join(runtimeDir, "tasks.db"))
      db.exec("PRAGMA journal_mode = WAL;")
      const schemaSql = fs.readFileSync(path.join(import.meta.dir, "schema.sql"), "utf8")
      db.exec(schemaSql)
      db.query(
        "INSERT INTO registry_meta (key, value) VALUES ('schema_version', ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(SCHEMA_VERSION)
    } catch (e: any) {
      db = null
      dbError = errMsg(e)
    }

    const q = db
      ? {
          latest: db.query(
            "SELECT * FROM sessions WHERE session_key = ? ORDER BY generation DESC LIMIT 1",
          ),
          insert: db.query(
            "INSERT INTO sessions (session_key, project_id, role, opencode_session_id, generation, " +
              "agent_id, model_runtime_id, project_path, status, checkpoint_path, created_at, last_used_at, replaced_by) " +
              "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          ),
          touch: db.query(
            "UPDATE sessions SET last_used_at = ? WHERE session_key = ? AND generation = ?",
          ),
          markStatus: db.query(
            "UPDATE sessions SET status = ?, last_used_at = ? WHERE session_key = ? AND generation = ?",
          ),
          linkReplaced: db.query(
            "UPDATE sessions SET replaced_by = ?, last_used_at = ? WHERE session_key = ? AND generation = ?",
          ),
          current: db.query(
            "SELECT s.session_key, s.project_id, s.role, s.opencode_session_id, s.generation, " +
              "s.agent_id, s.model_runtime_id, s.status, s.last_used_at " +
              "FROM sessions s JOIN (SELECT session_key, MAX(generation) AS g FROM sessions GROUP BY session_key) m " +
              "ON s.session_key = m.session_key AND s.generation = m.g " +
              "ORDER BY s.project_id, s.role, s.generation",
          ),
        }
      : null

    // --- config access (plan §17: read framework-config, never hardcode) ---
    function loadConfig() {
      const B = (globalThis as any).Bun
      if (typeof B?.YAML?.parse !== "function") {
        throw new Error("YAML_PARSER_UNAVAILABLE: Bun.YAML.parse is not present in this runtime")
      }
      return {
        projects: B.YAML.parse(fs.readFileSync(projectsFile, "utf8")),
        agents: B.YAML.parse(fs.readFileSync(agentsFile, "utf8")),
      }
    }

    function findProject(cfg: any, projectId: string) {
      const list = cfg?.projects?.projects
      if (!Array.isArray(list)) return null
      return list.find((p: any) => p?.id === projectId) ?? null
    }

    function resolveRoleModel(cfg: any, projectId: string, role: string): string | null {
      if (role === "project-reader") {
        const list = cfg?.agents?.agents
        if (!Array.isArray(list)) return null
        const agent = list.find((a: any) => a?.id === "project-reader")
        const rid = agent?.model?.runtime_id
        return typeof rid === "string" && rid ? rid : null
      }
      // project-main: model comes from project_sessions.<project>.model.runtime_id
      const rid = cfg?.agents?.project_sessions?.[projectId]?.model?.runtime_id
      return typeof rid === "string" && rid ? rid : null
    }

    // --- initial scope context (plan §22), written as a synthetic message ---
    function initialContext(projectId: string, projectPath: string, role: string): string {
      if (role === "project-main") {
        return [
          `PROJECT_ID: ${projectId}`,
          `PROJECT_PATH: ${projectPath}`,
          "ROLE: PROJECT_MAIN",
          "",
          "Rules:",
          "- only coordinate this project",
          "- root framework Git must not stage business project source",
          "- project Git operations must target the project repository explicitly",
          "- obey D:\\ai-dev\\AGENTS.md",
          "- no git pull",
          "- no git push",
          "- code implementation must go to Feature Executor",
          "",
          "(Synthetic scope context written by the runtime-registry plugin, Plan 5.)",
        ].join("\n")
      }
      return [
        `PROJECT_ID: ${projectId}`,
        `PROJECT_PATH: ${projectPath}`,
        "ROLE: PROJECT_READER",
        "",
        "Rules:",
        "- read-only",
        "- focus only on this project",
        "- maintain project reading context across requests",
        "- no code modifications",
        "- no DB write / DDL",
        "- no Mem0 write",
        "",
        "(Synthetic scope context written by the runtime-registry plugin, Plan 5.)",
      ].join("\n")
    }

    function guard() {
      if (!db || !q) return failure("SQLITE_RUNTIME_UNAVAILABLE", dbError ?? "registry database unavailable")
      if (!configReady) {
        return failure("CONFIG_ROOT_NOT_FOUND", `framework-config not found from root '${root}'`)
      }
      return null
    }

    function sessionKey(projectId: string, role: string): string {
      return `project:${projectId}:${ROLE_KEYS[role]}`
    }

    function rowToResult(row: any, reused: boolean) {
      return {
        ok: true,
        status: row.status,
        session_key: row.session_key,
        session_id: row.opencode_session_id,
        project_id: row.project_id,
        role: row.role,
        generation: row.generation,
        reused,
        agent_id: row.agent_id,
        model_runtime_id: row.model_runtime_id,
        project_path: row.project_path,
        created_at: row.created_at,
        last_used_at: row.last_used_at,
      }
    }

    // --- core: ensure (plan §20/§21) ---
    async function ensure(projectId: any, role: any) {
      const g = guard()
      if (g) return g
      if (typeof projectId !== "string" || !projectId) return failure("INVALID_INPUT", "project_id is required")
      if (typeof role !== "string" || !ROLE_KEYS[role]) {
        return failure("ROLE_NOT_SUPPORTED", "role must be one of: project-main, project-reader")
      }

      let cfg: any
      try {
        cfg = loadConfig()
      } catch (e: any) {
        return failure("CONFIG_LOAD_FAILED", errMsg(e))
      }
      const project = findProject(cfg, projectId)
      if (!project) {
        return failure("PROJECT_NOT_FOUND", `project '${projectId}' is not registered in framework-config/projects.yaml`)
      }
      const projectPath = typeof project.path === "string" ? project.path : ""
      const key = sessionKey(projectId, role)

      const runtimeId = resolveRoleModel(cfg, projectId, role)
      if (!runtimeId) {
        // plan §20.3 / §39: no configured runtime_id -> refuse, never guess, never inherit
        return {
          ok: false,
          status: "MODEL_UNASSIGNED",
          session_key: key,
          project_id: projectId,
          role,
          session_created: false,
          detail:
            role === "project-main"
              ? `agents.yaml project_sessions.${projectId}.model.runtime_id is null; refusing to create a session or guess a model`
              : "agents.yaml project-reader.model.runtime_id is missing; refusing to create a session or guess a model",
        }
      }
      const model = parseRuntimeId(runtimeId)
      if (!model) return failure("RUNTIME_ID_UNPARSEABLE", `cannot parse runtime_id '${runtimeId}'`)

      const latest: any = q.latest.get(key)
      if (latest && latest.status === "ACTIVE") {
        let alive = true
        try {
          await ctx.session.get({ sessionID: latest.opencode_session_id })
        } catch {
          alive = false
        }
        if (alive) {
          q.touch.run(nowIso(), key, latest.generation)
          return rowToResult({ ...latest, last_used_at: nowIso() }, true)
        }
        // registry record exists but the OpenCode session is gone -> STALE, generation + 1
        q.markStatus.run("STALE", nowIso(), key, latest.generation)
      }

      const prevGeneration = latest ? (latest.generation as number) : 0
      const generation = prevGeneration + 1
      const title = `[runtime] ${projectId} ${role} gen${generation}`
      let sessionID: string
      try {
        // plan §19: session location stays at the framework root (plugin location),
        // project scoping is done via registry fields + synthetic scope context.
        const info: any = await ctx.session.create({ title })
        sessionID = info?.id ?? info?.sessionID
        if (!sessionID) throw new Error("session create returned no id")
      } catch (e: any) {
        return failure("SESSION_CREATE_FAILED", errMsg(e))
      }

      try {
        // plan §20.8: switchAgent -> role profile, switchModel -> configured runtime model
        await ctx.session.switchAgent({ sessionID, agent: role })
        const modelRef: any = { providerID: model.providerID, id: model.id }
        if (model.variant) modelRef.variant = model.variant
        await ctx.session.switchModel({ sessionID, model: modelRef })
        await ctx.session.synthetic({ sessionID, text: initialContext(projectId, projectPath, role) })
      } catch (e: any) {
        return failure("SESSION_INIT_FAILED", `${errMsg(e)} (session ${sessionID} was created but initialization failed)`, {
          session_id: sessionID,
        })
      }

      const ts = nowIso()
      q.insert.run(key, projectId, role, sessionID, generation, role, runtimeId, projectPath, "ACTIVE", null, ts, ts, null)
      if (latest) q.linkReplaced.run(sessionID, ts, key, prevGeneration)

      return {
        ok: true,
        status: "ACTIVE",
        session_key: key,
        session_id: sessionID,
        project_id: projectId,
        role,
        generation,
        reused: false,
        agent_id: role,
        model_runtime_id: runtimeId,
        project_path: projectPath,
        created_at: ts,
        last_used_at: ts,
      }
    }

    // --- core: send (plan §25: durable prompt, wait, extract last assistant result) ---
    async function send(projectId: any, role: any, text: any) {
      const g = guard()
      if (g) return g
      if (typeof text !== "string" || !text.trim()) return failure("INVALID_INPUT", "text is required")
      const ensured: any = await ensure(projectId, role)
      if (!ensured.ok) return ensured
      const sessionID = ensured.session_id
      const key = ensured.session_key
      try {
        await ctx.session.prompt({ sessionID, text })
        let timer: any
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("WAIT_TIMEOUT")), WAIT_TIMEOUT_MS)
        })
        try {
          await Promise.race([ctx.session.wait({ sessionID }), timeout])
        } finally {
          clearTimeout(timer)
        }
        const contextRes: any = await ctx.session.context({ sessionID })
        const messages: any[] = Array.isArray(contextRes) ? contextRes : (contextRes?.messages ?? [])
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i]
          if (m?.type !== "assistant") continue
          const parts: any[] = Array.isArray(m.content) ? m.content : []
          const resultText = parts
            .filter((p: any) => p?.type === "text" && typeof p.text === "string")
            .map((p: any) => p.text)
            .join("\n")
            .trim()
          q.touch.run(nowIso(), key, ensured.generation)
          if (resultText) {
            return {
              ok: true,
              status: "OK",
              session_key: key,
              session_id: sessionID,
              generation: ensured.generation,
              reused_session: ensured.reused,
              result: resultText,
            }
          }
          return {
            ok: false,
            status: "NO_ASSISTANT_TEXT",
            session_key: key,
            session_id: sessionID,
            generation: ensured.generation,
            result: null,
            detail: "the last assistant message contained no text part",
          }
        }
        return {
          ok: false,
          status: "NO_ASSISTANT_RESULT",
          session_key: key,
          session_id: sessionID,
          generation: ensured.generation,
          result: null,
        }
      } catch (e: any) {
        return failure("SEND_FAILED", errMsg(e), { session_id: sessionID, generation: ensured.generation })
      }
    }

    // --- core: list / get / archive (plan §26-§28) ---
    function list() {
      const g = guard()
      if (g) return g
      const rows: any[] = q.current.all()
      return {
        ok: true,
        status: "OK",
        count: rows.length,
        sessions: rows.map((r) => ({
          project: r.project_id,
          role: r.role,
          session_id: r.opencode_session_id,
          generation: r.generation,
          agent: r.agent_id,
          model: r.model_runtime_id,
          status: r.status,
          last_used_at: r.last_used_at,
          session_key: r.session_key,
        })),
      }
    }

    function get(projectId: any, role: any) {
      const g = guard()
      if (g) return g
      if (typeof role !== "string" || !ROLE_KEYS[role]) {
        return failure("ROLE_NOT_SUPPORTED", "role must be one of: project-main, project-reader")
      }
      if (typeof projectId !== "string" || !projectId) return failure("INVALID_INPUT", "project_id is required")
      const key = sessionKey(projectId, role)
      const row: any = q.latest.get(key)
      if (!row) return { ok: false, status: "NOT_FOUND", session_key: key, project_id: projectId, role }
      // registry read only; never triggers a model request
      return {
        ok: true,
        status: row.status,
        session_key: row.session_key,
        session_id: row.opencode_session_id,
        project_id: row.project_id,
        role: row.role,
        generation: row.generation,
        agent_id: row.agent_id,
        model_runtime_id: row.model_runtime_id,
        project_path: row.project_path,
        checkpoint_path: row.checkpoint_path,
        created_at: row.created_at,
        last_used_at: row.last_used_at,
        replaced_by: row.replaced_by,
      }
    }

    function archive(projectId: any, role: any) {
      const g = guard()
      if (g) return g
      if (typeof role !== "string" || !ROLE_KEYS[role]) {
        return failure("ROLE_NOT_SUPPORTED", "role must be one of: project-main, project-reader")
      }
      if (typeof projectId !== "string" || !projectId) return failure("INVALID_INPUT", "project_id is required")
      const key = sessionKey(projectId, role)
      const row: any = q.latest.get(key)
      if (!row) return { ok: false, status: "NOT_FOUND", session_key: key, project_id: projectId, role }
      if (row.status === "ARCHIVED") {
        return {
          ok: true,
          status: "ALREADY_ARCHIVED",
          session_key: key,
          session_id: row.opencode_session_id,
          generation: row.generation,
        }
      }
      // plan §28: mark ARCHIVED only; the OpenCode session is intentionally NOT deleted.
      q.markStatus.run("ARCHIVED", nowIso(), key, row.generation)
      return {
        ok: true,
        status: "ARCHIVED",
        session_key: key,
        session_id: row.opencode_session_id,
        generation: row.generation,
        opencode_session_deleted: false,
        note: "OpenCode session kept for manual inspection; the next runtime_session_ensure creates generation + 1",
      }
    }

    // --- per-session_key serialization to avoid racing ensure/send/archive ---
    const chains = new Map<string, Promise<any>>()
    function withLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
      const prev = chains.get(key) ?? Promise.resolve()
      const run = prev.then(() => fn())
      chains.set(key, run.then(
        () => undefined,
        () => undefined,
      ))
      return run
    }

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
          content: JSON.stringify(await withLock(sessionKey(String(input.project_id), String(input.role)), () =>
            ensure(input.project_id, input.role),
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
          content: JSON.stringify(await withLock(sessionKey(String(input.project_id), String(input.role)), () =>
            send(input.project_id, input.role, input.text),
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
        execute: async () => ({ content: JSON.stringify(list()) }),
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
        execute: async (input: any) => ({ content: JSON.stringify(get(input.project_id, input.role)) }),
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
          content: JSON.stringify(await withLock(sessionKey(String(input.project_id), String(input.role)), () =>
            archive(input.project_id, input.role),
          )),
        }),
      })
    })

    console.log(`[runtime-registry] loaded root=${root} db=${db ? "ok" : "unavailable:" + dbError} config=${configReady}`)

    return () => {
      try {
        db?.close()
      } catch {}
    }
  },
}
