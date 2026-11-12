import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export type Db = DatabaseSync;
export const SCHEMA_VERSION = 2;

export function openDatabase(dbPath: string): Db {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA synchronous = NORMAL;');
  return db;
}

export function migrate(db: Db): void {
  const schema = readFileSync(join(here, 'schema.sql'), 'utf8');
  db.exec(schema);
  db.exec('PRAGMA foreign_keys = ON;');

  const columns = db.prepare('PRAGMA table_info(pages)').all() as unknown as { name: string }[];
  const has = (name: string) => columns.some((column) => column.name === name);
  if (!has('review_status')) {
    db.exec("ALTER TABLE pages ADD COLUMN review_status TEXT NOT NULL DEFAULT 'unreviewed'");
    db.exec("UPDATE pages SET review_status = CASE WHEN status = 'draft' THEN 'unreviewed' ELSE 'approved' END");
  }
  if (!has('review_note')) db.exec("ALTER TABLE pages ADD COLUMN review_note TEXT NOT NULL DEFAULT ''");
  if (!has('reviewed_by')) db.exec('ALTER TABLE pages ADD COLUMN reviewed_by TEXT REFERENCES persons(id) ON DELETE SET NULL');
  if (!has('reviewed_at')) db.exec('ALTER TABLE pages ADD COLUMN reviewed_at TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_pages_review ON pages(library_id, review_status)');

  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw error;
  }
}

export function closeDatabase(db: Db): void {
  try {
    db.close();
  } catch {
    /* ignore */
  }
}

export function count(db: Db, table: string): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number } | undefined;
    return Number(row?.c ?? 0);
  } catch {
    return 0;
  }
}
