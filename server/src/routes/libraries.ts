import type { Router } from '../http/router.ts';
import type { RequestContext } from '../http/context.ts';
import { requireActor, requireAdmin } from '../http/auth.ts';
import { requireLibrary, visibleLibraries, effectiveRole, parseActorFromPerson } from '../domain/access.ts';
import { audit } from '../domain/audit.ts';
import { errors } from '../http/respond.ts';
import { newId, nowIso, parseJson, slugify } from '../lib/ids.ts';
import { ensureDefaultOntology } from '../knowledge/ontology.ts';
import { pageToView } from '../knowledge/pages.ts';
import { canEdit, libraryCounts, nodeTree, pageListDto, serializeLibrary } from './helpers.ts';
import type { LibraryRow, PageRow } from '../types.ts';

function requireLibraryEdit(rc: RequestContext, idOrSlug: string) {
  const actor = requireActor(rc);
  const { library, role } = requireLibrary(rc.app.db, actor, idOrSlug, 'editor');
  return { actor, library, role };
}

function createNode(
  db: import('../db/index.ts').Db,
  libraryId: string,
  input: { name: string; parentId?: string | null; kind?: string; code?: string; description?: string; icon?: string },
): Record<string, unknown> {
  const name = String(input.name ?? '').trim();
  if (!name) throw errors.badRequest('目录名称不能为空');
  const parentId = input.parentId ?? null;
  if (parentId) {
    const parent = db
      .prepare('SELECT 1 FROM catalog_nodes WHERE id = ? AND library_id = ?')
      .get(parentId, libraryId);
    if (!parent) throw errors.badRequest('父级目录不存在');
  }
  let slug = slugify(name, 'node');
  let counter = 2;
  while (db.prepare('SELECT 1 FROM catalog_nodes WHERE library_id = ? AND slug = ?').get(libraryId, slug)) {
    slug = `${slugify(name, 'node')}-${counter}`;
    counter += 1;
  }
  const id = newId('cat');
  const max = db
    .prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM catalog_nodes WHERE library_id = ? AND parent_id IS ?')
    .get(libraryId, parentId) as unknown as { m: number };
  db.prepare(
    `INSERT INTO catalog_nodes (id, library_id, parent_id, name, slug, kind, code, description, icon, sort_order, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    libraryId,
    parentId,
    name,
    slug,
    input.kind ?? 'section',
    input.code ?? '',
    input.description ?? '',
    input.icon ?? '',
    Number(max.m) + 10,
    nowIso(),
  );
  return { id, name, slug, parentId };
}

export function registerLibraryRoutes(router: Router): void {
  router.get('/api/libraries', (rc) => {
    const actor = requireActor(rc);
    const libraries = visibleLibraries(rc.app.db, actor).map((library) =>
      serializeLibrary(rc.app.db, library as LibraryRow, library.role),
    );
    rc.json({ libraries });
  });

  router.post('/api/libraries', async (rc) => {
    const actor = requireActor(rc);
    const body = await rc.body<{
      name?: string;
      slug?: string;
      description?: string;
      color?: string;
      icon?: string;
      visibility?: string;
      ownerTeamId?: string | null;
      kind?: string;
    }>();
    const name = String(body.name ?? '').trim();
    if (!name) throw errors.badRequest('知识库名称不能为空');
    let ownerTeamId = body.ownerTeamId ?? null;
    if (ownerTeamId && !actor.teamIds.includes(ownerTeamId) && !actor.person.isAdmin) {
      throw errors.forbidden('只能把知识库绑定到自己所属的团队');
    }
    if (!actor.person.isAdmin) {
      if (!ownerTeamId) {
        const leadTeam = rc.app.db
          .prepare("SELECT team_id FROM team_members WHERE person_id = ? AND role = 'lead' LIMIT 1")
          .get(actor.person.id) as unknown as { team_id: string } | undefined;
        ownerTeamId = leadTeam?.team_id ?? null;
      }
      if (!ownerTeamId) throw errors.forbidden('只有组织管理员或团队负责人可以创建知识库');
    }
    const slug = slugify(body.slug?.trim() || name, 'library');
    if (rc.app.db.prepare('SELECT 1 FROM libraries WHERE slug = ?').get(slug)) {
      throw errors.conflict('知识库标识（slug）已被占用');
    }
    const id = newId('lib');
    const now = nowIso();
    rc.app.db
      .prepare(
        `INSERT INTO libraries (id, slug, name, description, icon, color, kind, visibility, owner_team_id, created_by, settings, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
      )
      .run(
        id,
        slug,
        name,
        body.description ?? '',
        body.icon ?? 'book',
        body.color ?? 'jade',
        body.kind ?? 'wiki',
        body.visibility === 'private' || body.visibility === 'public' ? body.visibility : 'internal',
        ownerTeamId,
        actor.person.id,
        now,
        now,
      );
    ensureDefaultOntology(rc.app.db, id);
    createNode(rc.app.db, id, { name: '综合', kind: 'shelf', code: 'A', description: '未分类的资料与知识页' });
    createNode(rc.app.db, id, { name: '专题', kind: 'section', code: 'B', description: '按主题组织的知识' });
    rc.app.db
      .prepare(
        "INSERT INTO library_grants (id, library_id, subject_type, subject_id, role, created_by, created_at) VALUES (?, ?, 'person', ?, 'owner', ?, ?)",
      )
      .run(newId('grant'), id, actor.person.id, actor.person.id, now);
    audit(rc.app.db, {
      actor,
      action: 'library.create',
      targetType: 'library',
      targetId: id,
      libraryId: id,
      detail: { name, visibility: body.visibility ?? 'internal' },
    });
    const library = rc.app.db.prepare('SELECT * FROM libraries WHERE id = ?').get(id) as unknown as LibraryRow;
    rc.json({ library: serializeLibrary(rc.app.db, library, 'owner') }, 201);
  });

  router.get('/api/libraries/:id', (rc) => {
    const actor = requireActor(rc);
    const { library, role } = requireLibrary(rc.app.db, actor, rc.params.id!);
    const nodes = nodeTree(rc.app.db, library.id);
    const classes = rc.app.db
      .prepare('SELECT * FROM ontology_classes WHERE library_id = ? ORDER BY sort_order')
      .all(library.id) as unknown as {
      id: string;
      key: string;
      name: string;
      description: string;
      icon: string;
      color: string;
      schema_json: string;
      builtin: number;
    }[];
    const relations = rc.app.db
      .prepare('SELECT * FROM ontology_relations WHERE library_id = ? ORDER BY created_at')
      .all(library.id) as unknown as {
      id: string;
      key: string;
      name: string;
      description: string;
      source_class: string | null;
      target_class: string | null;
      inverse_name: string;
      color: string;
    }[];
    const grants = canEdit(role)
      ? (rc.app.db
          .prepare('SELECT * FROM library_grants WHERE library_id = ? ORDER BY created_at')
          .all(library.id) as unknown as {
          id: string;
          subject_type: string;
          subject_id: string;
          role: string;
          created_at: string;
        }[])
      : [];
    const grantViews = grants.map((grant) => {
      let name = grant.subject_id;
      if (grant.subject_type === 'person') {
        name =
          (rc.app.db.prepare('SELECT name FROM persons WHERE id = ?').get(grant.subject_id) as unknown as { name: string } | undefined)
            ?.name ?? name;
      } else if (grant.subject_type === 'team') {
        name =
          (rc.app.db.prepare('SELECT name FROM teams WHERE id = ?').get(grant.subject_id) as unknown as { name: string } | undefined)
            ?.name ?? name;
      } else if (grant.subject_type === 'org') {
        name = '组织全体成员';
      }
      return { ...grant, subjectName: name };
    });
    const recentPages = (
      rc.app.db
        .prepare('SELECT * FROM pages WHERE library_id = ? ORDER BY updated_at DESC LIMIT 10')
        .all(library.id) as unknown as PageRow[]
    ).map((page) => pageListDto(rc.app.db, page));
    const recentSources = rc.app.db
      .prepare(
        'SELECT id, title, filename, kind, status, page_count, word_count, excerpt, created_at, updated_at FROM sources WHERE library_id = ? ORDER BY created_at DESC LIMIT 10',
      )
      .all(library.id);
    const grantsSummary = rc.app.db
      .prepare('SELECT COUNT(*) AS c FROM library_grants WHERE library_id = ?')
      .get(library.id) as unknown as { c: number };

    rc.json({
      library: serializeLibrary(rc.app.db, library, role),
      role,
      canEdit: canEdit(role),
      nodes,
      classes: classes.map((klass) => ({ ...klass, schema: parseJson<Record<string, unknown>>(klass.schema_json, {}) })),
      relations,
      grants: grantViews,
      grantsCount: Number(grantsSummary.c),
      recentPages,
      recentSources,
      counts: libraryCounts(rc.app.db, library.id),
      stats: {
        pages: Number(
          (rc.app.db.prepare('SELECT COUNT(*) AS c FROM pages WHERE library_id = ?').get(library.id) as unknown as { c: number }).c,
        ),
        sources: Number(
          (rc.app.db.prepare('SELECT COUNT(*) AS c FROM sources WHERE library_id = ?').get(library.id) as unknown as { c: number }).c,
        ),
      },
    });
  });

  router.patch('/api/libraries/:id', async (rc) => {
    const actor = requireActor(rc);
    const { library, role } = requireLibrary(rc.app.db, actor, rc.params.id!, 'owner');
    void role;
    const body = await rc.body<Record<string, unknown>>();
    const fields: string[] = [];
    const values: (string | null)[] = [];
    const set = (column: string, value: string | null) => {
      fields.push(`${column} = ?`);
      values.push(value);
    };
    if (body.name !== undefined) set('name', String(body.name).trim());
    if (body.description !== undefined) set('description', String(body.description));
    if (body.color !== undefined) set('color', String(body.color));
    if (body.icon !== undefined) set('icon', String(body.icon));
    if (body.visibility !== undefined && ['private', 'internal', 'public'].includes(String(body.visibility))) {
      set('visibility', String(body.visibility));
    }
    if (body.kind !== undefined) set('kind', String(body.kind));
    if (body.ownerTeamId !== undefined) set('owner_team_id', body.ownerTeamId ? String(body.ownerTeamId) : null);
    if (body.settings !== undefined) set('settings', JSON.stringify(body.settings));
    set('updated_at', nowIso());
    values.push(library.id);
    rc.app.db.prepare(`UPDATE libraries SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    audit(rc.app.db, { actor, action: 'library.update', targetType: 'library', targetId: library.id, libraryId: library.id, detail: body });
    const updated = rc.app.db.prepare('SELECT * FROM libraries WHERE id = ?').get(library.id) as unknown as LibraryRow;
    rc.json({ library: serializeLibrary(rc.app.db, updated, 'owner') });
  });

  router.delete('/api/libraries/:id', (rc) => {
    const actor = requireActor(rc);
    const { library } = requireLibrary(rc.app.db, actor, rc.params.id!, 'owner');
    if (!actor.person.isAdmin && library.created_by !== actor.person.id) {
      throw errors.forbidden('只有组织管理员或知识库创建人可以删除');
    }
    rc.app.db.prepare('DELETE FROM libraries WHERE id = ?').run(library.id);
    audit(rc.app.db, { actor, action: 'library.delete', targetType: 'library', targetId: library.id, detail: { name: library.name } });
    rc.json({ ok: true });
  });

  // 目录树
  router.get('/api/libraries/:id/nodes', (rc) => {
    const actor = requireActor(rc);
    const { library } = requireLibrary(rc.app.db, actor, rc.params.id!);
    rc.json({ nodes: nodeTree(rc.app.db, library.id) });
  });

  router.post('/api/libraries/:id/nodes', async (rc) => {
    const { actor, library } = requireLibraryEdit(rc, rc.params.id!);
    const body = await rc.body<Record<string, unknown>>();
    const node = createNode(rc.app.db, library.id, {
      name: String(body.name ?? ''),
      parentId: body.parentId ? String(body.parentId) : null,
      kind: body.kind ? String(body.kind) : 'section',
      code: body.code ? String(body.code) : '',
      description: body.description ? String(body.description) : '',
      icon: body.icon ? String(body.icon) : '',
    });
    audit(rc.app.db, { actor, action: 'node.create', targetType: 'node', targetId: String(node.id), libraryId: library.id, detail: node });
    rc.json({ node }, 201);
  });

  router.patch('/api/nodes/:id', async (rc) => {
    const actor = requireActor(rc);
    const node = rc.app.db.prepare('SELECT * FROM catalog_nodes WHERE id = ?').get(rc.params.id!) as unknown as
      | { id: string; library_id: string }
      | undefined;
    if (!node) throw errors.notFound('目录不存在');
    const { library } = requireLibraryEdit(rc, node.library_id);
    const body = await rc.body<Record<string, unknown>>();
    const fields: string[] = [];
    const values: (string | null)[] = [];
    const set = (column: string, value: string | null) => {
      fields.push(`${column} = ?`);
      values.push(value);
    };
    if (body.name !== undefined) set('name', String(body.name).trim());
    if (body.description !== undefined) set('description', String(body.description));
    if (body.code !== undefined) set('code', String(body.code));
    if (body.icon !== undefined) set('icon', String(body.icon));
    if (body.parentId !== undefined) set('parent_id', body.parentId ? String(body.parentId) : null);
    if (body.sortOrder !== undefined) set('sort_order', String(Number(body.sortOrder)));
    values.push(node.id);
    rc.app.db.prepare(`UPDATE catalog_nodes SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    audit(rc.app.db, { actor, action: 'node.update', targetType: 'node', targetId: node.id, libraryId: library.id, detail: body });
    rc.json({ ok: true });
  });

  router.delete('/api/nodes/:id', (rc) => {
    const actor = requireActor(rc);
    const node = rc.app.db.prepare('SELECT * FROM catalog_nodes WHERE id = ?').get(rc.params.id!) as unknown as
      | { id: string; library_id: string }
      | undefined;
    if (!node) throw errors.notFound('目录不存在');
    requireLibraryEdit(rc, node.library_id);
    rc.app.db.prepare('DELETE FROM catalog_nodes WHERE id = ?').run(node.id);
    audit(rc.app.db, { actor, action: 'node.delete', targetType: 'node', targetId: node.id, libraryId: node.library_id });
    rc.json({ ok: true });
  });

  // 本体
  router.post('/api/libraries/:id/classes', async (rc) => {
    const { actor, library } = requireLibraryEdit(rc, rc.params.id!);
    const body = await rc.body<Record<string, unknown>>();
    const key = String(body.key ?? '').trim();
    const name = String(body.name ?? '').trim();
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(key)) throw errors.badRequest('类型 key 只能是小写字母、数字和连字符');
    if (!name) throw errors.badRequest('类型名称不能为空');
    if (rc.app.db.prepare('SELECT 1 FROM ontology_classes WHERE library_id = ? AND key = ?').get(library.id, key)) {
      throw errors.conflict('该类型已存在');
    }
    const id = newId('cls');
    rc.app.db
      .prepare(
        `INSERT INTO ontology_classes (id, library_id, key, name, description, icon, color, schema_json, builtin, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 100, ?)`,
      )
      .run(
        id,
        library.id,
        key,
        name,
        String(body.description ?? ''),
        String(body.icon ?? 'circle'),
        String(body.color ?? 'jade'),
        JSON.stringify(body.schema ?? { fields: [] }),
        nowIso(),
      );
    audit(rc.app.db, { actor, action: 'ontology.class.create', targetType: 'class', targetId: id, libraryId: library.id, detail: { key, name } });
    rc.json({ id, key, name }, 201);
  });

  router.patch('/api/classes/:id', async (rc) => {
    const actor = requireActor(rc);
    const klass = rc.app.db.prepare('SELECT * FROM ontology_classes WHERE id = ?').get(rc.params.id!) as unknown as
      | { id: string; library_id: string; builtin: number }
      | undefined;
    if (!klass) throw errors.notFound('类型不存在');
    const { library } = requireLibraryEdit(rc, klass.library_id);
    const body = await rc.body<Record<string, unknown>>();
    const fields: string[] = [];
    const values: (string | number)[] = [];
    const set = (column: string, value: string | number) => {
      fields.push(`${column} = ?`);
      values.push(value);
    };
    if (body.name !== undefined) set('name', String(body.name));
    if (body.description !== undefined) set('description', String(body.description));
    if (body.color !== undefined) set('color', String(body.color));
    if (body.icon !== undefined) set('icon', String(body.icon));
    if (body.schema !== undefined) set('schema_json', JSON.stringify(body.schema));
    values.push(klass.id);
    rc.app.db.prepare(`UPDATE ontology_classes SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    audit(rc.app.db, { actor, action: 'ontology.class.update', targetType: 'class', targetId: klass.id, libraryId: library.id });
    rc.json({ ok: true });
  });

  router.delete('/api/classes/:id', (rc) => {
    const actor = requireActor(rc);
    const klass = rc.app.db.prepare('SELECT * FROM ontology_classes WHERE id = ?').get(rc.params.id!) as unknown as
      | { id: string; library_id: string; builtin: number; key: string }
      | undefined;
    if (!klass) throw errors.notFound('类型不存在');
    if (klass.builtin) throw errors.badRequest('内置类型不能删除');
    const { library } = requireLibraryEdit(rc, klass.library_id);
    const used = rc.app.db
      .prepare('SELECT COUNT(*) AS c FROM pages WHERE library_id = ? AND class_key = ?')
      .get(library.id, klass.key) as unknown as { c: number };
    if (Number(used.c) > 0) throw errors.conflict('仍有页面使用该类型，不能删除');
    rc.app.db.prepare('DELETE FROM ontology_classes WHERE id = ?').run(klass.id);
    audit(rc.app.db, { actor, action: 'ontology.class.delete', targetType: 'class', targetId: klass.id, libraryId: library.id });
    rc.json({ ok: true });
  });

  router.post('/api/libraries/:id/relations', async (rc) => {
    const { actor, library } = requireLibraryEdit(rc, rc.params.id!);
    const body = await rc.body<Record<string, unknown>>();
    const key = String(body.key ?? '').trim();
    const name = String(body.name ?? '').trim();
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(key)) throw errors.badRequest('关系 key 不合法');
    if (!name) throw errors.badRequest('关系名称不能为空');
    if (rc.app.db.prepare('SELECT 1 FROM ontology_relations WHERE library_id = ? AND key = ?').get(library.id, key)) {
      throw errors.conflict('该关系已存在');
    }
    const id = newId('rel');
    rc.app.db
      .prepare(
        `INSERT INTO ontology_relations (id, library_id, key, name, description, source_class, target_class, inverse_name, color, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        library.id,
        key,
        name,
        String(body.description ?? ''),
        body.sourceClass ? String(body.sourceClass) : null,
        body.targetClass ? String(body.targetClass) : null,
        String(body.inverseName ?? ''),
        String(body.color ?? 'ink'),
        nowIso(),
      );
    audit(rc.app.db, { actor, action: 'ontology.relation.create', targetType: 'relation', targetId: id, libraryId: library.id });
    rc.json({ id, key, name }, 201);
  });

  router.delete('/api/relations/:id', (rc) => {
    const actor = requireActor(rc);
    const relation = rc.app.db.prepare('SELECT * FROM ontology_relations WHERE id = ?').get(rc.params.id!) as unknown as
      | { id: string; library_id: string }
      | undefined;
    if (!relation) throw errors.notFound('关系不存在');
    requireLibraryEdit(rc, relation.library_id);
    rc.app.db.prepare('DELETE FROM ontology_relations WHERE id = ?').run(relation.id);
    audit(rc.app.db, { actor, action: 'ontology.relation.delete', targetType: 'relation', targetId: relation.id, libraryId: relation.library_id });
    rc.json({ ok: true });
  });

  // 授权
  router.get('/api/libraries/:id/grants', (rc) => {
    const actor = requireActor(rc);
    const { library, role } = requireLibrary(rc.app.db, actor, rc.params.id!, 'editor');
    if (!canEdit(role)) throw errors.forbidden();
    rc.json({
      grants: rc.app.db.prepare('SELECT * FROM library_grants WHERE library_id = ? ORDER BY created_at').all(library.id),
    });
  });

  router.post('/api/libraries/:id/grants', async (rc) => {
    const actor = requireActor(rc);
    const { library } = requireLibrary(rc.app.db, actor, rc.params.id!, 'owner');
    const body = await rc.body<Record<string, unknown>>();
    const subjectType = String(body.subjectType ?? '');
    const subjectId = String(body.subjectId ?? '');
    const role = String(body.role ?? 'viewer');
    if (!['person', 'team', 'org'].includes(subjectType)) throw errors.badRequest('授权主体类型不合法');
    if (!['viewer', 'editor', 'owner'].includes(role)) throw errors.badRequest('授权角色不合法');
    if (subjectType === 'org') {
      if (subjectId !== 'org') throw errors.badRequest('组织授权主体应为 org');
    } else if (!subjectId) {
      throw errors.badRequest('请选择授权对象');
    }
    rc.app.db
      .prepare(
        `INSERT INTO library_grants (id, library_id, subject_type, subject_id, role, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(library_id, subject_type, subject_id) DO UPDATE SET role = excluded.role`,
      )
      .run(newId('grant'), library.id, subjectType, subjectId, role, actor.person.id, nowIso());
    audit(rc.app.db, {
      actor,
      action: 'library.grant',
      targetType: 'library',
      targetId: library.id,
      libraryId: library.id,
      detail: { subjectType, subjectId, role },
    });
    rc.json({ ok: true });
  });

  router.delete('/api/grants/:id', (rc) => {
    const actor = requireActor(rc);
    const grant = rc.app.db.prepare('SELECT * FROM library_grants WHERE id = ?').get(rc.params.id!) as unknown as
      | { id: string; library_id: string; subject_type: string; subject_id: string }
      | undefined;
    if (!grant) throw errors.notFound('授权不存在');
    requireLibrary(rc.app.db, actor, grant.library_id, 'owner');
    if (grant.subject_type === 'person' && grant.subject_id === actor.person.id) {
      throw errors.badRequest('不能移除自己的所有者授权');
    }
    rc.app.db.prepare('DELETE FROM library_grants WHERE id = ?').run(grant.id);
    audit(rc.app.db, { actor, action: 'library.revoke', targetType: 'library', targetId: grant.library_id, libraryId: grant.library_id, detail: { grantId: grant.id } });
    rc.json({ ok: true });
  });

  router.get('/api/libraries/:id/audit', (rc) => {
    const actor = requireActor(rc);
    const { library } = requireLibrary(rc.app.db, actor, rc.params.id!);
    const rows = rc.app.db
      .prepare('SELECT * FROM audit_events WHERE library_id = ? ORDER BY created_at DESC LIMIT 100')
      .all(library.id) as unknown as Record<string, unknown>[];
    rc.json({
      events: rows.map((row) => ({ ...row, detail: parseJson<Record<string, unknown>>(String(row.detail ?? '{}'), {}) })),
    });
  });

  router.get('/api/libraries/:id/export', (rc) => {
    const actor = requireActor(rc);
    const { library } = requireLibrary(rc.app.db, actor, rc.params.id!);
    const pages = rc.app.db
      .prepare('SELECT * FROM pages WHERE library_id = ? ORDER BY class_key, title')
      .all(library.id) as unknown as PageRow[];
    const nodes = rc.app.db.prepare('SELECT * FROM catalog_nodes WHERE library_id = ?').all(library.id);
    const classes = rc.app.db.prepare('SELECT * FROM ontology_classes WHERE library_id = ?').all(library.id);
    rc.json({
      format: 'alexandria-wiki-v1',
      exportedAt: nowIso(),
      library: { ...library, settings: parseJson<Record<string, unknown>>(library.settings, {}) },
      nodes,
      classes,
      pages: pages.map((page) => {
        const view = pageToView(rc.app.db, page);
        return {
          slug: page.slug,
          title: page.title,
          classKey: page.class_key,
          className: view.className,
          summary: page.summary,
          tldr: page.tldr,
          body: page.body,
          status: page.status,
          confidence: page.confidence,
          tags: view.tagsList,
          aliases: view.aliasesList,
          readWhen: view.readWhenList,
          sources: rc.app.db
            .prepare('SELECT source_id, relation, locator FROM page_sources WHERE page_id = ?')
            .all(page.id),
          links: rc.app.db.prepare('SELECT to_page_id, relation FROM links WHERE from_page_id = ?').all(page.id),
        };
      }),
    });
  });

  // 当前用户视角的重算（用于权限变更后刷新）
  router.get('/api/libraries/:id/role', (rc) => {
    const actor = requireActor(rc);
    const library = rc.app.db
      .prepare('SELECT * FROM libraries WHERE id = ? OR slug = ?')
      .get(rc.params.id!, rc.params.id!) as unknown as LibraryRow | undefined;
    if (!library) throw errors.notFound('知识库不存在');
    const role = effectiveRole(rc.app.db, actor, library);
    if (!role) throw errors.notFound('知识库不存在');
    rc.json({ role, canEdit: canEdit(role) });
  });

  // 管理员可由下拉框使用：按团队列出可见库
  router.get('/api/admin/orphans', (rc) => {
    requireAdmin(rc);
    rc.json({ ok: true });
  });

  // 阻止类型系统里出现完全空的库
  router.get('/api/libraries/:id/health', (rc) => {
    const actor = requireActor(rc);
    const { library } = requireLibrary(rc.app.db, actor, rc.params.id!);
    const counts = libraryCounts(rc.app.db, library.id);
    const orphans = rc.app.db
      .prepare(
        `SELECT p.id, p.title FROM pages p WHERE p.library_id = ?
          AND NOT EXISTS (SELECT 1 FROM links l WHERE l.from_page_id = p.id OR l.to_page_id = p.id)
          AND p.class_key <> 'source' LIMIT 20`,
      )
      .all(library.id) as unknown as { id: string; title: string }[];
    const failedSources = rc.app.db
      .prepare("SELECT id, title, error FROM sources WHERE library_id = ? AND status = 'failed'")
      .all(library.id);
    rc.json({ counts, orphans, failedSources });
  });
}
