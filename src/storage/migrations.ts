// Linear migration list. Each entry is applied once and recorded in the
// `schema_migrations` table. Never edit an existing migration in place: add a
// new entry so persisted databases upgrade cleanly.

import type { DatabaseSync } from "node:sqlite";

interface Migration {
  id: number;
  name: string;
  up: string;
}

const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: "initial_schema",
    up: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX conversations_updated_at ON conversations(updated_at DESC, id DESC);

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user','assistant')),
        text TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(conversation_id, sequence)
      );
      CREATE INDEX messages_conversation ON messages(conversation_id, sequence);

      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        user_message_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        status TEXT NOT NULL,
        mode TEXT NOT NULL,
        execution_mode TEXT NOT NULL,
        created_at TEXT NOT NULL,
        finished_at TEXT,
        last_event_sequence INTEGER NOT NULL DEFAULT 0,
        UNIQUE(conversation_id, idempotency_key)
      );
      CREATE INDEX runs_conversation ON runs(conversation_id, created_at DESC);
      CREATE INDEX runs_status ON runs(status);

      CREATE TABLE run_events (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        at TEXT NOT NULL,
        data_json TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence)
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        csrf_token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL
      );
    `,
  },
  {
    id: 2,
    name: "attachments",
    up: `
      -- One row per uploaded blob. Conversation-scoped so a stored id can
      -- never leak across accounts; the HTTP boundary enforces the IDOR
      -- check (attachment.conversation_id must equal the request path).
      -- The blob itself lives at {dataDir}/attachments/{storage_key}
      -- (random UUID path, never a user-supplied filename).
      --
      -- state lifecycle:
      --   uploading -> ready       (write + sniff succeeded; blob present)
      --   uploading -> failed      (write/validation/quota rejected; no blob)
      --   ready     -> bound       (frozen onto a sent user message; the
      --                             reference becomes immutable; delete must
      --                             then come via conversation deletion)
      --
      -- sanitized_display_name is the ONLY name shown in the UI / sent to
      -- download Content-Disposition / written to export. It contains no
      -- path separators, no control bytes, no leading dot, and is bounded.
      -- The user's raw filename is NOT stored.
      --
      -- sniffed_mime is the magic-byte-sniffed type and is the only mime
      -- we trust for preview / provider routing. The client-declared mime
      -- is kept only for diagnostics.
      --
      -- extraction_json holds the metadata-only extraction result (status,
      -- bytes extracted, char count, truncation flags, label). The
      -- extracted text itself is stored separately in extracted_text so
      -- exports can trivially omit it.
      CREATE TABLE attachments (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK (state IN ('uploading','ready','failed','bound')),
        storage_key TEXT NOT NULL,
        sanitized_display_name TEXT NOT NULL,
        declared_mime TEXT NOT NULL,
        sniffed_mime TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN (
          'image','pdf','audio','video','text','archive','document','binary'
        )),
        byte_size INTEGER NOT NULL,
        content_sha256 TEXT NOT NULL,
        extraction_status TEXT NOT NULL DEFAULT 'none' CHECK (extraction_status IN (
          'none','text_extracted','truncated','encrypted','unsupported','failed','pending'
        )),
        extraction_json TEXT NOT NULL DEFAULT '{}',
        extracted_text TEXT,
        failure_code TEXT,
        failure_message TEXT,
        created_at TEXT NOT NULL,
        bound_at TEXT
      );
      CREATE INDEX attachments_conversation ON attachments(conversation_id, created_at DESC);
      CREATE INDEX attachments_state ON attachments(state);
      CREATE UNIQUE INDEX attachments_storage_key ON attachments(storage_key);

      -- Immutable link table: once a user message is created the ordered
      -- list of attachment refs is written here in one transaction and
      -- never mutated. 'position' preserves the composer order the user
      -- saw at send. The attachment row's own state goes to 'bound' at the
      -- same time; the UNIQUE index ensures an attachment can only be
      -- bound to one message.
      CREATE TABLE message_attachments (
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE RESTRICT,
        position INTEGER NOT NULL,
        PRIMARY KEY (message_id, position),
        UNIQUE (attachment_id)
      );
      CREATE INDEX message_attachments_attachment ON message_attachments(attachment_id);
    `,
  },
  {
    id: 3,
    name: "attachment_image_dimensions",
    up: `
      -- Persist header-sniffed image dimensions so the native-routing
      -- code can enforce per-side and pixel-count caps without re-reading
      -- the blob. Null for non-images and for formats whose dimensions
      -- cannot be read from the 64-byte head slice (JPEG; the byte-size
      -- cap still bounds those).
      ALTER TABLE attachments ADD COLUMN sniffed_width INTEGER;
      ALTER TABLE attachments ADD COLUMN sniffed_height INTEGER;
    `,
  },
  {
    id: 4,
    name: "attachment_validated_metadata",
    up: `
      -- PDF: Poppler pdfinfo-reported page count, persisted after the
      -- bounded extractor runs so the native-routing path can enforce
      -- the per-page token reserve without re-spawning the subprocess.
      -- Null when the PDF was encrypted / malformed / Poppler
      -- unavailable.
      ALTER TABLE attachments ADD COLUMN sniffed_pdf_pages INTEGER;

      -- Audio / video: ffprobe-reported duration (milliseconds) and the
      -- bounded sanitized stream summary (codec_type, codec_name, and
      -- when relevant width/height/channels/sample_rate). Routing
      -- refuses native audio/video routing when duration is null.
      ALTER TABLE attachments ADD COLUMN sniffed_media_duration_ms INTEGER;
      ALTER TABLE attachments ADD COLUMN sniffed_media_streams_json TEXT;
    `,
  },
  {
    id: 5,
    name: "attachment_validated_media_identity",
    up: `
      -- Validated container format (ffprobe format_name) and the media
      -- MIME normalized for provider wire use. Added as a separate
      -- migration: migration 4 may already be applied in a database that
      -- was not inspected, and applied migrations are never edited.
      ALTER TABLE attachments ADD COLUMN validated_media_format TEXT;
      ALTER TABLE attachments ADD COLUMN normalized_media_mime TEXT;
    `,
  },
];

export function runMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  const applied = new Set<number>(
    db
      .prepare("SELECT id FROM schema_migrations")
      .all()
      .map((row) => Number((row as { id: number }).id)),
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    db.exec("BEGIN");
    try {
      db.exec(migration.up);
      db.prepare(
        "INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)",
      ).run(migration.id, migration.name, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}
