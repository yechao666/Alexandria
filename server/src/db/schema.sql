-- Alexandria schema v1
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS persons (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  avatar_color  TEXT NOT NULL DEFAULT 'clay',
  is_admin      INTEGER NOT NULL DEFAULT 0,
  password_hash TEXT NOT NULL,
  wecom_userid  TEXT,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT,
  totp_secret   TEXT,
  totp_enabled  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS teams (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  slug           TEXT NOT NULL UNIQUE,
  parent_id      TEXT REFERENCES teams(id) ON DELETE SET NULL,
  description    TEXT NOT NULL DEFAULT '',
  lead_person_id TEXT REFERENCES persons(id) ON DELETE SET NULL,
  wecom_dept_id  TEXT,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_teams_parent ON teams(parent_id);

CREATE TABLE IF NOT EXISTS team_members (
  team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  person_id  TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL,
  PRIMARY KEY (team_id, person_id)
);
CREATE INDEX IF NOT EXISTS idx_team_members_person ON team_members(person_id);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  person_id  TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip         TEXT,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS recovery_codes (
  id         TEXT PRIMARY KEY,
  person_id  TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recovery_person ON recovery_codes(person_id, used_at);

CREATE TABLE IF NOT EXISTS login_challenges (
  token_hash TEXT PRIMARY KEY,
  person_id  TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  person_id    TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  prefix       TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  scope        TEXT NOT NULL DEFAULT 'read',
  last_used_at TEXT,
  revoked_at   TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS libraries (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  icon          TEXT NOT NULL DEFAULT 'book',
  color         TEXT NOT NULL DEFAULT 'jade',
  kind          TEXT NOT NULL DEFAULT 'wiki',
  visibility    TEXT NOT NULL DEFAULT 'internal',
  owner_team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  created_by    TEXT REFERENCES persons(id) ON DELETE SET NULL,
  settings      TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS library_grants (
  id           TEXT PRIMARY KEY,
  library_id   TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  role         TEXT NOT NULL,
  created_by   TEXT REFERENCES persons(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL,
  UNIQUE(library_id, subject_type, subject_id)
);
CREATE INDEX IF NOT EXISTS idx_grants_library ON library_grants(library_id);
CREATE INDEX IF NOT EXISTS idx_grants_subject ON library_grants(subject_type, subject_id);

CREATE TABLE IF NOT EXISTS resource_grants (
  id            TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL,
  resource_id   TEXT NOT NULL,
  subject_type  TEXT NOT NULL,
  subject_id    TEXT NOT NULL,
  role          TEXT NOT NULL,
  created_by    TEXT REFERENCES persons(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL,
  UNIQUE(resource_type, resource_id, subject_type, subject_id)
);
CREATE INDEX IF NOT EXISTS idx_resource_grants_resource ON resource_grants(resource_type, resource_id);


CREATE TABLE IF NOT EXISTS catalog_nodes (
  id          TEXT PRIMARY KEY,
  library_id  TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  parent_id   TEXT REFERENCES catalog_nodes(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'section',
  code        TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  icon        TEXT NOT NULL DEFAULT '',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  UNIQUE(library_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_nodes_library ON catalog_nodes(library_id, parent_id);

CREATE TABLE IF NOT EXISTS ontology_classes (
  id          TEXT PRIMARY KEY,
  library_id  TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon        TEXT NOT NULL DEFAULT 'circle',
  color       TEXT NOT NULL DEFAULT 'jade',
  schema_json TEXT NOT NULL DEFAULT '{}',
  builtin     INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  UNIQUE(library_id, key)
);

CREATE TABLE IF NOT EXISTS ontology_properties (
  id          TEXT PRIMARY KEY,
  library_id  TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  class_key   TEXT,
  key         TEXT NOT NULL,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'string',
  description TEXT NOT NULL DEFAULT '',
  required    INTEGER NOT NULL DEFAULT 0,
  options     TEXT NOT NULL DEFAULT '[]',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  UNIQUE(library_id, class_key, key)
);
CREATE INDEX IF NOT EXISTS idx_ontology_properties_library ON ontology_properties(library_id, class_key);

CREATE TABLE IF NOT EXISTS ontology_relations (
  id           TEXT PRIMARY KEY,
  library_id   TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  key          TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  source_class TEXT,
  target_class TEXT,
  inverse_name TEXT NOT NULL DEFAULT '',
  color        TEXT NOT NULL DEFAULT 'ink',
  created_at   TEXT NOT NULL,
  UNIQUE(library_id, key)
);

CREATE TABLE IF NOT EXISTS sources (
  id             TEXT PRIMARY KEY,
  library_id     TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  node_id        TEXT REFERENCES catalog_nodes(id) ON DELETE SET NULL,
  title          TEXT NOT NULL,
  filename       TEXT NOT NULL,
  ext            TEXT NOT NULL,
  mime           TEXT NOT NULL DEFAULT '',
  size           INTEGER NOT NULL DEFAULT 0,
  sha256         TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'text',
  storage_path   TEXT NOT NULL,
  visibility     TEXT NOT NULL DEFAULT 'inherit',
  status         TEXT NOT NULL DEFAULT 'queued',
  language       TEXT NOT NULL DEFAULT 'zh',
  page_count     INTEGER NOT NULL DEFAULT 0,
  word_count     INTEGER NOT NULL DEFAULT 0,
  excerpt        TEXT NOT NULL DEFAULT '',
  extracted_text TEXT NOT NULL DEFAULT '',
  metadata       TEXT NOT NULL DEFAULT '{}',
  uploaded_by    TEXT REFERENCES persons(id) ON DELETE SET NULL,
  error          TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE(library_id, sha256)
);
CREATE INDEX IF NOT EXISTS idx_sources_library ON sources(library_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sources_node ON sources(node_id);

CREATE TABLE IF NOT EXISTS source_assets (
  id          TEXT PRIMARY KEY,
  source_id   TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'image',
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL DEFAULT '',
  storage_path TEXT NOT NULL,
  thumbnail_path TEXT,
  sha256      TEXT NOT NULL DEFAULT '',
  width       INTEGER,
  height      INTEGER,
  ocr_text    TEXT NOT NULL DEFAULT '',
  metadata    TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assets_source ON source_assets(source_id);

CREATE TABLE IF NOT EXISTS ingest_jobs (
  id          TEXT PRIMARY KEY,
  library_id  TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  source_id   TEXT REFERENCES sources(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'queued',
  stage       TEXT NOT NULL DEFAULT 'queued',
  progress    INTEGER NOT NULL DEFAULT 0,
  compiler    TEXT NOT NULL DEFAULT 'rule',
  pages_created INTEGER NOT NULL DEFAULT 0,
  pages_updated INTEGER NOT NULL DEFAULT 0,
  conflicts   INTEGER NOT NULL DEFAULT 0,
  log         TEXT NOT NULL DEFAULT '[]',
  error       TEXT,
  started_at  TEXT,
  finished_at TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_source ON ingest_jobs(source_id);

CREATE TABLE IF NOT EXISTS job_events (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL REFERENCES ingest_jobs(id) ON DELETE CASCADE,
  step        TEXT NOT NULL,
  status      TEXT NOT NULL,
  message     TEXT NOT NULL DEFAULT '',
  progress    INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id, created_at);


CREATE TABLE IF NOT EXISTS pages (
  id             TEXT PRIMARY KEY,
  library_id     TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  node_id        TEXT REFERENCES catalog_nodes(id) ON DELETE SET NULL,
  class_key      TEXT NOT NULL DEFAULT 'concept',
  slug           TEXT NOT NULL,
  title          TEXT NOT NULL,
  summary        TEXT NOT NULL DEFAULT '',
  tldr           TEXT NOT NULL DEFAULT '',
  body           TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'active',
  visibility     TEXT NOT NULL DEFAULT 'inherit',
  review_status  TEXT NOT NULL DEFAULT 'unreviewed',
  review_note    TEXT NOT NULL DEFAULT '',
  reviewed_by    TEXT REFERENCES persons(id) ON DELETE SET NULL,
  reviewed_at    TEXT,
  confidence     REAL NOT NULL DEFAULT 0.5,
  tags           TEXT NOT NULL DEFAULT '[]',
  aliases        TEXT NOT NULL DEFAULT '[]',
  read_when      TEXT NOT NULL DEFAULT '[]',
  owner_person_id TEXT REFERENCES persons(id) ON DELETE SET NULL,
  superseded_by  TEXT,
  metadata       TEXT NOT NULL DEFAULT '{}',
  version        INTEGER NOT NULL DEFAULT 1,
  created_by     TEXT REFERENCES persons(id) ON DELETE SET NULL,
  updated_by     TEXT REFERENCES persons(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE(library_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_pages_library ON pages(library_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_pages_node ON pages(node_id);
CREATE INDEX IF NOT EXISTS idx_pages_class ON pages(library_id, class_key);

CREATE TABLE IF NOT EXISTS page_sources (
  page_id   TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  relation  TEXT NOT NULL DEFAULT 'derived-from',
  locator   TEXT NOT NULL DEFAULT '',
  quote     TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (page_id, source_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_page_sources_source ON page_sources(source_id);

CREATE TABLE IF NOT EXISTS claims (
  id          TEXT PRIMARY KEY,
  page_id     TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  subject     TEXT NOT NULL DEFAULT '',
  predicate   TEXT NOT NULL DEFAULT '',
  object      TEXT NOT NULL DEFAULT '',
  confidence  REAL NOT NULL DEFAULT 0.5,
  source_id   TEXT REFERENCES sources(id) ON DELETE SET NULL,
  section     TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claims_page ON claims(page_id);
CREATE INDEX IF NOT EXISTS idx_claims_subject ON claims(subject, predicate);

CREATE TABLE IF NOT EXISTS links (
  id           TEXT PRIMARY KEY,
  library_id   TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  from_page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  to_page_id   TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  relation     TEXT NOT NULL DEFAULT 'references',
  origin       TEXT NOT NULL DEFAULT 'body',
  weight       REAL NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  UNIQUE(from_page_id, to_page_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_page_id);
CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_page_id);

CREATE TABLE IF NOT EXISTS comments (
  id          TEXT PRIMARY KEY,
  library_id  TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  page_id     TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  parent_id   TEXT REFERENCES comments(id) ON DELETE CASCADE,
  author_id   TEXT REFERENCES persons(id) ON DELETE SET NULL,
  body        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',
  resolved_by TEXT REFERENCES persons(id) ON DELETE SET NULL,
  resolved_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_page ON comments(page_id, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_library ON comments(library_id, created_at);

CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,
  person_id  TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  actor_id   TEXT REFERENCES persons(id) ON DELETE SET NULL,
  kind       TEXT NOT NULL DEFAULT 'info',
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  link       TEXT NOT NULL DEFAULT '',
  library_id TEXT REFERENCES libraries(id) ON DELETE CASCADE,
  page_id    TEXT REFERENCES pages(id) ON DELETE CASCADE,
  read_at    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_person ON notifications(person_id, read_at, created_at);

CREATE TABLE IF NOT EXISTS page_revisions (
  id        TEXT PRIMARY KEY,
  page_id   TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  version   INTEGER NOT NULL,
  snapshot  TEXT NOT NULL,
  editor_id TEXT REFERENCES persons(id) ON DELETE SET NULL,
  note      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS page_properties (
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  key     TEXT NOT NULL,
  value   TEXT NOT NULL,
  PRIMARY KEY (page_id, key)
);

CREATE TABLE IF NOT EXISTS saved_searches (
  id         TEXT PRIMARY KEY,
  person_id  TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  library_id TEXT REFERENCES libraries(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  params     TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_saved_searches_person ON saved_searches(person_id, created_at);

CREATE TABLE IF NOT EXISTS search_queries (
  id         TEXT PRIMARY KEY,
  person_id  TEXT REFERENCES persons(id) ON DELETE SET NULL,
  library_id TEXT REFERENCES libraries(id) ON DELETE SET NULL,
  query      TEXT NOT NULL,
  mode       TEXT NOT NULL DEFAULT 'compiled',
  hits       INTEGER NOT NULL DEFAULT 0,
  took_ms    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_search_queries_person ON search_queries(person_id, created_at);

CREATE TABLE IF NOT EXISTS audit_events (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT,
  actor_name  TEXT NOT NULL DEFAULT '',
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_id   TEXT NOT NULL DEFAULT '',
  library_id  TEXT,
  detail      TEXT NOT NULL DEFAULT '{}',
  ip          TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_library ON audit_events(library_id, created_at);

CREATE TABLE IF NOT EXISTS oidc_states (
  state      TEXT PRIMARY KEY,
  return_to  TEXT NOT NULL DEFAULT '/',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trash_pages (
  id          TEXT PRIMARY KEY,
  page_id     TEXT NOT NULL,
  library_id  TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  snapshot    TEXT NOT NULL,
  deleted_by  TEXT REFERENCES persons(id) ON DELETE SET NULL,
  deleted_at  TEXT NOT NULL,
  restored_at TEXT,
  restored_page_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_trash_library ON trash_pages(library_id, restored_at);

CREATE TABLE IF NOT EXISTS merge_proposals (
  id             TEXT PRIMARY KEY,
  library_id     TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  source_page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  target_page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  score          REAL NOT NULL DEFAULT 0,
  reasons        TEXT NOT NULL DEFAULT '[]',
  status         TEXT NOT NULL DEFAULT 'pending',
  created_by     TEXT REFERENCES persons(id) ON DELETE SET NULL,
  reviewed_by    TEXT REFERENCES persons(id) ON DELETE SET NULL,
  reviewed_at    TEXT,
  created_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_merge_proposals_pending
  ON merge_proposals(library_id, source_page_id, target_page_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS security_events (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  severity   TEXT NOT NULL DEFAULT 'info',
  actor_id   TEXT REFERENCES persons(id) ON DELETE SET NULL,
  subject    TEXT NOT NULL DEFAULT '',
  ip         TEXT,
  detail     TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_security_events_created ON security_events(created_at);

CREATE TABLE IF NOT EXISTS wecom_auth_states (
  state      TEXT PRIMARY KEY,
  return_to  TEXT NOT NULL DEFAULT '/',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wecom_sync_runs (
  id                  TEXT PRIMARY KEY,
  actor_id            TEXT REFERENCES persons(id) ON DELETE SET NULL,
  mode                TEXT NOT NULL DEFAULT 'mock',
  dry_run             INTEGER NOT NULL DEFAULT 1,
  departments         INTEGER NOT NULL DEFAULT 0,
  users               INTEGER NOT NULL DEFAULT 0,
  applied_departments INTEGER NOT NULL DEFAULT 0,
  applied_users       INTEGER NOT NULL DEFAULT 0,
  deactivated         INTEGER NOT NULL DEFAULT 0,
  detail              TEXT NOT NULL DEFAULT '{}',
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wecom_sync_runs_created ON wecom_sync_runs(created_at);

CREATE TABLE IF NOT EXISTS wecom_links (
  id          TEXT PRIMARY KEY,
  person_id   TEXT REFERENCES persons(id) ON DELETE CASCADE,
  wecom_userid TEXT NOT NULL,
  synced_at   TEXT,
  raw         TEXT NOT NULL DEFAULT '{}',
  UNIQUE(wecom_userid)
);

-- 全量文本索引。terms 由 Alexandria 分词器写入：CJK 单字/双字 + 拉丁词。
CREATE VIRTUAL TABLE IF NOT EXISTS page_fts USING fts5(
  page_id UNINDEXED,
  library_id UNINDEXED,
  title,
  summary,
  body,
  terms,
  tags,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE IF NOT EXISTS source_fts USING fts5(
  source_id UNINDEXED,
  library_id UNINDEXED,
  title,
  excerpt,
  text,
  terms,
  tokenize = 'unicode61 remove_diacritics 2'
);
