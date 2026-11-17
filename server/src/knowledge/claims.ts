import type { Db } from '../db/index.ts';
import { newId, nowIso } from '../lib/ids.ts';
import { normalizeTitle, splitSentences } from './terms.ts';
import { truncate } from '../lib/ids.ts';

export interface ExtractedClaim {
  text: string;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  section: string;
}

const GENERIC_SUBJECTS = new Set([
  '我们', '你们', '他们', '它', '这', '那', '其中', '本文', '本图', '本表', '上述', '以下', '例如', '比如', '因此', '所以', '但是', '然而',
]);

function cleanSubject(value: string): string {
  return value
    .replace(/^[\s\d.、,，;；:：\-—•*]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSubject(value: string): boolean {
  const subject = cleanSubject(value);
  if (subject.length < 2 || subject.length > 48) return false;
  if (GENERIC_SUBJECTS.has(subject)) return false;
  if (/^(?:第[一二三四五六七八九十]+|图|表|注|资料来源|数据来源)/.test(subject)) return false;
  return /[\p{L}\p{N}]/u.test(subject);
}

/** 规则式主张抽取：定义、分类、属性、包含关系；宁可少抽，不制造空话。 */
export function extractClaims(text: string, section = '', limit = 24): ExtractedClaim[] {
  const claims: ExtractedClaim[] = [];
  const seen = new Set<string>();
  const patterns: { regex: RegExp; predicate: string }[] = [
    { regex: /^(.{2,48}?)(?:是指|指的是|被定义为|定义为|是一种|是一个|是一类)(.{6,300})$/, predicate: '定义' },
    { regex: /^(.{2,48}?)(?:包括|包含|涵盖)(.{4,300})$/, predicate: '包含' },
    { regex: /^(.{2,48}?)(?:由)(.{4,300}?)(?:组成|构成)$/, predicate: '组成' },
    { regex: /^(.{2,48}?)(?:分为|可以分为|划分为)(.{4,300})$/, predicate: '分类' },
    { regex: /^(.{2,48}?)(?:支持|提供|具备|具有)(.{4,300})$/, predicate: '能力' },
    { regex: /^(.{2,48}?)[：:](.{6,300})$/, predicate: '说明' },
    { regex: /^(.{2,48}?)(?:是)(.{6,300})$/, predicate: '是' },
    { regex: /^(.{2,48}?)(?:需要|必须|应当|应该)(.{4,300})$/, predicate: '要求' },
  ];

  for (const sentence of splitSentences(text)) {
    const value = sentence.trim().replace(/^[-•*\d.\s]+/, '');
    if (value.length < 12 || value.length > 340) continue;
    for (const { regex, predicate } of patterns) {
      const match = value.match(regex);
      if (!match) continue;
      const subject = cleanSubject(match[1]!);
      const object = match[2]!.replace(/[。；;]+$/, '').trim();
      if (!isSubject(subject) || object.length < 4) continue;
      const key = `${normalizeTitle(subject)}|${predicate}|${normalizeTitle(object)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      claims.push({
        text: truncate(value, 320),
        subject,
        predicate,
        object: truncate(object, 280),
        confidence: predicate === '定义' ? 0.62 : predicate === '是' ? 0.5 : 0.56,
        section,
      });
      break;
    }
    if (claims.length >= limit) break;
  }
  return claims;
}

export function saveClaims(
  db: Db,
  pageId: string,
  claims: ExtractedClaim[],
  sourceId?: string | null,
): number {
  let inserted = 0;
  const existing = db.prepare('SELECT text FROM claims WHERE page_id = ?').all(pageId) as unknown as { text: string }[];
  const existingTexts = new Set(existing.map((row) => normalizeTitle(row.text)));
  for (const claim of claims) {
    if (existingTexts.has(normalizeTitle(claim.text))) continue;
    existingTexts.add(normalizeTitle(claim.text));
    db.prepare(
      `INSERT INTO claims (id, page_id, text, subject, predicate, object, confidence, source_id, section, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    ).run(
      newId('clm'),
      pageId,
      claim.text,
      claim.subject,
      claim.predicate,
      claim.object,
      claim.confidence,
      sourceId ?? null,
      claim.section,
      nowIso(),
    );
    inserted += 1;
  }
  return inserted;
}

function objectKey(value: string): string {
  return normalizeTitle(value).slice(0, 80);
}

function similar(a: string, b: string): boolean {
  const left = objectKey(a);
  const right = objectKey(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.includes(right) || right.includes(left)) return true;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length > right.length ? left : right;
  let matched = 0;
  for (const char of shorter) if (longer.includes(char)) matched += 1;
  return matched / shorter.length > 0.85;
}

/**
 * 入库时检测矛盾：同一主语 + 同一谓词，但宾语不同。
 * 保留双方主张，标记 conflicted，让人来裁决，而不是静默覆盖。
 */
export function detectConflicts(db: Db, pageId: string): { count: number; details: string[] } {
  const claims = db
    .prepare('SELECT id, subject, predicate, object, text FROM claims WHERE page_id = ? AND status = ?')
    .all(pageId, 'active') as unknown as { id: string; subject: string; predicate: string; object: string; text: string }[];
  const details: string[] = [];
  let count = 0;
  for (const claim of claims) {
    if (!claim.subject || !claim.predicate || !claim.object) continue;
    const rivals = db
      .prepare(
        `SELECT c.id, c.page_id, c.object, c.text, p.title FROM claims c JOIN pages p ON p.id = c.page_id
          WHERE c.page_id <> ? AND c.status = 'active' AND c.predicate = ?
            AND lower(c.subject) = lower(?) LIMIT 8`,
      )
      .all(pageId, claim.predicate, claim.subject) as unknown as {
      id: string;
      page_id: string;
      object: string;
      text: string;
      title: string;
    }[];
    for (const rival of rivals) {
      if (!rival.object || similar(claim.object, rival.object)) continue;
      db.prepare("UPDATE claims SET status = 'conflicted' WHERE id IN (?, ?)").run(claim.id, rival.id);
      db.prepare(
        "UPDATE pages SET status = 'draft', review_status = 'unreviewed', review_note = ?, updated_at = ? WHERE id IN (?, ?)",
      ).run(`检测到与《${rival.title}》的主张矛盾`, nowIso(), pageId, rival.page_id);
      const libraryRow = db.prepare('SELECT library_id FROM pages WHERE id = ?').get(pageId) as unknown as { library_id: string } | undefined;
      if (libraryRow) {
        db.prepare("INSERT OR IGNORE INTO contradictions (id, library_id, subject, predicate, claim_id, rival_claim_id, status, severity, created_at) VALUES (?, ?, ?, ?, ?, ?, 'unresolved', 'medium', ?)").run(newId('con'), libraryRow.library_id, claim.subject, claim.predicate, claim.id, rival.id, nowIso());
      }
      count += 1;
      details.push(`「${claim.subject}」在《${rival.title}》中的说法与本页不一致`);
    }
  }
  return { count, details };
}
