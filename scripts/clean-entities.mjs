#!/usr/bin/env node
import { openDatabase, migrate } from '../server/src/db/index.ts';
import { isKnownEntityName, isValidEntityName } from '../server/src/knowledge/entities.ts';

const db = openDatabase(new URL('../data/alexandria.db', import.meta.url).pathname);
migrate(db);
const rows = db.prepare("SELECT p.id, p.library_id, p.title, p.status, l.slug FROM pages p JOIN libraries l ON l.id = p.library_id WHERE p.class_key = 'entity' AND l.slug IN ('power-industry','power-standards')").all();
let archived = 0;
const samples = [];
for (const row of rows) {
  if (row.status === 'archived') continue;
  const standardCode = /^(?:GB|DL|NB|JB|YD|IEC|IEEE)\s*\/?\s*T?\s*[\d.]/i.test(row.title);
  if (!standardCode && (isValidEntityName(row.title) || !/[\u4e00-\u9fa5]/.test(row.title))) {
    if (row.slug !== 'power-standards' || isKnownEntityName(row.title)) continue;
  }
  db.prepare("UPDATE pages SET status = 'archived', updated_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
  archived += 1;
  if (samples.length < 15) samples.push(row.title);
}
console.log(`[clean-entities] archived=${archived} / ${rows.length}`);
console.log(samples.join('\n'));
