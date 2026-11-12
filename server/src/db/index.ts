import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export type Db = DatabaseSync;
export const SCHEMA_VERSION = 13;

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

  const pageColumns = db.prepare('PRAGMA table_info(pages)').all() as unknown as { name: string }[];
  if (!pageColumns.some((column) => column.name === 'visibility')) {
    db.exec("ALTER TABLE pages ADD COLUMN visibility TEXT NOT NULL DEFAULT 'inherit'");
  }
  const sourceColumns = db.prepare('PRAGMA table_info(sources)').all() as unknown as { name: string }[];
  if (!sourceColumns.some((column) => column.name === 'visibility')) {
    db.exec("ALTER TABLE sources ADD COLUMN visibility TEXT NOT NULL DEFAULT 'inherit'");
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_pages_visibility ON pages(library_id, visibility)');
  const reviewColumns = db.prepare('PRAGMA table_info(pages)').all() as unknown as { name: string }[];
  if (!reviewColumns.some((column) => column.name === 'review_assignee')) db.exec('ALTER TABLE pages ADD COLUMN review_assignee TEXT REFERENCES persons(id) ON DELETE SET NULL');
  if (!reviewColumns.some((column) => column.name === 'review_reminded_at')) db.exec('ALTER TABLE pages ADD COLUMN review_reminded_at TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_pages_review_assignee ON pages(review_assignee, review_status)');
  db.exec(`CREATE TABLE IF NOT EXISTS job_events (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES ingest_jobs(id) ON DELETE CASCADE,
    step TEXT NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL DEFAULT '', progress INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER, created_at TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id, created_at)');
  db.exec(`CREATE TABLE IF NOT EXISTS saved_searches (
    id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    library_id TEXT REFERENCES libraries(id) ON DELETE CASCADE, name TEXT NOT NULL,
    params TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_saved_searches_person ON saved_searches(person_id, created_at)');
  db.exec(`CREATE TABLE IF NOT EXISTS search_queries (
    id TEXT PRIMARY KEY, person_id TEXT REFERENCES persons(id) ON DELETE SET NULL,
    library_id TEXT REFERENCES libraries(id) ON DELETE SET NULL, query TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'compiled', hits INTEGER NOT NULL DEFAULT 0,
    took_ms INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_search_queries_person ON search_queries(person_id, created_at)');
  db.exec(`CREATE TABLE IF NOT EXISTS security_events (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'info',
    actor_id TEXT REFERENCES persons(id) ON DELETE SET NULL, subject TEXT NOT NULL DEFAULT '',
    ip TEXT, detail TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_security_events_created ON security_events(created_at)');
  const personColumns = db.prepare('PRAGMA table_info(persons)').all() as unknown as { name: string }[];
  if (!personColumns.some((column) => column.name === 'totp_secret')) db.exec('ALTER TABLE persons ADD COLUMN totp_secret TEXT');
  if (!personColumns.some((column) => column.name === 'totp_enabled')) db.exec('ALTER TABLE persons ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0');
  db.exec(`CREATE TABLE IF NOT EXISTS trash_pages (
    id TEXT PRIMARY KEY, page_id TEXT NOT NULL, library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    snapshot TEXT NOT NULL, deleted_by TEXT REFERENCES persons(id) ON DELETE SET NULL, deleted_at TEXT NOT NULL,
    restored_at TEXT, restored_page_id TEXT
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_trash_library ON trash_pages(library_id, restored_at)');
  db.exec(`CREATE TABLE IF NOT EXISTS merge_proposals (
    id TEXT PRIMARY KEY, library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    source_page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    target_page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    score REAL NOT NULL DEFAULT 0, reasons TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending', created_by TEXT REFERENCES persons(id) ON DELETE SET NULL,
    reviewed_by TEXT REFERENCES persons(id) ON DELETE SET NULL, reviewed_at TEXT, created_at TEXT NOT NULL
  )`);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_merge_proposals_pending ON merge_proposals(library_id, source_page_id, target_page_id) WHERE status = 'pending'");
  db.exec(`CREATE TABLE IF NOT EXISTS recovery_codes (
    id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_recovery_person ON recovery_codes(person_id, used_at)');
  db.exec(`CREATE TABLE IF NOT EXISTS login_challenges (
    token_hash TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS oidc_states (
    state TEXT PRIMARY KEY, return_to TEXT NOT NULL DEFAULT '/', created_at TEXT NOT NULL, expires_at TEXT NOT NULL
  )`);

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
