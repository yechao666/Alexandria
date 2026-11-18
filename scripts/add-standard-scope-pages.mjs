#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase, migrate } from '../server/src/db/index.ts';
import { createPage, attachSource, addLink } from '../server/src/knowledge/pages.ts';
import { slugify, truncate } from '../server/src/lib/ids.ts';

const root = new URL('../', import.meta.url).pathname;
const db = openDatabase(join(root, 'data/alexandria.db'));
migrate(db);
const standards = JSON.parse(readFileSync(join(root, 'data/power-standards/manifest.json'), 'utf8')).standards;
const library = db.prepare("SELECT id FROM libraries WHERE slug='power-standards'").get();
let created = 0, skipped = 0;
for (const item of standards) {
  const source = db.prepare('SELECT * FROM sources WHERE library_id=? AND title LIKE ? LIMIT 1').get(library.id, `${item.code}%`);
  if (!source) { skipped++; continue; }
  const standardTitle = String(source.title).replace(/^(?:GB|DL|NB|JB|YD|IEC|IEEE)\s*\/?\s*T?\s*[\d.\-—]+\s*/, '').trim() || source.title;
  const title = `${standardTitle} · 适用范围`.slice(0, 120);
  const existing = db.prepare('SELECT id FROM pages WHERE library_id=? AND class_key=? AND lower(title)=lower(?)').get(library.id, 'howto', title);
  if (existing) { skipped++; continue; }
  let markdown = '';
  try { markdown = readFileSync(join(root, 'data/power-standards', item.file), 'utf8'); } catch { /* ignore */ }
  const scope = markdown.match(/## 适用范围\n([\s\S]*?)(?:\n## |$)/)?.[1]?.trim() || markdown.split('\n').slice(0, 20).join('\n');
  if (!scope) { skipped++; continue; }
  const page = createPage(db, {
    libraryId: library.id,
    nodeId: source.node_id,
    classKey: 'howto',
    title,
    slug: `howtos/${slugify(title, 'howto')}`,
    summary: truncate(scope, 180),
    tldr: truncate(scope, 110),
    body: `## 适用范围\n${truncate(scope, 900)}\n\n## 来源\n- [[${db.prepare("SELECT slug FROM pages WHERE id IN (SELECT page_id FROM page_sources WHERE source_id=? AND relation='source-document') LIMIT 1").get(source.id)?.slug ?? ''}|《${source.title}》]]`,
    status: 'draft',
    confidence: 0.55,
    tags: ['标准', '适用范围'],
    aliases: [],
    metadata: { compiledBy: 'rule', compiledFrom: source.id, standard: true },
    createdBy: null,
  }, null);
  attachSource(db, page.id, source.id, 'derived-from', '标准条目', scope.slice(0, 200));
  addLink(db, library.id, page.id, page.id, 'self', 'semantic', 0);
  const sourcePage = db.prepare("SELECT page_id FROM page_sources WHERE source_id=? AND relation='source-document' LIMIT 1").get(source.id);
  if (sourcePage) {
    addLink(db, library.id, page.id, sourcePage.page_id, 'derived-from', 'frontmatter', 1.1);
    addLink(db, library.id, sourcePage.page_id, page.id, 'mentions', 'frontmatter', 0.9);
  }
  created++;
}
console.log({ created, skipped });
