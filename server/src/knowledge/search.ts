import type { Db } from '../db/index.ts';
import type { Actor, LibraryRow, PageRow } from '../types.ts';
import { parseJson, truncate } from '../lib/ids.ts';
import { normalizeTitle, queryTokens, snippet, termsString } from './terms.ts';
import { pageToView, type PageView } from './pages.ts';
import { visibleLibraries } from '../domain/access.ts';

export interface SearchFilters {
  libraryIds?: string[];
  classKey?: string;
  status?: string;
  tag?: string;
  limit?: number;
}

export interface SearchHit {
  kind: 'page' | 'source';
  id: string;
  title: string;
  slug: string;
  summary: string;
  libraryId: string;
  libraryName: string;
  librarySlug: string;
  className: string;
  classKey: string;
  status: string;
  confidence: number;
  updatedAt: string;
  snippet: string;
  score: number;
  signals: Record<string, number>;
  page?: PageView;
  tags: string[];
}

export interface KnowledgeAnswer {
  mode: 'compiled' | 'llm' | 'dsh' | 'empty';
  answer: string;
  citations: {
    pageId: string;
    title: string;
    slug: string;
    libraryId: string;
    libraryName: string;
    excerpt: string;
    confidence: number;
  }[];
  pages: SearchHit[];
  gaps: string[];
  signals: Record<string, number>;
  tookMs: number;
}

function accessibleLibraries(db: Db, actor: Actor): Map<string, LibraryRow> {
  const map = new Map<string, LibraryRow>();
  for (const library of visibleLibraries(db, actor)) map.set(library.id, library);
  return map;
}

function ftsExpression(tokens: string[]): string {
  return tokens
    .filter((token) => token.trim())
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(' OR ');
}

function coverage(tokens: string[], text: string): number {
  if (!tokens.length) return 0;
  const haystack = normalizeTitle(text);
  let matched = 0;
  for (const token of tokens) if (haystack.includes(normalizeTitle(token))) matched += 1;
  return matched / tokens.length;
}

function recencyScore(updatedAt: string): number {
  const days = Math.max(0, (Date.now() - new Date(updatedAt).getTime()) / 86_400_000);
  return Math.exp(-days / 180);
}

function lexicalSignals(page: PageRow, tokens: string[], rank: number): Record<string, number> {
  const titleCoverage = coverage(tokens, `${page.title} ${parseJson<string[]>(page.aliases, []).join(' ')}`);
  const bodyCoverage = coverage(tokens, `${page.summary} ${page.tldr} ${page.body}`);
  return {
    lexical: Math.max(0, -rank),
    title: titleCoverage,
    coverage: bodyCoverage,
    confidence: page.confidence,
    freshness: recencyScore(page.updated_at),
    readWhen: coverage(tokens, parseJson<string[]>(page.read_when, []).join(' ')),
  };
}

function scoreOf(signals: Record<string, number>): number {
  return (
    signals.lexical * 1.0 +
    signals.title * 8 +
    signals.coverage * 6 +
    signals.confidence * 0.8 +
    signals.freshness * 0.6 +
    signals.readWhen * 2
  );
}

function libraryInfo(libraries: Map<string, LibraryRow>, id: string): { name: string; slug: string } {
  const library = libraries.get(id);
  return { name: library?.name ?? '未知知识库', slug: library?.slug ?? '' };
}

export function searchKnowledge(db: Db, actor: Actor, query: string, filters: SearchFilters = {}): SearchHit[] {
  const libraries = accessibleLibraries(db, actor);
  let allowed = [...libraries.keys()];
  if (filters.libraryIds?.length) allowed = allowed.filter((id) => filters.libraryIds!.includes(id));
  if (!allowed.length) return [];
  const limit = Math.max(1, Math.min(100, filters.limit ?? 30));
  const tokens = queryTokens(query);
  const placeholders = allowed.map(() => '?').join(',');
  const hits = new Map<string, SearchHit>();

  if (tokens.length) {
    const expression = ftsExpression(tokens);
    const rows = db
      .prepare(
        `SELECT p.*, bm25(page_fts) AS rank FROM page_fts f JOIN pages p ON p.id = f.page_id
          WHERE page_fts MATCH ? AND p.library_id IN (${placeholders})
          ORDER BY rank LIMIT 80`,
      )
      .all(expression, ...allowed) as unknown as (PageRow & { rank: number })[];
    for (const row of rows) {
      if (filters.classKey && row.class_key !== filters.classKey) continue;
      if (filters.status && row.status !== filters.status) continue;
      if (filters.tag && !parseJson<string[]>(row.tags, []).includes(filters.tag)) continue;
      const signals = lexicalSignals(row, tokens, row.rank);
      const lib = libraryInfo(libraries, row.library_id);
      hits.set(row.id, {
        kind: 'page',
        id: row.id,
        title: row.title,
        slug: row.slug,
        summary: row.summary,
        libraryId: row.library_id,
        libraryName: lib.name,
        librarySlug: lib.slug,
        className: pageToView(db, row).className,
        classKey: row.class_key,
        status: row.status,
        confidence: row.confidence,
        updatedAt: row.updated_at,
        snippet: snippet(`${row.summary} ${row.tldr} ${row.body}`, tokens, 190),
        score: scoreOf(signals),
        signals,
        page: pageToView(db, row),
        tags: parseJson<string[]>(row.tags, []),
      });
    }

    // 文献全文命中作为补充：知识页优先，但原文仍是可回溯的证据。
    const sourceRows = db
      .prepare(
        `SELECT s.*, bm25(source_fts) AS rank FROM source_fts f JOIN sources s ON s.id = f.source_id
          WHERE source_fts MATCH ? AND s.library_id IN (${placeholders}) AND s.status = 'ready'
          ORDER BY rank LIMIT 20`,
      )
      .all(expression, ...allowed) as unknown as (SourceRow & { rank: number })[];
    for (const source of sourceRows) {
      const duplicate = [...hits.values()].some(
        (hit) => hit.kind === 'page' && hit.libraryId === source.library_id && hit.title === source.title && hit.classKey === 'source',
      );
      if (duplicate) continue;
      const signals = {
        lexical: Math.max(0, -source.rank),
        title: coverage(tokens, source.title),
        coverage: coverage(tokens, source.extracted_text),
        confidence: 0.7,
        freshness: recencyScore(source.updated_at),
      };
      const lib = libraryInfo(libraries, source.library_id);
      hits.set(`source:${source.id}`, {
        kind: 'source',
        id: source.id,
        title: source.title,
        slug: `source/${source.id}`,
        summary: source.excerpt,
        libraryId: source.library_id,
        libraryName: lib.name,
        librarySlug: lib.slug,
        className: '文献',
        classKey: 'source',
        status: source.status,
        confidence: 0.7,
        updatedAt: source.updated_at,
        snippet: snippet(source.extracted_text, tokens, 190),
        score: scoreOf(signals) * 0.55,
        signals,
        tags: [],
      });
    }
  } else {
    const rows = db
      .prepare(
        `SELECT * FROM pages WHERE library_id IN (${placeholders}) ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(...allowed, limit) as unknown as PageRow[];
    for (const row of rows) {
      if (filters.classKey && row.class_key !== filters.classKey) continue;
      const lib = libraryInfo(libraries, row.library_id);
      hits.set(row.id, {
        kind: 'page',
        id: row.id,
        title: row.title,
        slug: row.slug,
        summary: row.summary,
        libraryId: row.library_id,
        libraryName: lib.name,
        librarySlug: lib.slug,
        className: pageToView(db, row).className,
        classKey: row.class_key,
        status: row.status,
        confidence: row.confidence,
        updatedAt: row.updated_at,
        snippet: row.summary,
        score: 1 + recencyScore(row.updated_at),
        signals: { freshness: recencyScore(row.updated_at), confidence: row.confidence },
        page: pageToView(db, row),
        tags: parseJson<string[]>(row.tags, []),
      });
    }
  }

  // 图扩展：知识页之间预编译的关联路径，把“没有直接关键词”的相关知识带出来。
  const seeds = [...hits.values()].filter((hit) => hit.kind === 'page').sort((a, b) => b.score - a.score).slice(0, 6);
  for (const seed of seeds) {
    const neighbors = db
      .prepare(
        `SELECT p.*, l.relation, l.weight FROM links l JOIN pages p ON p.id = l.to_page_id
          WHERE l.from_page_id = ? AND p.library_id IN (${placeholders})
         UNION
         SELECT p.*, l.relation, l.weight FROM links l JOIN pages p ON p.id = l.from_page_id
          WHERE l.to_page_id = ? AND p.library_id IN (${placeholders})`,
      )
      .all(seed.id, ...allowed, seed.id, ...allowed) as unknown as (PageRow & { relation: string; weight: number })[];
    for (const neighbor of neighbors.slice(0, 8)) {
      if (hits.has(neighbor.id)) continue;
      if (filters.classKey && neighbor.class_key !== filters.classKey) continue;
      const lib = libraryInfo(libraries, neighbor.library_id);
      const signals = { graph: (seed.score / Math.max(1, seed.score)) * (0.35 + (neighbor.weight ?? 1) * 0.1) };
      hits.set(neighbor.id, {
        kind: 'page',
        id: neighbor.id,
        title: neighbor.title,
        slug: neighbor.slug,
        summary: neighbor.summary,
        libraryId: neighbor.library_id,
        libraryName: lib.name,
        librarySlug: lib.slug,
        className: pageToView(db, neighbor).className,
        classKey: neighbor.class_key,
        status: neighbor.status,
        confidence: neighbor.confidence,
        updatedAt: neighbor.updated_at,
        snippet: neighbor.summary,
        score: seed.score * 0.22 + 0.2,
        signals,
        page: pageToView(db, neighbor),
        tags: parseJson<string[]>(neighbor.tags, []),
      });
    }
  }

  return [...hits.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

interface SourceRow {
  id: string;
  library_id: string;
  title: string;
  excerpt: string;
  extracted_text: string;
  status: string;
  updated_at: string;
  rank: number;
}

export function relatedPages(db: Db, pageId: string): {
  outbound: { id: string; title: string; slug: string; relation: string }[];
  inbound: { id: string; title: string; slug: string; relation: string }[];
} {
  const outbound = db
    .prepare(
      `SELECT p.id, p.title, p.slug, l.relation FROM links l JOIN pages p ON p.id = l.to_page_id
        WHERE l.from_page_id = ? ORDER BY l.weight DESC LIMIT 40`,
    )
    .all(pageId) as unknown as { id: string; title: string; slug: string; relation: string }[];
  const inbound = db
    .prepare(
      `SELECT p.id, p.title, p.slug, l.relation FROM links l JOIN pages p ON p.id = l.from_page_id
        WHERE l.to_page_id = ? ORDER BY l.weight DESC LIMIT 40`,
    )
    .all(pageId) as unknown as { id: string; title: string; slug: string; relation: string }[];
  return { outbound, inbound };
}

export function graphForLibrary(
  db: Db,
  actor: Actor,
  libraryId: string,
  options: { limit?: number; classKey?: string } = {},
): { nodes: unknown[]; edges: unknown[] } {
  const libraries = accessibleLibraries(db, actor);
  if (!libraries.has(libraryId)) return { nodes: [], edges: [] };
  const limit = Math.max(10, Math.min(800, options.limit ?? 400));
  const rows = db
    .prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM links l WHERE l.from_page_id = p.id OR l.to_page_id = p.id) AS degree
        FROM pages p WHERE p.library_id = ? ${options.classKey ? 'AND p.class_key = ?' : ''}
        ORDER BY degree DESC, p.updated_at DESC LIMIT ?`,
    )
    .all(libraryId, ...(options.classKey ? [options.classKey] : []), limit) as unknown as (PageRow & { degree: number })[];
  const ids = new Set(rows.map((row) => row.id));
  const edges = db
    .prepare(
      `SELECT from_page_id, to_page_id, relation, weight FROM links WHERE library_id = ?`,
    )
    .all(libraryId) as unknown as { from_page_id: string; to_page_id: string; relation: string; weight: number }[];
  return {
    nodes: rows.map((row) => ({
      id: row.id,
      title: row.title,
      slug: row.slug,
      classKey: row.class_key,
      className: pageToView(db, row).className,
      color: pageToView(db, row).classColor,
      status: row.status,
      confidence: row.confidence,
      degree: row.degree,
      summary: row.summary,
    })),
    edges: edges
      .filter((edge) => ids.has(edge.from_page_id) && ids.has(edge.to_page_id))
      .map((edge) => ({
        source: edge.from_page_id,
        target: edge.to_page_id,
        relation: edge.relation,
        weight: edge.weight,
      })),
  };
}

function cleanKnowledgeSentence(line: string): string {
  return line
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target: string, label?: string) => label ?? target)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>#]/g, '')
    .replace(/\([^)]{0,80}\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sentenceCandidates(page: PageRow, tokens: string[]): string[] {
  const text = `${page.tldr}。 ${page.summary}。 ${page.body}`;
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line && !/^\|/.test(line) && !/^#/.test(line) && !/^[-+*]\s/.test(line))
    .map(cleanKnowledgeSentence)
    .filter((line) => line.length >= 22 && line.length <= 260);
  const sentences = lines.flatMap((line) => line.split(/(?<=[。！？!?；;])\s*/));
  const seen = new Set<string>();
  return sentences
    .map((sentence) => ({ sentence: sentence.trim(), match: coverage(tokens, sentence) }))
    .filter((item) => item.match > 0 && item.sentence.length >= 18)
    .filter((item) => {
      const key = normalizeTitle(item.sentence).slice(0, 60);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.match - a.match || b.sentence.length - a.sentence.length)
    .slice(0, 3)
    .map((item) => item.sentence);
}

/** 编译式问答：从已编译知识页中组织答案，并给出可回溯引用；不重新切块原文。 */
export function answerKnowledge(db: Db, actor: Actor, query: string, filters: SearchFilters = {}): KnowledgeAnswer {
  const started = Date.now();
  const pages = searchKnowledge(db, actor, query, { ...filters, limit: filters.limit ?? 8 });
  const tokens = queryTokens(query);
  const citations: KnowledgeAnswer['citations'] = [];
  const answerParts: string[] = [];
  const seenExcerpts = new Set<string>();
  const gaps: string[] = [];

  const pageHits = pages.filter((item) => item.kind === 'page');
  const ordered = [
    ...pageHits.filter((hit) => hit.status !== 'draft'),
    ...pageHits.filter((hit) => hit.status === 'draft'),
  ].slice(0, 5);
  for (const hit of ordered) {
    if (hit.status === 'draft' && citations.length >= 2) continue;
    const page = db.prepare('SELECT * FROM pages WHERE id = ?').get(hit.id) as unknown as PageRow | undefined;
    if (!page) continue;
    const sentences = sentenceCandidates(page, tokens);
    const excerpt = truncate(sentences.slice(0, 2).join(' ') || page.tldr || page.summary, 420);
    if (!excerpt) continue;
    const excerptKey = normalizeTitle(excerpt).slice(0, 80);
    if (seenExcerpts.has(excerptKey)) continue;
    seenExcerpts.add(excerptKey);
    citations.push({
      pageId: page.id,
      title: page.title,
      slug: page.slug,
      libraryId: page.library_id,
      libraryName: hit.libraryName,
      excerpt,
      confidence: page.confidence,
    });
    answerParts.push(`- ${excerpt} 〔${page.title}〕`);
  }

  if (!citations.length) {
    gaps.push('知识库中还没有编译出与此问题直接相关的知识页；可以上传资料并运行编译，或换一个更具体的问法。');
  } else if (citations.length < 2) {
    gaps.push('仅命中一个知识页，结论可能缺少交叉验证；建议补充来源或检查是否存在矛盾主张。');
  }
  const draftPages = pages.filter((hit) => hit.status === 'draft').length;
  if (draftPages) gaps.push(`${draftPages} 个命中的知识页处于草稿状态（可能含未裁决的矛盾），引用时请复核。`);

  const signals = {
    hits: pages.length,
    citations: citations.length,
    graphHits: pages.filter((hit) => hit.signals.graph).length,
    topScore: pages[0]?.score ?? 0,
  };

  return {
    mode: citations.length ? 'compiled' : 'empty',
    answer:
      answerParts.length > 0
        ? `根据已编译的知识页，可以确认：\n\n${answerParts.join('\n')}\n\n以上结论来自知识页，而非查询时临时检索的原文片段。`
        : '没有找到可引用的知识。',
    citations,
    pages,
    gaps,
    signals,
    tookMs: Date.now() - started,
  };
}

export function rebuildIndexes(db: Db): { pages: number; sources: number } {
  db.exec('DELETE FROM page_fts; DELETE FROM source_fts;');
  const pages = db.prepare('SELECT * FROM pages').all() as unknown as PageRow[];
  for (const page of pages) {
    db.prepare(
      `INSERT INTO page_fts (page_id, library_id, title, summary, body, terms, tags)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      page.id,
      page.library_id,
      page.title,
      `${page.summary} ${page.tldr}`,
      page.body,
      termsString(`${page.title} ${page.summary} ${page.tldr} ${page.body} ${page.tags} ${page.aliases} ${page.read_when}`),
      page.tags,
    );
  }
  const sources = db.prepare("SELECT * FROM sources WHERE status = 'ready'").all() as unknown as SourceRow[];
  for (const source of sources) {
    db.prepare(
      'INSERT INTO source_fts (source_id, library_id, title, excerpt, text, terms) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(source.id, source.library_id, source.title, source.excerpt, source.extracted_text, termsString(`${source.title} ${source.excerpt} ${source.extracted_text}`));
  }
  return { pages: pages.length, sources: sources.length };
}
