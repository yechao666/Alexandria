import type { Router } from '../http/router.ts';
import { requireActor } from '../http/auth.ts';
import { requireLibrary, visibleLibraries } from '../domain/access.ts';
import { errors } from '../http/respond.ts';
import { newId, nowIso } from '../lib/ids.ts';
import { audit } from '../domain/audit.ts';

function normalizeRule(body: Record<string, unknown>, actor: { person: { isAdmin: boolean } }) {
  const name = String(body.name ?? '').trim();
  const pattern = String(body.pattern ?? '').trim();
  if (!name || name.length > 80) throw errors.badRequest('规则名称不能为空且不能超过 80 字');
  if (!pattern || pattern.length > 2000) throw errors.badRequest('正则表达式不能为空且不能超过 2000 字');
  const flags = String(body.flags ?? 'g').replace(/[^gimsu]/g, '') || 'g';
  try { new RegExp(pattern, flags); } catch (error) { throw errors.badRequest(`正则表达式无效：${(error as Error).message}`); }
  const scope = body.scope === 'library' ? 'library' : 'public';
  if (scope === 'public' && !actor.person.isAdmin) throw errors.forbidden('公共规则只有组织管理员可以维护');
  return {
    name,
    category: String(body.category ?? '通用').slice(0, 40),
    description: String(body.description ?? '').slice(0, 300),
    pattern,
    flags,
    captureGroup: Math.max(0, Math.min(9, Number(body.captureGroup ?? 0))),
    scope,
    libraryId: scope === 'library' ? String(body.libraryId ?? '') : null,
    enabled: body.enabled === false || body.enabled === 0 ? 0 : 1,
    priority: Math.max(0, Math.min(9999, Number(body.priority ?? 100))),
  };
}

export function registerRegexRoutes(router: Router): void {
  router.get('/api/regex-rules', (rc) => {
    const actor = requireActor(rc);
    const libraryRef = rc.query('library');
    let libraryId: string | null = null;
    if (libraryRef) libraryId = requireLibrary(rc.app.db, actor, libraryRef).library.id;
    const libraryCondition = libraryId ? "OR (scope = 'library' AND library_id = ?)" : '';
    const rules = rc.app.db.prepare(
      `SELECT * FROM regex_rules WHERE scope = 'public' ${libraryCondition} ORDER BY scope DESC, priority ASC, name ASC`,
    ).all(...(libraryId ? [libraryId] : []));
    rc.json({ rules, libraries: visibleLibraries(rc.app.db, actor).map((library) => ({ id: library.id, name: library.name, slug: library.slug })) });
  });

  router.post('/api/regex-rules', async (rc) => {
    const actor = requireActor(rc);
    const body = await rc.body<Record<string, unknown>>();
    const rule = normalizeRule(body, actor);
    if (rule.scope === 'library') {
      if (!rule.libraryId) throw errors.badRequest('项目级规则必须指定知识库');
      requireLibrary(rc.app.db, actor, rule.libraryId, 'editor');
    }
    const id = newId('rx');
    const now = nowIso();
    rc.app.db.prepare(
      `INSERT INTO regex_rules (id, name, category, description, pattern, flags, capture_group, scope, library_id, enabled, priority, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, rule.name, rule.category, rule.description, rule.pattern, rule.flags, rule.captureGroup, rule.scope, rule.libraryId, rule.enabled, rule.priority, actor.person.id, now, now);
    audit(rc.app.db, { actor, action: 'regex.create', targetType: 'regex_rule', targetId: id, libraryId: rule.libraryId, detail: { name: rule.name } });
    rc.json({ id }, 201);
  });

  router.patch('/api/regex-rules/:id', async (rc) => {
    const actor = requireActor(rc);
    const current = rc.app.db.prepare('SELECT * FROM regex_rules WHERE id = ?').get(rc.params.id!) as unknown as Record<string, unknown> | undefined;
    if (!current) throw errors.notFound('规则不存在');
    if (current.scope === 'public' && !actor.person.isAdmin) throw errors.forbidden('公共规则只有组织管理员可以维护');
    if (current.scope === 'library' && current.library_id) requireLibrary(rc.app.db, actor, String(current.library_id), 'editor');
    const body = await rc.body<Record<string, unknown>>();
    const merged = { ...current, ...body, libraryId: body.libraryId ?? current.library_id, scope: body.scope ?? current.scope };
    const rule = normalizeRule(merged, actor);
    if (rule.scope === 'library' && !rule.libraryId) throw errors.badRequest('项目级规则必须指定知识库');
    rc.app.db.prepare(
      `UPDATE regex_rules SET name = ?, category = ?, description = ?, pattern = ?, flags = ?, capture_group = ?, scope = ?, library_id = ?, enabled = ?, priority = ?, updated_at = ? WHERE id = ?`,
    ).run(rule.name, rule.category, rule.description, rule.pattern, rule.flags, rule.captureGroup, rule.scope, rule.libraryId, rule.enabled, rule.priority, nowIso(), String(current.id));
    audit(rc.app.db, { actor, action: 'regex.update', targetType: 'regex_rule', targetId: String(current.id), libraryId: rule.libraryId, detail: { name: rule.name } });
    rc.json({ ok: true });
  });

  router.delete('/api/regex-rules/:id', (rc) => {
    const actor = requireActor(rc);
    const current = rc.app.db.prepare('SELECT * FROM regex_rules WHERE id = ?').get(rc.params.id!) as unknown as Record<string, unknown> | undefined;
    if (!current) throw errors.notFound('规则不存在');
    if (current.scope === 'public' && !actor.person.isAdmin) throw errors.forbidden('公共规则只有组织管理员可以维护');
    if (current.scope === 'library' && current.library_id) requireLibrary(rc.app.db, actor, String(current.library_id), 'editor');
    rc.app.db.prepare('DELETE FROM regex_rules WHERE id = ?').run(String(current.id));
    audit(rc.app.db, { actor, action: 'regex.delete', targetType: 'regex_rule', targetId: String(current.id), detail: { name: current.name } });
    rc.json({ ok: true });
  });
}
