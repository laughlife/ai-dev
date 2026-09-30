// Lifecycle Rotation Reconcile — crash-leftover resolution (Plan 8 C3).
//
// Resolves incomplete lifecycle_rotations rows (status PREPARING /
// SUCCESSOR_CREATED / INITIALIZED — the non-terminal vocabulary of the
// committed T3 schema) left behind by a crashed or interrupted rotation,
// IDEMPOTENTLY and WITHOUT ever creating a second successor:
//
// - ROLL FORWARD (resolution COMMITTED) ONLY when the successor's registry
//   row already exists: a sessions row (session_key, to_generation) whose
//   opencode_session_id EQUALS the rotation ledger's successor_session_id.
//   The roll-forward settles the ledger in ONE transaction: old generation
//   ARCHIVED + replaced_by + checkpoint_path (when still ACTIVE), rotation
//   status COMMITTED, ROTATION_RECONCILED event. Re-running is a no-op
//   (terminal rows are SKIPPED).
// - FAIL SAFELY (resolution FAILED) in every other case — PREPARING without a
//   persisted successor id, SUCCESSOR_CREATED / INITIALIZED whose successor
//   was never registered, registered rows that do not match the recorded
//   successor id, or dead/unverifiable successors. The OLD generation stays
//   ACTIVE and serviceable (only lifecycle_state ROTATING -> ROTATION_FAILED);
//   orphaned successor OpenCode sessions are kept for audit and NEVER
//   deleted; a NEW successor is NEVER created here (that is a fresh
//   rotation's job, at generation+1, which cannot collide because the failed
//   rotation never registered its generation).
// - CONFLICT (resolution CONFLICT, ledger untouched, non-terminal) when the
//   registry changes underneath the roll-forward transaction (cross-process
//   writer) or a double-ACTIVE invariant would be violated: nothing is
//   forced; a later reconcile run (or a human) settles it.
//
// Why the strict registry-row rule: rotation.ts persists
// successor_session_id + SUCCESSOR_CREATED BEFORE any further await and
// commits the registry flip in ONE transaction. A successor that is merely
// "alive" but unregistered cannot be distinguished from an unrelated or
// half-initialized session with certainty, so C3 refuses to adopt it —
// adopting would risk double successors/double ACTIVE, which this module
// exists to prevent. (This is deliberately stricter than lifecycle-core's
// T4 adopt-INITIALIZED behavior; the facade chooses which engine to wire.)
//
// Locking: reconcileRotations acquires the per-session_key lock for every
// affected key (default: globalWithLock from ../global-lock.ts — the same
// process-global lock runtimeCore.withLock and rotateSession use, so a
// reconcile can never interleave with a running prompt/send/rotation on the
// key). The lock is NON-REENTRANT: callers already holding a key's lock use
// reconcileKeyLocked / reconcileOneLocked.
//
// Dependencies: shares ONE storage factory, ledger writer and vocabulary
// with ./rotation.ts (same committed T3 schema; no DDL, no ALTER, no own
// database handle — the runtime core's existing db is used).

import { globalWithLock } from "../global-lock.ts"
import {
  appendEvent,
  createLifecycleStorage,
  errMsg,
  guardStorage,
  isTerminalRotationStatus,
  nowIso,
  num,
  probeSessionAlive,
  resolveSessionKey,
  ROTATION_LIFECYCLE_STATES,
  type EventRecorder,
  type LifecycleStorage,
  type LockPrimitive,
} from "./rotation.ts"

const ROTATION_ERROR_MAX_CHARS = 2000 // lifecycle_rotations.error is detail, not a transcript

export interface ReconcileCoreOptions {
  withLock?: LockPrimitive // default: globalWithLock
  recordEvent?: EventRecorder // default: direct lifecycle_events insert
  root?: string
}

export function createReconcileCore(ctx: any, runtimeCore: any, options?: ReconcileCoreOptions) {
  const root: string =
    typeof options?.root === "string" && options.root
      ? options.root
      : typeof runtimeCore?.root === "string" && runtimeCore.root
        ? runtimeCore.root
        : (ctx?.location?.directory ?? process.cwd())
  const db: any = runtimeCore?.db ?? null
  const dbError: string | null = runtimeCore?.dbError ?? null
  const st: LifecycleStorage | null = createLifecycleStorage(db)
  const withLock: LockPrimitive = typeof options?.withLock === "function" ? options.withLock : globalWithLock

  const diagnostics = {
    root,
    db_ready: !!db,
    db_error: dbError,
    lifecycle_tables_ready: !!st?.lifecycleTablesReady,
    telemetry_columns_ready: !!st?.telemetryColumnsReady,
    lock: typeof options?.withLock === "function" ? "injected" : "globalWithLock",
  }

  function guard() {
    return guardStorage(st, dbError)
  }

  function rotationView(r: any) {
    if (!r) return null
    return {
      rotation_id: r.rotation_id,
      session_key: r.session_key,
      from_generation: r.from_generation,
      from_session_id: r.from_session_id,
      to_generation: r.to_generation,
      checkpoint_path: r.checkpoint_path ?? null,
      successor_session_id: r.successor_session_id ?? null,
      status: r.status,
      error: r.error ?? null,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }
  }

  // Read-only view of the incomplete ledger (all keys or one key).
  function listIncompleteRotations(input?: any) {
    const g = guard()
    if (g) return g
    const key = resolveSessionKey(runtimeCore, input)
    const rows: any[] = key ? st!.rotIncompleteForKey.all(key) : st!.rotIncomplete.all()
    return { ok: true, status: "OK", count: rows.length, rotations: rows.map(rotationView) }
  }

  // ===================================================================
  // Roll forward — ONLY when the successor's registry row already exists
  // and provably belongs to this rotation (session id match). One
  // transaction; no awaits inside; never inserts a sessions row (the row
  // must already be there), never deletes an OpenCode session.
  // ===================================================================
  function rollForwardLocked(rot: any, oldRow: any, base: Record<string, unknown>) {
    const key = String(rot.session_key)
    const dbx = st!.db
    dbx.exec("BEGIN IMMEDIATE")
    try {
      const freshRot: any = st!.rotGet.get(rot.rotation_id)
      if (!freshRot) throw Object.assign(new Error("rotation row disappeared"), { skip: `rotation row ${rot.rotation_id} disappeared` })
      if (isTerminalRotationStatus(freshRot.status)) {
        throw Object.assign(new Error("already terminal"), { skip: `already terminal (${freshRot.status})` })
      }
      const freshNew: any = st!.rowByGen.get(key, rot.to_generation)
      if (!freshNew || freshNew.opencode_session_id !== rot.successor_session_id) {
        // registry changed underneath us (cross-process writer): do NOT
        // force anything — non-terminal CONFLICT, reconcile again later
        throw Object.assign(new Error("successor registry row vanished or changed"), {
          conflict:
            `successor registry row (${key}, ${rot.to_generation}) vanished or no longer matches successor_session_id ` +
            `${rot.successor_session_id ?? "none"} during the roll-forward transaction; nothing was written`,
        })
      }
      const ts = nowIso()
      if (oldRow && oldRow.status === "ACTIVE") {
        const archived: any = st!.archiveOldGeneration.run(
          freshNew.opencode_session_id,
          rot.checkpoint_path ?? null,
          ts,
          key,
          rot.from_generation,
        )
        if (Number(archived?.changes ?? 0) !== 1) {
          throw Object.assign(new Error("old generation archive matched 0 rows"), {
            conflict:
              `old generation ${rot.from_generation} of '${key}' changed status during the roll-forward transaction ` +
              `(conditional ARCHIVED update matched ${archived?.changes ?? 0} rows); nothing was written`,
          })
        }
      } else if (oldRow && oldRow.lifecycle_state === ROTATION_LIFECYCLE_STATES.rotating) {
        // old row is no longer ACTIVE (e.g. STALE because its OpenCode
        // session died meanwhile): keep the registry status, only clear the
        // transitional ROTATING label
        st!.setLifecycleState.run(
          oldRow.status === "STALE" ? ROTATION_LIFECYCLE_STATES.stale : ROTATION_LIFECYCLE_STATES.archived,
          key,
          rot.from_generation,
        )
      }
      const active: any = st!.activeCount.get(key)
      if (Number(active?.n ?? 0) > 1) {
        throw Object.assign(new Error("double ACTIVE after roll-forward"), {
          conflict:
            `roll-forward would leave ${active?.n} ACTIVE generations for '${key}' (at most 1 allowed); ` +
            "nothing was written — fix the registry, then reconcile again",
        })
      }
      st!.rotSetStatus.run("COMMITTED", ts, rot.rotation_id)
      appendEvent(st, options?.recordEvent, {
        session_key: key,
        generation: rot.to_generation,
        opencode_session_id: freshNew.opencode_session_id,
        event_type: "ROTATION_RECONCILED",
        context_pct: num(oldRow?.context_pct),
        checkpoint_path: rot.checkpoint_path ?? null,
        details: {
          rotation_id: rot.rotation_id,
          resolution: "COMMITTED",
          note: `successor generation ${rot.to_generation} was already registered with the recorded successor id; ledger settled`,
          status_at_reconcile: rot.status,
          from_generation: rot.from_generation,
          from_session_id: rot.from_session_id,
        },
      })
      dbx.exec("COMMIT")
      return {
        ...base,
        resolution: "COMMITTED",
        detail: `successor generation ${rot.to_generation} already registered (session ${freshNew.opencode_session_id}); ledger settled`,
      }
    } catch (e: any) {
      try {
        dbx.exec("ROLLBACK")
      } catch {}
      if (typeof e?.skip === "string") return { ...base, resolution: "SKIPPED", detail: e.skip }
      if (typeof e?.conflict === "string") return { ...base, resolution: "CONFLICT", detail: e.conflict }
      return {
        ...base,
        resolution: "CONFLICT",
        detail: `roll-forward transaction failed and was rolled back (nothing written): ${errMsg(e)}`,
      }
    }
  }

  // ===================================================================
  // Fail safely — rotation FAILED, old generation stays ACTIVE and
  // serviceable, orphaned successor sessions (if any) kept for audit and
  // NEVER deleted, NO new successor ever created here.
  // ===================================================================
  async function abandonLocked(rot: any, oldRow: any, base: Record<string, unknown>, reason: string) {
    const key = String(rot.session_key)
    // liveness probe is audit-only: the resolution never depends on it (an
    // alive-but-unregistered successor is still abandoned — adopting it
    // would risk a double successor). Awaited BEFORE the transaction so no
    // await ever runs inside BEGIN IMMEDIATE.
    const successorAlive = await probeSessionAlive(ctx, rot.successor_session_id ?? null)
    const detail =
      `${reason} (status_at_reconcile=${rot.status}, successor_session_id=${rot.successor_session_id ?? "none"}, ` +
      `successor_alive=${successorAlive}); abandoned WITHOUT creating or adopting a successor; the old generation stays ACTIVE; ` +
      "orphaned OpenCode sessions are kept for audit and never deleted"

    const dbx = st!.db
    dbx.exec("BEGIN IMMEDIATE")
    try {
      const freshRot: any = st!.rotGet.get(rot.rotation_id)
      if (!freshRot) throw Object.assign(new Error("rotation row disappeared"), { skip: `rotation row ${rot.rotation_id} disappeared` })
      if (isTerminalRotationStatus(freshRot.status)) {
        throw Object.assign(new Error("already terminal"), { skip: `already terminal (${freshRot.status})` })
      }
      const ts = nowIso()
      st!.rotFail.run(`RECONCILED_ABANDONED: ${detail}`.slice(0, ROTATION_ERROR_MAX_CHARS), ts, rot.rotation_id)
      if (oldRow && oldRow.lifecycle_state === ROTATION_LIFECYCLE_STATES.rotating) {
        // sessions.status was never changed from ACTIVE — only the
        // transitional label flips, and the generation stays serviceable
        st!.setLifecycleState.run(ROTATION_LIFECYCLE_STATES.rotationFailed, key, rot.from_generation)
      }
      appendEvent(st, options?.recordEvent, {
        session_key: key,
        generation: rot.from_generation,
        opencode_session_id: rot.from_session_id ?? null,
        event_type: "ROTATION_RECONCILED",
        context_pct: num(oldRow?.context_pct),
        checkpoint_path: rot.checkpoint_path ?? null,
        details: {
          rotation_id: rot.rotation_id,
          resolution: "FAILED",
          detail,
          status_at_reconcile: rot.status,
          successor_session_id: rot.successor_session_id ?? null,
          successor_alive: successorAlive,
        },
      })
      dbx.exec("COMMIT")
      return { ...base, resolution: "FAILED", detail }
    } catch (e: any) {
      try {
        dbx.exec("ROLLBACK")
      } catch {}
      if (typeof e?.skip === "string") return { ...base, resolution: "SKIPPED", detail: e.skip }
      return {
        ...base,
        resolution: "CONFLICT",
        detail: `abandon transaction failed and was rolled back (nothing written): ${errMsg(e)}`,
      }
    }
  }

  // ===================================================================
  // One rotation — LOCK-FREE (caller holds the session_key lock).
  // Idempotent: terminal rows are SKIPPED without any write.
  // ===================================================================
  async function reconcileOneLocked(rot: any) {
    const g = guard()
    if (g) return g
    const key = String(rot.session_key)
    const base = {
      rotation_id: rot.rotation_id,
      session_key: key,
      from_generation: rot.from_generation,
      to_generation: rot.to_generation,
      status_at_reconcile: rot.status,
      successor_session_id: rot.successor_session_id ?? null,
      checkpoint_path: rot.checkpoint_path ?? null,
    }
    if (isTerminalRotationStatus(rot.status)) {
      return { ...base, resolution: "SKIPPED", detail: `already terminal (${rot.status})` }
    }
    const oldRow: any = st!.rowByGen.get(key, rot.from_generation)
    const newRow: any = st!.rowByGen.get(key, rot.to_generation)

    // Roll forward ONLY when the successor registry row already exists AND
    // provably belongs to this rotation (recorded successor id matches).
    const successorRegistered =
      !!newRow &&
      typeof rot.successor_session_id === "string" &&
      !!rot.successor_session_id &&
      newRow.opencode_session_id === rot.successor_session_id
    if (successorRegistered) return rollForwardLocked(rot, oldRow, base)

    // Everything else fails safely. Distinguish the crash windows for the
    // ledger detail (the resolution is the same: FAILED, never adopt/create).
    let reason: string
    if (!newRow && typeof rot.successor_session_id === "string" && rot.successor_session_id) {
      reason =
        `rotation incomplete at ${rot.status} with a recorded successor id but NO successor registry row for ` +
        `generation ${rot.to_generation} — refusing to adopt an unregistered successor`
    } else if (newRow && !successorRegistered) {
      reason =
        `sessions row (${key}, ${rot.to_generation}) exists but belongs to a DIFFERENT OpenCode session ` +
        `(${newRow.opencode_session_id}) than the recorded successor (${rot.successor_session_id ?? "none"}) — ` +
        "the registry was taken over by another writer (e.g. ensure after a crash); this rotation did not succeed"
    } else {
      reason =
        `rotation incomplete at ${rot.status} with no persisted successor id and no successor registry row — ` +
        "a successor may exist only as an unrecoverable orphan; failing safely instead of creating one (no duplicate successor)"
    }
    return abandonLocked(rot, oldRow, base, reason)
  }

  // ===================================================================
  // One key — LOCK-FREE (caller holds globalWithLock(key)). Re-reads every
  // rotation row freshly inside the lock (idempotent under repeats).
  // ===================================================================
  async function reconcileKeyLocked(key: string) {
    const g = guard()
    if (g) return g
    const rows = st!.rotIncompleteForKey.all(key) as any[]
    const results: any[] = []
    for (const r of rows) {
      const fresh: any = st!.rotGet.get(r.rotation_id)
      if (!fresh) {
        results.push({
          rotation_id: r.rotation_id,
          session_key: key,
          resolution: "SKIPPED",
          detail: "rotation row disappeared",
        })
        continue
      }
      results.push(await reconcileOneLocked(fresh))
    }
    return results
  }

  // ===================================================================
  // Public reconcile — scans the incomplete ledger (optionally filtered to
  // one session_key) and resolves each affected key under its own lock.
  // ===================================================================
  async function reconcileRotations(input?: any) {
    const g = guard()
    if (g) return g
    const keyFilter = resolveSessionKey(runtimeCore, input)
    const rows: any[] = keyFilter ? st!.rotIncompleteForKey.all(keyFilter) : st!.rotIncomplete.all()
    const keys: string[] = [...new Set(rows.map((r) => String(r.session_key)))]
    const results: any[] = []
    for (const k of keys) {
      const perKey = await withLock(k, () => reconcileKeyLocked(k))
      results.push(...(Array.isArray(perKey) ? perKey : []))
    }
    return {
      ok: true,
      status: "OK",
      incomplete_found: rows.length,
      keys: keys.length,
      count: results.length,
      reconciled: results,
    }
  }

  return {
    root,
    diagnostics,
    reconcileRotations, // acquires the session_key lock per affected key
    reconcileKeyLocked, // LOCK-FREE — caller must hold the key's lock
    reconcileOneLocked, // LOCK-FREE — caller must hold the key's lock
    listIncompleteRotations, // read-only
    rotationView, // read-only helper (ledger row -> stable view)
  }
}
