import type { Db } from '../db/index.ts';
import type { Actor, PageRow } from '../types.ts';
import { normalizeTitle } from './terms.ts';
import { effectivePageRole } from '../domain/access.ts';

export interface MergeSuggestion {
  source: { id: string; title: string; slug: string; classKey: string; confidence: number; status: string };
  target: { id: string; title: string; slug: string; classKey: string; confidence: number; status: string };
  score: number;
  reasons: string[];
}

function bigrams(value: string): Set<string> {
  const text = normalizeTitle(value).replace(/\s+/g, '');
  const grams = new Set<string>();
  for (let i = 0; i < text.length - 1; i += 1) grams.add(text.slice(i, i + 2));
  return grams;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function titleKey(page: PageRow): string {
  return normalizeTitle(page.title);
}

function aliasesOf(page: PageRow): string[] {
  try {
    const parsed = JSON.parse(page.aliases) as unknown;
    return Array.isArray(parsed) ? parsed.map(String).map(normalizeTitle).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** 计算两条知识页的重复概率（0–1），用于人工确认合并。 */
export function duplicateScore(a: PageRow, b: PageRow): { score: number; reasons: string[] } {
  if (a.class_key !== b.class_key) return { score: 0, reasons: [] };
  if (a.library_id !== b.library_id) return { score: 0, reasons: [] };
  const reasons: string[] = [];
  const aTitle = titleKey(a);
  const bTitle = titleKey(b);
  const aAliases = aliasesOf(a);
  const bAliases = aliasesOf(b);
  let score = 0;
  if (aTitle && aTitle === bTitle) {
    score = 1;
    reasons.push('标题相同');
  } else if (aTitle.length >= 3 && (aTitle.includes(bTitle) || bTitle.includes(aTitle))) {
    score = Math.max(score, 0.82);
    reasons.push('标题包含');
  }
  if (aAliases.some((alias) => alias === bTitle) || bAliases.some((alias) => alias === aTitle)) {
    score = Math.max(score, 0.94);
    reasons.push('标题与对方别名一致');
  }
  const sharedAlias = aAliases.find((alias) => bAliases.includes(alias));
  if (sharedAlias) {
    score = Math.max(score, 0.92);
    reasons.push('共享别名');
  }
  const titleJaccard = jaccard(bigrams(a.title), bigrams(b.title));
  if (titleJaccard >= 0.55) {
    score = Math.max(score, 0.6 + titleJaccard * 0.22);
    reasons.push(`标题相似 ${(titleJaccard * 100).toFixed(0)}%`);
  }
  const summaryJaccard = jaccard(bigrams(`${a.summary} ${a.tldr}`), bigrams(`${b.summary} ${b.tldr}`));
  if (titleJaccard >= 0.35 && summaryJaccard >= 0.3) {
    score = Math.max(score, 0.55 + summaryJaccard * 0.2);
    reasons.push('摘要语境相近');
  }
  return { score: Math.round(score * 100) / 100, reasons };
}

export function mergeSuggestions(db: Db, actor: Actor, libraryId: string, minimum = 0.62): MergeSuggestion[] {
  const rows = (db.prepare('SELECT * FROM pages WHERE library_id = ?').all(libraryId) as unknown as PageRow[])
    .filter((page) => page.class_key !== 'source' && page.status !== 'archived')
    .filter((page) => Boolean(effectivePageRole(db, actor, page)));
  const suggestions: MergeSuggestion[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const a = rows[i]!;
      const b = rows[j]!;
      const { score, reasons } = duplicateScore(a, b);
      if (score < minimum) continue;
      const target = a.confidence >= b.confidence ? a : b;
      const source = target.id === a.id ? b : a;
      suggestions.push({
        source: { id: source.id, title: source.title, slug: source.slug, classKey: source.class_key, confidence: source.confidence, status: source.status },
        target: { id: target.id, title: target.title, slug: target.slug, classKey: target.class_key, confidence: target.confidence, status: target.status },
        score,
        reasons,
      });
    }
  }
  return suggestions.sort((a, b) => b.score - a.score).slice(0, 40);
}
