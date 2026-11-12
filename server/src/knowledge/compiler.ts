import type { Db } from '../db/index.ts';
import type { Actor, ExtractResult, PageRow, SourceRow } from '../types.ts';
import { nowIso, parseJson, slugify, truncate } from '../lib/ids.ts';
import { keyphrases, normalizeTitle, splitSentences } from './terms.ts';
import { extractClaims, saveClaims, detectConflicts, type ExtractedClaim } from './claims.ts';
import {
  addLink,
  attachSource,
  createPage,
  getPage,
  updatePage,
  type PageInput,
} from './pages.ts';

const GENERIC_HEADINGS = new Set([
  '摘要', '简介', '引言', '前言', '背景', '概述', '总结', '结论', '讨论', '方法', '结果', '参考文献', '参考资料', '附录', '目录', '致谢',
  '正文', '说明', '目标', '原则', '范围', '术语', '定义', 'overview', 'summary', 'introduction', 'conclusion', 'references', 'appendix',
]);

interface Candidate {
  title: string;
  score: number;
  definitions: string[];
  points: string[];
  sections: string[];
}

export interface CompileReport {
  sourcePageId: string;
  pagesCreated: number;
  pagesUpdated: number;
  conflicts: number;
  log: string[];
  conceptIds: string[];
}

export interface CompileOptions {
  maxConcepts?: number;
  actorId?: string | null;
  actor?: Actor | null;
}

function cleanHeading(value: string): string {
  return value
    .replace(/^[\s#\d.、,，;；:：\-—•*]+/, '')
    .replace(/[（(][^）)]{0,12}[）)]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isHeadingTitle(value: string): boolean {
  if (value.length < 2 || value.length > 44) return false;
  if (GENERIC_HEADINGS.has(value.toLowerCase())) return false;
  if (/^(?:第[一二三四五六七八九十百]+[章节篇]|chapter|section)\s*$/i.test(value)) return false;
  return /[\p{L}\p{N}]/u.test(value);
}

function definitionSentences(title: string, text: string): string[] {
  const normalizedTitle = normalizeTitle(title);
  const found: string[] = [];
  for (const sentence of splitSentences(text)) {
    const compact = normalizeTitle(sentence);
    if (!compact.includes(normalizedTitle)) continue;
    if (/(?:是指|指的是|是一种|是一个|定义为|即|包括|包含|分为|支持|具有)/.test(sentence) && sentence.length <= 260) {
      found.push(sentence.trim());
    }
    if (found.length >= 3) break;
  }
  return found;
}

function sectionPoints(text: string, definitions: string[]): string[] {
  const definitionSet = new Set(definitions.map((value) => normalizeTitle(value)));
  return splitSentences(text)
    .filter((sentence) => sentence.length >= 18 && sentence.length <= 220)
    .filter((sentence) => !definitionSet.has(normalizeTitle(sentence)))
    .slice(0, 4);
}

function collectCandidates(extracted: ExtractResult): Candidate[] {
  const byTitle = new Map<string, Candidate>();
  const add = (candidate: Candidate) => {
    const key = normalizeTitle(candidate.title);
    const existing = byTitle.get(key);
    if (existing) {
      existing.score += candidate.score * 0.4;
      existing.definitions = [...new Set([...existing.definitions, ...candidate.definitions])].slice(0, 4);
      existing.points = [...new Set([...existing.points, ...candidate.points])].slice(0, 5);
      existing.sections = [...new Set([...existing.sections, ...candidate.sections])].slice(0, 3);
    } else {
      byTitle.set(key, candidate);
    }
  };

  for (const section of extracted.sections) {
    const title = cleanHeading(section.title);
    if (!isHeadingTitle(title)) continue;
    const definitions = definitionSentences(title, section.text);
    const points = sectionPoints(section.text, definitions);
    if (section.text.length < 80 && !definitions.length) continue;
    add({
      title,
      score: 2.2 + Math.min(2, section.text.length / 500) + (definitions.length ? 1.8 : 0) + (section.level <= 3 ? 0.6 : 0),
      definitions,
      points,
      sections: [section.title],
    });
  }

  for (const claim of extractClaims(extracted.text, '', 40)) {
    const title = cleanHeading(claim.subject);
    if (!isHeadingTitle(title)) continue;
    add({
      title,
      score: 1.4 + (claim.predicate === '定义' ? 1.4 : 0.6),
      definitions: claim.predicate === '定义' ? [claim.text] : [],
      points: claim.predicate === '定义' ? [] : [claim.text],
      sections: [claim.section],
    });
  }

  for (const phrase of keyphrases(extracted.text, 24)) {
    const title = cleanHeading(phrase);
    if (!isHeadingTitle(title)) continue;
    add({ title, score: 1.1, definitions: [], points: [], sections: [] });
  }

  return [...byTitle.values()].sort((a, b) => b.score - a.score);
}

function findExisting(db: Db, libraryId: string, title: string): PageRow | null {
  const normalized = normalizeTitle(title);
  if (!normalized) return null;
  const slug = `concepts/${slugify(title, 'concept')}`;
  const direct = getPage(db, slug);
  if (direct && direct.library_id === libraryId) return direct;
  const pages = db.prepare('SELECT * FROM pages WHERE library_id = ?').all(libraryId) as unknown as PageRow[];
  for (const page of pages) {
    if (page.class_key === 'source') continue;
    if (normalizeTitle(page.title) === normalized) return page;
    if (parseJson<string[]>(page.aliases, []).some((alias) => normalizeTitle(alias) === normalized)) return page;
  }
  return null;
}

function sourceBody(source: SourceRow, extracted: ExtractResult, conceptLinks: string[], claims: ExtractedClaim[]): string {
  const rows = extracted.sections
    .filter((section) => section.title && section.text)
    .slice(0, 18)
    .map((section) => `| ${section.title.replace(/\|/g, '\\|').slice(0, 48)} | ${truncate(section.text, 90).replace(/\|/g, '\\|')} |`)
    .join('\n');
  const metadata = [
    `文件：${source.filename}`,
    `格式：${source.ext || extracted.kind}`,
    source.page_count ? `页数：${source.page_count}` : '',
    source.word_count ? `字数：${source.word_count}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return [
    `> 本文由 Alexandria 在入库时编译：先读原文，再更新概念页与主张，不把原文切块留给查询时再猜。原始文件保留在「文献」中，可随时回溯。`,
    '',
    '## 一句话摘要',
    source.excerpt || truncate(extracted.text, 220) || '（本文件未抽取到文本）',
    '',
    '## 文档结构',
    rows ? `| 章节 | 概要 |\n| --- | --- |\n${rows}` : '（未识别到章节）',
    '',
    '## 关键主张',
    claims.length ? claims.slice(0, 10).map((claim) => `- ${claim.text}`).join('\n') : '（未抽取到结构化主张）',
    '',
    '## 相关概念',
    conceptLinks.length ? conceptLinks.map((link) => `- [[${link}]]`).join('\n') : '（暂无，等待后续入库时建立关联）',
    '',
    '## 溯源',
    metadata,
  ].join('\n');
}

function conceptBody(title: string, definitions: string[], points: string[], sourceSlug: string, sourceTitle: string): string {
  return [
    `## 定义`,
    definitions[0] ?? `《${sourceTitle}》围绕「${title}」给出了说明，此页由入库编译器建立，等待更多来源交叉验证。`,
    '',
    `## 要点`,
    points.length ? points.map((point) => `- ${point}`).join('\n') : '- 暂无结构化要点，建议补充人工校对。',
    '',
    `## 来源`,
    `- [[${sourceSlug}]] · 《${sourceTitle}》`,
    '',
    `## 开放问题`,
    `- 「${title}」与其他概念的边界是否清晰？哪些来源支持或反驳本页？`,
  ].join('\n');
}

function mergeUnique(existing: string[], incoming: string[]): string[] {
  return [...new Set([...existing, ...incoming].map((value) => value.trim()).filter(Boolean))];
}

function sourcePageFor(db: Db, sourceId: string): PageRow | null {
  const row = db
    .prepare(
      `SELECT p.* FROM pages p JOIN page_sources ps ON ps.page_id = p.id
        WHERE ps.source_id = ? AND ps.relation = 'source-document' LIMIT 1`,
    )
    .get(sourceId) as unknown as PageRow | undefined;
  return row ?? null;
}

export function compileSource(db: Db, source: SourceRow, extracted: ExtractResult, options: CompileOptions = {}): CompileReport {
  const actor = options.actor ?? null;
  const maxConcepts = Math.max(1, Math.min(16, options.maxConcepts ?? 8));
  const log: string[] = [];
  let pagesCreated = 0;
  let pagesUpdated = 0;
  let conflicts = 0;

  const candidates = collectCandidates(extracted);
  const chosen = candidates
    .filter((candidate) => candidate.score >= 3.0 && (candidate.definitions.length > 0 || candidate.points.length >= 2))
    .slice(0, maxConcepts);
  log.push(`抽取候选概念 ${candidates.length} 个，选择 ${chosen.length} 个编译`);

  const claims = extractClaims(extracted.text, '', 18);
  const allClaims: ExtractedClaim[] = [];
  for (const section of extracted.sections) {
    allClaims.push(...extractClaims(section.text, section.title, 2));
  }
  for (const claim of claims) allClaims.push(claim);
  const uniqueClaims = new Map<string, ExtractedClaim>();
  for (const claim of allClaims) {
    if (!uniqueClaims.has(normalizeTitle(claim.text))) uniqueClaims.set(normalizeTitle(claim.text), claim);
  }
  const sourceClaims = [...uniqueClaims.values()].slice(0, 24);

  const existingSourcePage = sourcePageFor(db, source.id);
  const sourceSlug = existingSourcePage?.slug ?? `sources/${slugify(source.title, 'source')}`;
  const placeholderBody = sourceBody(source, extracted, [], sourceClaims);
  let sourcePage: PageRow;

  if (existingSourcePage) {
    sourcePage = updatePage(
      db,
      existingSourcePage,
      {
        title: source.title,
        summary: source.excerpt || truncate(extracted.text, 180),
        tldr: truncate(sourceClaims[0]?.text ?? extracted.text, 120),
        body: placeholderBody,
        status: 'active',
        tags: keyphrases(`${source.title} ${extracted.text}`, 10),
        metadata: {
          ...parseJson<Record<string, unknown>>(existingSourcePage.metadata, {}),
          sourceId: source.id,
          compiledAt: nowIso(),
        },
        note: '重新编译文献',
      },
      actor,
    );
    pagesUpdated += 1;
    log.push(`更新文献页《${sourcePage.title}》`);
  } else {
    sourcePage = createPage(
      db,
      {
        libraryId: source.library_id,
        nodeId: source.node_id,
        classKey: 'source',
        title: source.title,
        slug: sourceSlug,
        summary: source.excerpt || truncate(extracted.text, 180),
        tldr: truncate(sourceClaims[0]?.text ?? extracted.text, 120),
        body: placeholderBody,
        status: 'active',
        confidence: 0.65,
        tags: keyphrases(`${source.title} ${extracted.text}`, 10),
        readWhen: [`查阅《${source.title}》原文`, `了解 ${source.title} 的内容与来源`],
        metadata: { sourceId: source.id, compiledAt: nowIso() },
        createdBy: actor?.person.id ?? null,
      },
      actor,
    );
    db.prepare(
      `INSERT OR IGNORE INTO page_sources (page_id, source_id, relation, locator, quote)
       VALUES (?, ?, 'source-document', '', '')`,
    ).run(sourcePage.id, source.id);
    pagesCreated += 1;
    log.push(`创建文献页《${sourcePage.title}》`);
  }
  saveClaims(db, sourcePage.id, sourceClaims, source.id);

  const conceptIds: string[] = [];
  const conceptLinks: string[] = [];
  const linkedConcepts: { id: string; title: string }[] = [];

  for (const candidate of chosen) {
    let existing = findExisting(db, source.library_id, candidate.title);
    if (existing?.id === sourcePage.id) existing = null;
    const definition = candidate.definitions[0] ?? candidate.points[0] ?? '';
    const tags = keyphrases(`${candidate.title} ${candidate.definitions.join(' ')} ${candidate.points.join(' ')}`, 6, [
      candidate.title,
    ]);

    if (existing) {
      const attached = db
        .prepare('SELECT 1 FROM page_sources WHERE page_id = ? AND source_id = ?')
        .get(existing.id, source.id);
      if (attached) {
        linkedConcepts.push({ id: existing.id, title: existing.title });
        conceptLinks.push(existing.slug);
        continue;
      }
      const addition = [
        '',
        `## 补充：来自《${source.title}》`,
        definition ? definition : '该来源提及了此概念。',
        ...candidate.points.map((point) => `- ${point}`),
        '',
        `来源：[[${sourcePage.slug}]]`,
      ].join('\n');
      const updated = updatePage(
        db,
        existing,
        {
          body: `${existing.body.trim()}\n${addition}`,
          summary: existing.summary || truncate(definition, 180),
          tags: mergeUnique(parseJson<string[]>(existing.tags, []), tags),
          confidence: Math.min(0.92, existing.confidence + 0.03),
          metadata: {
            ...parseJson<Record<string, unknown>>(existing.metadata, {}),
            lastSourceId: source.id,
            compiledAt: nowIso(),
          },
          note: `吸收《${source.title}》`,
        },
        actor,
      );
      attachSource(db, updated.id, source.id, 'derived-from', candidate.sections[0] ?? '', definition);
      addLink(db, source.library_id, updated.id, sourcePage.id, 'derived-from', 'frontmatter', 1.2);
      addLink(db, source.library_id, sourcePage.id, updated.id, 'mentions', 'frontmatter', 1);
      saveClaims(
        db,
        updated.id,
        candidate.definitions.concat(candidate.points).map((text) => ({
          text,
          subject: candidate.title,
          predicate: '说明',
          object: truncate(text, 200),
          confidence: 0.55,
          section: candidate.sections[0] ?? '',
        })),
        source.id,
      );
      conflicts += detectConflicts(db, updated.id).count;
      conceptIds.push(updated.id);
      linkedConcepts.push({ id: updated.id, title: updated.title });
      conceptLinks.push(updated.slug);
      pagesUpdated += 1;
      log.push(`扩展概念页《${updated.title}》`);
      continue;
    }

    const body = conceptBody(candidate.title, candidate.definitions, candidate.points, sourcePage.slug, source.title);
    const page = createPage(
      db,
      {
        libraryId: source.library_id,
        nodeId: source.node_id,
        classKey: 'concept',
        title: candidate.title,
        slug: `concepts/${slugify(candidate.title, 'concept')}`,
        summary: truncate(definition || `由《${source.title}》编译的概念页`, 180),
        tldr: truncate(definition || `了解「${candidate.title}」`, 110),
        body,
        status: 'draft',
        confidence: 0.5,
        tags,
        aliases: [],
        readWhen: [`了解「${candidate.title}」的定义与边界`, `查找与 ${candidate.title} 相关的资料`],
        metadata: { compiledFrom: source.id, compiledAt: nowIso() },
        createdBy: actor?.person.id ?? null,
      },
      actor,
    );
    attachSource(db, page.id, source.id, 'derived-from', candidate.sections[0] ?? '', definition);
    addLink(db, source.library_id, page.id, sourcePage.id, 'derived-from', 'frontmatter', 1.2);
    addLink(db, source.library_id, sourcePage.id, page.id, 'mentions', 'frontmatter', 1);
    saveClaims(
      db,
      page.id,
      candidate.definitions.concat(candidate.points).map((text) => ({
        text,
        subject: candidate.title,
        predicate: '说明',
        object: truncate(text, 200),
        confidence: 0.55,
        section: candidate.sections[0] ?? '',
      })),
      source.id,
    );
    conflicts += detectConflicts(db, page.id).count;
    conceptIds.push(page.id);
    linkedConcepts.push({ id: page.id, title: page.title });
    conceptLinks.push(page.slug);
    pagesCreated += 1;
    log.push(`创建概念页《${page.title}》`);
  }

  // 同一来源编译出的概念互为相关，构成可扩展的关联路径。
  for (let i = 0; i < linkedConcepts.length; i += 1) {
    for (let j = i + 1; j < linkedConcepts.length; j += 1) {
      addLink(db, source.library_id, linkedConcepts[i]!.id, linkedConcepts[j]!.id, 'related-to', 'semantic', 0.6);
    }
  }

  const finalBody = sourceBody(source, extracted, conceptLinks, sourceClaims);
  sourcePage = updatePage(
    db,
    sourcePage,
    { body: finalBody, metadata: { ...parseJson<Record<string, unknown>>(sourcePage.metadata, {}), conceptIds, compiledAt: nowIso() } },
    actor,
  );
  conflicts += detectConflicts(db, sourcePage.id).count;
  log.push(`完成编译：${pagesCreated} 新建 / ${pagesUpdated} 更新 / ${conflicts} 处矛盾待裁决`);

  return { sourcePageId: sourcePage.id, pagesCreated, pagesUpdated, conflicts, log, conceptIds };
}
