// Thin wrapper over node:sqlite (built in Node 22). All queries pass through
// here so test and production code share the same transaction/prepare helpers.

import { DatabaseSync, type StatementSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { runMigrations } from "./migrations.js";

export interface DbHandle {
  readonly db: DatabaseSync;
  prepare(sql: string): StatementSync;
  transaction<T>(fn: () => T): T;
  close(): void;
  readonly path: string;
}

const prepared = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

function cachePrepared(db: DatabaseSync, sql: string): StatementSync {
  let cache = prepared.get(db);
  if (!cache) {
    cache = new Map();
    prepared.set(db, cache);
  }
  const existing = cache.get(sql);
  if (existing) return existing;
  const stmt = db.prepare(sql);
  cache.set(sql, stmt);
  return stmt;
}

export function openDatabase(filePath: string): DbHandle {
  if (filePath !== ":memory:") {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(filePath);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA foreign_keys=ON;");
  db.exec("PRAGMA synchronous=NORMAL;");
  db.exec("PRAGMA busy_timeout=5000;");
  runMigrations(db);
  if (filePath !== ":memory:") {
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // On platforms where chmod is unsupported, best-effort.
    }
  }
  const handle: DbHandle = {
    db,
    path: filePath,
    prepare: (sql) => cachePrepared(db, sql),
    transaction<T>(fn: () => T): T {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // ignore rollback failures to preserve the original error
        }
        throw err;
      }
    },
    close(): void {
      db.close();
    },
  };
  return handle;
}
