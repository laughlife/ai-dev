# Runtime Context Telemetry (Plan 8 — Verified Protocol)

Status: VERIFIED (Plan 8 Phase 1 / T1 read-only capability probe, 2026-09-30)

This document records the accepted, source-verified protocol for measuring
session context usage (`context_pct`) against the installed OpenCode runtime.
It is the evidence base for Plan 8 lifecycle thresholds
(60 / 70 / 80, see `../framework-config/lifecycle.yaml`) and for the
Runtime Registry `context_pct` field shown in
`../diagrams/multi_agent_framework_v3_workspace.drawio`.

## 1. Runtime version and provenance

| Fact | Value | Evidence |
| --- | --- | --- |
| Running service version | **OpenCode 2.0.20** (not 2.0.19) | `GET /api/info` → `{"version":"2.0.20","pid":2332,...}` |
| Service binary | `...\ai.opencode.desktop\cli\2.0.20\opencode-cli.exe serve --service` | spawned by the Desktop app; `cli\` also contains 2.0.18 and 2.0.19 |
| Auto-update drift | 2.0.18 → 2.0.19 (2026-09-29) → 2.0.20 (2026-09-30) within ~24 h | `~\.local\share\opencode\log\opencode.log` |
| PATH `opencode --version` | stale `1.1.53` npm shim (V1 tree; no `api`/`service`) | must not be used for V2 probing; use the Desktop-managed CLI or HTTP API |
| Service auth | HTTP Basic, user `opencode`, password field of `~\.config\opencode\service.json` | credential is never recorded here |

Preceding static analysis of 2.0.19 concluded `CONTEXT_TELEMETRY_UNVERIFIED`
(2026-09-30, read-only doc/binary analysis). That verdict was superseded the
same day by the dynamic T1 probe against the live 2.0.20 service, which
returned `CONTEXT_TELEMETRY_VERIFIED`. All sections below are backed by the
T1 probe; no write operation was performed by the probe (SQLite `mode=ro`,
GET-only HTTP, file reads).

## 2. Verified telemetry contract

```yaml
context_usage_source: last-assistant-message TokenUsage via ctx.session.context()
context_limit_source: Model.Info.limit.context via ctx.model.list() (model catalog)
approximation_allowed: false
```

The T1 gate condition — that a deterministic, UI-identical measurement is
achievable without estimation — is satisfiable.

### 2.1 Usage source: `ctx.session.context()`

- `ctx.session.context({ sessionID })` returns `readonly SessionMessageInfo[]`
  (documented V2 plugin API; confirmed present in the installed 2.0.20 binary
  and serving live).
- Usage is taken from the **latest assistant message that actually carries
  `tokens`** (in-flight/streaming assistant messages have no `tokens` and must
  be skipped, never treated as zero).
- Each assistant message `tokens` is `TokenUsage.Info`:
  `{ input, output, reasoning, cache: { read, write } }` (OpenAPI schema
  confirmed; no extra fields).
- The equivalent persisted source is the `session_message` table in
  `~\.local\share\opencode\opencode.db` (`data.content[].tokens` / message
  `tokens` field), ordered by `seq`. The T1 probe verified that the live API
  view and the DB view are consistent.
- `GET /api/session/{id}/message` is paginated (default newest-50 window);
  plugin telemetry should use `ctx.session.context()` (unpaginated,
  compaction-bounded — see §5) instead.

### 2.2 Limit source: `ctx.model.list()` → `Model.Info.limit.context`

- `ctx.model.list()` returns `Model.Info` entries whose
  `limit = { context: int, input?: int, output: int }`.
- The catalog endpoint `GET /api/model` (568 models at probe time) carries the
  same data; lookup key is the **message's own** `{ model.providerID, model.id }`.
- No name-based window hardcoding is needed or allowed.
- Reasoning variants (`high`, `xhigh`, ...) are **not** separate context
  limits.

## 3. Exact UI-identical formula

The ground truth was extracted verbatim from the minified UI bundle that the
installed 2.0.20 service itself serves (`/_assets/route-*.js`, the component
rendering the Desktop context meter):

```js
let e = messages.findLast(e => e.type === "assistant" && !!e.tokens);
if (e?.type !== "assistant" || !e.tokens) return;
let t = catalog.all().get(e.model.providerID)?.models[e.model.id];
let n = e.tokens.input + e.tokens.output + e.tokens.reasoning
      + e.tokens.cache.read + e.tokens.cache.write;
return { total: n, usage: t?.limit.context ? Math.round(n / t.limit.context * 100) : null };
```

Normalized into the framework contract:

```text
verified_context_tokens = (latest assistant message with usage).tokens
                            .(input + output + reasoning + cache.read + cache.write)
verified_context_limit  = model catalog entry of THAT message's { providerID, id }
                            → limit.context
context_pct             = round(verified_context_tokens / verified_context_limit * 100)
                          → null when the catalog entry or limit.context is missing
```

### 3.1 Cache semantics (measured, not assumed)

- `input` and `cache.read` are **disjoint** counters; the UI sums both. Never
  subtract or replace one with the other.
- Per-message `cache.write` was **always 0** across the entire installed
  message DB (0 rows with `cache.write > 0` out of 1,296 messages). The
  formula still adds it (harmless; if a future provider populates it, the sum
  semantics already match the UI).
- `session_v2.tokens_input / tokens_output / tokens_reasoning /
  tokens_cache_read / tokens_cache_write` are **cumulative cost accounting,
  not context size**, and MUST NOT be used for telemetry. Measured evidence
  (session `ses_f14cbf5c…`): message-sums input 115,741 / output 11,644 /
  cache.read 1,640,448 / cache.write 0, versus session totals 115,744 /
  11,660 / 1,640,448 / **5,249**. The delta comes from auxiliary model calls
  (title/compaction) that never appear as per-message tokens.

## 4. Verification samples — 0pp agreement

Three stable (idle) sessions spanning small → high usage. `pct (API)` was
computed from the live `GET /api/session/{id}/context` + `GET /api/model`;
`pct (DB)` from the read-only DB recomputation with the same formula.

| Session | Context msgs | Last-assistant model | Tokens total | limit.context | pct (API) | pct (DB) | Δ |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ses_f1374a3f… | 4 | openai/gpt-6-sol-fast | 8,108 | 400,000 | 2 | 2 | **0pp** |
| ses_f1043b82… | 21 | bailian-token-plan/qwen3.8-flash | 129,732 | 200,000 | 65 | 65 | **0pp** |
| ses_f11fc56f… | 39 | bailian-token-plan/qwen3.8-max | 149,958 | 200,000 | 75 | 75 | **0pp** |

Additionally ≈60 idle sessions recomputed cleanly (1%–75%). Because the
telemetry reads the *same data* the UI bundle reads (same message tokens,
same catalog lookup, same `Math.round`), the formula is proven **identical,
not approximated**; the ≤2pp tolerance is expected to resolve to 0pp.

Scope note: T1 was strictly read-only; the formal live side-by-side check
against the Desktop UI rendering for ≥3 sessions is scheduled for the Plan 8
smoke phase and has not been executed at the time of writing.

## 5. Compaction behavior

- `GET /api/session/{id}/context` (and `ctx.session.context()`) return the
  true live model context **bounded by the newest `compaction` message**
  (verified: a large session's context started at its `compaction` message,
  57 entries vs. the full history).
- Persisted `compaction` messages carry
  `{ status, reason: "auto" | "manual", summary, recent, model, cost, tokens }`;
  `session_v2.time_compacting` exists; `session.hook("compaction")` can record
  custom summaries via `event.result`.
- Consequence for telemetry: after compaction, the next assistant message's
  usage reflects the reduced context and `context_pct` drops by construction.
  The formula needs no compaction-specific handling; consumers must treat a
  sudden drop as expected behavior, not a measurement fault. This matters for
  the 60/70/80 rotation thresholds in `framework-config/lifecycle.yaml`.

## 6. Limitations and risks

1. **Version drift**: the Desktop-managed CLI auto-updates on `channel=latest`
   (2.0.19 → 2.0.20 within ~24 h during the probe window). Do not pin
   behavior to a specific version string; after any upgrade, re-extract the
   formula from the served `/_assets/route-*.js` and re-run the three-sample
   check before trusting the numbers.
2. **Streaming messages**: in-flight assistant messages have no `tokens`;
   use `findLast(type == "assistant" && !!tokens)` exactly like the UI — skip,
   never treat as 0.
3. **Active-session values drift**: a running session's measurement changes
   minute to minute (observed). Deterministic comparison must use **idle**
   sessions (`time_idle` set).
4. **Message endpoint pagination**: `GET /api/session/{id}/message` defaults
   to a newest-50 window; order matters. Prefer `ctx.session.context()`.
5. **Missing catalog entry → `context_pct = null`**: if the model used by the
   last assistant message has no catalog entry (or no `limit.context`), the UI
   shows nothing (`usage: null`). Telemetry MUST yield `null` in that case and
   never guess a window size.
6. **`Plugin.define`** string was not located in the 2.0.20 binary (docs-
   confirmed only; everything else in the API surface was binary- and
   live-confirmed). The first lifecycle plugin must verify
   `ctx.session.hook` registration empirically at load time and note
   `summary_source` accordingly.
7. **`providerState`** raw payloads were not sampled to a conclusion; not
   needed for telemetry since the formula source is definitive.

## 7. No-estimation policy (normative)

Framework telemetry **must never estimate** context usage. Explicitly
forbidden:

- characters/4 or any heuristic char-based approximation;
- running a local tokenizer over message history;
- using `session_v2.tokens_*` cumulative totals as context size;
- hardcoding or guessing context windows by model name (catalog
  `limit.context` only);
- substituting session-total ratios for the last-assistant-message formula.

If a value cannot be obtained exactly as the UI computes it, the result is
`null` (or the telemetry field is absent), never a fabricated number.
`approximation_allowed: false` is a standing rule for Plan 8 lifecycle
automation (60/70/80 rotation, checkpoint, generation rotation).

## 8. Reproduction (read-only)

Service endpoints (port and Basic credentials come from the live service;
password lives only in `~\.config\opencode\service.json`, never in docs or Git):

```text
GET  http://127.0.0.1:<service-port>/api/info              # version identity
GET  http://127.0.0.1:<service-port>/_assets/route-*.js    # search "limit.context" for the UI formula
GET  http://127.0.0.1:<service-port>/api/model             # catalog → limit.context
GET  http://127.0.0.1:<service-port>/api/session/{id}/context
```

Local DB (open strictly with `mode=ro`):

```text
C:\Users\Administrator\.local\share\opencode\opencode.db
tables: session_v2, session_message   (context = last assistant row by seq with tokens)
```

## 9. Change record

- 2026-09-30: Plan 8 T1 probe (session "探测真实上下文遥测", read-only)
  returned `CONTEXT_TELEMETRY_VERIFIED`; this document captures its results.
- Supersedes the interim `CONTEXT_TELEMETRY_UNVERIFIED` static-analysis
  verdict of the same day for 2.0.19.
- Consumers: Runtime Registry `context_pct` (drawio),
  `framework-config/lifecycle.yaml` 60/70/80 thresholds. Automatic lifecycle
  rotation remains disabled (`framework.yaml` flags) until the Plan 8 smoke
  phase completes.
