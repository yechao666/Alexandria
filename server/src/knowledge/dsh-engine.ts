import type { Db } from '../db/index.ts';
import type { Env } from '../env.ts';
import type { Actor, ExtractResult, PageRow, SourceRow } from '../types.ts';
import { newId, nowIso, parseJson, slugify, truncate } from '../lib/ids.ts';
import { normalizeTitle } from './terms.ts';
import { runDshSync, extractJson } from './dsh-runtime.ts';
import { saveClaims, detectConflicts, type ExtractedClaim } from './claims.ts';
import { addLink, attachSource, createPage, getPage, updatePage } from './pages.ts';

interface DshClaim {
  text?: string;
  subject?: string;
  predicate?: string;
  object?: string;
  confidence?: number;
}

interface DshEntity {
  name?: string;
  type?: string;
  description?: string;
  aliases?: string[];
}

interface DshFact {
  subject?: string;
  predicate?: string;
  object?: string;
  confidence?: number;
}

interface DshDecision {
  title?: string;
  decision?: string;
  rationale?: string;
  alternatives?: string[];
  owner?: string;
  effectiveDate?: string;
  status?: string;
  related?: string[];
  claims?: DshClaim[];
  confidence?: number;
}

interface DshConcept {
  title?: string;
  parent?: string;
  classKey?: string;
  summary?: string;
  definition?: string;
  points?: string[];
  tags?: string[];
  aliases?: string[];
  readWhen?: string[];
  confidence?: number;
  claims?: DshClaim[];
  related?: string[];
}

interface DshCompilation {
  sourceSummary?: string;
  tldr?: string;
  claims?: DshClaim[];
  entities?: DshEntity[];
  facts?: DshFact[];
  decisions?: DshDecision[];
  concepts?: DshConcept[];
}

export interface DshCompileReport {
  sourcePageId: string;
  pagesCreated: number;
  pagesUpdated: number;
  conflicts: number;
  log: string[];
  conceptIds: string[];
}

function findSourcePage(db: Db, sourceId: string): PageRow | null {
  return (
    (db
      .prepare(
        `SELECT p.* FROM pages p JOIN page_sources ps ON ps.page_id = p.id
          WHERE ps.source_id = ? AND ps.relation = 'source-document' LIMIT 1`,
      )
      .get(sourceId) as unknown as PageRow | undefined) ?? null
  );
}

function entityNameSimilar(left: string, right: string): boolean {
  const a = normalizeTitle(left).replace(/[有限公司集团股份]/g, '');
  const b = normalizeTitle(right).replace(/[有限公司集团股份]/g, '');
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a)) && Math.abs(a.length - b.length) <= 8) return true;
  const bigrams = (value: string) => new Set(Array.from({ length: Math.max(0, value.length - 1) }, (_, index) => value.slice(index, index + 2)));
  const one = bigrams(a); const two = bigrams(b);
  if (!one.size || !two.size) return false;
  let overlap = 0; for (const item of one) if (two.has(item)) overlap += 1;
  return (2 * overlap) / (one.size + two.size) >= 0.86;
}

function findExisting(db: Db, libraryId: string, title: string): PageRow | null {
  const normalized = normalizeTitle(title);
  const pages = db.prepare('SELECT * FROM pages WHERE library_id = ?').all(libraryId) as unknown as PageRow[];
  return (
    pages.find((page) => page.class_key !== 'source' && page.status !== 'archived' && normalizeTitle(page.title) === normalized) ??
    pages.find((page) =>
      page.class_key !== 'source' &&
      page.status !== 'archived' &&
      parseJson<string[]>(page.aliases, []).some((alias) => normalizeTitle(alias) === normalized),
    ) ??
    pages.find((page) => page.class_key !== 'source' && page.status !== 'archived' && entityNameSimilar(page.title, title)) ??
    null
  );
}

function findByRef(db: Db, libraryId: string, ref: string): PageRow | null {
  return (
    (db.prepare('SELECT * FROM pages WHERE library_id = ? AND slug = ?').get(libraryId, ref) as unknown as PageRow | undefined) ??
    findExisting(db, libraryId, ref)
  );
}

function mergeUnique(left: string[], right: string[]): string[] {
  return [...new Set([...left, ...right].map((item) => String(item).trim()).filter(Boolean))];
}

function toClaim(input: DshClaim, fallbackSubject: string, section = 'DSH 编译'): ExtractedClaim | null {
  const text = String(input.text ?? '').trim();
  if (text.length < 4) return null;
  return {
    text: truncate(text, 320),
    subject: String(input.subject ?? fallbackSubject).trim() || fallbackSubject,
    predicate: String(input.predicate ?? '说明').trim() || '说明',
    object: truncate(String(input.object ?? text), 280),
    confidence: Math.max(0, Math.min(1, Number(input.confidence ?? 0.6))),
    section,
  };
}

function sourceBody(source: SourceRow, extracted: ExtractResult, concepts: { slug: string; title: string }[], claims: ExtractedClaim[], summary: string, entities: { slug: string; title: string }[] = []): string {
  const rows = extracted.sections
    .filter((section) => section.title && section.text)
    .slice(0, 18)
    .map((section) => `| ${section.title.replace(/\|/g, '\\|').slice(0, 48)} | ${truncate(section.text, 90).replace(/\|/g, '\\|')} |`)
    .join('\n');
  return [
    '> 本页由**本机 DSH**在入库时阅读原文、抽取概念与主张并建立关联。原始文件保留在文献中。',
    '',
    '## 摘要',
    summary || truncate(extracted.text, 240) || '（未抽取到文本）',
    '',
    '## 文档结构',
    rows ? `| 章节 | 概要 |\n| --- | --- |\n${rows}` : '（未识别到章节）',
    '',
    '## 关键主张',
    claims.length ? claims.slice(0, 12).map((claim) => `- ${claim.text}`).join('\n') : '（未抽取到结构化主张）',
    '',
    '## 相关概念',
    concepts.length ? concepts.map((concept) => `- [[${concept.slug}|${concept.title}]]`).join('\n') : '（DSH 未给出概念）',
    '',
    '## 实体',
    entities.length ? entities.map((entity) => `- [[${entity.slug}|${entity.title}]]`).join('\n') : '（DSH 未给出实体）',
    '',
    '## 溯源',
    `文件：${source.filename} · 格式：${source.ext || extracted.kind}${source.page_count ? ` · 页数：${source.page_count}` : ''}`,
  ].join('\n');
}

function buildPrompt(source: SourceRow, extracted: ExtractResult, db: Db, classes: { key: string; name: string }[]): string {
  const existing = db
    .prepare('SELECT title, slug, class_key FROM pages WHERE library_id = ? ORDER BY updated_at DESC LIMIT 80')
    .all(source.library_id) as unknown as { title: string; slug: string; class_key: string }[];
  const sections = extracted.sections
    .slice(0, 24)
    .map((section) => `### ${section.title}\n${truncate(section.text, 1400)}`)
    .join('\n\n')
    .slice(0, 14_000);
  return [
    '你是 Alexandria 企业知识库的知识编译器。请阅读资料，将其编译成原子知识页、结构化主张与关联。',
    '只输出一个 JSON 对象，不要输出 Markdown、解释或代码围栏之外的文字。',
    '',
    'JSON 结构：',
    '{"sourceSummary":"一句话摘要","tldr":"一句话结论","claims":[{"text":"","subject":"","predicate":"","object":"","confidence":0.6}],"entities":[{"name":"实体名","type":"组织/人物/产品/标准/指标","description":"一句话","aliases":["别名"]}],"facts":[{"subject":"主语","predicate":"关系","object":"宾语","confidence":0.6}],"decisions":[{"title":"稳定决策名","decision":"决定了什么","rationale":"为什么这样决定","alternatives":["备选方案"],"owner":"责任主体","effectiveDate":"YYYY-MM-DD","status":"active|superseded","related":["相关概念标题"],"claims":[{"text":"","subject":"","predicate":"","object":"","confidence":0.6}],"confidence":0.6}],"concepts":[{"title":"稳定名词","classKey":"concept","parent":"上位概念标题","summary":"一句话","definition":"定义","points":["要点"],"tags":["标签"],"aliases":["别名"],"readWhen":["何时读这一页"],"confidence":0.6,"claims":[{"text":"","subject":"","predicate":"","object":"","confidence":0.6}],"related":["已有页面 slug 或标题"]}]}',
    '',
    '规则：',
    '- 一页只讲一个概念；标题必须是 2–30 字的稳定名词，不要句子、不要章节编号。',
    '- 最多 8 个概念；entities 抽取资料中出现的组织、人物、产品、标准、指标等；facts 抽取可核对的主谓宾事实。\n- decisions 抽取明确的政策选择、方案决定、批复、规则变更或管理决定：必须有 decision 与 rationale；没有明确决定时留空，不要把普通事实当决策。\n- 分层：用 parent 指向更上位的概念（或已有页面标题）；没有把握时留空。\n- 没有足够信息时对应数组可以为空。',
    '- 每条主张尽量带来源语境；不要编造资料中不存在的数字、人物或结论。',
    '- 优先复用已有页面；related 使用已有页面的 slug 或标题，避免制造重复页。',
    '- classKey 必须来自给定本体类型；不确定时用 concept。',
    '',
    `知识库本体类型：${classes.map((klass) => `${klass.key}(${klass.name})`).join('、')}`,
    `已有页面：${existing.map((page) => `${page.slug} | ${page.title} | ${page.class_key}`).join('；') || '无'}`,
    '',
    `资料标题：${source.title}`,
    `资料格式：${extracted.kind}`,
    '资料正文：',
    sections || truncate(extracted.text, 14_000),
  ].join('\n');
}

/**
 * 使用本机 DSH 编译一份资料。失败返回 null，由调用方回退到规则编译器。
 */
export function dshCompileSource(
  db: Db,
  env: Env,
  source: SourceRow,
  extracted: ExtractResult,
  actor?: Actor | null,
): DshCompileReport | null {
  const classes = db
    .prepare('SELECT key, name FROM ontology_classes WHERE library_id = ? ORDER BY sort_order')
    .all(source.library_id) as unknown as { key: string; name: string }[];
  const prompt = buildPrompt(source, extracted, db, classes);
  const output = runDshSync(env, prompt, { timeoutMs: Math.max(180_000, env.dsh.timeoutMs), maxChars: 32_000 });
  const parsed = extractJson<DshCompilation>(output);
  if (!parsed || !Array.isArray(parsed.concepts)) return null;

  const allowedClasses = new Set(classes.map((klass) => klass.key));
  const seen = new Set<string>();
  const concepts = parsed.concepts
    .filter((concept): concept is DshConcept & { title: string } => typeof concept.title === 'string' && concept.title.trim().length >= 2)
    .filter((concept) => {
      const key = normalizeTitle(concept.title);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8);
  const entities = (Array.isArray(parsed.entities) ? parsed.entities : [])
    .filter((entity): entity is DshEntity & { name: string } => typeof entity.name === 'string' && entity.name.trim().length >= 2)
    .slice(0, 12);
  const facts = (Array.isArray(parsed.facts) ? parsed.facts : []).slice(0, 30);
  const decisions = (Array.isArray(parsed.decisions) ? parsed.decisions : [])
    .filter((decision): decision is DshDecision & { title: string; decision: string } => typeof decision.title === 'string' && decision.title.trim().length >= 2 && typeof decision.decision === 'string' && decision.decision.trim().length >= 4)
    .slice(0, 5);
  const log: string[] = [`DSH 返回 ${concepts.length} 个概念、${entities.length} 个实体、${facts.length} 条事实、${decisions.length} 个决策`];
  let pagesCreated = 0;
  let pagesUpdated = 0;
  let conflicts = 0;

  const factClaims = facts
    .map((fact) => toClaim({ text: `${fact.subject ?? ''} ${fact.predicate ?? ''} ${fact.object ?? ''}`.trim(), subject: fact.subject, predicate: fact.predicate, object: fact.object, confidence: fact.confidence }, source.title, 'DSH 事实'))
    .filter((claim): claim is ExtractedClaim => Boolean(claim));
  const topClaims = [...(Array.isArray(parsed.claims) ? parsed.claims : []).map((claim) => toClaim(claim, source.title)).filter((claim): claim is ExtractedClaim => Boolean(claim)), ...factClaims];
  const summary = String(parsed.sourceSummary ?? '').trim() || truncate(extracted.text, 220);
  const sourceSlug = `sources/${slugify(source.title, 'source')}`;
  const existingSource = findSourcePage(db, source.id);
  let sourcePage: PageRow;
  if (existingSource) {
    sourcePage = updatePage(
      db,
      existingSource,
      {
        title: source.title,
        summary,
        tldr: String(parsed.tldr ?? '').trim() || truncate(topClaims[0]?.text ?? extracted.text, 120),
        body: sourceBody(source, extracted, [], topClaims, summary, []),
        status: 'active',
        metadata: { ...parseJson<Record<string, unknown>>(existingSource.metadata, {}), compiledBy: 'dsh', compiledAt: nowIso() },
        note: 'DSH 重新编译文献',
      },
      actor ?? null,
    );
    pagesUpdated += 1;
  } else {
    sourcePage = createPage(
      db,
      {
        libraryId: source.library_id,
        nodeId: source.node_id,
        classKey: 'source',
        title: source.title,
        slug: sourceSlug,
        summary,
        tldr: String(parsed.tldr ?? '').trim() || truncate(topClaims[0]?.text ?? extracted.text, 120),
        body: sourceBody(source, extracted, [], topClaims, summary, []),
        status: 'active',
        confidence: 0.7,
        tags: [],
        readWhen: [`查阅《${source.title}》原文`],
        metadata: { sourceId: source.id, compiledBy: 'dsh', compiledAt: nowIso() },
        createdBy: actor?.person.id ?? null,
      },
      actor ?? null,
    );
    db.prepare(
      "INSERT OR IGNORE INTO page_sources (page_id, source_id, relation, locator, quote) VALUES (?, ?, 'source-document', '', '')",
    ).run(sourcePage.id, source.id);
    pagesCreated += 1;
  }
  saveClaims(db, sourcePage.id, topClaims, source.id);

  const linked: { id: string; slug: string; title: string; related: string[] }[] = [];
  for (const concept of concepts) {
    const title = concept.title.trim();
    const classKey = concept.classKey && allowedClasses.has(concept.classKey) ? concept.classKey : 'concept';
    const definition = String(concept.definition ?? '').trim() || String(concept.summary ?? '').trim();
    const points = (Array.isArray(concept.points) ? concept.points : []).map(String).filter(Boolean).slice(0, 6);
    const tags = (Array.isArray(concept.tags) ? concept.tags : []).map(String).filter(Boolean).slice(0, 8);
    const aliases = (Array.isArray(concept.aliases) ? concept.aliases : []).map(String).filter(Boolean).slice(0, 6);
    const readWhen = (Array.isArray(concept.readWhen) ? concept.readWhen : []).map(String).filter(Boolean).slice(0, 4);
    const confidence = Math.max(0.35, Math.min(0.9, Number(concept.confidence ?? 0.6)));
    const existing = findExisting(db, source.library_id, title);
    if (existing) {
      const attached = db
        .prepare('SELECT 1 FROM page_sources WHERE page_id = ? AND source_id = ?')
        .get(existing.id, source.id);
      if (!attached) {
        const addition = [
          '',
          `## DSH 补充：来自《${source.title}》`,
          definition || concept.summary || 'DSH 从该来源补充了此概念。',
          ...points.map((point) => `- ${point}`),
          '',
          `来源：[[${sourcePage.slug}|《${source.title}》]]`,
        ].join('\n');
        const updated = updatePage(
          db,
          existing,
          {
            body: `${existing.body.trim()}\n${addition}`,
            summary: existing.summary || truncate(definition || concept.summary || '', 180),
            tags: mergeUnique(parseJson<string[]>(existing.tags, []), tags),
            aliases: mergeUnique(parseJson<string[]>(existing.aliases, []), aliases),
            readWhen: mergeUnique(parseJson<string[]>(existing.read_when, []), readWhen),
            confidence: Math.min(0.92, Math.max(existing.confidence, confidence)),
            metadata: { ...parseJson<Record<string, unknown>>(existing.metadata, {}), compiledBy: 'dsh', lastSourceId: source.id },
            note: `DSH 吸收《${source.title}》`,
          },
          actor ?? null,
        );
        attachSource(db, updated.id, source.id, 'derived-from', '', definition);
        saveClaims(db, updated.id, concept.claims?.map((claim) => toClaim(claim, title)).filter((claim): claim is ExtractedClaim => Boolean(claim)) ?? [], source.id);
        pagesUpdated += 1;
        linked.push({ id: updated.id, slug: updated.slug, title: updated.title, related: concept.related ?? [] });
      } else {
        linked.push({ id: existing.id, slug: existing.slug, title: existing.title, related: concept.related ?? [] });
      }
      continue;
    }

    const body = [
      '## 定义',
      definition || `《${source.title}》对本概念给出了说明。`,
      '',
      '## 要点',
      points.length ? points.map((point) => `- ${point}`).join('\n') : '- 暂无结构化要点，建议补充人工校对。',
      '',
      '## 来源',
      `- [[${sourcePage.slug}|《${source.title}》]]`,
      '',
    ].join('\n');
    const page = createPage(
      db,
      {
        libraryId: source.library_id,
        nodeId: source.node_id,
        classKey,
        title,
        slug: `concepts/${slugify(title, 'concept')}`,
        summary: truncate(definition || concept.summary || `由《${source.title}》编译`, 180),
        tldr: truncate(definition || concept.summary || `了解「${title}」`, 120),
        body,
        status: 'draft',
        confidence,
        tags,
        aliases,
        readWhen,
        metadata: { compiledBy: 'dsh', compiledFrom: source.id, compiledAt: nowIso() },
        createdBy: actor?.person.id ?? null,
      },
      actor ?? null,
    );
    attachSource(db, page.id, source.id, 'derived-from', '', definition);
    saveClaims(
      db,
      page.id,
      (concept.claims ?? []).map((claim) => toClaim(claim, title)).filter((claim): claim is ExtractedClaim => Boolean(claim)),
      source.id,
    );
    pagesCreated += 1;
    linked.push({ id: page.id, slug: page.slug, title: page.title, related: concept.related ?? [] });
  }

  for (const concept of linked) {
    addLink(db, source.library_id, concept.id, sourcePage.id, 'derived-from', 'frontmatter', 1.2);
    addLink(db, source.library_id, sourcePage.id, concept.id, 'mentions', 'frontmatter', 1);
  }
  for (const concept of linked) {
    for (const target of concept.related) {
      const ref = String(target).trim();
      const page = findByRef(db, source.library_id, ref);
      if (page && page.id !== concept.id) addLink(db, source.library_id, concept.id, page.id, 'related-to', 'semantic', 0.6);
    }
  }
  const linkedEntities: { id: string; slug: string; title: string }[] = [];
  for (const entity of entities) {
    const name = entity.name.trim();
    const existing = findExisting(db, source.library_id, name);
    if (existing) {
      const attached = db.prepare('SELECT 1 FROM page_sources WHERE page_id = ? AND source_id = ?').get(existing.id, source.id);
      if (!attached) attachSource(db, existing.id, source.id, 'derived-from', '', entity.description ?? '');
      addLink(db, source.library_id, existing.id, sourcePage.id, 'derived-from', 'frontmatter', 1.1);
      addLink(db, source.library_id, sourcePage.id, existing.id, 'mentions', 'frontmatter', 0.9);
      linkedEntities.push({ id: existing.id, slug: existing.slug, title: existing.title });
      continue;
    }
    const page = createPage(db, {
      libraryId: source.library_id,
      nodeId: source.node_id,
      classKey: allowedClasses.has('entity') ? 'entity' : 'concept',
      title: name,
      slug: `entities/${slugify(name, 'entity')}`,
      summary: truncate(String(entity.description ?? ''), 180),
      tldr: truncate(String(entity.description ?? ''), 120),
      body: `## 实体说明\n${entity.description ?? '由 DSH 从资料中抽取。'}\n\n## 来源\n- [[${sourcePage.slug}|《${source.title}》]]`,
      status: 'draft',
      confidence: 0.6,
      tags: [String(entity.type ?? '实体')],
      aliases: (entity.aliases ?? []).map(String).slice(0, 6),
      metadata: { compiledBy: 'dsh', compiledFrom: source.id, entityType: entity.type ?? 'entity' },
      createdBy: actor?.person.id ?? null,
    }, actor ?? null);
    attachSource(db, page.id, source.id, 'derived-from', '', String(entity.description ?? ''));
    addLink(db, source.library_id, page.id, sourcePage.id, 'derived-from', 'frontmatter', 1.1);
    addLink(db, source.library_id, sourcePage.id, page.id, 'mentions', 'frontmatter', 0.9);
    pagesCreated += 1;
    linkedEntities.push({ id: page.id, slug: page.slug, title: page.title });
  }
  const decisionPages: { id: string; slug: string; title: string }[] = [];
  const decisionPropertyRows = db.prepare("SELECT key, options FROM ontology_properties WHERE library_id = ? AND class_key = 'decision'").all(source.library_id) as unknown as { key: string; options: string }[];
  const decisionProperties = new Set(decisionPropertyRows.map((row) => row.key));
  const decisionStatusOptions = parseJson<string[]>(decisionPropertyRows.find((row) => row.key === 'status')?.options, []);
  for (const decision of decisions) {
    const title = decision.title.trim();
    const effectiveDate = String(decision.effectiveDate ?? '').trim() || (extracted.text.match(/(20\d{2})\s*[年\-/]\s*(\d{1,2})\s*[月\-/]\s*(\d{1,2})/)?.[0] ? `${extracted.text.match(/(20\d{2})/)?.[1]}-${String(Number(extracted.text.match(/(20\d{2})\s*[年\-/]\s*(\d{1,2})/) ?.[2] ?? 1)).padStart(2, '0')}-${String(Number(extracted.text.match(/(20\d{2})\s*[年\-/]\s*(\d{1,2})\s*[月\-/]\s*(\d{1,2})/)?.[3] ?? 1)).padStart(2, '0')}` : '');
    const status = decision.status === 'superseded' ? 'superseded' : 'active';
    const rationale = String(decision.rationale ?? '').trim();
    const alternatives = (Array.isArray(decision.alternatives) ? decision.alternatives : []).map(String).filter(Boolean).slice(0, 6);
    const owner = String(decision.owner ?? '').trim();
    const existing = db.prepare("SELECT * FROM pages WHERE library_id = ? AND class_key = 'decision' AND lower(title) = lower(?)").get(source.library_id, title) as unknown as PageRow | undefined;
    const body = [
      '## 决策', decision.decision.trim(), '',
      '## 依据', rationale || '资料未提供明确理由，需人工补充。', '',
      '## 备选方案', alternatives.length ? alternatives.map((item) => `- ${item}`).join('\n') : '资料未记录备选方案。', '',
      '## 责任主体', owner || '待确认', '',
      '## 生效信息', `生效日期：${effectiveDate || '待确认'} · 状态：${status}`, '',
      '## 来源', `- [[${sourcePage.slug}|《${source.title}》]]`, '',
    ].join('\n');
    const properties: Record<string, unknown> = {};
    if (decisionProperties.has('decidedAt') && effectiveDate) properties.decidedAt = effectiveDate;
    const mappedStatus = decisionStatusOptions.includes(status) ? status : status === 'active' && decisionStatusOptions.includes('已采纳') ? '已采纳' : status === 'superseded' && decisionStatusOptions.includes('已废弃') ? '已废弃' : null;
    if (decisionProperties.has('status') && mappedStatus) properties.status = mappedStatus;
    const metadata = { compiledBy: 'dsh', compiledFrom: source.id, decisionOwner: owner || null, effectiveDate: effectiveDate || null, status, rationale, alternatives };
    let page: PageRow;
    if (existing) {
      page = updatePage(db, existing, { body, summary: truncate(decision.decision.trim(), 180), tldr: truncate(decision.decision.trim(), 120), confidence: Math.max(existing.confidence, Math.min(0.9, Number(decision.confidence ?? 0.65))), metadata: { ...parseJson<Record<string, unknown>>(existing.metadata, {}), ...metadata }, properties: Object.keys(properties).length ? properties : undefined, effectiveDate: effectiveDate || null, note: `DSH 从《${source.title}》更新决策` }, actor ?? null);
      pagesUpdated += 1;
    } else {
      page = createPage(db, { libraryId: source.library_id, nodeId: source.node_id, classKey: 'decision', title, slug: `decisions/${slugify(title, 'decision')}`, summary: truncate(decision.decision.trim(), 180), tldr: truncate(decision.decision.trim(), 120), body, status: 'draft', confidence: Math.min(0.9, Number(decision.confidence ?? 0.65)), tags: ['决策'], aliases: [], readWhen: ['需要了解决策依据时'], metadata, properties: Object.keys(properties).length ? properties : undefined, createdBy: actor?.person.id ?? null }, actor ?? null);
      pagesCreated += 1;
    }
    attachSource(db, page.id, source.id, 'derived-from', '', decision.decision.trim());
    addLink(db, source.library_id, page.id, sourcePage.id, 'derived-from', 'frontmatter', 1.2);
    addLink(db, source.library_id, sourcePage.id, page.id, 'mentions', 'frontmatter', 1);
    saveClaims(db, page.id, (decision.claims ?? []).map((claim) => toClaim(claim, title, '决策')).filter((claim): claim is ExtractedClaim => Boolean(claim)), source.id);
    decisionPages.push({ id: page.id, slug: page.slug, title: page.title });
  }
  for (const decision of decisionPages) {
    const row = concepts.find((concept) => normalizeTitle(concept.title) === normalizeTitle(decision.title));
    if (row?.parent) { const parent = findByRef(db, source.library_id, row.parent); if (parent && parent.id !== decision.id) addLink(db, source.library_id, decision.id, parent.id, 'related-to', 'semantic', 0.5); }
  }

  for (const fact of facts) {
    const subject = findByRef(db, source.library_id, String(fact.subject ?? '').trim());
    const object = findByRef(db, source.library_id, String(fact.object ?? '').trim());
    if (subject && object && subject.id !== object.id) {
      addLink(db, source.library_id, subject.id, object.id, String(fact.predicate ?? 'relates-to').trim().slice(0, 40), 'semantic', Number(fact.confidence ?? 0.6));
    }
  }
  for (const concept of linked) {
    const sourceConcept = concepts.find((item) => normalizeTitle(item.title) === normalizeTitle(concept.title));
    if (sourceConcept?.parent) {
      const parent = findByRef(db, source.library_id, sourceConcept.parent);
      if (parent && parent.id !== concept.id) addLink(db, source.library_id, concept.id, parent.id, 'broader-than', 'semantic', 0.7);
    }
  }
  const finalBody = sourceBody(source, extracted, linked, topClaims, summary, linkedEntities);
  sourcePage = updatePage(
    db,
    sourcePage,
    {
      body: finalBody,
      metadata: { ...parseJson<Record<string, unknown>>(sourcePage.metadata, {}), compiledBy: 'dsh', conceptIds: linked.map((item) => item.id), compiledAt: nowIso() },
    },
    actor ?? null,
  );
  conflicts += detectConflicts(db, sourcePage.id).count;
  for (const concept of linked) conflicts += detectConflicts(db, concept.id).count;
  log.push(`DSH 编译完成：${pagesCreated} 新建 / ${pagesUpdated} 更新 / ${conflicts} 处矛盾 / ${decisionPages.length} 个决策`);
  return { sourcePageId: sourcePage.id, pagesCreated, pagesUpdated, conflicts, log, conceptIds: linked.map((item) => item.id) };
}
