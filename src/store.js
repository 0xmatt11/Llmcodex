import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';

export class BridgeStore {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        source_message_id TEXT NOT NULL,
        target TEXT NOT NULL,
        target_message_id TEXT,
        direction TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(source, source_message_id, target)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_hash ON messages(content_hash);
      CREATE TABLE IF NOT EXISTS dedupe_events (
        event_key TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS cursors (
        name TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  hasEvent(eventKey) {
    return Boolean(this.db.prepare('SELECT 1 FROM dedupe_events WHERE event_key = ?').get(eventKey));
  }

  recordEvent(eventKey) {
    return this.db.prepare('INSERT OR IGNORE INTO dedupe_events(event_key) VALUES (?)').run(eventKey).changes === 1;
  }

  getMapping(source, sourceMessageId, target) {
    return this.db.prepare(
      'SELECT * FROM messages WHERE source = ? AND source_message_id = ? AND target = ?'
    ).get(source, sourceMessageId, target);
  }

  recordMapping({ source, sourceMessageId, target, targetMessageId, direction, contentHash }) {
    this.db.prepare(`
      INSERT OR IGNORE INTO messages(source, source_message_id, target, target_message_id, direction, content_hash)
      VALUES (@source, @sourceMessageId, @target, @targetMessageId, @direction, @contentHash)
    `).run({ source, sourceMessageId, target, targetMessageId, direction, contentHash });
  }

  getCursor(name) {
    return this.db.prepare('SELECT value FROM cursors WHERE name = ?').get(name)?.value ?? null;
  }

  setCursor(name, value) {
    this.db.prepare(`
      INSERT INTO cursors(name, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `).run(name, value);
  }

  close() {
    this.db.close();
  }
}
