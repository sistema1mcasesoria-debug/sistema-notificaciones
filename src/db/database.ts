import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

let dbInstance: DatabaseSync | null = null;

export function getDatabase(dbPath: string): DatabaseSync {
  if (dbInstance) {
    return dbInstance;
  }

  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  initializeSchema(db);
  dbInstance = db;
  return db;
}

function initializeSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      login_mode TEXT NOT NULL CHECK(login_mode IN ('RUC', 'DNI')) DEFAULT 'RUC',
      doc_number TEXT NOT NULL,
      sol_user_enc TEXT,
      sol_password_enc TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      last_checked_at TEXT,
      last_status TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      UNIQUE(login_mode, doc_number)
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      external_hash TEXT NOT NULL,
      sunat_code TEXT,
      subject TEXT NOT NULL,
      sender TEXT,
      notification_type TEXT,
      published_at TEXT,
      read_status_sunat TEXT,
      is_new_alert INTEGER NOT NULL DEFAULT 1,
      raw_row_json TEXT,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      UNIQUE(client_id, external_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_notifications_client_new
      ON notifications(client_id, is_new_alert, first_seen_at DESC);

    CREATE TABLE IF NOT EXISTS check_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      status TEXT NOT NULL,
      total_found INTEGER NOT NULL DEFAULT 0,
      new_found INTEGER NOT NULL DEFAULT 0,
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    DELETE FROM notifications WHERE published_at IS NULL;
  `);

  const applied = db
    .prepare('SELECT 1 FROM schema_migrations WHERE id = ?')
    .get('v2_clean_legacy_v1_noise');

  if (!applied) {
    db.prepare(
      "DELETE FROM notifications WHERE published_at IS NULL AND raw_row_json LIKE '{\"text\":%'",
    ).run();
    db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run('v2_clean_legacy_v1_noise');
  }

  const appliedV3 = db
    .prepare('SELECT 1 FROM schema_migrations WHERE id = ?')
    .get('v3_clean_dateless_notifications');

  if (!appliedV3) {
    db.prepare('DELETE FROM notifications WHERE published_at IS NULL').run();
    db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(
      'v3_clean_dateless_notifications',
    );
  }

  const appliedV4 = db
    .prepare('SELECT 1 FROM schema_migrations WHERE id = ?')
    .get('v4_sync_read_status_alerts');

  if (!appliedV4) {
    db.prepare("UPDATE notifications SET is_new_alert = 0 WHERE read_status_sunat = 'Leído' AND is_new_alert = 1").run();
    db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(
      'v4_sync_read_status_alerts',
    );
  }

  const appliedV5 = db
    .prepare('SELECT 1 FROM schema_migrations WHERE id = ?')
    .get('v5_add_attachments_columns');

  if (!appliedV5) {
    try {
      db.prepare('ALTER TABLE notifications ADD COLUMN attachment_path TEXT').run();
    } catch {}
    try {
      db.prepare('ALTER TABLE notifications ADD COLUMN attachment_name TEXT').run();
    } catch {}
    db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(
      'v5_add_attachments_columns',
    );
  }

  const appliedV6 = db
    .prepare('SELECT 1 FROM schema_migrations WHERE id = ?')
    .get('v6_add_mailbox_source_column');

  if (!appliedV6) {
    try {
      db.prepare(
        "ALTER TABLE notifications ADD COLUMN mailbox_source TEXT NOT NULL DEFAULT 'NOTIFICACIONES'",
      ).run();
    } catch {}
    db.prepare(
      "UPDATE notifications SET mailbox_source = 'MENSAJES' WHERE LOWER(COALESCE(notification_type, '')) LIKE '%mensaje%'",
    ).run();
    db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(
      'v6_add_mailbox_source_column',
    );
  }

  const appliedV7 = db
    .prepare('SELECT 1 FROM schema_migrations WHERE id = ?')
    .get('v7_clean_message_body_table_noise');

  if (!appliedV7) {
    db.prepare(`
      DELETE FROM notifications
      WHERE raw_row_json LIKE '%Tipo de Comprobante%'
         OR raw_row_json LIKE '%Pendiente (Puesto a disposición)%'
         OR raw_row_json LIKE '%col_27%'
         OR subject LIKE 'RUC:%GEN INVERSIONES Y MULTISERVICIOS%'
         OR subject LIKE 'PHQ CONSULTING S.A.C.%'
    `).run();
    db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(
      'v7_clean_message_body_table_noise',
    );
  }
}

export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
