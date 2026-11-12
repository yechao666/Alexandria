import type { Db } from '../db/index.ts';
import type { Env } from '../env.ts';
import type { Actor, PageRow } from '../types.ts';
import { truncate } from '../lib/ids.ts';
import { answerKnowledge, type KnowledgeAnswer, type SearchFilters } from './search.ts';
import { runDsh, extractJson } from './dsh-runtime.ts';

interface DshSelected {
  pageId?: string;
  reason?: string;
}

interface DshAnswerPayload {
  answer?: string;
  selected?: DshSelected[];
  gaps?: string[];
}

function sourceContext(db: Db, page: PageRow, maxChars = 1200): string {
  const claims = db
    .prepare("SELECT text FROM claims WHERE page_id = ? AND status <> 'ignored' ORDER BY confidence DESC LIMIT 5")
    .all(page.id) as unknown as { text: string }[];
  const sources = db
    .prepare('SELECT s.title FROM page_sources ps JOIN sources s ON s.id = ps.source_id WHERE ps.page_id = ? LIMIT 3')
    .all(page.id) as unknown as { title: string }[];
  return [
    `页面 ID：${page.id}`,
    `标题：${page.title}`,
    `类型：${page.class_key}｜状态：${page.status}｜置信度：${page.confidence}`,
    `摘要：${page.summary}`,
    page.tldr ? `结论：${page.tldr}` : '',
    `正文节选：${truncate(page.body, maxChars)}`,
    claims.length ? `主张：${claims.map((claim) => claim.text).join('；')}` : '',
    sources.length ? `来源：${sources.map((source) => source.title).join('；')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 本机 DSH 驱动的语义检索 + 知识合成。
 * 本地 FTS/图谱负责给出候选集，DSH 在候选内做相关性选择、证据组织与答案合成。
 * DSH 不可用或输出不合法时返回 null，由调用方回退到编译式答案。
 */
export async function answerKnowledgeWithDsh(
  db: Db,
  env: Env,
  actor: Actor,
  query: string,
  filters: SearchFilters = {},
): Promise<KnowledgeAnswer | null> {
  if (!env.dsh.enabled) return null;
  const started = Date.now();
  const base = answerKnowledge(db, actor, query, filters);
  const hits = base.pages.filter((hit) => hit.kind === 'page').slice(0, 10);
  if (!hits.length) return base;
  const pages = hits
    .map((hit) => db.prepare('SELECT * FROM pages WHERE id = ?').get(hit.id) as unknown as PageRow | undefined)
    .filter((page): page is PageRow => Boolean(page));
  if (!pages.length) return base;
  const candidates = pages.map((page) => sourceContext(db, page)).join('\n\n---\n\n');

  const prompt = [
    '你是 Alexandria 企业知识库的检索与知识合成器。你只能依据下面给出的候选知识页回答，不得使用外部知识，不得编造。',
    '请完成两件事：1) 从候选页中选择真正支持答案的页面；2) 用这些页面合成简洁、可核对的中文答案。',
    '只输出 JSON，不要 Markdown 代码围栏之外的内容：',
    '{"selected":[{"pageId":"pg_...","reason":"为什么相关"}],"answer":"答案正文","gaps":["仍需补充的信息"]}',
    '',
    '规则：',
    '- selected 只能使用候选页面中的 pageId，按相关性排序，最多 6 个。',
    '- answer 先给结论，再用 2–5 个要点展开；每个要点后用〔页面标题〕标注来源。',
    '- 如果候选页不足，明确写出的不确定性或 gaps，不要臆测。',
    '- 不要引用未出现在候选中的页面。',
    '',
    `用户问题：${query}`,
    '',
    '候选知识页：',
    candidates,
  ].join('\n');

  const output = await runDsh(env, prompt, { timeoutMs: Math.max(60_000, env.dsh.timeoutMs), maxChars: 16_000 });
  const parsed = extractJson<DshAnswerPayload>(output);
  if (!parsed || !String(parsed.answer ?? '').trim()) return null;
  const selectedIds = (Array.isArray(parsed.selected) ? parsed.selected : [])
    .map((item) => String(item.pageId ?? ''))
    .filter((id) => pages.some((page) => page.id === id))
    .slice(0, 6);
  const selectedPages = selectedIds.length
    ? selectedIds.map((id) => pages.find((page) => page.id === id)!).filter(Boolean)
    : pages.slice(0, 3);
  const citations = selectedPages.map((page) => {
    const hit = hits.find((item) => item.id === page.id);
    return {
      pageId: page.id,
      title: page.title,
      slug: page.slug,
      libraryId: page.library_id,
      libraryName: hit?.libraryName ?? '',
      excerpt: truncate(page.tldr || page.summary || page.body, 420),
      confidence: page.confidence,
    };
  });
  return {
    mode: 'dsh',
    answer: String(parsed.answer).trim(),
    citations,
    pages: base.pages,
    gaps: (Array.isArray(parsed.gaps) ? parsed.gaps : []).map(String).filter(Boolean).slice(0, 5),
    signals: {
      ...base.signals,
      dsh: 1,
      dshSelected: selectedPages.length,
    },
    tookMs: Date.now() - started,
  };
}

interface DshRankPayload {
  selected?: { id?: string; reason?: string }[];
}

/**
 * DSH 语义重排：本地 FTS/图谱给出候选，DSH 在候选内选择与排序。
 * 失败时回退到原始检索结果。
 */
export async function searchKnowledgeWithDsh(
  db: Db,
  env: Env,
  actor: Actor,
  query: string,
  filters: SearchFilters = {},
): Promise<import('./search.ts').SearchHit[]> {
  const hits = answerKnowledge(db, actor, query, filters).pages;
  if (!env.dsh.enabled || !query.trim() || hits.length < 2) return hits;
  const pages = hits.filter((hit) => hit.kind === 'page').slice(0, 15);
  if (pages.length < 2) return hits;
  const prompt = [
    '你是 Alexandria 企业知识库的检索排序器。根据用户问题，从候选结果中选择真正相关的知识页并排序。',
    '只输出 JSON：{"selected":[{"id":"页面 ID","reason":"为什么相关"}]}',
    '最多选择 8 个；不要编造候选之外的 ID；没有相关结果时 selected 为空。',
    '',
    `用户问题：${query}`,
    '',
    '候选结果：',
    ...pages.map((hit, index) => `${index + 1}. id=${hit.id}｜${hit.title}｜${hit.libraryName}｜${hit.className}\n摘要：${hit.summary}\n片段：${hit.snippet}`),
  ].join('\n');
  const output = await runDsh(env, prompt, { timeoutMs: Math.max(45_000, env.dsh.timeoutMs), maxChars: 8000 });
  const parsed = extractJson<DshRankPayload>(output);
  if (!parsed || !Array.isArray(parsed.selected) || !parsed.selected.length) return hits;
  const selected = parsed.selected
    .map((item) => String(item.id ?? ''))
    .filter((id) => pages.some((hit) => hit.id === id));
  if (!selected.length) return hits;
  const rank = new Map(selected.map((id, index) => [id, index]));
  return [...hits].sort((a, b) => {
    const left = rank.has(a.id) ? rank.get(a.id)! : 1000;
    const right = rank.has(b.id) ? rank.get(b.id)! : 1000;
    return left - right || b.score - a.score;
  }).map((hit) => (rank.has(hit.id) ? { ...hit, signals: { ...hit.signals, dsh: 1 } } : hit));
}
