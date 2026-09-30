// Global Lock — process-global per-key promise-chain lock (Plan 8 T4)
//
// Why this exists:
// Up to Plan 7, every plugin (runtime-registry / task-bus / workflow-engine)
// built its OWN runtime core instance, and each core kept its own private
// `chains: Map<string, Promise>` for per-session_key serialization. That was
// sufficient while only ONE core per process touched a given key at a time,
// but Plan 8 adds a lifecycle engine that MUST NOT rotate a session while a
// prompt/send from ANOTHER plugin core is still running on the same
// session_key. Two private maps in the same process do not serialize against
// each other.
//
// This module therefore keeps ONE promise-chain registry per PROCESS, stored
// on globalThis under a Symbol.for key, so every core instance (and any
// future lifecycle plugin core) that routes through `globalWithLock` shares
// the same per-key FIFO ordering:
//
//   globalWithLock(key, fn) — fn runs only after every previously enqueued
//   fn for the same key has settled (fulfilled OR rejected). Different keys
//   never block each other. Errors propagate to the caller and never poison
//   the chain (the queued successor always runs).
//
// Semantics (identical to the previous per-core `withLock`, just global):
// - FIFO per key, promise-chaining based (no OS mutex, no busy wait).
// - NON-REENTRANT: a fn that (directly or transitively) calls
//   globalWithLock with the SAME key it is already running under DEADLOCKS
//   (the inner call waits for the outer chain entry to settle, which waits
//   for the inner call). Callers already inside a lock must use the
//   lock-free "*Locked" helpers that lifecycle-core / runtime-registry-core
//   provide. This matches the pre-existing per-core withLock behavior.
// - Cross-process: this is a PROCESS-global lock only. Concurrent OS
//   processes are serialized at the data layer via SQLite WAL +
//   busy_timeout (Plan 8 T3), not here.
//
// This module has NO dependency on Bun, SQLite or the plugin ctx; it is safe
// to import from any core/plugin file.

const REGISTRY_SYMBOL = Symbol.for("ai-dev.opencode.global-lock.v1")

type LockRegistry = Map<string, Promise<unknown>>

function getRegistry(): LockRegistry {
  const g = globalThis as any
  let reg = g[REGISTRY_SYMBOL]
  if (!(reg instanceof Map)) {
    reg = new Map<string, Promise<unknown>>()
    g[REGISTRY_SYMBOL] = reg
  }
  return reg as LockRegistry
}

// Run `fn` under the process-global lock for `key`.
//
// The returned promise resolves/rejects with fn's result; the chain entry
// itself always settles to undefined so a failing fn never rejects the
// bookkeeping promise that later callers chain onto. Settled chain entries
// are removed from the registry (only when no newer acquisition replaced
// them), so lockStats() reflects genuinely pending keys and the map does not
// grow unboundedly across long-running processes.
export function globalWithLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
  if (typeof key !== "string" || !key) {
    return Promise.reject(new Error("globalWithLock: key must be a non-empty string"))
  }
  const reg = getRegistry()
  const prev = reg.get(key) ?? Promise.resolve()
  const run = prev.then(() => fn())
  const settled: Promise<undefined> = run.then(
    () => undefined,
    () => undefined,
  )
  reg.set(key, settled)
  settled.then(() => {
    // delete only if no newer acquisition re-registered this key meanwhile
    if (reg.get(key) === settled) reg.delete(key)
  })
  return run
}

// Diagnostics only (never required for correctness): how many keys currently
// have a pending chain entry, and which ones. A key appears here while its
// fn is queued or running; idle keys are absent (entries are cleaned up on
// settle).
export function lockStats(): { registry_symbol: string; pending_keys: number; keys: string[] } {
  const reg = getRegistry()
  return {
    registry_symbol: REGISTRY_SYMBOL.toString(),
    pending_keys: reg.size,
    keys: [...reg.keys()],
  }
}

// Test/inspection helper: true when the key currently has a pending chain
// entry (queued or running). Never blocks.
export function isLockBusy(key: string): boolean {
  return getRegistry().has(key)
}
