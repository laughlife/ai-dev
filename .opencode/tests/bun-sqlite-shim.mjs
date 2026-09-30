// Node 24 adapter that exposes the subset of the Bun `bun:sqlite` API the
// Plan 8 lifecycle code uses, backed by the built-in `node:sqlite` module.
//
// Bun surface used by the framework:
//   db.query(sql)   -> cached statement { get, all, run, iterate }
//   db.prepare(sql) -> statement { get, all, run }
//   db.exec(sql)    -> multi-statement exec (used for schema.sql + BEGIN/COMMIT)
//   db.transaction(fn) -> returns a callable wrapping fn in BEGIN IMMEDIATE/COMMIT
//   db.run(sql, ...params)
//   db.close()
//
// The lifecycle code only ever passes POSITIONAL parameters, so the wrapper
// forwards ...params unchanged to node:sqlite StatementSync.

import { DatabaseSync } from "node:sqlite"

function wrapStatement(stmt) {
  return {
    get: (...params) => stmt.get(...params),
    all: (...params) => stmt.all(...params),
    run: (...params) => stmt.run(...params),
    iterate: (...params) => stmt.iterate(...params),
    columns: () => stmt.columns(),
    sourceSQL: () => stmt.sourceSQL?.() ?? "",
  }
}

export class Database {
  #db
  #cache = new Map()

  constructor(filename, options) {
    this.#db = new DatabaseSync(filename, options ?? {})
  }

  #statement(sql) {
    let s = this.#cache.get(sql)
    if (!s) {
      s = wrapStatement(this.#db.prepare(sql))
      this.#cache.set(sql, s)
    }
    return s
  }

  query(sql) {
    return this.#statement(sql)
  }

  prepare(sql) {
    return this.#statement(sql)
  }

  run(sql, ...params) {
    return this.#db.prepare(sql).run(...params)
  }

  exec(sql) {
    return this.#db.exec(sql)
  }

  transaction(fn) {
    const self = this
    return (...args) => {
      self.#db.exec("BEGIN IMMEDIATE")
      try {
        const out = fn(...args)
        if (out && typeof out.then === "function") {
          throw new Error("bun:sqlite adapter does not support async transaction callbacks")
        }
        self.#db.exec("COMMIT")
        return out
      } catch (e) {
        try {
          self.#db.exec("ROLLBACK")
        } catch {}
        throw e
      }
    }
  }

  close() {
    this.#cache.clear()
    return this.#db.close()
  }
}

export default { Database }
