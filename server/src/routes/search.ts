import type { Router } from '../http/router.ts';
import { requireActor } from '../http/auth.ts';
import { requireLibrary, visibleLibraries } from '../domain/access.ts';
import { errors } from '../http/respond.ts';
import { searchKnowledge, answerKnowledge, graphForLibrary, relatedPages, rebuildIndexes } from '../knowledge/search.ts';
import { synthesizeWithLlm } from '../knowledge/llm.ts';
import { getPage, pageToView } from '../knowledge/pages.ts';
import { parseList } from './helpers.ts';
import type { PageRow } from '../types.ts';

function filtersFrom(rc: import('../http/context.ts').RequestContext) {
  const library = rc.query('library') || rc.query('libraryId');
  const libraryIds = library
    ? [
        (rc.app.db.prepare('SELECT id FROM libraries WHERE id = ? OR slug = ?').get(library, library) as unknown as { id: string } | undefined)?.id ?? library,
      ]
    : parseList(rc.query('libraries'))
        .map((ref) => {
          const row = rc.app.db.prepare('SELECT id FROM libraries WHERE id = ? OR slug = ?').get(ref, ref) as unknown as
            | { id: string }
            | undefined;
          return row?.id;
        })
        .filter((id): id is string => Boolean(id));
  return {
    libraryIds,
    classKey: rc.query('class') || rc.query('classKey') || undefined,
    status: rc.query('status') || undefined,
    tag: rc.query('tag') || undefined,
    limit: rc.queryInt('limit', 30),
  };
}

export function registerSearchRoutes(router: Router): void {
  router.get('/api/search', (rc) => {
    const actor = requireActor(rc);
    const q = rc.query('q');
    const filters = filtersFrom(rc);
    const started = Date.now();
    const hits = searchKnowledge(rc.app.db, actor, q, filters);
    rc.json({
      query: q,
      tookMs: Date.now() - started,
      total: hits.length,
      hits,
      strategy: q
        ? 'FTS5 词法检索 + 预编译关联图扩展 + 元数据/时效重排（无查询时向量化）'
        : '最近更新',
    });
  });

  router.post('/api/query', async (rc) => {
    const actor = requireActor(rc);
    const body = await rc.body<{
      q?: string;
      query?: string;
      library?: string;
      libraryIds?: string[];
      mode?: 'compiled' | 'llm' | 'auto';
      limit?: number;
    }>();
    const q = String(body.q ?? body.query ?? '').trim();
    if (!q) throw errors.badRequest('请输入问题');
    if (body.libraryIds?.length) {
      for (const id of body.libraryIds) requireLibrary(rc.app.db, actor, id);
    }
    const filters = {
      libraryIds: body.libraryIds,
      limit: Math.max(1, Math.min(20, body.limit ?? 8)),
    };
    const compiled = answerKnowledge(rc.app.db, actor, q, filters);
    let answer = compiled.answer;
    let mode = compiled.mode;
    if ((body.mode === 'llm' || body.mode === 'auto' || !body.mode) && rc.app.env.llm && compiled.citations.length) {
      const synthesized = await synthesizeWithLlm(rc.app.env, q, compiled);
      if (synthesized) {
        answer = synthesized.answer;
        mode = 'llm';
      }
    }
    rc.json({ ...compiled, answer, mode, query: q });
  });

  router.get('/api/graph', (rc) => {
    const actor = requireActor(rc);
    const library = rc.query('library') || rc.query('libraryId');
    if (library) {
      const { library: resolved } = requireLibrary(rc.app.db, actor, library);
      rc.json({ ...graphForLibrary(rc.app.db, actor, resolved.id, { classKey: rc.query('class') || undefined }), libraryId: resolved.id });
      return;
    }
    const libraries = visibleLibraries(rc.app.db, actor).slice(0, 8);
    const nodes: unknown[] = [];
    const edges: unknown[] = [];
    for (const lib of libraries) {
      const graph = graphForLibrary(rc.app.db, actor, lib.id, { limit: 80, classKey: rc.query('class') || undefined });
      nodes.push(...(graph.nodes as Record<string, unknown>[]).map((node) => ({ ...node, libraryId: lib.id, libraryName: lib.name })));
      edges.push(...(graph.edges as unknown[]));
    }
    rc.json({ nodes: nodes.slice(0, 400), edges, libraryId: null });
  });

  router.get('/api/libraries/:id/graph', (rc) => {
    const actor = requireActor(rc);
    const { library } = requireLibrary(rc.app.db, actor, rc.params.id!);
    const graph = graphForLibrary(rc.app.db, actor, library.id, {
      classKey: rc.query('class') || undefined,
      limit: rc.queryInt('limit', 400),
    });
    rc.json({ ...graph, libraryId: library.id });
  });

  router.get('/api/libraries/:id/facets', (rc) => {
    const actor = requireActor(rc);
    const { library } = requireLibrary(rc.app.db, actor, rc.params.id!);
    const classes = rc.app.db
      .prepare(
        `SELECT p.class_key AS key, c.name, c.color, COUNT(*) AS count FROM pages p
          LEFT JOIN ontology_classes c ON c.library_id = p.library_id AND c.key = p.class_key
          WHERE p.library_id = ? GROUP BY p.class_key ORDER BY count DESC`,
      )
      .all(library.id) as unknown as { key: string; name: string; color: string; count: number }[];
    const statuses = rc.app.db
      .prepare('SELECT status AS key, COUNT(*) AS count FROM pages WHERE library_id = ? GROUP BY status')
      .all(library.id) as unknown as { key: string; count: number }[];
    const tags = rc.app.db.prepare('SELECT tags FROM pages WHERE library_id = ?').all(library.id) as unknown as { tags: string }[];
    const tagCounts = new Map<string, number>();
    for (const row of tags) {
      for (const tag of parseList(row.tags)) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
    rc.json({
      classes,
      statuses,
      tags: [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([tag, count]) => ({ tag, count })),
      ontologyRelations: rc.app.db.prepare('SELECT * FROM ontology_relations WHERE library_id = ?').all(library.id),
    });
  });

  router.get('/api/tags', (rc) => {
    const actor = requireActor(rc);
    const libraries = visibleLibraries(rc.app.db, actor);
    const ids = libraries.map((library) => library.id);
    const ph = ids.map(() => '?').join(',') || "''";
    const rows = rc.app.db.prepare(`SELECT tags FROM pages WHERE library_id IN (${ph})`).all(...(ids.length ? ids : [''])) as unknown as {
      tags: string;
    }[];
    const counts = new Map<string, number>();
    for (const row of rows) for (const tag of parseList(row.tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    rc.json({ tags: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 100).map(([tag, count]) => ({ tag, count })) });
  });

  router.get('/api/recent', (rc) => {
    const actor = requireActor(rc);
    const libraries = visibleLibraries(rc.app.db, actor);
    const ids = libraries.map((library) => library.id);
    const ph = ids.map(() => '?').join(',') || "''";
    const rows = ids.length
      ? (rc.app.db
          .prepare(`SELECT * FROM pages WHERE library_id IN (${ph}) ORDER BY updated_at DESC LIMIT ?`)
          .all(...ids, rc.queryInt('limit', 20)) as unknown as PageRow[])
      : [];
    rc.json({
      pages: rows.map((page) => {
        const lib = libraries.find((library) => library.id === page.library_id)!;
        return {
          id: page.id,
          title: page.title,
          summary: page.summary,
          classKey: page.class_key,
          status: page.status,
          updatedAt: page.updated_at,
          libraryId: page.library_id,
          libraryName: lib.name,
          librarySlug: lib.slug,
          tags: parseList(page.tags),
        };
      }),
    });
  });

  router.get('/api/pages/:id/neighbors', (rc) => {
    const actor = requireActor(rc);
    const page = getPage(rc.app.db, rc.params.id!);
    if (!page) throw errors.notFound('知识页不存在');
    requireLibrary(rc.app.db, actor, page.library_id);
    const relation = relatedPages(rc.app.db, page.id);
    const neighbors = [...relation.outbound.map((item) => ({ ...item, direction: 'out' })), ...relation.inbound.map((item) => ({ ...item, direction: 'in' }))];
    rc.json({ neighbors, page: { id: page.id, title: page.title, classKey: page.class_key, className: pageToView(rc.app.db, page).className } });
  });

  router.post('/api/rebuild-index', (rc) => {
    const actor = requireActor(rc);
    if (!actor.person.isAdmin) throw errors.forbidden('需要组织管理员权限');
    rc.json({ ok: true, ...rebuildIndexes(rc.app.db) });
  });
}
