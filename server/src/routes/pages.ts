import type { Router } from '../http/router.ts';
import type { RequestContext } from '../http/context.ts';
import { requireActor } from '../http/auth.ts';
import { requireLibrary, effectivePageRole, effectiveSourceRole, resourceGrants, actorFor, effectiveRole } from '../domain/access.ts';
import { audit } from '../domain/audit.ts';
import { securityEvent, requestIp, grantRecipients } from '../domain/security.ts';
import { notifyPerson } from '../domain/notifications.ts';
import { errors } from '../http/respond.ts';
import { newId, nowIso, parseJson } from '../lib/ids.ts';
import { pageContext, pageToView, getPage, createPage, updatePage, deletePage, attachSource, resolvePageRef, mergePages, snapshotAndTrashPage, restorePageFromTrash } from '../knowledge/pages.ts';
import { relatedPages } from '../knowledge/search.ts';
import { canEdit, pageAccess, pageListDto, parseList } from './helpers.ts';
import type { PageRow } from '../types.ts';

function pageDetail(rc: RequestContext, page: PageRow, role: import('../types.ts').Role, actor: import('../types.ts').Actor) {
  const view = pageToView(rc.app.db, page);
  const sources = rc.app.db
    .prepare(
      `SELECT s.*, ps.relation, ps.locator, ps.quote
         FROM page_sources ps JOIN sources s ON s.id = ps.source_id WHERE ps.page_id = ?`,
    )
    .all(page.id) as unknown as import('../types.ts').SourceRow[];
  const visibleSources = sources.filter((source) => Boolean(effectiveSourceRole(rc.app.db, actor, source)));
  const claims = rc.app.db
    .prepare("SELECT * FROM claims WHERE page_id = ? AND status NOT IN ('ignored', 'resolved') ORDER BY confidence DESC, created_at ASC")
    .all(page.id) as unknown as Record<string, unknown>[];
  const allRelations = relatedPages(rc.app.db, page.id);
  const canSeeRelated = (item: { id: string }) => {
    const related = getPage(rc.app.db, item.id);
    return Boolean(related && effectivePageRole(rc.app.db, actor, related));
  };
  const relations = { outbound: allRelations.outbound.filter(canSeeRelated), inbound: allRelations.inbound.filter(canSeeRelated) };
  const parentRow = rc.app.db
    .prepare("SELECT p.id, p.title, p.slug FROM links l JOIN pages p ON p.id = l.to_page_id WHERE l.from_page_id = ? AND l.relation = 'broader-than' LIMIT 1")
    .get(page.id) as unknown as { id: string; title: string; slug: string } | undefined;
  const childRows = rc.app.db
    .prepare("SELECT p.id, p.title, p.slug FROM links l JOIN pages p ON p.id = l.from_page_id WHERE l.to_page_id = ? AND l.relation = 'broader-than' ORDER BY p.title")
    .all(page.id) as unknown as { id: string; title: string; slug: string }[];
  const properties = rc.app.db
    .prepare(
      `SELECT pp.key, pp.value, op.name, op.type, op.options
         FROM page_properties pp
         LEFT JOIN ontology_properties op ON op.library_id = ? AND op.key = pp.key AND (op.class_key = ? OR op.class_key IS NULL)
        WHERE pp.page_id = ?`,
    )
    .all(page.library_id, page.class_key, page.id) as unknown as {
    key: string;
    value: string;
    name: string | null;
    type: string | null;
    options: string | null;
  }[];
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
      visibility: page.visibility,
      access: role === 'owner'
        ? { canManage: true, grants: resourceGrants(rc.app.db, 'page', page.id) }
        : { canManage: false, grants: [] },
    },
    library,
    sources: visibleSources,
    claims: claims.map((claim) => ({
      ...claim,
      confidence: Number(claim.confidence),
    })),
    links: relations,
    properties: properties.map((property) => ({
      key: property.key,
      value: parseJson<unknown>(property.value, property.value),
      name: property.name ?? property.key,
      type: property.type ?? 'string',
      options: parseJson<string[]>(property.options, []),
    })),
    revisions,
    context: pageContext(rc.app.db, page, 12000, visibleSources.map((source) => source.id)),
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
    const allRows = rc.app.db
      .prepare(`SELECT * FROM pages WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC`)
      .all(...params) as unknown as PageRow[];
    const visible = allRows.filter((page) => Boolean(effectivePageRole(rc.app.db, actor, page)));
    rc.json({ total: visible.length, pages: visible.slice(offset, offset + limit).map((page) => pageListDto(rc.app.db, page)) });
  });

  router.get('/api/pages/:id', (rc) => {
    const { actor, page, role } = pageAccess(rc, rc.params.id!);
    rc.json({ ...pageDetail(rc, page, role, actor), role, canEdit: canEdit(role) });
  });

  router.get('/api/pages/:id/context', (rc) => {
    const { actor, page } = pageAccess(rc, rc.params.id!);
    const sourceIds = (rc.app.db.prepare('SELECT s.* FROM sources s JOIN page_sources ps ON ps.source_id = s.id WHERE ps.page_id = ?').all(page.id) as unknown as import('../types.ts').SourceRow[])
      .filter((source) => Boolean(effectiveSourceRole(rc.app.db, actor, source)))
      .map((source) => source.id);
    rc.json({ context: pageContext(rc.app.db, page, 12000, sourceIds), page: pageListDto(rc.app.db, page) });
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
        properties: body.properties as Record<string, unknown> | undefined,
      },
      actor,
    );
    audit(rc.app.db, { actor, action: 'page.create', targetType: 'page', targetId: page.id, libraryId: library.id, detail: { title } });
    rc.json({ page: pageListDto(rc.app.db, page) }, 201);
  });

  router.patch('/api/pages/:id', async (rc) => {
    const actor = requireActor(rc);
    const { page, library, role } = pageAccess(rc, rc.params.id!);
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
        properties: body.properties !== undefined ? (body.properties as Record<string, unknown>) : undefined,
        note: body.note ? String(body.note) : '',
      },
      actor,
    );
    audit(rc.app.db, { actor, action: 'page.update', targetType: 'page', targetId: page.id, libraryId: library.id, detail: { version: updated.version } });
    rc.json({ page: pageListDto(rc.app.db, updated) });
  });

  router.delete('/api/pages/:id', (rc) => {
    const actor = requireActor(rc);
    const { page, library, role } = pageAccess(rc, rc.params.id!);
    if (!canEdit(role)) throw errors.forbidden('需要编辑权限');
    const trashId = snapshotAndTrashPage(rc.app.db, page, actor);
    audit(rc.app.db, { actor, action: 'page.trash', targetType: 'page', targetId: page.id, libraryId: library.id, detail: { title: page.title, trashId } });
    rc.json({ ok: true });
  });

  router.get('/api/pages/:id/revisions', (rc) => {
    const { page } = pageAccess(rc, rc.params.id!);
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
    const { page, library, role } = pageAccess(rc, rc.params.id!);
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
    const { page, library, role } = pageAccess(rc, rc.params.id!);
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
    const { page } = pageAccess(rc, rc.params.id!);
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
  router.get('/api/pages/:id/access', (rc) => {
    const { actor, page, library, role } = pageAccess(rc, rc.params.id!, 'viewer');
    const canManage = actor.person.isAdmin || role === 'owner';
    if (!canManage) throw errors.forbidden('需要知识页所有者权限');
    rc.json({
      pageId: page.id,
      visibility: page.visibility,
      canManage,
      grants: resourceGrants(rc.app.db, 'page', page.id),
      libraryRole: requireLibrary(rc.app.db, actor, library.id).role,
      visibilityOptions: ['inherit', 'restricted', 'private'],
    });
  });

  router.patch('/api/pages/:id/access', async (rc) => {
    const { actor, page, library, role } = pageAccess(rc, rc.params.id!, 'viewer');
    if (actor.viaApiKey && actor.apiScope === 'read') throw errors.forbidden('只读 API Key 不能修改访问策略');
    if (!actor.person.isAdmin && role !== 'owner') throw errors.forbidden('需要知识页所有者权限');
    const body = await rc.body<{
      visibility?: string;
      grants?: { subjectType?: string; subjectId?: string; role?: string }[];
    }>();
    const visibility = ['inherit', 'restricted', 'private'].includes(String(body.visibility)) ? String(body.visibility) : page.visibility;
    const grants = Array.isArray(body.grants) ? body.grants : [];
    const valid = [];
    for (const grant of grants) {
      const subjectType = String(grant.subjectType ?? '');
      const subjectId = String(grant.subjectId ?? '').trim();
      const grantRole = String(grant.role ?? 'viewer');
      if (!['person', 'team'].includes(subjectType) || !subjectId || !['viewer', 'editor'].includes(grantRole)) continue;
      const exists = subjectType === 'person'
        ? rc.app.db.prepare("SELECT 1 FROM persons WHERE id = ? AND status = 'active'").get(subjectId)
        : rc.app.db.prepare('SELECT 1 FROM teams WHERE id = ?').get(subjectId);
      if (exists) valid.push({ subjectType, subjectId, role: grantRole });
    }
    const before = resourceGrants(rc.app.db, 'page', page.id);
    rc.app.db.prepare('UPDATE pages SET visibility = ?, updated_at = ? WHERE id = ?').run(visibility, nowIso(), page.id);
    rc.app.db.prepare("DELETE FROM resource_grants WHERE resource_type = 'page' AND resource_id = ?").run(page.id);
    const insert = rc.app.db.prepare(
      'INSERT INTO resource_grants (id, resource_type, resource_id, subject_type, subject_id, role, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const grant of valid) insert.run(newId('rgrant'), 'page', page.id, grant.subjectType, grant.subjectId, grant.role, actor.person.id, nowIso());
    const beforeKeys = new Set(before.map((grant) => `${grant.subjectType}:${grant.subjectId}:${grant.role}`));
    for (const grant of valid) {
      if (beforeKeys.has(`${grant.subjectType}:${grant.subjectId}:${grant.role}`)) continue;
      for (const personId of grantRecipients(rc.app.db, grant.subjectType, grant.subjectId)) {
        if (personId === actor.person.id) continue;
        await notifyPerson(rc.app.db, rc.app.env, {
          personId,
          actorId: actor.person.id,
          kind: 'permission',
          title: `你获得了知识页「${page.title}」的访问权限`,
          body: `角色：${grant.role}`,
          link: `/#/page/${encodeURIComponent(page.id)}`,
          libraryId: library.id,
          pageId: page.id,
        });
      }
    }
    securityEvent(rc.app.db, { kind: 'page.access.update', severity: 'warning', actorId: actor.person.id, subject: page.id, ip: requestIp(rc), detail: { visibility, grants: valid.length } });
    audit(rc.app.db, { actor, action: 'page.access.update', targetType: 'page', targetId: page.id, libraryId: library.id, detail: { visibility, grants: valid.length } });
    rc.json({ ok: true, visibility, grants: resourceGrants(rc.app.db, 'page', page.id) });
  });

  router.post('/api/pages/:id/merge', async (rc) => {
    const { actor, page, library, role } = pageAccess(rc, rc.params.id!, 'editor');
    if (!actor.person.isAdmin && role !== 'owner') throw errors.forbidden('需要页面所有者权限');
    const body = await rc.body<{ targetId?: string }>();
    const targetId = String(body.targetId ?? '').trim();
    if (!targetId) throw errors.badRequest('需要 targetId');
    const { page: target, role: targetRole } = pageAccess(rc, targetId, 'editor');
    if (!actor.person.isAdmin && targetRole !== 'owner') throw errors.forbidden('需要目标页面所有者权限');
    if (page.id === target.id) throw errors.badRequest('不能合并到自身');
    if (page.library_id !== target.library_id) throw errors.badRequest('只能合并同一知识库内的页面');
    if (page.class_key !== target.class_key) throw errors.badRequest('只能合并同类型页面');
    const merged = mergePages(rc.app.db, page, target, actor);
    audit(rc.app.db, {
      actor,
      action: 'page.merge',
      targetType: 'page',
      targetId: target.id,
      libraryId: library.id,
      detail: { sourceId: page.id, sourceTitle: page.title, targetId: target.id, targetTitle: target.title },
    });
    rc.json({ ok: true, page: pageListDto(rc.app.db, merged), mergedInto: target.id });
  });

  router.post('/api/pages/:id/parent', async (rc) => {
    const { actor, page, library, role } = pageAccess(rc, rc.params.id!, 'editor');
    if (actor.viaApiKey && actor.apiScope === 'read') throw errors.forbidden('只读 API Key 不能修改层级');
    if (!actor.person.isAdmin && role !== 'owner') throw errors.forbidden('需要页面所有者权限');
    const body = await rc.body<{ parentId?: string | null }>();
    const parentId = body.parentId ? String(body.parentId) : null;
    if (parentId === page.id) throw errors.badRequest('不能把页面设为自己的上位概念');
    if (parentId) {
      const target = getPage(rc.app.db, parentId);
      if (!target || target.library_id !== library.id) throw errors.badRequest('上位概念必须属于同一知识库');
      const targetAccess = pageAccess(rc, target.id, 'viewer');
      if (!targetAccess.role) throw errors.notFound('上位概念不存在');
    }
    rc.app.db.prepare("DELETE FROM links WHERE from_page_id = ? AND relation = 'broader-than'").run(page.id);
    if (parentId) {
      rc.app.db
        .prepare('INSERT OR IGNORE INTO links (id, library_id, from_page_id, to_page_id, relation, origin, weight, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(newId('lnk'), library.id, page.id, parentId, 'broader-than', 'manual', 1, nowIso());
    }
    audit(rc.app.db, { actor, action: 'page.hierarchy.update', targetType: 'page', targetId: page.id, libraryId: library.id, detail: { parentId } });
    rc.json({ ok: true, parentId });
  });

  router.get('/api/pages/:id/access-audit', (rc) => {
    const { actor, page, library, role } = pageAccess(rc, rc.params.id!, 'viewer');
    if (!actor.person.isAdmin && role !== 'owner') throw errors.forbidden('需要知识页所有者权限');
    const grants = resourceGrants(rc.app.db, 'page', page.id);
    const libraryRole = requireLibrary(rc.app.db, actor, library.id).role;
    const people = rc.app.db.prepare("SELECT * FROM persons WHERE status = 'active' ORDER BY name").all() as unknown as Record<string, unknown>[];
    const rows = people.map((row) => {
      const person = {
        id: String(row.id),
        email: String(row.email),
        name: String(row.name),
        title: String(row.title ?? ''),
        avatarColor: String(row.avatar_color ?? 'slate'),
        isAdmin: Boolean(row.is_admin),
      };
      const subject = actorFor(rc.app.db, person);
      const effective = effectivePageRole(rc.app.db, subject, page);
      let reason = 'none';
      if (effective) {
        if (person.isAdmin) reason = '组织管理员';
        else if (grants.some((grant) => (grant.subjectType === 'person' && grant.subjectId === person.id) || (grant.subjectType === 'team' && subject.teamIds.includes(grant.subjectId)))) reason = '页面/团队定向共享';
        else if (page.owner_person_id === person.id || page.created_by === person.id) reason = '页面所有者';
        else if (page.visibility === 'inherit') reason = effectiveRole(rc.app.db, subject, library) === 'owner' ? '知识库所有者' : effectiveRole(rc.app.db, subject, library) === 'editor' ? '知识库成员' : '知识库只读';
        else reason = '知识库所有者继承';
      }
      return { ...person, role: effective ?? null, reason };
    });
    rc.json({ pageId: page.id, visibility: page.visibility, grants, actorRole: libraryRole, people: rows.filter((row) => row.role) });
  });

  router.post('/api/merge-proposals/:id/approve', (rc) => {
    const actor = requireActor(rc);
    const proposal = rc.app.db.prepare('SELECT * FROM merge_proposals WHERE id = ?').get(rc.params.id!) as unknown as
      | { id: string; library_id: string; source_page_id: string; target_page_id: string; status: string }
      | undefined;
    if (!proposal) throw errors.notFound('合并建议不存在');
    if (proposal.status !== 'pending') throw errors.conflict('该建议已处理');
    const { library } = requireLibrary(rc.app.db, actor, proposal.library_id, 'editor');
    const source = getPage(rc.app.db, proposal.source_page_id);
    const target = getPage(rc.app.db, proposal.target_page_id);
    if (!source || !target) throw errors.notFound('页面不存在');
    pageAccess(rc, source.id, 'editor');
    pageAccess(rc, target.id, 'editor');
    mergePages(rc.app.db, source, target, actor);
    rc.app.db.prepare("UPDATE merge_proposals SET status = 'approved', reviewed_by = ?, reviewed_at = ? WHERE id = ?").run(actor.person.id, nowIso(), proposal.id);
    audit(rc.app.db, { actor, action: 'merge.approve', targetType: 'page', targetId: target.id, libraryId: library.id, detail: { proposalId: proposal.id, sourceId: source.id } });
    rc.json({ ok: true, targetId: target.id });
  });

  router.post('/api/merge-proposals/:id/reject', (rc) => {
    const actor = requireActor(rc);
    const proposal = rc.app.db.prepare('SELECT * FROM merge_proposals WHERE id = ?').get(rc.params.id!) as unknown as
      | { id: string; library_id: string; status: string }
      | undefined;
    if (!proposal) throw errors.notFound('合并建议不存在');
    if (proposal.status !== 'pending') throw errors.conflict('该建议已处理');
    requireLibrary(rc.app.db, actor, proposal.library_id, 'editor');
    rc.app.db.prepare("UPDATE merge_proposals SET status = 'rejected', reviewed_by = ?, reviewed_at = ? WHERE id = ?").run(actor.person.id, nowIso(), proposal.id);
    audit(rc.app.db, { actor, action: 'merge.reject', targetType: 'merge_proposal', targetId: proposal.id, libraryId: proposal.library_id });
    rc.json({ ok: true });
  });

  router.get('/api/libraries/:id/trash', (rc) => {
    const actor = requireActor(rc);
    const { library } = requireLibrary(rc.app.db, actor, rc.params.id!, 'editor');
    const rows = rc.app.db
      .prepare(
        `SELECT t.id, t.page_id, t.deleted_at, t.restored_at, t.restored_page_id, p.name AS deleted_by_name, t.snapshot
           FROM trash_pages t LEFT JOIN persons p ON p.id = t.deleted_by
          WHERE t.library_id = ? AND t.restored_at IS NULL ORDER BY t.deleted_at DESC LIMIT 100`,
      )
      .all(library.id) as unknown as Record<string, unknown>[];
    rc.json({
      items: rows.map((row) => {
        const snapshot = parseJson<{ page?: { title?: string; channel?: string; slug?: string } }>(String(row.snapshot ?? '{}'), {});
        return {
          id: row.id,
          pageId: row.page_id,
          title: snapshot.page?.title ?? '未命名页面',
          slug: snapshot.page?.slug ?? '',
          deletedAt: row.deleted_at,
          deletedByName: row.deleted_by_name,
        };
      }),
    });
  });

  router.post('/api/trash/:id/restore', (rc) => {
    const actor = requireActor(rc);
    const row = rc.app.db.prepare('SELECT * FROM trash_pages WHERE id = ?').get(rc.params.id!) as unknown as
      | { id: string; library_id: string }
      | undefined;
    if (!row) throw errors.notFound('回收站记录不存在');
    requireLibrary(rc.app.db, actor, row.library_id, 'editor');
    const page = restorePageFromTrash(rc.app.db, row.id, actor);
    audit(rc.app.db, { actor, action: 'page.restore', targetType: 'page', targetId: page.id, libraryId: row.library_id, detail: { trashId: row.id } });
    rc.json({ ok: true, page: pageListDto(rc.app.db, page) });
  });

  router.delete('/api/trash/:id', (rc) => {
    const actor = requireActor(rc);
    const row = rc.app.db.prepare('SELECT * FROM trash_pages WHERE id = ?').get(rc.params.id!) as unknown as
      | { id: string; library_id: string }
      | undefined;
    if (!row) throw errors.notFound('回收站记录不存在');
    requireLibrary(rc.app.db, actor, row.library_id, 'owner');
    rc.app.db.prepare('DELETE FROM trash_pages WHERE id = ?').run(row.id);
    audit(rc.app.db, { actor, action: 'trash.purge', targetType: 'trash', targetId: row.id, libraryId: row.library_id });
    rc.json({ ok: true });
  });

}
