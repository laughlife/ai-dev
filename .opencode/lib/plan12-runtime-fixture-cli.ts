#!/usr/bin/env node
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  extractPlan12ToolEvidence,
  initializePlan12RuntimeFixture,
  normalizePlan12RuntimeModelRef,
  PLAN12_REQUIRED_RUNTIME_TOOLS,
  resolvePlan12FixtureRoleModel,
  runPlan12OpenCodeCli,
  type Plan12VerifiedRuntimeProbe,
} from "./plan12-runtime-fixture.ts"
import { sha256Canonical } from "./plan12-contract.ts"

type AnyRecord = Record<string, any>

function fail(code: string, detail: string): never {
  process.stderr.write(`${JSON.stringify({ ok: false, status: "BLOCKED", code, detail })}\n`)
  process.exit(2)
}

function parseArgs(argv: string[]): { command: string; values: Map<string, string[]> } {
  const command = argv[0] ?? ""
  const values = new Map<string, string[]>()
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key.startsWith("--")) fail("CLI_ARGUMENT_INVALID", `unexpected argument '${key}'`)
    const value = argv[index + 1]
    if (!value || value.startsWith("--")) fail("CLI_ARGUMENT_MISSING", `${key} requires a value`)
    values.set(key.slice(2), [...(values.get(key.slice(2)) ?? []), value])
    index += 1
  }
  return { command, values }
}

function one(values: Map<string, string[]>, key: string, required = true): string | null {
  const found = values.get(key) ?? []
  if (found.length > 1) fail("CLI_ARGUMENT_DUPLICATE", `--${key} may be supplied once`)
  if (required && found.length === 0) fail("CLI_ARGUMENT_REQUIRED", `--${key} is required`)
  return found[0] ?? null
}

function unwrap(value: any): any { return value && typeof value === "object" && Object.hasOwn(value, "data") ? value.data : value }

function opencodeApi(runtimeRoot: string, method: string, apiPath: string, data?: AnyRecord): any {
  const args = ["api", method, apiPath, "--header", `x-opencode-directory:${runtimeRoot}`]
  if (data !== undefined) args.push("--data", JSON.stringify(data))
  const result = runPlan12OpenCodeCli(args, runtimeRoot)
  if (result.error) throw new Error(`DESKTOP_CLI_EXECUTION_FAILED:${result.error.message}`)
  const stdout = String(result.stdout ?? "").trim()
  if (result.status !== 0) throw new Error(`DESKTOP_CLI_REQUEST_FAILED:opencode api ${method} ${apiPath} exited ${result.status}: ${String(result.stderr ?? stdout).trim().slice(0, 500)}`)
  if (!stdout) return null
  try { return JSON.parse(stdout) } catch { throw new Error(`DESKTOP_CLI_RESPONSE_INVALID:non-JSON response from ${apiPath}`) }
}

export function extractVerifiedProbeFromDesktopResponses(input: {
  targetModelRef: string
  runtimeRoot: string
  serverInfo: AnyRecord
  plugins: any
  session: any
  messages: any
  expectedText: string
  observedAt?: string
  endpoint?: string
}): Plan12VerifiedRuntimeProbe {
  const assistants = (Array.isArray(unwrap(input.messages)) ? unwrap(input.messages) : []).filter((message: any) => message?.type === "assistant")
  const response = assistants.at(-1)
  const responseText = Array.isArray(response?.content) ? response.content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n").trim() : ""
  if (!input.expectedText || responseText !== input.expectedText) throw new Error("RUNTIME_PROBE_CHALLENGE_MISMATCH")
  if (response?.agent !== "project-reader") throw new Error(`RUNTIME_PROBE_AGENT_IDENTITY_MISMATCH:${response?.agent ?? "missing"}`)
  const provider = typeof response?.model?.providerID === "string" ? response.model.providerID.trim() : ""
  const modelId = typeof response?.model?.id === "string" ? response.model.id.trim() : ""
  const variant = typeof response?.model?.variant === "string" ? response.model.variant.trim() : ""
  const rawActual = provider && modelId ? `${provider}/${modelId}${variant ? `#${variant}` : ""}` : ""
  const actual = rawActual ? normalizePlan12RuntimeModelRef(rawActual) : ""
  const target = normalizePlan12RuntimeModelRef(input.targetModelRef)
  if (!actual || actual !== target) throw new Error(`RUNTIME_PROBE_IDENTITY_MISMATCH:${rawActual || "missing"}`)
  const session = unwrap(input.session)
  if (typeof response?.id !== "string" || !response.id || typeof session?.id !== "string" || !session.id) throw new Error("RUNTIME_PROBE_RESPONSE_IDENTITY_MISSING")
  if (session.agent !== "project-reader") throw new Error(`RUNTIME_PROBE_SESSION_IDENTITY_MISMATCH:${session.agent ?? "missing"}`)
  const sessionModel = session?.model?.providerID && session?.model?.id ? `${session.model.providerID}/${session.model.id}${session.model.variant ? `#${session.model.variant}` : ""}` : ""
  if (!sessionModel || normalizePlan12RuntimeModelRef(sessionModel) !== target) throw new Error(`RUNTIME_PROBE_SESSION_IDENTITY_MISMATCH:${sessionModel || "missing"}`)
  if (typeof session?.location?.directory !== "string" || path.resolve(session.location.directory).toLowerCase() !== path.resolve(input.runtimeRoot).toLowerCase()) throw new Error(`RUNTIME_PROBE_SESSION_LOCATION_MISMATCH:${session?.location?.directory ?? "missing"}`)
  const plugins = Array.isArray(unwrap(input.plugins)) ? unwrap(input.plugins) : []
  const workflowPlugin = plugins.find((plugin: any) => plugin?.id === "workflow-engine" && plugin?.features?.server === true && plugin?.state?.status === "active")
  if (!workflowPlugin) throw new Error("RUNTIME_PROBE_WORKFLOW_PLUGIN_MISSING")
  const toolEvidence = extractPlan12ToolEvidence(input.messages, { agent: "project-reader", modelRef: target })
  const completed = typeof response?.time?.completed === "number" ? new Date(response.time.completed).toISOString() : null
  if (!completed) throw new Error("RUNTIME_PROBE_RESPONSE_TIME_MISSING")
  const runtimeVersion = String(unwrap(input.serverInfo)?.version ?? "").trim()
  if (!runtimeVersion) throw new Error("RUNTIME_PROBE_RUNTIME_VERSION_MISSING")
  return {
    runtime_version: runtimeVersion,
    provider,
    model_id: modelId,
    exact_model_ref: actual,
    workflow_plugin_loaded: true,
    tools: Object.fromEntries(PLAN12_REQUIRED_RUNTIME_TOOLS.map((tool) => [tool, Boolean(toolEvidence[tool])])),
    probe_status: "AVAILABLE",
    availability_state: "AVAILABLE",
    observed_at: input.observedAt ?? new Date().toISOString(),
    evidence_source: "opencode-cli:authenticated-target-response",
    endpoint: input.endpoint ?? "desktop-cli://opencode-api",
    probe_id: `desktop-probe-${crypto.randomUUID()}`,
    probe_kind: "authenticated_desktop_target_call",
    authenticated_transport: "opencode-cli-managed-auth",
    requested_model_ref: target,
    response_model_ref: actual,
    response_session_id: session.id,
    response_message_id: response.id,
    response_completed_at: completed,
    challenge: input.expectedText,
    response_text_sha256: sha256Canonical(responseText),
    response_agent: response.agent,
    raw_response_model_ref: rawActual,
    session_location: session.location.directory,
    tool_evidence: toolEvidence,
  }
}

export function runAuthenticatedDesktopTargetProbe(runtimeRoot: string): Plan12VerifiedRuntimeProbe {
  const root = fs.realpathSync(path.resolve(runtimeRoot))
  const target = resolvePlan12FixtureRoleModel(root, "project-reader").runtimeId
  const slash = target.indexOf("/")
  const hash = target.indexOf("#", slash + 1)
  const model = { providerID: target.slice(0, slash), id: target.slice(slash + 1, hash < 0 ? undefined : hash), ...(hash < 0 ? {} : { variant: target.slice(hash + 1) }) }
  const info = opencodeApi(root, "get", "/api/info")
  const plugins = opencodeApi(root, "get", "/api/plugin")
  const session = unwrap(opencodeApi(root, "post", "/api/session", { title: `[plan12-target-probe] project-reader ${Date.now()}`, agent: "project-reader", model, location: { directory: root } }))
  const sessionId = session?.id
  if (typeof sessionId !== "string" || !sessionId) fail("DESKTOP_PROBE_SESSION_CREATE_FAILED", "Desktop returned no session id")
  const challenge = `PLAN12_TARGET_PROBE_${crypto.randomUUID()}`
  const invalidId = `plan12-probe-invalid-${crypto.randomUUID()}`
  const invalidProject = `plan12-probe-invalid-${crypto.randomUUID()}`
  const calls = [
    { tool: "workflow_list", input: { limit: 1 } },
    { tool: "workflow_get", input: { workflow_id: invalidId } },
    { tool: "workflow_run", input: { workflow_id: invalidId } },
    { tool: "workflow_plan", input: { primary_project_id: invalidProject, objective: "capability probe; reject invalid project before writes" } },
    { tool: "workflow_execute", input: { primary_project_id: invalidProject, objective: "capability probe; reject invalid project before writes" } },
  ]
  const prompt = [
    "This is a no-side-effect registered-tool capability probe using Desktop Code Mode.",
    "Call the execute tool exactly five times. Each execute call must use exactly one of the following code strings, unchanged; do not call workflow tools directly, combine calls, add helpers, or transform returns:",
    ...calls.map(({ tool, input }) => `execute(${JSON.stringify({ code: `return await tools.workflow.${tool}(${JSON.stringify(input)});` })})`),
    `After all five tool responses, your final text must be exactly ${challenge}`,
  ].join("\n")
  opencodeApi(root, "post", `/api/session/${encodeURIComponent(sessionId)}/prompt`, { text: prompt })
  opencodeApi(root, "post", `/api/experimental/session/${encodeURIComponent(sessionId)}/wait`)
  const verifiedSession = opencodeApi(root, "get", `/api/session/${encodeURIComponent(sessionId)}`)
  const messages = opencodeApi(root, "get", `/api/session/${encodeURIComponent(sessionId)}/message?type=assistant&order=asc`)
  return extractVerifiedProbeFromDesktopResponses({ targetModelRef: target, runtimeRoot: root, serverInfo: info, plugins, session: verifiedSession, messages, expectedText: challenge })
}

function writeJson(file: string, value: any): void {
  const target = path.resolve(file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" })
}

function initialize(values: Map<string, string[]>, probe: Plan12VerifiedRuntimeProbe): AnyRecord {
  const runtimeRoot = one(values, "runtime-root")!
  const dbPath = one(values, "db-path")!
  const allowedRoots = values.get("allowed-root") ?? []
  if (allowedRoots.length === 0) fail("CLI_ARGUMENT_REQUIRED", "at least one --allowed-root is required")
  const fixture = initializePlan12RuntimeFixture({
    runtimeRoot,
    frameworkRoot: runtimeRoot,
    dbPath,
    allowedRoots,
    runtimeProbe: probe,
    configRevision: one(values, "config-revision", false) ?? undefined,
    projectScope: one(values, "project-scope", false) ?? "ruoyi-vue-pro",
  })
  const result = {
    ok: true,
    status: "INITIALIZED",
    db_path: fixture.dbPath,
    path_envelope: fixture.pathEnvelope,
    config_revision: fixture.configRevision,
    model_ref: fixture.modelRef,
    fingerprints: fixture.fingerprints,
    evidence_classification: fixture.evidenceClassification,
    plan: fixture.plan,
  }
  fixture.store.close()
  return result
}

async function main(): Promise<void> {
  const { command, values } = parseArgs(process.argv.slice(2))
  if (command === "probe") {
    const probe = runAuthenticatedDesktopTargetProbe(one(values, "runtime-root")!)
    const output = one(values, "output")!
    writeJson(output, probe)
    process.stdout.write(`${JSON.stringify({ ok: true, status: "PROBED", output: path.resolve(output), exact_model_ref: probe.exact_model_ref, response_session_id: probe.response_session_id, response_message_id: probe.response_message_id })}\n`)
    return
  }
  if (command === "init") {
    const probeFile = one(values, "probe-file")!
    const probe = JSON.parse(fs.readFileSync(path.resolve(probeFile), "utf8"))
    process.stdout.write(`${JSON.stringify(initialize(values, probe))}\n`)
    return
  }
  if (command === "probe-init") {
    const probe = runAuthenticatedDesktopTargetProbe(one(values, "runtime-root")!)
    const probeOutput = one(values, "probe-output")!
    writeJson(probeOutput, probe)
    process.stdout.write(`${JSON.stringify({ ...initialize(values, probe), probe_output: path.resolve(probeOutput) })}\n`)
    return
  }
  fail("CLI_COMMAND_INVALID", "command must be probe, init, or probe-init")
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => fail("PLAN12_FIXTURE_CLI_FAILED", error?.message ?? String(error)))
}
