import type { Db } from '../db/index.ts';
import type { Actor, PageRow } from '../types.ts';
import { newId, nowIso, parseJson, slugify, truncate } from '../lib/ids.ts';
import { normalizeTitle, snippet, termsString } from './terms.ts';
import { errors } from '../http/respond.ts';

export interface PageInput {
  libraryId: string;
  nodeId?: string | null;
  classKey?: string;
  title: string;
  slug?: string;
  summary?: string;
  tldr?: string;
  body?: string;
  status?: string;
  confidence?: number;
  tags?: string[];
  aliases?: string[];
  readWhen?: string[];
  ownerPersonId?: string | null;
  metadata?: Record<string, unknown>;
  createdBy?: string | null;
}

export interface PageView extends PageRow {
  tagsList: string[];
  aliasesList: string[];
  readWhenList: string[];
  metadataObj: Record<string, unknown>;
  className: string;
  classColor: string;
  nodeName: string | null;
  creatorName: string | null;
  updaterName: string | null;
}

export function uniqueSlug(db: Db, libraryId: string, base: string): string {
  let slug = base;
  let counter = 2;
  while (db.prepare('SELECT 1 FROM pages WHERE library_id = ? AND slug = ?').get(libraryId, slug)) {
    slug = `${base}-${counter}`;
    counter += 1;
    if (counter > 200) {
      slug = `${base}-${Date.now().toString(36)}`;
      break;
    }
  }
  return slug;
}

export function pageToView(db: Db, row: PageRow): PageView {
  const klass = db
    .prepare('SELECT name, color FROM ontology_classes WHERE library_id = ? AND key = ?')
    .get(row.library_id, row.class_key) as unknown as { name: string; color: string } | undefined;
  const node = row.node_id
    ? (db.prepare('SELECT name FROM catalog_nodes WHERE id = ?').get(row.node_id) as unknown as { name: string } | undefined)
    : undefined;
  const creator = row.created_by
    ? (db.prepare('SELECT name FROM persons WHERE id = ?').get(row.created_by) as unknown as { name: string } | undefined)
    : undefined;
  const updater = row.updated_by
    ? (db.prepare('SELECT name FROM persons WHERE id = ?').get(row.updated_by) as unknown as { name: string } | undefined)
    : undefined;
  return {
    ...row,
    tagsList: parseJson<string[]>(row.tags, []),
    aliasesList: parseJson<string[]>(row.aliases, []),
    readWhenList: parseJson<string[]>(row.read_when, []),
    metadataObj: parseJson<Record<string, unknown>>(row.metadata, {}),
    className: klass?.name ?? row.class_key,
    classColor: klass?.color ?? 'jade',
    nodeName: node?.name ?? null,
    creatorName: creator?.name ?? null,
    updaterName: updater?.name ?? null,
  };
}

export function getPage(db: Db, idOrSlug: string): PageRow | null {
  const row = db
    .prepare('SELECT * FROM pages WHERE id = ? OR slug = ?')
    .get(idOrSlug, idOrSlug) as unknown as PageRow | undefined;
  return row ?? null;
}

export function indexPage(db: Db, page: PageRow): void {
  db.prepare('DELETE FROM page_fts WHERE page_id = ?').run(page.id);
  const tags = parseJson<string[]>(page.tags, []).join(' ');
  const aliases = parseJson<string[]>(page.aliases, []).join(' ');
  const readWhen = parseJson<string[]>(page.read_when, []).join(' ');
  db.prepare(
    `INSERT INTO page_fts (page_id, library_id, title, summary, body, terms, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    page.id,
    page.library_id,
    page.title,
    `${page.summary} ${page.tldr}`,
    page.body,
    termsString(`${page.title} ${aliases} ${tags} ${readWhen} ${page.summary} ${page.tldr} ${page.body}`),
    termsString(`${tags} ${aliases} ${readWhen}`),
  );
}

export function removePageIndex(db: Db, pageId: string): void {
  db.prepare('DELETE FROM page_fts WHERE page_id = ?').run(pageId);
}

export function indexSource(
  db: Db,
  source: { id: string; library_id: string; title: string; excerpt: string; extracted_text: string },
): void {
  db.prepare('DELETE FROM source_fts WHERE source_id = ?').run(source.id);
  db.prepare(
    `INSERT INTO source_fts (source_id, library_id, title, excerpt, text, terms)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    source.id,
    source.library_id,
    source.title,
    source.excerpt,
    source.extracted_text,
    termsString(`${source.title} ${source.excerpt} ${source.extracted_text}`),
  );
}

const WIKILINK = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g;

export function parseWikiLinks(body: string): { target: string; label: string }[] {
  const found: { target: string; label: string }[] = [];
  for (const match of String(body ?? '').matchAll(WIKILINK)) {
    const target = match[1]!.trim();
    if (target) found.push({ target, label: (match[2] ?? target).trim() });
  }
  return found;
}

export function resolvePageRef(db: Db, libraryId: string, ref: string): PageRow | null {
  const direct = db
    .prepare('SELECT * FROM pages WHERE library_id = ? AND slug = ?')
    .get(libraryId, ref.trim()) as unknown as PageRow | undefined;
  if (direct) return direct;
  const pages = db.prepare('SELECT * FROM pages WHERE library_id = ?').all(libraryId) as unknown as PageRow[];
  const normalized = normalizeTitle(ref);
  return (
    pages.find((page) => normalizeTitle(page.title) === normalized) ??
    pages.find((page) => parseJson<string[]>(page.aliases, []).some((alias) => normalizeTitle(alias) === normalized)) ??
    null
  );
}

export function rebuildBodyLinks(db: Db, page: PageRow): number {
  db.prepare("DELETE FROM links WHERE from_page_id = ? AND origin = 'body'").run(page.id);
  let count = 0;
  const seen = new Set<string>();
  const body = page.body.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
  for (const link of parseWikiLinks(body)) {
    const target = resolvePageRef(db, page.library_id, link.target);
    if (!target || target.id === page.id || seen.has(target.id)) continue;
    seen.add(target.id);
    db.prepare(
      `INSERT OR IGNORE INTO links (id, library_id, from_page_id, to_page_id, relation, origin, weight, created_at)
       VALUES (?, ?, ?, ?, 'references', 'body', 1, ?)`,
    ).run(newId('lnk'), page.library_id, page.id, target.id, nowIso());
    count += 1;
  }
  return count;
}

function backfillLinksTo(db: Db, page: PageRow): void {
  const pages = db.prepare('SELECT * FROM pages WHERE library_id = ? AND id <> ?').all(page.library_id, page.id) as unknown as PageRow[];
  const needles = [`[[${page.slug}`, `[[${page.title}`];
  for (const other of pages) {
    if (needles.some((needle) => other.body.includes(needle))) rebuildBodyLinks(db, other);
  }
}

export function addLink(
  db: Db,
  libraryId: string,
  fromPageId: string,
  toPageId: string,
  relation: string,
  origin = 'frontmatter',
  weight = 1,
): void {
  if (fromPageId === toPageId) return;
  db.prepare(
    `INSERT OR IGNORE INTO links (id, library_id, from_page_id, to_page_id, relation, origin, weight, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(newId('lnk'), libraryId, fromPageId, toPageId, relation, origin, weight, nowIso());
}

function snapshot(page: PageRow): string {
  return JSON.stringify(page);
}

export function createPage(db: Db, input: PageInput, actor?: Actor | null): PageRow {
  const now = nowIso();
  const id = newId('pg');
  const base = input.slug?.trim() || slugify(input.title, 'page');
  const slug = uniqueSlug(db, input.libraryId, base);
  const classKey = input.classKey ?? 'concept';
  const exists = db
    .prepare('SELECT 1 FROM ontology_classes WHERE library_id = ? AND key = ?')
    .get(input.libraryId, classKey);
  if (!exists) throw errors.badRequest(`本体中不存在类型：${classKey}`);
  if (input.nodeId) {
    const node = db
      .prepare('SELECT 1 FROM catalog_nodes WHERE id = ? AND library_id = ?')
      .get(input.nodeId, input.libraryId);
    if (!node) throw errors.badRequest('目录节点不属于该知识库');
  }

  db.prepare(
    `INSERT INTO pages (id, library_id, node_id, class_key, slug, title, summary, tldr, body, status, confidence,
       tags, aliases, read_when, owner_person_id, superseded_by, metadata, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 1, ?, ?, ?, ?)`,
  ).run(
    id,
    input.libraryId,
    input.nodeId ?? null,
    classKey,
    slug,
    input.title.trim(),
    input.summary ?? truncate(input.body ?? '', 180),
    input.tldr ?? '',
    input.body ?? '',
    input.status ?? 'active',
    Math.max(0, Math.min(1, input.confidence ?? 0.5)),
    JSON.stringify(input.tags ?? []),
    JSON.stringify(input.aliases ?? []),
    JSON.stringify(input.readWhen ?? []),
    input.ownerPersonId ?? actor?.person.id ?? null,
    JSON.stringify(input.metadata ?? {}),
    input.createdBy ?? actor?.person.id ?? null,
    input.createdBy ?? actor?.person.id ?? null,
    now,
    now,
  );
  const page = getPage(db, id)!;
  db.prepare(
    'INSERT INTO page_revisions (id, page_id, version, snapshot, editor_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(newId('rev'), id, 1, snapshot(page), actor?.person.id ?? null, '创建', now);
  indexPage(db, page);
  rebuildBodyLinks(db, page);
  backfillLinksTo(db, page);
  return page;
}

export interface PagePatch {
  nodeId?: string | null;
  classKey?: string;
  title?: string;
  slug?: string;
  summary?: string;
  tldr?: string;
  body?: string;
  status?: string;
  confidence?: number;
  tags?: string[];
  aliases?: string[];
  readWhen?: string[];
  ownerPersonId?: string | null;
  metadata?: Record<string, unknown>;
  note?: string;
}

export function updatePage(db: Db, page: PageRow, patch: PagePatch, actor: Actor | null): PageRow {
  if (patch.title !== undefined && !patch.title.trim()) throw errors.badRequest('标题不能为空');
  if (patch.classKey !== undefined) {
    const exists = db
      .prepare('SELECT 1 FROM ontology_classes WHERE library_id = ? AND key = ?')
      .get(page.library_id, patch.classKey);
    if (!exists) throw errors.badRequest(`本体中不存在类型：${patch.classKey}`);
  }
  const fields: string[] = [];
  const values: (string | number | null)[] = [];
  const set = (column: string, value: string | number | null) => {
    fields.push(`${column} = ?`);
    values.push(value);
  };
  if (patch.nodeId !== undefined) set('node_id', patch.nodeId);
  if (patch.classKey !== undefined) set('class_key', patch.classKey);
  if (patch.title !== undefined) set('title', patch.title.trim());
  if (patch.slug !== undefined && patch.slug !== page.slug) set('slug', uniqueSlug(db, page.library_id, patch.slug));
  if (patch.summary !== undefined) set('summary', patch.summary);
  if (patch.tldr !== undefined) set('tldr', patch.tldr);
  if (patch.body !== undefined) set('body', patch.body);
  if (patch.status !== undefined) set('status', patch.status);
  if (patch.confidence !== undefined) set('confidence', Math.max(0, Math.min(1, patch.confidence)));
  if (patch.tags !== undefined) set('tags', JSON.stringify(patch.tags));
  if (patch.aliases !== undefined) set('aliases', JSON.stringify(patch.aliases));
  if (patch.readWhen !== undefined) set('read_when', JSON.stringify(patch.readWhen));
  if (patch.ownerPersonId !== undefined) set('owner_person_id', patch.ownerPersonId);
  if (patch.metadata !== undefined) set('metadata', JSON.stringify(patch.metadata));
  set('version', page.version + 1);
  set('updated_by', actor?.person.id ?? null);
  set('updated_at', nowIso());
  values.push(page.id);
  db.prepare(`UPDATE pages SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  const updated = getPage(db, page.id)!;
  db.prepare(
    'INSERT INTO page_revisions (id, page_id, version, snapshot, editor_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(newId('rev'), page.id, updated.version, snapshot(updated), actor?.person.id ?? null, patch.note ?? '', nowIso());
  indexPage(db, updated);
  rebuildBodyLinks(db, updated);
  if (patch.title !== undefined || patch.slug !== undefined) backfillLinksTo(db, updated);
  return updated;
}

export function deletePage(db: Db, pageId: string): void {
  removePageIndex(db, pageId);
  db.prepare('DELETE FROM pages WHERE id = ?').run(pageId);
}

export function pageSourceIds(db: Db, pageId: string): string[] {
  const rows = db
    .prepare('SELECT source_id FROM page_sources WHERE page_id = ?')
    .all(pageId) as unknown as { source_id: string }[];
  return rows.map((row) => row.source_id);
}

export function attachSource(
  db: Db,
  pageId: string,
  sourceId: string,
  relation = 'derived-from',
  locator = '',
  quote = '',
): void {
  db.prepare(
    'INSERT OR IGNORE INTO page_sources (page_id, source_id, relation, locator, quote) VALUES (?, ?, ?, ?, ?)',
  ).run(pageId, sourceId, relation, locator, truncate(quote, 500));
}

export function pageContext(db: Db, page: PageRow, maxChars = 12000): string {
  const sources = db
    .prepare(
      `SELECT s.title, ps.locator, ps.quote FROM page_sources ps JOIN sources s ON s.id = ps.source_id
        WHERE ps.page_id = ?`,
    )
    .all(page.id) as unknown as { title: string; locator: string; quote: string }[];
  const claims = db
    .prepare('SELECT text FROM claims WHERE page_id = ? AND status <> ? ORDER BY confidence DESC LIMIT 12')
    .all(page.id, 'ignored') as unknown as { text: string }[];
  const parts = [
    `# ${page.title}`,
    page.summary,
    page.body,
    claims.length ? `## 结构化主张\n${claims.map((claim) => `- ${claim.text}`).join('\n')}` : '',
    sources.length ? `## 来源\n${sources.map((source) => `- ${source.title}${source.locator ? ` · ${source.locator}` : ''}`).join('\n')}` : '',
  ];
  return truncate(parts.filter(Boolean).join('\n\n'), maxChars);
}

export function searchSnippet(page: PageRow, tokens: string[]): string {
  return snippet(`${page.summary} ${page.body}`, tokens, 200);
}
