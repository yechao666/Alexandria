import type { Router } from '../http/router.ts';
import type { RequestContext } from '../http/context.ts';
import { requireActor } from '../http/auth.ts';
import { requireLibrary } from '../domain/access.ts';
import { audit } from '../domain/audit.ts';
import { errors } from '../http/respond.ts';
import { newId, nowIso, parseJson } from '../lib/ids.ts';
import { pageContext, pageToView, getPage, createPage, updatePage, deletePage, attachSource, resolvePageRef } from '../knowledge/pages.ts';
import { relatedPages } from '../knowledge/search.ts';
import { canEdit, pageListDto, parseList } from './helpers.ts';
import type { PageRow } from '../types.ts';

function requirePage(rc: RequestContext, id: string) {
  const actor = requireActor(rc);
  const page = getPage(rc.app.db, id);
  if (!page) throw errors.notFound('知识页不存在');
  const { library, role } = requireLibrary(rc.app.db, actor, page.library_id);
  return { actor, page, library, role };
}

function pageDetail(rc: RequestContext, page: PageRow) {
  const view = pageToView(rc.app.db, page);
  const sources = rc.app.db
    .prepare(
      `SELECT s.id, s.title, s.filename, s.kind, s.status, ps.relation, ps.locator, ps.quote
         FROM page_sources ps JOIN sources s ON s.id = ps.source_id WHERE ps.page_id = ?`,
    )
    .all(page.id);
  const claims = rc.app.db
    .prepare('SELECT * FROM claims WHERE page_id = ? ORDER BY confidence DESC, created_at ASC')
    .all(page.id) as unknown as Record<string, unknown>[];
  const relations = relatedPages(rc.app.db, page.id);
  const properties = rc.app.db
    .prepare('SELECT key, value FROM page_properties WHERE page_id = ?')
    .all(page.id) as unknown as { key: string; value: string }[];
  const revisions = rc.app.db
    .prepare('SELECT id, version, editor_id, note, created_at FROM page_revisions WHERE page_id = ? ORDER BY version DESC LIMIT 20')
    .all(page.id);
  const library = rc.app.db.prepare('SELECT name, slug FROM libraries WHERE id = ?').get(page.library_id) as unknown as {
    name: string;
    slug: string;
  };
  return {
    page: {
      ...pageListDto(rc.app.db, page),
      body: view.body,
      tldr: view.tldr,
      metadata: view.metadataObj,
      readWhen: view.readWhenList,
      aliases: view.aliasesList,
      ownerPersonId: view.owner_person_id,
      supersededBy: view.superseded_by,
      creatorName: view.creatorName,
      updaterName: view.updaterName,
    },
    library,
    sources,
    claims: claims.map((claim) => ({
      ...claim,
      confidence: Number(claim.confidence),
    })),
    links: relations,
    properties: properties.map((property) => ({ key: property.key, value: parseJson<unknown>(property.value, property.value) })),
    revisions,
    context: pageContext(rc.app.db, page),
  };
}

export function registerPageRoutes(router: Router): void {

  router.get('/api/libraries/:id/pages', (rc) => {
    const actor = requireActor(rc);
    const { library } = requireLibrary(rc.app.db, actor, rc.params.id!);
    const limit = Math.max(1, Math.min(500, rc.queryInt('limit', 100)));
    const offset = Math.max(0, rc.queryInt('offset', 0));
    const conditions = ['library_id = ?'];
    const params: (string | number)[] = [library.id];
    if (rc.query('node')) {
      conditions.push('node_id = ?');
      params.push(rc.query('node'));
    }
    if (rc.query('class')) {
      conditions.push('class_key = ?');
      params.push(rc.query('class'));
    }
    if (rc.query('status')) {
      conditions.push('status = ?');
      params.push(rc.query('status'));
    }
    if (rc.query('q')) {
      conditions.push('(title LIKE ? OR summary LIKE ? OR body LIKE ?)');
      const q = `%${rc.query('q')}%`;
      params.push(q, q, q);
    }
    const total = rc.app.db
      .prepare(`SELECT COUNT(*) AS c FROM pages WHERE ${conditions.join(' AND ')}`)
      .get(...params) as unknown as { c: number };
    const rows = rc.app.db
      .prepare(`SELECT * FROM pages WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as unknown as PageRow[];
    rc.json({ total: Number(total.c), pages: rows.map((page) => pageListDto(rc.app.db, page)) });
  });

  router.get('/api/pages/:id', (rc) => {
    const { page, role } = requirePage(rc, rc.params.id!);
    rc.json({ ...pageDetail(rc, page), role, canEdit: canEdit(role) });
  });

  router.get('/api/pages/:id/context', (rc) => {
    const { page } = requirePage(rc, rc.params.id!);
    rc.json({ context: pageContext(rc.app.db, page), page: pageListDto(rc.app.db, page) });
  });

  router.post('/api/libraries/:id/pages', async (rc) => {
    const actor = requireActor(rc);
    const { library } = requireLibrary(rc.app.db, actor, rc.params.id!, 'editor');
    const body = await rc.body<Record<string, unknown>>();
    const title = String(body.title ?? '').trim();
    if (!title) throw errors.badRequest('标题不能为空');
    const page = createPage(
      rc.app.db,
      {
        libraryId: library.id,
        nodeId: body.nodeId ? String(body.nodeId) : null,
        classKey: body.classKey ? String(body.classKey) : 'concept',
        title,
        slug: body.slug ? String(body.slug) : undefined,
        summary: body.summary ? String(body.summary) : '',
        tldr: body.tldr ? String(body.tldr) : '',
        body: body.body ? String(body.body) : '',
        status: body.status ? String(body.status) : 'draft',
        confidence: Number(body.confidence ?? 0.5),
        tags: parseList(body.tags),
        aliases: parseList(body.aliases),
        readWhen: parseList(body.readWhen),
        metadata: (body.metadata as Record<string, unknown>) ?? {},
      },
      actor,
    );
    audit(rc.app.db, { actor, action: 'page.create', targetType: 'page', targetId: page.id, libraryId: library.id, detail: { title } });
    rc.json({ page: pageListDto(rc.app.db, page) }, 201);
  });

  router.patch('/api/pages/:id', async (rc) => {
    const actor = requireActor(rc);
    const { page, library, role } = requirePage(rc, rc.params.id!);
    if (!canEdit(role)) throw errors.forbidden('需要编辑权限');
    const body = await rc.body<Record<string, unknown>>();
    if (body.classKey !== undefined) {
      const exists = rc.app.db
        .prepare('SELECT 1 FROM ontology_classes WHERE library_id = ? AND key = ?')
        .get(library.id, String(body.classKey));
      if (!exists) throw errors.badRequest('类型不存在');
    }
    if (body.nodeId) {
      const node = rc.app.db
        .prepare('SELECT 1 FROM catalog_nodes WHERE id = ? AND library_id = ?')
        .get(String(body.nodeId), library.id);
      if (!node) throw errors.badRequest('目录不存在');
    }
    const updated = updatePage(
      rc.app.db,
      page,
      {
        nodeId: body.nodeId !== undefined ? (body.nodeId ? String(body.nodeId) : null) : undefined,
        classKey: body.classKey !== undefined ? String(body.classKey) : undefined,
        title: body.title !== undefined ? String(body.title) : undefined,
        slug: body.slug !== undefined ? String(body.slug) : undefined,
        summary: body.summary !== undefined ? String(body.summary) : undefined,
        tldr: body.tldr !== undefined ? String(body.tldr) : undefined,
        body: body.body !== undefined ? String(body.body) : undefined,
        status: body.status !== undefined ? String(body.status) : undefined,
        confidence: body.confidence !== undefined ? Number(body.confidence) : undefined,
        tags: body.tags !== undefined ? parseList(body.tags) : undefined,
        aliases: body.aliases !== undefined ? parseList(body.aliases) : undefined,
        readWhen: body.readWhen !== undefined ? parseList(body.readWhen) : undefined,
        metadata: body.metadata !== undefined ? (body.metadata as Record<string, unknown>) : undefined,
        note: body.note ? String(body.note) : '',
      },
      actor,
    );
    audit(rc.app.db, { actor, action: 'page.update', targetType: 'page', targetId: page.id, libraryId: library.id, detail: { version: updated.version } });
    rc.json({ page: pageListDto(rc.app.db, updated) });
  });

  router.delete('/api/pages/:id', (rc) => {
    const actor = requireActor(rc);
    const { page, library, role } = requirePage(rc, rc.params.id!);
    if (!canEdit(role)) throw errors.forbidden('需要编辑权限');
    deletePage(rc.app.db, page.id);
    audit(rc.app.db, { actor, action: 'page.delete', targetType: 'page', targetId: page.id, libraryId: library.id, detail: { title: page.title } });
    rc.json({ ok: true });
  });

  router.get('/api/pages/:id/revisions', (rc) => {
    const { page } = requirePage(rc, rc.params.id!);
    const rows = rc.app.db
      .prepare('SELECT id, version, snapshot, editor_id, note, created_at FROM page_revisions WHERE page_id = ? ORDER BY version DESC LIMIT 40')
      .all(page.id) as unknown as { id: string; version: number; snapshot: string; editor_id: string | null; note: string; created_at: string }[];
    rc.json({
      revisions: rows.map((row) => ({
        id: row.id,
        version: row.version,
        note: row.note,
        createdAt: row.created_at,
        editorId: row.editor_id,
        page: parseJson<Record<string, unknown>>(row.snapshot, {}),
      })),
    });
  });

  router.post('/api/pages/:id/claims', async (rc) => {
    const actor = requireActor(rc);
    const { page, library, role } = requirePage(rc, rc.params.id!);
    if (!canEdit(role)) throw errors.forbidden('需要编辑权限');
    const body = await rc.body<Record<string, unknown>>();
    const text = String(body.text ?? '').trim();
    if (!text) throw errors.badRequest('主张内容不能为空');
    const id = newId('clm');
    rc.app.db
      .prepare(
        `INSERT INTO claims (id, page_id, text, subject, predicate, object, confidence, source_id, section, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      )
      .run(
        id,
        page.id,
        text,
        String(body.subject ?? ''),
        String(body.predicate ?? '人工补充'),
        String(body.object ?? ''),
        Number(body.confidence ?? 0.65),
        body.sourceId ? String(body.sourceId) : null,
        String(body.section ?? ''),
        nowIso(),
      );
    audit(rc.app.db, { actor, action: 'claim.create', targetType: 'page', targetId: page.id, libraryId: library.id });
    rc.json({ id }, 201);
  });

  router.post('/api/pages/:id/sources', async (rc) => {
    const actor = requireActor(rc);
    const { page, library, role } = requirePage(rc, rc.params.id!);
    if (!canEdit(role)) throw errors.forbidden('需要编辑权限');
    const body = await rc.body<Record<string, unknown>>();
    const sourceId = String(body.sourceId ?? '');
    const source = rc.app.db
      .prepare('SELECT id FROM sources WHERE id = ? AND library_id = ?')
      .get(sourceId, library.id);
    if (!source) throw errors.badRequest('文献不存在');
    attachSource(rc.app.db, page.id, sourceId, body.relation ? String(body.relation) : 'cites', String(body.locator ?? ''), String(body.quote ?? ''));
    audit(rc.app.db, { actor, action: 'page.source.attach', targetType: 'page', targetId: page.id, libraryId: library.id, detail: { sourceId } });
    rc.json({ ok: true });
  });

  router.get('/api/pages/:id/related', (rc) => {
    const { page } = requirePage(rc, rc.params.id!);
    rc.json(relatedPages(rc.app.db, page.id));
  });

  router.get('/api/resolve', (rc) => {
    const actor = requireActor(rc);
    const libraryRef = rc.query('library');
    const ref = rc.query('ref');
    if (!ref) throw errors.badRequest('缺少 ref');
    const { library } = requireLibrary(rc.app.db, actor, libraryRef);
    const page = resolvePageRef(rc.app.db, library.id, ref);
    if (!page) throw errors.notFound('未找到页面');
    rc.json({ page: pageListDto(rc.app.db, page) });
  });
}
