import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Router } from '../http/router.ts';
import { requireActor } from '../http/auth.ts';
import { requireLibrary, visibleLibraries } from '../domain/access.ts';
import { errors } from '../http/respond.ts';
import { audit } from '../domain/audit.ts';
import { newId, nowIso, parseJson } from '../lib/ids.ts';
import { createPage, getPage, pageContext, pageToView, updatePage, attachSource } from '../knowledge/pages.ts';
import { searchKnowledge, answerKnowledge, graphForLibrary } from '../knowledge/search.ts';
import { answerKnowledgeWithDsh, searchKnowledgeWithDsh } from '../knowledge/dsh-query.ts';
import { synthesizeWithLlm } from '../knowledge/llm.ts';
import { pageListDto, parseList } from './helpers.ts';
import { ingestBuffer } from '../ingest/pipeline.ts';
import type { PageRow } from '../types.ts';

const MANIFEST = {
  name: 'alexandria',
  version: '0.1.0',
  description:
    '面向 DSH 智能体的 LLM Wiki 知识库：知识在入库时被编译为带本体类型、主张与关联的页面；查询时走词法 + 图谱 + 编译知识，而非查询期 RAG。',
  auth: 'Authorization: Bearer <alex_ak_...>（只读或写入密钥）',
  principles: [
    '先搜索已有知识，再决定创建还是更新页面',
    '写入完整页面，保留既有 tags/aliases/sources/claims，不要静默丢弃',
    '每条主张尽量带来源；矛盾要保留双方并标记，而不是覆盖',
    '页面正文使用 [[slug]] 建立关联；关联图在写入后即时可检索',
  ],
  tools: [
    { name: 'search', method: 'POST', path: '/api/agent/search', description: '检索知识页与文献' },
    { name: 'ask', method: 'POST', path: '/api/agent/ask', description: '从已编译知识页合成带引用的回答' },
    { name: 'read', method: 'POST', path: '/api/agent/read', description: '读取页面、主张、来源与关联' },
    { name: 'graph', method: 'POST', path: '/api/agent/graph', description: '读取知识图谱邻域' },
    { name: 'compile', method: 'POST', path: '/api/agent/compile', description: '重新编译一份文献' },
    { name: 'ingest', method: 'POST', path: '/api/agent/ingest', description: '以文本或 base64 资料入库并编译' },
    { name: 'upsert_page', method: 'POST', path: '/api/agent/page', description: '创建或更新知识页' },
    { name: 'lint', method: 'POST', path: '/api/agent/lint', description: '结构体检：孤儿页、断链、失败文献' },
    { name: 'export_page', method: 'GET', path: '/api/pages/:id/markdown', description: '导出 LLM Wiki 风格 Markdown' },
    { name: 'export_library', method: 'GET', path: '/api/libraries/:id/export.md', description: '导出整库 Markdown bundle' },
  ],
};

export function registerAgentRoutes(router: Router): void {
  router.get('/api/agent/manifest', (rc) => {
    rc.json(MANIFEST);
  });

  router.post('/api/agent/search', async (rc) => {
    const actor = requireActor(rc);
    const body = await rc.body<{ query?: string; libraryIds?: string[]; library?: string; classKey?: string; limit?: number }>();
    const libraryIds = body.libraryIds?.length
      ? body.libraryIds
      : body.library
        ? [requireLibrary(rc.app.db, actor, body.library).library.id]
        : undefined;
    if (libraryIds) for (const id of libraryIds) requireLibrary(rc.app.db, actor, id);
    const hits = body.query && rc.app.env.dsh.enabled
      ? await searchKnowledgeWithDsh(rc.app.db, rc.app.env, actor, body.query, {
          libraryIds,
          classKey: body.classKey,
          limit: body.limit ?? 20,
        })
      : searchKnowledge(rc.app.db, actor, body.query ?? '', {
          libraryIds,
          classKey: body.classKey,
          limit: body.limit ?? 20,
        });
    rc.json({
      hits: hits.map((hit) => ({
        kind: hit.kind,
        id: hit.id,
        title: hit.title,
        slug: hit.slug,
        libraryId: hit.libraryId,
        libraryName: hit.libraryName,
        classKey: hit.classKey,
        summary: hit.summary,
        snippet: hit.snippet,
        score: Number(hit.score.toFixed(3)),
        signals: hit.signals,
        status: hit.status,
        confidence: hit.confidence,
        tags: hit.tags,
      })),
      strategy: rc.app.env.dsh.enabled
        ? 'compiled-wiki: local candidates + local DSH semantic rerank/selection'
        : 'compiled-wiki: FTS5 + typed graph expansion',
    });
  });

  router.post('/api/agent/ask', async (rc) => {
    const actor = requireActor(rc);
    const body = await rc.body<{ query?: string; libraryIds?: string[]; mode?: 'compiled' | 'llm' | 'auto' | 'dsh' }>();
    const query = String(body.query ?? '').trim();
    if (!query) throw errors.badRequest('缺少 query');
    let compiled = answerKnowledge(rc.app.db, actor, query, { libraryIds: body.libraryIds, limit: 8 });
    if ((body.mode === 'dsh' || !body.mode) && rc.app.env.dsh.enabled && compiled.citations.length) {
      const dshAnswer = await answerKnowledgeWithDsh(rc.app.db, rc.app.env, actor, query, { libraryIds: body.libraryIds, limit: 8 });
      if (dshAnswer) compiled = dshAnswer;
    }
    let answer = compiled.answer;
    let mode = compiled.mode;
    if (compiled.mode !== 'dsh' && (body.mode === 'llm' || body.mode === 'auto' || (!body.mode && rc.app.env.llm)) && rc.app.env.llm && compiled.citations.length) {
      const synthesized = await synthesizeWithLlm(rc.app.env, query, compiled);
      if (synthesized) {
        answer = synthesized.answer;
        mode = 'llm';
      }
    }
    rc.json({ ...compiled, answer, mode });
  });

  router.post('/api/agent/read', async (rc) => {
    const actor = requireActor(rc);
    const body = await rc.body<{ pageId?: string; slug?: string; library?: string; includeContext?: boolean }>();
    let page: PageRow | null = null;
    if (body.pageId) page = getPage(rc.app.db, body.pageId);
    if (!page && body.slug) {
      if (body.library) {
        const { library } = requireLibrary(rc.app.db, actor, body.library);
        page = getPage(rc.app.db, body.slug);
        if (page && page.library_id !== library.id) page = null;
      } else {
        page = getPage(rc.app.db, body.slug);
      }
    }
    if (!page) throw errors.notFound('知识页不存在');
    const { library, role } = requireLibrary(rc.app.db, actor, page.library_id);
    const view = pageToView(rc.app.db, page);
    const properties = rc.app.db
      .prepare('SELECT key, value FROM page_properties WHERE page_id = ?')
      .all(page.id) as unknown as { key: string; value: string }[];
    const claims = rc.app.db.prepare('SELECT * FROM claims WHERE page_id = ? ORDER BY confidence DESC').all(page.id);
    const sources = rc.app.db
      .prepare(
        `SELECT s.id, s.title, s.filename, ps.relation, ps.locator, ps.quote FROM page_sources ps
          JOIN sources s ON s.id = ps.source_id WHERE ps.page_id = ?`,
      )
      .all(page.id);
    const links = rc.app.db
      .prepare(
        `SELECT l.relation, l.origin, p.id, p.title, p.slug, p.class_key FROM links l JOIN pages p ON p.id = l.to_page_id
          WHERE l.from_page_id = ? ORDER BY l.weight DESC`,
      )
      .all(page.id);
    const backlinks = rc.app.db
      .prepare(
        `SELECT l.relation, p.id, p.title, p.slug, p.class_key FROM links l JOIN pages p ON p.id = l.from_page_id
          WHERE l.to_page_id = ? ORDER BY l.weight DESC`,
      )
      .all(page.id);
    rc.json({
      page: {
        ...pageListDto(rc.app.db, page),
        body: view.body,
        metadata: view.metadataObj,
        properties: properties.map((property) => ({ key: property.key, value: (() => { try { return JSON.parse(property.value); } catch { return property.value; } })() })),
      },
      context: body.includeContext === false ? undefined : pageContext(rc.app.db, page),
      claims,
      sources,
      links,
      backlinks,
      library: { id: library.id, name: library.name, slug: library.slug },
      role,
    });
  });

  router.post('/api/agent/graph', async (rc) => {
    const actor = requireActor(rc);
    const body = await rc.body<{ libraryId?: string; library?: string; classKey?: string; limit?: number }>();
    const ref = body.libraryId ?? body.library;
    if (!ref) throw errors.badRequest('需要 libraryId');
    const { library } = requireLibrary(rc.app.db, actor, ref);
    rc.json(graphForLibrary(rc.app.db, actor, library.id, { classKey: body.classKey, limit: body.limit ?? 300 }));
  });

  router.post('/api/agent/ingest', async (rc) => {
    const actor = requireActor(rc);
    const body = await rc.body<{
      libraryId?: string;
      library?: string;
      filename?: string;
      title?: string;
      text?: string;
      base64?: string;
      nodeId?: string;
    }>();
    const ref = body.libraryId ?? body.library;
    if (!ref) throw errors.badRequest('需要 libraryId');
    const { library } = requireLibrary(rc.app.db, actor, ref, 'editor');
    let buffer: Buffer;
    if (body.base64) {
      try {
        buffer = Buffer.from(body.base64, 'base64');
      } catch {
        throw errors.badRequest('base64 内容不合法');
      }
    } else if (typeof body.text === 'string') {
      buffer = Buffer.from(body.text, 'utf8');
    } else {
      throw errors.badRequest('需要 text 或 base64 内容');
    }
    if (!buffer.length) throw errors.badRequest('入库内容为空');
    const filename = String(body.filename ?? 'agent-note.md').slice(0, 180);
    const result = ingestBuffer(rc.app.db, rc.app.env, library.id, {
      buffer,
      filename,
      title: body.title ? String(body.title) : undefined,
      nodeId: body.nodeId ?? null,
      actor,
    });
    rc.json(
      {
        source: { id: result.source.id, title: result.source.title, status: result.source.status },
        jobId: result.jobId,
        duplicate: result.duplicate,
        note: '编译异步执行；轮询 /api/jobs/:id，完成后用 /api/agent/search 验证',
      },
      result.duplicate ? 200 : 202,
    );
  });

  router.post('/api/agent/compile', async (rc) => {
    const actor = requireActor(rc);
    const body = await rc.body<{ sourceId?: string }>();
    if (!body.sourceId) throw errors.badRequest('需要 sourceId');
    const source = rc.app.db.prepare('SELECT * FROM sources WHERE id = ?').get(body.sourceId) as unknown as
      | { id: string; library_id: string; status: string }
      | undefined;
    if (!source) throw errors.notFound('文献不存在');
    requireLibrary(rc.app.db, actor, source.library_id, 'editor');
    const { reprocessSource } = await import('../ingest/pipeline.ts');
    const scheduled = reprocessSource(rc.app.db, rc.app.env, source.id);
    rc.json({ jobId: scheduled, note: '编译已排队；轮询 /api/jobs/:id' }, 202);
  });

  router.post('/api/agent/page', async (rc) => {
    const actor = requireActor(rc);
    const body = await rc.body<{
      libraryId?: string;
      library?: string;
      slug?: string;
      title?: string;
      classKey?: string;
      summary?: string;
      tldr?: string;
      body?: string;
      status?: string;
      confidence?: number;
      tags?: string[];
      aliases?: string[];
      readWhen?: string[];
      properties?: Record<string, unknown>;
      sourceId?: string;
      note?: string;
    }>();
    const ref = body.libraryId ?? body.library;
    if (!ref) throw errors.badRequest('需要 libraryId');
    const { library } = requireLibrary(rc.app.db, actor, ref, 'editor');
    const title = String(body.title ?? '').trim();
    if (!title) throw errors.badRequest('需要 title');
    let existing: PageRow | null = null;
    if (body.slug) {
      existing = rc.app.db
        .prepare('SELECT * FROM pages WHERE library_id = ? AND slug = ?')
        .get(library.id, body.slug) as unknown as PageRow | undefined ?? null;
    }
    if (!existing) {
      existing = rc.app.db
        .prepare('SELECT * FROM pages WHERE library_id = ? AND lower(title) = lower(?)')
        .get(library.id, title) as unknown as PageRow | undefined ?? null;
    }
    let page: PageRow;
    if (existing) {
      page = updatePage(
        rc.app.db,
        existing,
        {
          classKey: body.classKey,
          title,
          summary: body.summary,
          tldr: body.tldr,
          body: body.body,
          status: body.status,
          confidence: body.confidence,
          tags: body.tags,
          aliases: body.aliases,
          readWhen: body.readWhen,
          properties: body.properties,
          note: body.note ?? 'DSH 智能体更新',
        },
        actor,
      );
    } else {
      page = createPage(
        rc.app.db,
        {
          libraryId: library.id,
          classKey: body.classKey ?? 'concept',
          title,
          slug: body.slug,
          summary: body.summary ?? '',
          tldr: body.tldr ?? '',
          body: body.body ?? '',
          status: body.status ?? 'draft',
          confidence: body.confidence ?? 0.5,
          tags: parseList(body.tags),
          aliases: parseList(body.aliases),
          readWhen: parseList(body.readWhen),
          metadata: { createdByAgent: true },
          properties: body.properties,
        },
        actor,
      );
    }
    if (body.sourceId) {
      const source = rc.app.db.prepare('SELECT 1 FROM sources WHERE id = ? AND library_id = ?').get(body.sourceId, library.id);
      if (source) attachSource(rc.app.db, page.id, body.sourceId, 'derived-from');
    }
    audit(rc.app.db, { actor, action: existing ? 'agent.page.update' : 'agent.page.create', targetType: 'page', targetId: page.id, libraryId: library.id });
    rc.json({ page: pageListDto(rc.app.db, page), created: !existing }, existing ? 200 : 201);
  });

  router.post('/api/agent/lint', async (rc) => {
    const actor = requireActor(rc);
    const body = await rc.body<{ libraryId?: string }>();
    const libraries = body.libraryId ? [requireLibrary(rc.app.db, actor, body.libraryId).library] : visibleLibraries(rc.app.db, actor);
    const ids = libraries.map((library) => library.id);
    const ph = ids.map(() => '?').join(',') || "''";
    const pages = rc.app.db
      .prepare(`SELECT * FROM pages WHERE library_id IN (${ph})`)
      .all(...(ids.length ? ids : [''])) as unknown as PageRow[];
    const orphans: unknown[] = [];
    const brokenLinks: unknown[] = [];
    for (const page of pages) {
      const degree = rc.app.db
        .prepare('SELECT COUNT(*) AS c FROM links WHERE from_page_id = ? OR to_page_id = ?')
        .get(page.id, page.id) as unknown as { c: number };
      if (Number(degree.c) === 0 && page.class_key !== 'source') orphans.push({ id: page.id, title: page.title, libraryId: page.library_id });
      const linkBody = page.body.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
      for (const match of linkBody.matchAll(/\[\[([^\]|#]+)/g)) {
        const target = rc.app.db
          .prepare('SELECT 1 FROM pages WHERE library_id = ? AND slug = ?')
          .get(page.library_id, match[1]!.trim());
        if (!target) brokenLinks.push({ pageId: page.id, page: page.title, target: match[1]!.trim() });
      }
    }
    const failedSources = rc.app.db
      .prepare(`SELECT id, title, error FROM sources WHERE library_id IN (${ph}) AND status = 'failed'`)
      .all(...(ids.length ? ids : ['']));
    const stalePages = pages.filter((page) => page.status === 'draft').map((page) => ({ id: page.id, title: page.title, status: page.status }));
    rc.json({
      summary: { pages: pages.length, orphans: orphans.length, brokenLinks: brokenLinks.length, failedSources: failedSources.length, drafts: stalePages.length },
      orphans,
      brokenLinks,
      failedSources,
      drafts: stalePages,
    });
  });

  router.get('/api/agent/skill', (rc) => {
    try {
      const content = readFileSync(join(rc.app.env.root, 'skills', 'alexandria', 'SKILL.md'), 'utf8');
      rc.res.statusCode = 200;
      rc.res.setHeader('content-type', 'text/markdown; charset=utf-8');
      rc.res.end(content);
    } catch {
      throw errors.notFound('技能文件不存在');
    }
  });

  router.get('/api/agent/overview', (rc) => {
    const actor = requireActor(rc);
    const libraries = visibleLibraries(rc.app.db, actor).map((library) => ({
      id: library.id,
      slug: library.slug,
      name: library.name,
      role: library.role,
      pages: Number(
        (rc.app.db.prepare('SELECT COUNT(*) AS c FROM pages WHERE library_id = ?').get(library.id) as unknown as { c: number }).c,
      ),
      sources: Number(
        (rc.app.db.prepare('SELECT COUNT(*) AS c FROM sources WHERE library_id = ?').get(library.id) as unknown as { c: number }).c,
      ),
      classes: rc.app.db
        .prepare('SELECT key, name, color FROM ontology_classes WHERE library_id = ? ORDER BY sort_order')
        .all(library.id),
    }));
    rc.json({ organization: { people: rc.app.db.prepare('SELECT COUNT(*) AS c FROM persons').get(), teams: rc.app.db.prepare('SELECT COUNT(*) AS c FROM teams').get() }, libraries, manifest: MANIFEST });
  });

  router.get('/api/agent/export/:libraryId', (rc) => {
    const actor = requireActor(rc);
    const { library } = requireLibrary(rc.app.db, actor, rc.params.libraryId!);
    const pages = rc.app.db.prepare('SELECT * FROM pages WHERE library_id = ? ORDER BY class_key, title').all(library.id) as unknown as PageRow[];
    rc.json({
      format: 'llm-wiki-bundle',
      library: { slug: library.slug, name: library.name },
      pages: pages.map((page) => {
        const view = pageToView(rc.app.db, page);
        return {
          slug: page.slug,
          frontmatter: {
            type: page.class_key,
            title: page.title,
            status: page.status,
            confidence: page.confidence,
            tags: view.tagsList,
            aliases: view.aliasesList,
            read_when: view.readWhenList,
            sources: [],
            claims: [],
          },
          body: page.body,
        };
      }),
    });
  });
}
