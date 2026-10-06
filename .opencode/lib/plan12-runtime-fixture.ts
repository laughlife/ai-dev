import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { canonicalizePlan12Json, sha256Canonical } from "./plan12-contract.ts"
import { initializeControlPlaneDatabase, type ControlPlaneStore, type Plan12PathEnvelope } from "./plan12-control-plane.ts"
import { createConfigRevision, applyConfigRevision, transitionConfigRevision } from "./plan12-config-revision.ts"
import { appendModelCatalogEntry, appendRouteBinding, recordRuntimeProbe } from "./plan12-model-routes.ts"
import { parseDrawio } from "../../tools/architecture-sync/parser.ts"
import { canonicalJson, semanticHash } from "../../tools/architecture-sync/semantic-hash.ts"
import { parseYaml } from "../../tools/architecture-sync/yaml.ts"

type AnyRecord = Record<string, any>

export type Plan12VerifiedRuntimeProbe = {
  runtime_version: string
  provider: string
  model_id: string
  exact_model_ref: string
  workflow_plugin_loaded: boolean
  tools: Record<string, boolean> | string[]
  probe_status: string
  availability_state: string
  observed_at: string
  evidence_source: string
  endpoint?: string
  probe_id?: string
  probe_kind: "authenticated_desktop_target_call" | "synthetic_non_live"
  authenticated_transport?: "opencode-cli-managed-auth"
  requested_model_ref: string
  response_model_ref: string
  response_session_id: string
  response_message_id: string
  response_completed_at: string
  challenge: string
  response_text_sha256: string
  response_agent: string
  raw_response_model_ref: string
  session_location: string
  tool_evidence: Record<string, Plan12ToolEvidence>
}

export type Plan12ToolEvidence = {
  response_message_id: string
  tool_call_id: string
  channel: "code_mode_execute"
  registered_tool: string
  status: "completed" | "error"
  input_sha256: string
  execute_input_sha256: string
  response_sha256: string
  response_excerpt: string
}

export type Plan12ArchitectureFingerprints = {
  source_file: string
  drawio_raw_sha256: string
  drawio_semantic_sha256: string
  ir_sha256: string
}

function digest(value: AnyRecord): AnyRecord {
  const { payload_sha256: _ignored, ...body } = value
  return { ...body, payload_sha256: sha256Canonical(body) }
}
function operation(key: string): AnyRecord {
  return { actor: "plan12-runtime-fixture", reason: `initialize ${key}`, correlation_id: `${key}-correlation` }
}
function assertOk(value: any, operationName: string): any {
  if (!value?.ok) throw new Error(`${operationName}: ${value?.code ?? "REJECTED"}: ${value?.detail ?? "operation failed"}`)
  return value.value
}
function readYaml(file: string): any { return parseYaml(fs.readFileSync(file, "utf8")) ?? {} }
function parseRuntimeId(runtimeId: string): { provider: string; modelId: string; variant: string | null } {
  const match = /^([^/]+)\/([^#]+)(?:#([^#]+))?$/.exec(runtimeId)
  if (!match) throw new Error("ROLE_MODEL_RUNTIME_ID_INVALID")
  return { provider: match[1], modelId: match[2], variant: match[3] ?? null }
}

export const PLAN12_REQUIRED_RUNTIME_TOOLS = ["workflow_plan", "workflow_run", "workflow_execute", "workflow_get", "workflow_list"] as const

/** Desktop reports the implicit provider default as `#default`, while the
 * generated architecture intentionally omits it. They are the same formal
 * runtime identity; every non-default variant remains identity-significant. */
export function normalizePlan12RuntimeModelRef(runtimeId: string): string {
  const parsed = parseRuntimeId(runtimeId)
  return `${parsed.provider}/${parsed.modelId}${parsed.variant && parsed.variant !== "default" ? `#${parsed.variant}` : ""}`
}

function normalizedDirectory(directory: string): string {
  const resolved = path.resolve(directory)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

function textFromToolContent(content: any): string {
  if (!Array.isArray(content)) return ""
  return content.map((part: any) => typeof part?.text === "string" ? part.text : JSON.stringify(part)).join("\n").trim()
}

/** Derive availability only from persisted assistant tool response parts.
 * Advertising a plugin/tool is not evidence that the registered tool can be
 * called. Mutating workflow tools must use inputs that fail before writes. */
export function extractPlan12ToolEvidence(
  messagesValue: any,
  expected: { agent?: string; modelRef?: string } = {},
): Record<string, Plan12ToolEvidence> {
  const messages = Array.isArray(unwrapDesktop(messagesValue)) ? unwrapDesktop(messagesValue) : []
  const found = new Map<string, { evidence: Plan12ToolEvidence; input: AnyRecord; response: string }[]>()
  for (const message of messages) {
    if (message?.type !== "assistant" || typeof message?.id !== "string") continue
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (part?.type !== "tool" || part?.name !== "execute") continue
      const registeredCalls = Array.isArray(part?.state?.metadata?.toolCalls) ? part.state.metadata.toolCalls : []
      const requiredCalls = registeredCalls.filter((call: any) => typeof call?.tool === "string" && call.tool.startsWith("workflow.") && PLAN12_REQUIRED_RUNTIME_TOOLS.includes(call.tool.slice("workflow.".length)))
      if (requiredCalls.length === 0) continue
      if (registeredCalls.length !== 1 || requiredCalls.length !== 1) throw new Error("RUNTIME_PROBE_CODE_MODE_CALL_AMBIGUOUS")
      const registeredCall = requiredCalls[0]
      const tool = registeredCall.tool.slice("workflow.".length)
      if (expected.agent && message.agent !== expected.agent) throw new Error(`RUNTIME_PROBE_TOOL_AGENT_MISMATCH:${tool}`)
      if (expected.modelRef) {
        const messageModel = message?.model?.providerID && message?.model?.id ? `${message.model.providerID}/${message.model.id}${message.model.variant ? `#${message.model.variant}` : ""}` : ""
        if (!messageModel || normalizePlan12RuntimeModelRef(messageModel) !== normalizePlan12RuntimeModelRef(expected.modelRef)) throw new Error(`RUNTIME_PROBE_TOOL_MODEL_MISMATCH:${tool}`)
      }
      const status = part?.state?.status
      if (status !== "completed" || registeredCall.status !== "completed") throw new Error(`RUNTIME_PROBE_TOOL_RESPONSE_INVALID:${tool}`)
      const executeInput = part?.state?.input
      if (!executeInput || typeof executeInput !== "object" || Array.isArray(executeInput) || typeof executeInput.code !== "string" || !executeInput.code.trim()) throw new Error(`RUNTIME_PROBE_CODE_MODE_INPUT_INVALID:${tool}`)
      const input = registeredCall.input
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`RUNTIME_PROBE_TOOL_INPUT_UNSAFE:${tool}`)
      const directReturnCode = `return await tools.workflow.${tool}(${JSON.stringify(input)});`
      if (executeInput.code.trim() !== directReturnCode) throw new Error(`RUNTIME_PROBE_CODE_MODE_INPUT_INVALID:${tool}`)
      const response = textFromToolContent(part.state.content)
      if (!response) continue
      const evidence: Plan12ToolEvidence = {
        response_message_id: message.id,
        tool_call_id: String(part.id ?? ""),
        channel: "code_mode_execute",
        registered_tool: registeredCall.tool,
        status: "completed",
        input_sha256: sha256Canonical(input),
        execute_input_sha256: sha256Canonical(executeInput),
        response_sha256: sha256Canonical(response),
        response_excerpt: response.slice(0, 500),
      }
      if (!evidence.tool_call_id) continue
      found.set(tool, [...(found.get(tool) ?? []), { evidence, input, response }])
    }
  }
  for (const tool of PLAN12_REQUIRED_RUNTIME_TOOLS) {
    const entries = found.get(tool) ?? []
    if (entries.length !== 1) throw new Error(`RUNTIME_PROBE_TOOL_RESPONSE_INVALID:${tool}`)
    const input = entries[0].input
    let output: any = null
    try { output = JSON.parse(entries[0].response) } catch {}
    if (entries[0].evidence.status !== "completed" || !output || typeof output !== "object") throw new Error(`RUNTIME_PROBE_TOOL_RESPONSE_INVALID:${tool}`)
    if (tool === "workflow_list") {
      if (Object.keys(input).some((key) => !["limit"].includes(key)) || input.limit !== 1) throw new Error(`RUNTIME_PROBE_TOOL_INPUT_UNSAFE:${tool}`)
      if (output.ok !== true) throw new Error(`RUNTIME_PROBE_TOOL_RESPONSE_INVALID:${tool}`)
    } else if (tool === "workflow_get" || tool === "workflow_run") {
      if (typeof input.workflow_id !== "string" || !input.workflow_id.startsWith("plan12-probe-invalid-") || Object.keys(input).length !== 1) throw new Error(`RUNTIME_PROBE_TOOL_INPUT_UNSAFE:${tool}`)
      if (output.ok !== false || output.code !== "WORKFLOW_NOT_FOUND") throw new Error(`RUNTIME_PROBE_TOOL_RESPONSE_INVALID:${tool}`)
    } else {
      if (typeof input.primary_project_id !== "string" || !input.primary_project_id.startsWith("plan12-probe-invalid-") || typeof input.objective !== "string" || Object.keys(input).some((key) => !["primary_project_id", "objective"].includes(key))) throw new Error(`RUNTIME_PROBE_TOOL_INPUT_UNSAFE:${tool}`)
      if (output.ok !== false || output.code !== "PROJECT_NOT_FOUND") throw new Error(`RUNTIME_PROBE_TOOL_RESPONSE_INVALID:${tool}`)
    }
  }
  return Object.fromEntries(PLAN12_REQUIRED_RUNTIME_TOOLS.map((tool) => [tool, found.get(tool)![0].evidence]))
}

function unwrapDesktop(value: any): any { return value && typeof value === "object" && Object.hasOwn(value, "data") ? value.data : value }

export function resolvePlan12OpenCodeCliInvocation(
  args: string[],
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; exists?: (file: string) => boolean } = {},
): { command: string; args: string[] } {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const exists = options.exists ?? fs.existsSync
  if (platform !== "win32") return { command: "opencode", args }
  const desktopCli = path.join(env.LOCALAPPDATA ?? "", "Programs", "@opencodedesktop", "resources", "opencode-cli.exe")
  if (env.LOCALAPPDATA && exists(desktopCli)) return { command: desktopCli, args }
  const shim = (env.PATH ?? env.Path ?? "").split(path.delimiter)
    .map((entry) => path.join(entry, "opencode.ps1"))
    .find((candidate) => exists(candidate))
  if (!shim) throw new Error("DESKTOP_CLI_NOT_FOUND:opencode.ps1 is not present on PATH")
  // Windows PowerShell 5.1 strips the quotes inside JSON argv values before
  // invoking native programs. PowerShell 7 preserves each supplied argv item.
  return { command: "pwsh.exe", args: ["-NoProfile", "-NonInteractive", "-File", shim, ...args] }
}

export function runPlan12OpenCodeCli(args: string[], cwd: string): ReturnType<typeof spawnSync> {
  const invocation = resolvePlan12OpenCodeCliInvocation(args)
  return spawnSync(invocation.command, invocation.args, {
    cwd, encoding: "utf8", windowsHide: true, timeout: 120_000,
  })
}

function desktopApi(runtimeRoot: string, method: string, apiPath: string, data?: AnyRecord): any {
  const args = ["api", method, apiPath, "--header", `x-opencode-directory:${runtimeRoot}`]
  if (data !== undefined) args.push("--data", JSON.stringify(data))
  const result = runPlan12OpenCodeCli(args, runtimeRoot)
  if (result.error) throw new Error(`DESKTOP_CLI_EXECUTION_FAILED:${result.error.message}`)
  const stdout = String(result.stdout ?? "").trim()
  if (result.status !== 0) throw new Error(`DESKTOP_CLI_REQUEST_FAILED:${method} ${apiPath} exited ${result.status}: ${String(result.stderr ?? stdout).trim().slice(0, 500)}`)
  try { return stdout ? JSON.parse(stdout) : null } catch { throw new Error(`DESKTOP_CLI_RESPONSE_INVALID:${apiPath}`) }
}

/** Re-read the exact session/message from the authenticated Desktop CLI.
 * Serialized caller fields are never sufficient to enter AVAILABLE. */
function revalidateAuthenticatedDesktopProbe(runtimeRoot: string, probe: Plan12VerifiedRuntimeProbe): Plan12VerifiedRuntimeProbe {
  const info = unwrapDesktop(desktopApi(runtimeRoot, "get", "/api/info"))
  const plugins = unwrapDesktop(desktopApi(runtimeRoot, "get", "/api/plugin"))
  const session = unwrapDesktop(desktopApi(runtimeRoot, "get", `/api/session/${encodeURIComponent(probe.response_session_id)}`))
  const messages = unwrapDesktop(desktopApi(runtimeRoot, "get", `/api/session/${encodeURIComponent(probe.response_session_id)}/message?type=assistant&order=asc`))
  const response = (Array.isArray(messages) ? messages : []).find((message: any) => message?.id === probe.response_message_id)
  if (!response) throw new Error("RUNTIME_PROBE_RESPONSE_NOT_FOUND")
  if (response?.agent !== probe.response_agent || response.agent !== "project-reader") throw new Error("RUNTIME_PROBE_AGENT_IDENTITY_MISMATCH")
  const provider = typeof response?.model?.providerID === "string" ? response.model.providerID.trim() : ""
  const modelId = typeof response?.model?.id === "string" ? response.model.id.trim() : ""
  const variant = typeof response?.model?.variant === "string" ? response.model.variant.trim() : ""
  const rawActual = provider && modelId ? `${provider}/${modelId}${variant ? `#${variant}` : ""}` : ""
  const actual = rawActual ? normalizePlan12RuntimeModelRef(rawActual) : ""
  const text = Array.isArray(response?.content) ? response.content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n").trim() : ""
  const completed = typeof response?.time?.completed === "number" ? new Date(response.time.completed).toISOString() : ""
  const workflowPlugin = Array.isArray(plugins) && plugins.some((plugin: any) => plugin?.id === "workflow-engine" && plugin?.features?.server === true && plugin?.state?.status === "active")
  if (!workflowPlugin) throw new Error("RUNTIME_PROBE_WORKFLOW_PLUGIN_MISSING")
  if (session?.agent !== "project-reader" || normalizePlan12RuntimeModelRef(`${session?.model?.providerID ?? ""}/${session?.model?.id ?? ""}${session?.model?.variant ? `#${session.model.variant}` : ""}`) !== probe.requested_model_ref) throw new Error("RUNTIME_PROBE_SESSION_IDENTITY_MISMATCH")
  if (typeof session?.location?.directory !== "string" || normalizedDirectory(session.location.directory) !== normalizedDirectory(runtimeRoot) || normalizedDirectory(probe.session_location) !== normalizedDirectory(runtimeRoot)) throw new Error("RUNTIME_PROBE_SESSION_LOCATION_MISMATCH")
  if (String(info?.version ?? "") !== probe.runtime_version) throw new Error("RUNTIME_PROBE_REVALIDATION_MISMATCH:runtime_version")
  if (actual !== probe.requested_model_ref || actual !== probe.response_model_ref || actual !== probe.exact_model_ref) throw new Error("RUNTIME_PROBE_IDENTITY_MISMATCH")
  if (rawActual !== probe.raw_response_model_ref) throw new Error("RUNTIME_PROBE_REVALIDATION_MISMATCH:raw_response_model_ref")
  if (provider !== probe.provider || modelId !== probe.model_id || completed !== probe.response_completed_at) throw new Error("RUNTIME_PROBE_REVALIDATION_MISMATCH:response")
  if (text !== probe.challenge || sha256Canonical(text) !== probe.response_text_sha256) throw new Error("RUNTIME_PROBE_CHALLENGE_MISMATCH")
  const toolEvidence = extractPlan12ToolEvidence(messages, { agent: "project-reader", modelRef: probe.requested_model_ref })
  if (sha256Canonical(toolEvidence) !== sha256Canonical(probe.tool_evidence)) throw new Error("RUNTIME_PROBE_TOOL_EVIDENCE_MISMATCH")
  return probe
}

/** Resolve Project Reader through the complete architecture chain rather than
 * embedding a model in fixture code: Drawio model_key -> runtime model map ->
 * generated role entry. Any drift fails closed. */
export function resolvePlan12FixtureRoleModel(frameworkRoot: string, roleId = "project-reader"): { role: string; runtimeId: string; modelKey: string } {
  if (typeof frameworkRoot !== "string" || !frameworkRoot.trim()) throw new Error("FRAMEWORK_ROOT_REQUIRED")
  const root = fs.realpathSync(path.resolve(frameworkRoot))
  const ir = parseDrawio(path.join(root, "diagrams", "multi_agent_framework_v4_completion_guard.drawio"))
  const architectureRole = ir.agents.find((agent: any) => agent.id === roleId)
  if (!architectureRole?.model_key) throw new Error("ROLE_MODEL_ARCHITECTURE_MISSING")
  const runtimeMap = readYaml(path.join(root, "framework-config", "runtime-model-map.yaml"))
  const mappedRuntimeId = runtimeMap?.models?.[architectureRole.model_key]?.runtime_id
  const agents = readYaml(path.join(root, "framework-config", "agents.yaml"))
  const role = agents?.agents?.find((agent: any) => agent?.id === roleId)
  const generatedRuntimeId = role?.model?.runtime_id
  if (typeof mappedRuntimeId !== "string" || !mappedRuntimeId || typeof generatedRuntimeId !== "string" || !generatedRuntimeId) throw new Error("ROLE_MODEL_UNASSIGNED")
  if (mappedRuntimeId !== generatedRuntimeId) throw new Error("ROLE_MODEL_CONFIG_DRIFT")
  if (roleId === "project-reader" && generatedRuntimeId === "bailian-token-plan/qwen3.8-max") throw new Error("PROJECT_READER_QWEN_FALLBACK_FORBIDDEN")
  return { role: role.display_name ?? "Project Reader", runtimeId: generatedRuntimeId, modelKey: architectureRole.model_key }
}

/** Use the real Architecture Compiler parser/canonicalizer. ir_sha256 hashes
 * the compiler IR (including source provenance), while semantic_sha256 hashes
 * its architecture projection; neither value comes from sync-state or a
 * caller-provided placeholder. */
export function loadPlan12ArchitectureFingerprints(frameworkRoot: string): Plan12ArchitectureFingerprints {
  const root = fs.realpathSync(path.resolve(frameworkRoot))
  const source = path.join(root, "diagrams", "multi_agent_framework_v4_completion_guard.drawio")
  const ir = parseDrawio(source)
  const raw = crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex")
  if (ir?.source?.raw_sha256 !== raw) throw new Error("ARCHITECTURE_COMPILER_RAW_HASH_MISMATCH")
  return {
    source_file: source,
    drawio_raw_sha256: raw,
    drawio_semantic_sha256: semanticHash(ir),
    ir_sha256: crypto.createHash("sha256").update(canonicalJson(ir), "utf8").digest("hex"),
  }
}

function verifyProbe(probe: Plan12VerifiedRuntimeProbe, modelRef: string, _allowSyntheticNonLive: boolean): "AUTHENTICATED_DESKTOP" {
  // Synthetic evidence is useful only as parser input in contract tests. It
  // must never reach the persistence path below, where the snapshot, probe,
  // catalog and route are intentionally L3 / AVAILABLE / BOUND.
  if (probe?.probe_kind === "synthetic_non_live") throw new Error("RUNTIME_PROBE_SYNTHETIC_PERSISTENCE_FORBIDDEN")
  const requiredProbeFields = ["runtime_version", "provider", "model_id", "exact_model_ref", "observed_at", "evidence_source", "requested_model_ref", "response_model_ref", "response_session_id", "response_message_id", "response_completed_at", "challenge", "response_text_sha256", "response_agent", "raw_response_model_ref", "session_location"]
  if (requiredProbeFields.some((key) => typeof (probe as any)[key] !== "string" || !(probe as any)[key].trim())) throw new Error("RUNTIME_PROBE_INCOMPLETE")
  const normalizedModelRef = normalizePlan12RuntimeModelRef(modelRef)
  if (probe.requested_model_ref !== normalizedModelRef || probe.response_model_ref !== normalizedModelRef || probe.exact_model_ref !== normalizedModelRef || normalizePlan12RuntimeModelRef(probe.raw_response_model_ref) !== normalizedModelRef) throw new Error("RUNTIME_PROBE_IDENTITY_MISMATCH")
  if (!/^[a-f0-9]{64}$/.test(probe.response_text_sha256) || sha256Canonical(probe.challenge) !== probe.response_text_sha256) throw new Error("RUNTIME_PROBE_CHALLENGE_DIGEST_MISMATCH")
  const parsed = parseRuntimeId(normalizedModelRef)
  if (probe.provider !== parsed.provider || probe.model_id !== parsed.modelId) throw new Error("RUNTIME_PROBE_IDENTITY_MISMATCH")
  if (probe.response_agent !== "project-reader") throw new Error("RUNTIME_PROBE_AGENT_IDENTITY_MISMATCH")
  if (probe.probe_status !== "AVAILABLE" || probe.availability_state !== "AVAILABLE" || probe.workflow_plugin_loaded !== true) throw new Error("RUNTIME_PROBE_NOT_AVAILABLE")
  const availableTools = Array.isArray(probe.tools) ? new Set(probe.tools) : new Set(Object.keys(probe.tools ?? {}).filter((tool) => (probe.tools as Record<string, boolean>)[tool]))
  if (PLAN12_REQUIRED_RUNTIME_TOOLS.some((tool) => !availableTools.has(tool))) throw new Error("RUNTIME_PROBE_TOOLS_INCOMPLETE")
  if (!probe.tool_evidence || PLAN12_REQUIRED_RUNTIME_TOOLS.some((tool) => !probe.tool_evidence[tool]?.response_sha256)) throw new Error("RUNTIME_PROBE_TOOL_EVIDENCE_INCOMPLETE")
  if (probe.probe_kind === "authenticated_desktop_target_call") {
    if (probe.authenticated_transport !== "opencode-cli-managed-auth") throw new Error("RUNTIME_PROBE_AUTHENTICATION_REQUIRED")
    return "AUTHENTICATED_DESKTOP"
  }
  throw new Error("RUNTIME_PROBE_TARGET_CALL_REQUIRED")
}

/** Creates an isolated fixture only through production revision/model APIs.
 * Synthetic input is an explicit contract-test seam and is labelled NON-L3
 * LIVE in every returned/queryable envelope. */
export function initializePlan12RuntimeFixture(options: {
  dbPath: string
  runtimeRoot: string
  frameworkRoot?: string
  allowedRoots?: string[]
  configRevision?: string
  workflowId?: string
  routeBindingId?: string
  roleId?: string
  projectScope?: string
  includeXxlJob?: boolean
  runtimeProbe?: Plan12VerifiedRuntimeProbe
  verifiedProbe?: Plan12VerifiedRuntimeProbe
  observedAt?: string
  /** Legacy contract-test flag retained only so old callers fail with the
   * explicit synthetic-persistence error; it never enables persistence. */
  allowSyntheticNonLive?: boolean
}): { store: ControlPlaneStore; dbPath: string; pathEnvelope: Plan12PathEnvelope; configRevision: string; modelRef: string; routeBindingId: string; plan: AnyRecord; fingerprints: Plan12ArchitectureFingerprints; evidenceClassification: string } {
  if (typeof options.runtimeRoot !== "string" || !options.runtimeRoot.trim()) throw new Error("CONTROL_PLANE_DB_RUNTIME_ROOT_REQUIRED")
  const frameworkRoot = options.frameworkRoot ?? options.runtimeRoot
  const resolvedRole = resolvePlan12FixtureRoleModel(frameworkRoot, options.roleId ?? "project-reader")
  const revision = options.configRevision ?? "rev-r2"
  const routeBindingId = options.routeBindingId ?? "code_read"
  if (routeBindingId === "code_read" && (options.roleId ?? "project-reader") !== "project-reader") throw new Error("CODE_READ_ROUTE_ROLE_MISMATCH: code_read requires Project Reader")
  const projectScope = options.projectScope ?? "ruoyi-vue-pro"
  let probe = options.runtimeProbe ?? options.verifiedProbe
  if (!probe) throw new Error("RUNTIME_PROBE_REQUIRED")
  if (probe.probe_kind === "authenticated_desktop_target_call") probe = revalidateAuthenticatedDesktopProbe(fs.realpathSync(path.resolve(options.runtimeRoot)), probe)
  const classification = verifyProbe(probe, resolvedRole.runtimeId, options.allowSyntheticNonLive === true)
  if (options.observedAt !== undefined && options.observedAt !== probe.observed_at) throw new Error("RUNTIME_PROBE_TIME_MISMATCH")
  const observedAt = probe.observed_at
  const modelRef = resolvedRole.runtimeId
  const identity = parseRuntimeId(modelRef)
  const probeId = probe.probe_id ?? `probe-${revision}-${routeBindingId}`
  const catalogId = `catalog-${revision}-${routeBindingId}`
  const capabilities = { input: true, output: true }
  const model = {
    catalog_entry_id: catalogId, config_revision: revision, source: "runtime_probe", runtime_source: "runtime_probe",
    observed_at: observedAt, provider: identity.provider, provider_id: identity.provider, model_id: identity.modelId, variant: identity.variant, exact_model_ref: modelRef,
    display_name: modelRef, capability: capabilities, runtime_version: probe.runtime_version, first_seen_at: observedAt, last_seen_at: observedAt,
    probe_status: "AVAILABLE", availability_state: "AVAILABLE", metadata_sha256: sha256Canonical(capabilities), probe_error: null, probe_id: probeId,
    idempotency_key: `model-${revision}-${routeBindingId}`,
  }
  const route = {
    route_binding_id: routeBindingId, role: resolvedRole.role, workflow_scope: "global", project_scope: projectScope, lane: "default",
    provider: identity.provider, provider_id: identity.provider, model_id: identity.modelId, variant: identity.variant, exact_model_ref: modelRef, binding_state: "BOUND",
    config_revision: revision, source: "runtime_probe", reason: "verified Desktop target response identity", created_at: observedAt, updated_at: observedAt,
    idempotency_key: `route-${revision}-${routeBindingId}`,
  }
  const xxlRoute = {
    route_binding_id: "xxl-job-unassigned", role: "Project Reader", workflow_scope: "global", project_scope: "xxl-job", lane: "default",
    provider: null, provider_id: null, model_id: null, variant: null, exact_model_ref: null, binding_state: "MODEL_UNASSIGNED",
    config_revision: revision, source: "verified_config", reason: "xxl-job has no assigned Runtime model; Qwen fallback forbidden", created_at: observedAt, updated_at: observedAt,
    idempotency_key: `route-${revision}-xxl-job-unassigned`,
  }
  const snapshotPayload = { revision, model_catalog: [model], route_bindings: options.includeXxlJob === false ? [route] : [route, xxlRoute] }
  const fingerprints = loadPlan12ArchitectureFingerprints(frameworkRoot)
  const snapshot = digest({
    schema_version: 1, config_revision: revision, source: `plan12-runtime-fixture:${classification}`, observed_at: observedAt, evidence_level: "L3",
    fact_type: "workflow_config_snapshot", parent_revision: null, source_kind: "verified_config", drawio_raw_sha256: fingerprints.drawio_raw_sha256,
    drawio_semantic_sha256: fingerprints.drawio_semantic_sha256, ir_sha256: fingerprints.ir_sha256, config_digest: sha256Canonical(snapshotPayload),
    model_catalog_digest: sha256Canonical(snapshotPayload.model_catalog), route_bindings_digest: sha256Canonical(snapshotPayload.route_bindings),
    canonical_json: JSON.stringify(canonicalizePlan12Json(snapshotPayload)), state: "DRAFT", created_by: "plan12-runtime-fixture",
    created_at: observedAt, activated_at: null, rollback_of: null, idempotency_key: `snapshot-${revision}`,
  })
  const store = initializeControlPlaneDatabase({ dbPath: options.dbPath, runtimeRoot: options.runtimeRoot, allowedRoots: options.allowedRoots })
  if (!store.pathEnvelope) { store.close(); throw new Error("CONTROL_PLANE_PATH_ENVELOPE_REQUIRED") }
  try {
    assertOk(createConfigRevision(store, snapshot), "createConfigRevision")
    assertOk(transitionConfigRevision(store, { config_revision: revision, to_state: "VALIDATED", idempotency_key: `${revision}-validated`, ...operation(`${revision}-validated`) }), "validate revision")
    assertOk(transitionConfigRevision(store, { config_revision: revision, to_state: "STAGED", idempotency_key: `${revision}-staged`, ...operation(`${revision}-staged`) }), "stage revision")
    assertOk(transitionConfigRevision(store, { config_revision: revision, to_state: "APPLIED", idempotency_key: `${revision}-applied`, ...operation(`${revision}-applied`) }), "apply revision state")
    assertOk(applyConfigRevision(store, { target_revision: revision, expected_active_revision: null, idempotency_key: `${revision}-activate`, ...operation(`${revision}-activate`) }), "activate revision")
    assertOk(recordRuntimeProbe(store, digest({
      probe_id: probeId, endpoint: probe.endpoint ?? probe.evidence_source, runtime_version: probe.runtime_version, workflow_plugin_loaded: true, tools: probe.tools,
      provider: identity.provider, provider_id: identity.provider, model_id: identity.modelId, exact_model_ref: modelRef, probe_status: "AVAILABLE", availability_state: "AVAILABLE",
      probe_error: null, observed_at: observedAt, config_revision: revision, metadata: {
        evidence_source: probe.evidence_source, probe_kind: probe.probe_kind, evidence_classification: classification,
        requested_model_ref: probe.requested_model_ref, response_model_ref: probe.response_model_ref,
        response_session_id: probe.response_session_id, response_message_id: probe.response_message_id, response_completed_at: probe.response_completed_at,
        response_agent: probe.response_agent, raw_response_model_ref: probe.raw_response_model_ref, session_location: probe.session_location,
        challenge: probe.challenge, response_text_sha256: probe.response_text_sha256, tool_evidence: probe.tool_evidence,
      }, idempotency_key: `probe-${revision}-${routeBindingId}`,
    })), "recordRuntimeProbe")
    assertOk(appendModelCatalogEntry(store, digest(model)), "appendModelCatalogEntry")
    assertOk(appendRouteBinding(store, digest(route)), "appendRouteBinding")
    if (options.includeXxlJob !== false) assertOk(appendRouteBinding(store, digest(xxlRoute)), "append xxl-job route")
    return {
      store, dbPath: store.dbPath, pathEnvelope: store.pathEnvelope, configRevision: revision, modelRef, routeBindingId, fingerprints,
      evidenceClassification: classification,
      plan: {
        nodes: [{ node_id: "desktop-node", route: routeBindingId, project_id: projectScope, depends_on: [], metadata: { required: true } }],
        metadata: { runtime_evidence_required: true, fixture_classification: classification, execution_policy: { mode: "isolated_fixture", config_revision: revision, control_plane_db: store.dbPath, allowed_roots: store.pathEnvelope.allowed_roots } },
      },
    }
  } catch (error) {
    store.close()
    throw error
  }
}

export const initializeRuntimeFixture = initializePlan12RuntimeFixture
