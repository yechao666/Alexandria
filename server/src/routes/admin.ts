import type { Router } from '../http/router.ts';
import { requireActor, requireAdmin, createApiKey } from '../http/auth.ts';
import { errors } from '../http/respond.ts';
import { hashPassword } from '../lib/password.ts';
import { newId, nowIso, slugify } from '../lib/ids.ts';
import { teamTree } from './helpers.ts';
import { audit } from '../domain/audit.ts';
import type { Person } from '../types.ts';

function personView(person: Record<string, unknown>): Person & { isAdmin: boolean; status: string } {
  return {
    id: String(person.id),
    email: String(person.email),
    name: String(person.name),
    title: String(person.title ?? ''),
    avatarColor: String(person.avatar_color ?? 'clay'),
    isAdmin: Boolean(person.is_admin),
    status: String(person.status ?? 'active'),
  };
}

export function registerAdminRoutes(router: Router): void {
  router.get('/api/teams', (rc) => {
    requireActor(rc);
    rc.json({ teams: teamTree(rc.app.db) });
  });

  router.post('/api/teams', async (rc) => {
    const actor = requireAdmin(rc);
    const body = await rc.body<Record<string, unknown>>();
    const name = String(body.name ?? '').trim();
    if (!name) throw errors.badRequest('团队名称不能为空');
    const slug = slugify(body.slug ? String(body.slug) : name, 'team');
    if (rc.app.db.prepare('SELECT 1 FROM teams WHERE slug = ?').get(slug)) throw errors.conflict('团队标识已存在');
    if (body.parentId) {
      const parent = rc.app.db.prepare('SELECT 1 FROM teams WHERE id = ?').get(String(body.parentId));
      if (!parent) throw errors.badRequest('上级团队不存在');
    }
    const id = newId('team');
    rc.app.db
      .prepare(
        'INSERT INTO teams (id, name, slug, parent_id, description, lead_person_id, wecom_dept_id, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        name,
        slug,
        body.parentId ? String(body.parentId) : null,
        String(body.description ?? ''),
        body.leadPersonId ? String(body.leadPersonId) : null,
        body.wecomDeptId ? String(body.wecomDeptId) : null,
        100,
        nowIso(),
      );
    if (body.leadPersonId) {
      rc.app.db
        .prepare(
          `INSERT INTO team_members (team_id, person_id, role, created_at) VALUES (?, ?, 'lead', ?)
           ON CONFLICT(team_id, person_id) DO UPDATE SET role = 'lead'`,
        )
        .run(id, String(body.leadPersonId), nowIso());
    }
    audit(rc.app.db, { actor, action: 'team.create', targetType: 'team', targetId: id, detail: { name } });
    rc.json({ team: { id, name, slug } }, 201);
  });

  router.patch('/api/teams/:id', async (rc) => {
    const actor = requireAdmin(rc);
    const team = rc.app.db.prepare('SELECT * FROM teams WHERE id = ?').get(rc.params.id!) as unknown as
      | { id: string }
      | undefined;
    if (!team) throw errors.notFound('团队不存在');
    const body = await rc.body<Record<string, unknown>>();
    const fields: string[] = [];
    const values: (string | null)[] = [];
    const set = (column: string, value: string | null) => {
      fields.push(`${column} = ?`);
      values.push(value);
    };
    if (body.name !== undefined) set('name', String(body.name));
    if (body.description !== undefined) set('description', String(body.description));
    if (body.parentId !== undefined) set('parent_id', body.parentId ? String(body.parentId) : null);
    if (body.leadPersonId !== undefined) set('lead_person_id', body.leadPersonId ? String(body.leadPersonId) : null);
    if (body.wecomDeptId !== undefined) set('wecom_dept_id', body.wecomDeptId ? String(body.wecomDeptId) : null);
    values.push(team.id);
    rc.app.db.prepare(`UPDATE teams SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    audit(rc.app.db, { actor, action: 'team.update', targetType: 'team', targetId: team.id, detail: body });
    rc.json({ ok: true });
  });

  router.delete('/api/teams/:id', (rc) => {
    const actor = requireAdmin(rc);
    const team = rc.app.db.prepare('SELECT * FROM teams WHERE id = ?').get(rc.params.id!) as unknown as
      | { id: string; name: string }
      | undefined;
    if (!team) throw errors.notFound('团队不存在');
    const libs = rc.app.db.prepare('SELECT COUNT(*) AS c FROM libraries WHERE owner_team_id = ?').get(team.id) as unknown as { c: number };
    if (Number(libs.c) > 0) throw errors.conflict('该团队仍拥有知识库，请先转移所有权');
    rc.app.db.prepare('DELETE FROM teams WHERE id = ?').run(team.id);
    audit(rc.app.db, { actor, action: 'team.delete', targetType: 'team', targetId: team.id, detail: { name: team.name } });
    rc.json({ ok: true });
  });

  router.get('/api/teams/:id/members', (rc) => {
    requireActor(rc);
    const rows = rc.app.db
      .prepare(
        `SELECT p.id, p.name, p.email, p.title, p.avatar_color, tm.role FROM team_members tm
          JOIN persons p ON p.id = tm.person_id WHERE tm.team_id = ? ORDER BY tm.role DESC, p.name`,
      )
      .all(rc.params.id!) as unknown as Record<string, unknown>[];
    rc.json({ members: rows.map((row) => ({ ...personView(row), teamRole: row.role })) });
  });

  router.post('/api/teams/:id/members', async (rc) => {
    const actor = requireAdmin(rc);
    const body = await rc.body<Record<string, unknown>>();
    const personId = String(body.personId ?? '');
    const role = body.role === 'lead' ? 'lead' : 'member';
    const person = rc.app.db.prepare('SELECT id, name FROM persons WHERE id = ?').get(personId) as unknown as
      | { id: string; name: string }
      | undefined;
    if (!person) throw errors.badRequest('人员不存在');
    rc.app.db
      .prepare(
        `INSERT INTO team_members (team_id, person_id, role, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(team_id, person_id) DO UPDATE SET role = excluded.role`,
      )
      .run(rc.params.id!, personId, role, nowIso());
    audit(rc.app.db, { actor, action: 'team.member.add', targetType: 'team', targetId: rc.params.id!, detail: { personId, role } });
    rc.json({ ok: true });
  });

  router.delete('/api/teams/:id/members/:personId', (rc) => {
    const actor = requireAdmin(rc);
    rc.app.db.prepare('DELETE FROM team_members WHERE team_id = ? AND person_id = ?').run(rc.params.id!, rc.params.personId!);
    audit(rc.app.db, { actor, action: 'team.member.remove', targetType: 'team', targetId: rc.params.id!, detail: { personId: rc.params.personId } });
    rc.json({ ok: true });
  });

  router.get('/api/people', (rc) => {
    requireActor(rc);
    const rows = rc.app.db.prepare('SELECT * FROM persons ORDER BY name').all() as unknown as Record<string, unknown>[];
    rc.json({ people: rows.map((row) => personView(row)) });
  });

  router.post('/api/people', async (rc) => {
    const actor = requireAdmin(rc);
    const body = await rc.body<Record<string, unknown>>();
    const email = String(body.email ?? '').trim().toLowerCase();
    const name = String(body.name ?? '').trim();
    const password = String(body.password ?? '');
    if (!email || !name) throw errors.badRequest('姓名和邮箱不能为空');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw errors.badRequest('邮箱格式不正确');
    if (password.length < 8) throw errors.badRequest('初始密码至少 8 位');
    if (rc.app.db.prepare('SELECT 1 FROM persons WHERE lower(email) = ?').get(email)) throw errors.conflict('邮箱已存在');
    const id = newId('usr');
    rc.app.db
      .prepare(
        'INSERT INTO persons (id, email, name, title, avatar_color, is_admin, password_hash, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        email,
        name,
        String(body.title ?? ''),
        String(body.avatarColor ?? 'clay'),
        body.isAdmin ? 1 : 0,
        hashPassword(password),
        'active',
        nowIso(),
      );
    audit(rc.app.db, { actor, action: 'person.create', targetType: 'person', targetId: id, detail: { email, name } });
    rc.json({ person: { id, email, name } }, 201);
  });

  router.patch('/api/people/:id', async (rc) => {
    const actor = requireAdmin(rc);
    const person = rc.app.db.prepare('SELECT * FROM persons WHERE id = ?').get(rc.params.id!) as unknown as
      | Record<string, unknown>
      | undefined;
    if (!person) throw errors.notFound('人员不存在');
    const body = await rc.body<Record<string, unknown>>();
    const fields: string[] = [];
    const values: (string | number)[] = [];
    const set = (column: string, value: string | number) => {
      fields.push(`${column} = ?`);
      values.push(value);
    };
    if (body.name !== undefined) set('name', String(body.name));
    if (body.title !== undefined) set('title', String(body.title));
    if (body.avatarColor !== undefined) set('avatar_color', String(body.avatarColor));
    if (body.isAdmin !== undefined) set('is_admin', body.isAdmin ? 1 : 0);
    if (body.status !== undefined) set('status', String(body.status));
    if (body.password) set('password_hash', hashPassword(String(body.password)));
    if (body.wecomUserid !== undefined) set('wecom_userid', body.wecomUserid ? String(body.wecomUserid) : '');
    values.push(String(person.id));
    rc.app.db.prepare(`UPDATE persons SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    audit(rc.app.db, { actor, action: 'person.update', targetType: 'person', targetId: String(person.id), detail: Object.keys(body) });
    rc.json({ ok: true });
  });

  router.get('/api/api-keys', (rc) => {
    const actor = requireActor(rc);
    const rows = rc.app.db
      .prepare('SELECT id, name, prefix, scope, last_used_at, revoked_at, created_at FROM api_keys WHERE person_id = ? ORDER BY created_at DESC')
      .all(actor.person.id);
    rc.json({ keys: rows });
  });

  router.post('/api/api-keys', async (rc) => {
    const actor = requireActor(rc);
    if (actor.viaApiKey) throw errors.forbidden('API Key 不能创建新的 API Key');
    const body = await rc.body<Record<string, unknown>>();
    const name = String(body.name ?? '未命名密钥').slice(0, 80);
    const scope = body.scope === 'write' || body.scope === 'admin' ? body.scope : 'read';
    const result = createApiKey(rc.app.db, actor.person.id, name, scope);
    audit(rc.app.db, { actor, action: 'api_key.create', targetType: 'api_key', targetId: result.id, detail: { name, scope } });
    rc.json({ id: result.id, token: result.token, name, scope, warning: '密钥只展示一次，请立即保存' }, 201);
  });

  router.delete('/api/api-keys/:id', (rc) => {
    const actor = requireActor(rc);
    const result = rc.app.db
      .prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND person_id = ?')
      .run(nowIso(), rc.params.id!, actor.person.id);
    if (Number(result.changes) === 0) throw errors.notFound('密钥不存在');
    rc.json({ ok: true });
  });

  // 企业微信：当前提供组织映射与同步骨架，真实 corpId/secret 通过环境变量或管理员配置注入。
  router.get('/api/integrations/wecom', (rc) => {
    requireActor(rc);
    const get = (key: string) =>
      (rc.app.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as unknown as { value: string } | undefined)?.value ?? null;
    const teams = rc.app.db
      .prepare('SELECT id, name, slug, wecom_dept_id FROM teams ORDER BY name')
      .all() as unknown as { id: string; name: string; slug: string; wecom_dept_id: string | null }[];
    const persons = rc.app.db
      .prepare("SELECT id, name, email, wecom_userid FROM persons WHERE status = 'active' ORDER BY name")
      .all();
    rc.json({
      configured: Boolean(get('wecom_corp_id') && get('wecom_secret')),
      corpId: get('wecom_corp_id'),
      agentId: get('wecom_agent_id'),
      teams,
      persons,
      capabilities: ['oauth-login', 'department-sync', 'user-sync', 'bot-notify'],
      note: '企业微信接入按适配器设计：本地可用 wecom-mock，生产填入 CorpID/Secret 后同步部门与成员。',
    });
  });

  router.post('/api/integrations/wecom/config', async (rc) => {
    const actor = requireAdmin(rc);
    const body = await rc.body<Record<string, unknown>>();
    const put = (key: string, value: unknown) => {
      rc.app.db
        .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, String(value ?? ''));
    };
    if (body.corpId !== undefined) put('wecom_corp_id', body.corpId);
    if (body.secret !== undefined) put('wecom_secret', body.secret);
    if (body.agentId !== undefined) put('wecom_agent_id', body.agentId);
    audit(rc.app.db, { actor, action: 'wecom.config', targetType: 'integration', targetId: 'wecom', detail: { keys: Object.keys(body) } });
    rc.json({ ok: true });
  });

  router.post('/api/integrations/wecom/sync', (rc) => {
    const actor = requireAdmin(rc);
    const teams = rc.app.db
      .prepare('SELECT id, name, wecom_dept_id FROM teams')
      .all() as unknown as { id: string; name: string; wecom_dept_id: string | null }[];
    const persons = rc.app.db
      .prepare("SELECT id, name, wecom_userid FROM persons WHERE status = 'active'")
      .all() as unknown as { id: string; name: string; wecom_userid: string | null }[];
    const plan = {
      departments: teams.map((team) => ({
        teamId: team.id,
        name: team.name,
        wecomDeptId: team.wecom_dept_id,
        action: team.wecom_dept_id ? 'update' : 'create',
      })),
      users: persons.map((person) => ({
        personId: person.id,
        name: person.name,
        wecomUserid: person.wecom_userid,
        action: person.wecom_userid ? 'link' : 'invite',
      })),
    };
    audit(rc.app.db, { actor, action: 'wecom.sync.plan', targetType: 'integration', targetId: 'wecom', detail: { departments: plan.departments.length, users: plan.users.length } });
    rc.json({ ok: true, dryRun: true, plan, note: '尚未配置真实企业微信凭据；此接口返回可执行的差异计划，接入后复用同一结构执行。' });
  });
}
