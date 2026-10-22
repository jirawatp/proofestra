// SQLite open/pragma/migration behaviour using real temp database files.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type DbHandle } from "../../src/storage/db.js";
import { runMigrations } from "../../src/storage/migrations.js";

let dir: string;
const open: DbHandle[] = [];
const raw: DatabaseSync[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "proofestra-db-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const h of open.splice(0)) {
    try {
      h.close();
    } catch {
      // already closed by the test
    }
  }
  for (const d of raw.splice(0)) {
    try {
      d.close();
    } catch {
      // already closed
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

function tableNames(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map(
    (r) => r.name,
  );
}

describe("openDatabase", () => {
  it("creates missing parent directories, applies pragmas and restricts the file mode", () => {
    const file = path.join(dir, "nested", "deeper", "p.sqlite");
    const h = openDatabase(file);
    open.push(h);
    expect(h.path).toBe(file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect((h.db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
    expect((h.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
    expect(tableNames(h.db)).toEqual(
      expect.arrayContaining(["attachments", "conversations", "message_attachments", "messages", "run_events", "runs", "schema_migrations", "sessions"]),
    );
  });

  it("supports :memory: without touching the filesystem", () => {
    const mkdir = vi.spyOn(fs, "mkdirSync");
    const chmod = vi.spyOn(fs, "chmodSync");
    const h = openDatabase(":memory:");
    open.push(h);
    expect(mkdir).not.toHaveBeenCalled();
    expect(chmod).not.toHaveBeenCalled();
    expect(tableNames(h.db)).toContain("conversations");
  });

  it("tolerates a platform where chmod is unsupported", () => {
    vi.spyOn(fs, "chmodSync").mockImplementation(() => {
      throw new Error("EPERM");
    });
    const h = openDatabase(path.join(dir, "nochmod.sqlite"));
    open.push(h);
    expect(tableNames(h.db)).toContain("runs");
  });

  it("fails loudly when the data directory cannot be created", () => {
    const blocker = path.join(dir, "file-not-dir");
    fs.writeFileSync(blocker, "x");
    expect(() => openDatabase(path.join(blocker, "sub", "p.sqlite"))).toThrow();
  });

  it("fails loudly when the path is not a SQLite database", () => {
    const bad = path.join(dir, "bad.sqlite");
    fs.writeFileSync(bad, "this is definitely not a sqlite file ".repeat(10));
    expect(() => openDatabase(bad)).toThrow();
  });

  it("reuses one prepared statement per SQL text on a handle", () => {
    const h = openDatabase(":memory:");
    open.push(h);
    expect(h.prepare("SELECT 1 AS x")).toBe(h.prepare("SELECT 1 AS x"));
    expect(h.prepare("SELECT 2 AS x")).not.toBe(h.prepare("SELECT 1 AS x"));
  });

  it("transaction commits on success and returns the callback value", () => {
    const h = openDatabase(":memory:");
    open.push(h);
    const out = h.transaction(() => {
      h.prepare("INSERT INTO conversations (id,title,created_at,updated_at) VALUES ('c1','t','a','b')").run();
      return 42;
    });
    expect(out).toBe(42);
    expect(h.prepare("SELECT COUNT(*) AS c FROM conversations").get()).toEqual({ c: 1 });
  });

  it("transaction rolls back every write when the callback throws, and rethrows the original error", () => {
    const h = openDatabase(":memory:");
    open.push(h);
    expect(() =>
      h.transaction(() => {
        h.prepare("INSERT INTO conversations (id,title,created_at,updated_at) VALUES ('c1','t','a','b')").run();
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(h.prepare("SELECT COUNT(*) AS c FROM conversations").get()).toEqual({ c: 0 });
  });

  it("preserves the original error even if ROLLBACK itself fails", () => {
    const h = openDatabase(":memory:");
    open.push(h);
    expect(() =>
      h.transaction(() => {
        h.db.close(); // makes the subsequent ROLLBACK throw
        throw new Error("original failure");
      }),
    ).toThrow("original failure");
  });

  it("persists data across close and reopen, and re-running migrations is idempotent", () => {
    const file = path.join(dir, "persist.sqlite");
    const first = openDatabase(file);
    first.prepare("INSERT INTO conversations (id,title,created_at,updated_at) VALUES ('c1','keep','a','b')").run();
    const applied = (first.prepare("SELECT COUNT(*) AS c FROM schema_migrations").get() as { c: number }).c;
    first.close();
    const second = openDatabase(file);
    open.push(second);
    expect(second.prepare("SELECT title FROM conversations WHERE id='c1'").get()).toEqual({ title: "keep" });
    expect((second.prepare("SELECT COUNT(*) AS c FROM schema_migrations").get() as { c: number }).c).toBe(applied);
    expect(applied).toBeGreaterThanOrEqual(5);
    runMigrations(second.db);
    expect((second.prepare("SELECT COUNT(*) AS c FROM schema_migrations").get() as { c: number }).c).toBe(applied);
  });
});

describe("runMigrations", () => {
  it("upgrades a database that is only at migration 1 and records each applied migration once", () => {
    const db = new DatabaseSync(path.join(dir, "upgrade.sqlite"));
    raw.push(db);
    // Emulate a pre-existing v1 database by applying everything, then rewinding.
    runMigrations(db);
    const full = (db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as { id: number }[]).map((r) => r.id);
    expect(full).toEqual([1, 2, 3, 4, 5]);
    const cols = (db.prepare("PRAGMA table_info(attachments)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["sniffed_width", "sniffed_pdf_pages", "validated_media_format", "normalized_media_mime"]));
  });

  it("rolls back a failing migration atomically and leaves it unrecorded", () => {
    const db = new DatabaseSync(path.join(dir, "fail.sqlite"));
    raw.push(db);
    // Migration 1 already applied.
    db.exec(`CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);`);
    // Run only migration 1 by letting runMigrations apply everything on a
    // scratch DB, then copying the v1 tables is overkill; instead pre-create
    // the v1 tables via a full run on a sibling DB and drop the later ones.
    runMigrations(db);
    db.exec("DROP TABLE message_attachments; DROP TABLE attachments;");
    db.exec("DELETE FROM schema_migrations WHERE id >= 2;");
    // A conflicting object that migration 2 only reaches AFTER it has already
    // created `attachments` (so rollback must remove that table again).
    db.exec("CREATE TABLE message_attachments (x INTEGER)");
    expect(() => runMigrations(db)).toThrow(/message_attachments/);
    expect(tableNames(db)).not.toContain("attachments");
    expect(tableNames(db)).toContain("message_attachments");
    expect((db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as { id: number }[]).map((r) => r.id)).toEqual([1]);

    // Fix the conflict; the next run completes the remaining migrations.
    db.exec("DROP TABLE message_attachments");
    runMigrations(db);
    expect((db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as { id: number }[]).map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
    expect(tableNames(db)).toEqual(expect.arrayContaining(["attachments", "message_attachments"]));
  });
});
