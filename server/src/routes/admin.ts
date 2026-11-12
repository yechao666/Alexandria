import type { Router } from '../http/router.ts';
import { requireActor, requireAdmin, createApiKey } from '../http/auth.ts';
import { errors } from '../http/respond.ts';
import { hashPassword } from '../lib/password.ts';
import { newId, nowIso, slugify } from '../lib/ids.ts';
import { teamTree } from './helpers.ts';
import { audit } from '../domain/audit.ts';
import { securityEvent, requestIp } from '../domain/security.ts';
import { queueSnapshot } from '../ingest/queue.ts';
import { statSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Person } from '../types.ts';
import { getWecomConfig, wecomConfigured, wecomAccessToken, wecomDepartments, wecomUsers } from '../domain/wecom.ts';

function personView(person: Record<string, unknown>): Person & { isAdmin: boolean; status: string } {
  return {
    id: String(person.id),
    email: String(person.email),
    name: String(person.name),
    title: String(person.title ?? ''),
    avatarColor: String(person.avatar_color ?? 'clay'),
    isAdmin: Boolean(person.is_admin),
    wecomUserid: person.wecom_userid ? String(person.wecom_userid) : null,
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
    securityEvent(rc.app.db, { kind: 'api_key.create', actorId: actor.person.id, subject: name, ip: requestIp(rc), detail: { scope } });
    rc.json({ id: result.id, token: result.token, name, scope, warning: '密钥只展示一次，请立即保存' }, 201);
  });

  router.delete('/api/api-keys/:id', (rc) => {
    const actor = requireActor(rc);
    const result = rc.app.db
      .prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND person_id = ?')
      .run(nowIso(), rc.params.id!, actor.person.id);
    if (Number(result.changes) === 0) throw errors.notFound('密钥不存在');
    securityEvent(rc.app.db, { kind: 'api_key.revoke', severity: 'warning', actorId: actor.person.id, subject: rc.params.id!, ip: requestIp(rc) });
    rc.json({ ok: true });
  });

  // 企业微信：OAuth 登录、部门/成员同步；本地默认指向 wecom-mock。
  router.get('/api/integrations/wecom', (rc) => {
    requireActor(rc);
    const config = getWecomConfig(rc.app.db, rc.app.env);
    const teams = rc.app.db
      .prepare('SELECT id, name, slug, wecom_dept_id FROM teams ORDER BY name')
      .all() as unknown as { id: string; name: string; slug: string; wecom_dept_id: string | null }[];
    const persons = rc.app.db
      .prepare("SELECT id, name, email, wecom_userid FROM persons WHERE status = 'active' ORDER BY name")
      .all();
    rc.json({
      enabled: config.enabled,
      configured: wecomConfigured(config),
      mode: config.mock ? 'mock' : 'wecom',
      corpId: config.corpId,
      agentId: config.agentId,
      baseUrl: config.baseUrl,
      authorizeBase: config.authorizeBase,
      publicUrl: config.publicUrl,
      callbackUrl: `${config.publicUrl}/api/auth/wecom/callback`,
      imCallbackUrl: `${config.publicUrl}/api/integrations/wecom/im`,
      encryptedCallbackUrl: `${config.publicUrl}/api/wecom/callback`,
      callbackTokenConfigured: Boolean(config.callbackToken),
      aesKeyConfigured: Boolean(config.encodingAesKey),
      teams,
      persons,
      capabilities: ['oauth-login', 'department-sync', 'user-sync', 'bot-notify'],
      note: config.mock
        ? '当前为本地 Mock 模式：启动 wecom-mock 后可使用企业微信登录与通讯录同步。'
        : '生产模式：请确保回调地址可从企业微信侧访问。',
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
    if (body.secret !== undefined && String(body.secret).trim()) put('wecom_secret', body.secret);
    if (body.agentId !== undefined) put('wecom_agent_id', body.agentId);
    if (body.callbackToken !== undefined && String(body.callbackToken).trim()) put('wecom_callback_token', body.callbackToken);
    if (body.encodingAesKey !== undefined && String(body.encodingAesKey).trim()) put('wecom_encoding_aes_key', body.encodingAesKey);
    if (body.baseUrl !== undefined) put('wecom_base_url', body.baseUrl);
    if (body.authorizeBase !== undefined) put('wecom_authorize_base', body.authorizeBase);
    if (body.publicUrl !== undefined) put('wecom_public_url', body.publicUrl);
    if (body.mode !== undefined) put('wecom_mode', body.mode);
    if (body.enabled !== undefined) put('wecom_enabled', body.enabled ? '1' : '0');
    audit(rc.app.db, {
      actor,
      action: 'wecom.config',
      targetType: 'integration',
      targetId: 'wecom',
      detail: { keys: Object.keys(body), mode: body.mode ?? null },
    });
    rc.json({ ok: true });
  });

  router.post('/api/integrations/wecom/sync', async (rc) => {
    const actor = requireAdmin(rc);
    const body = await rc.body<{ apply?: boolean; deactivateMissing?: boolean }>();
    const apply = body.apply === true;
    const deactivateMissing = body.deactivateMissing === true;
    const config = getWecomConfig(rc.app.db, rc.app.env);
    if (!wecomConfigured(config)) {
      throw errors.serviceUnavailable('企业微信尚未配置 CorpID / Secret');
    }

    let token = '';
    let departments;
    let users;
    try {
      token = await wecomAccessToken(config);
      departments = await wecomDepartments(config, token);
      users = await wecomUsers(config, token, departments);
    } catch (error) {
      throw errors.serviceUnavailable(`无法读取企业微信通讯录：${(error as Error).message}`);
    }

    const teams = rc.app.db.prepare('SELECT id, name, wecom_dept_id FROM teams').all() as unknown as {
      id: string;
      name: string;
      wecom_dept_id: string | null;
    }[];
    const persons = rc.app.db
      .prepare('SELECT id, name, email, wecom_userid, status, is_admin FROM persons')
      .all() as unknown as {
      id: string;
      name: string;
      email: string;
      wecom_userid: string | null;
      status: string;
      is_admin: number;
    }[];

    const departmentPlan = departments.map((department) => {
      const matched = teams.find((team) => team.wecom_dept_id === String(department.id));
      const parent = department.parentid
        ? departments.find((item) => item.id === department.parentid)
        : undefined;
      const localParent = parent ? teams.find((team) => team.wecom_dept_id === String(parent.id)) : undefined;
      const leaderUserids = department.leaders ?? [];
      const leader = leaderUserids.length
        ? persons.find((person) => person.wecom_userid && leaderUserids.some((id) => person.wecom_userid?.toLowerCase() === id.toLowerCase()))
        : undefined;
      return {
        wecomDeptId: String(department.id),
        name: department.name,
        action: matched ? 'bind' : 'create',
        teamId: matched?.id ?? null,
        parentWecomDeptId: parent ? String(parent.id) : null,
        parentTeamId: localParent?.id ?? null,
        leaderUserids,
        leaderPersonId: leader?.id ?? null,
        leaderName: leader?.name ?? null,
      };
    });

    const userPlan = users.map((user) => {
      const byWecom = persons.find((person) => person.wecom_userid?.toLowerCase() === user.userid.toLowerCase());
      if (byWecom) return { wecomUserid: user.userid, name: user.name, email: user.email ?? '', action: byWecom.status === 'active' ? 'synced' : 'reactivate', personId: byWecom.id };
      const byEmail = user.email
        ? persons.find((person) => person.email.toLowerCase() === user.email!.toLowerCase())
        : undefined;
      if (byEmail) return { wecomUserid: user.userid, name: user.name, email: user.email ?? '', action: 'link-by-email', personId: byEmail.id };
      const byName = persons.find((person) => person.name === user.name);
      if (byName) return { wecomUserid: user.userid, name: user.name, email: user.email ?? '', action: 'link-by-name', personId: byName.id };
      return { wecomUserid: user.userid, name: user.name, email: user.email ?? '', action: 'invite', personId: null };
    });

    const directoryUserids = new Set(users.map((user) => user.userid.toLowerCase()));
    const deactivatePlan = persons
      .filter((person) => person.wecom_userid && !directoryUserids.has(person.wecom_userid.toLowerCase()) && person.status === 'active')
      .map((person) => ({ personId: person.id, name: person.name, wecomUserid: person.wecom_userid, action: person.is_admin ? 'skip-admin' : 'deactivate' }));
    const applied = { departments: 0, users: 0, deactivated: 0, reactivated: 0, leaders: 0 };
    if (apply) {
      for (const item of departmentPlan) {
        if (item.action === 'bind' && item.teamId) {
          applied.departments += 1;
          if (item.leaderPersonId) {
            rc.app.db.prepare('UPDATE teams SET lead_person_id = ? WHERE id = ?').run(item.leaderPersonId, item.teamId);
            rc.app.db
              .prepare(
                "INSERT INTO team_members (team_id, person_id, role, created_at) VALUES (?, ?, 'lead', ?) ON CONFLICT(team_id, person_id) DO UPDATE SET role = 'lead'",
              )
              .run(item.teamId, item.leaderPersonId, nowIso());
            applied.leaders += 1;
          }
          continue;
        }
        const existing = teams.find((team) => team.wecom_dept_id === item.wecomDeptId);
        if (existing) continue;
        const id = newId('team');
        const slug = `wecom-dept-${item.wecomDeptId}`;
        const collision = rc.app.db.prepare('SELECT 1 FROM teams WHERE slug = ?').get(slug);
        const finalSlug = collision ? `${slug}-${id.slice(-4)}` : slug;
        rc.app.db
          .prepare(
            'INSERT INTO teams (id, name, slug, parent_id, description, lead_person_id, wecom_dept_id, sort_order, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)',
          )
          .run(
            id,
            item.name,
            finalSlug,
            item.parentTeamId ?? null,
            '由企业微信通讯录同步',
            item.wecomDeptId,
            500,
            nowIso(),
          );
        if (item.leaderPersonId) {
          rc.app.db.prepare('UPDATE teams SET lead_person_id = ? WHERE id = ?').run(item.leaderPersonId, id);
          rc.app.db
            .prepare(
              "INSERT INTO team_members (team_id, person_id, role, created_at) VALUES (?, ?, 'lead', ?) ON CONFLICT(team_id, person_id) DO UPDATE SET role = 'lead'",
            )
            .run(id, item.leaderPersonId, nowIso());
          applied.leaders += 1;
        }
        applied.departments += 1;
      }
      for (const item of userPlan) {
        if (!item.personId || item.action === 'synced') continue;
        rc.app.db.prepare("UPDATE persons SET wecom_userid = ?, status = 'active' WHERE id = ?").run(item.wecomUserid, item.personId);
        if (item.action === 'reactivate') applied.reactivated += 1;
        else applied.users += 1;
      }
      if (deactivateMissing) {
        for (const item of deactivatePlan) {
          if (item.action !== 'deactivate') continue;
          rc.app.db.prepare("UPDATE persons SET status = 'inactive' WHERE id = ?").run(item.personId);
          applied.deactivated += 1;
        }
      }
    }

    const runId = newId('wsync');
    rc.app.db
      .prepare(
        `INSERT INTO wecom_sync_runs (id, actor_id, mode, dry_run, departments, users, applied_departments, applied_users, deactivated, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        actor.person.id,
        config.mock ? 'mock' : 'wecom',
        apply ? 0 : 1,
        departmentPlan.length,
        userPlan.length,
        applied.departments,
        applied.users,
        applied.deactivated,
        JSON.stringify({ deactivateMissing, applied, deactivatePlan }),
        nowIso(),
      );
    audit(rc.app.db, {
      actor,
      action: apply ? 'wecom.sync.apply' : 'wecom.sync.plan',
      targetType: 'integration',
      targetId: 'wecom',
      detail: { apply, departments: departmentPlan.length, users: userPlan.length, applied },
    });
    rc.json({
      ok: true,
      dryRun: !apply,
      mode: config.mock ? 'mock' : 'wecom',
      runId,
      plan: { departments: departmentPlan, users: userPlan, deactivate: deactivatePlan },
      applied,
      note: apply
        ? `已按计划写入：团队 ${applied.departments}、成员 ${applied.users}、恢复 ${applied.reactivated}、停用 ${applied.deactivated}。`
        : '未写入；传 apply=true 执行绑定/创建，deactivateMissing=true 停用已离职成员。',
    });
  });

  router.get('/api/integrations/wecom/sync-runs', (rc) => {
    requireAdmin(rc);
    const rows = rc.app.db
      .prepare('SELECT * FROM wecom_sync_runs ORDER BY created_at DESC LIMIT 20')
      .all() as unknown as Record<string, unknown>[];
    rc.json({ runs: rows.map((row) => ({ ...row, detail: JSON.parse(String(row.detail ?? '{}')) })) });
  });

  router.get('/api/admin/security', (rc) => {
    requireAdmin(rc);
    const limit = Math.max(1, Math.min(200, rc.queryInt('limit', 80)));
    const rows = rc.app.db
      .prepare('SELECT s.*, p.name AS actor_name FROM security_events s LEFT JOIN persons p ON p.id = s.actor_id ORDER BY s.created_at DESC LIMIT ?')
      .all(limit) as unknown as Record<string, unknown>[];
    const counts = rc.app.db
      .prepare("SELECT severity, COUNT(*) AS c FROM security_events WHERE created_at > ? GROUP BY severity")
      .all(new Date(Date.now() - 7 * 86_400_000).toISOString()) as unknown as { severity: string; c: number }[];
    rc.json({ events: rows.map((row) => ({ ...row, detail: JSON.parse(String(row.detail ?? '{}')) })), counts });
  });


  router.get('/api/admin/observability', (rc) => {
    requireAdmin(rc);
    const db = rc.app.db;
    const one = (sql: string, ...params: (string | number)[]) => Number((db.prepare(sql).get(...params) as unknown as { c: number } | undefined)?.c ?? 0);
    const group = (sql: string) => db.prepare(sql).all() as unknown as { key: string; c: number }[];
    const fileInfo = (path: string) => {
      try { return existsSync(path) ? statSync(path).size : 0; } catch { return 0; }
    };
    const backupsDir = join(rc.app.env.dataDir, 'backups');
    let backups: { name: string; size: number; modified: string }[] = [];
    try {
      backups = readdirSync(backupsDir).filter((name) => name.startsWith('alexandria-')).slice(-5).map((name) => {
        const info = statSync(join(backupsDir, name));
        return { name, size: info.size, modified: info.mtime.toISOString() };
      });
    } catch { /* no backups */ }
    rc.json({
      process: {
        pid: process.pid,
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        uptimeSeconds: Math.round(process.uptime()),
        memory: process.memoryUsage(),
      },
      queue: queueSnapshot(),
      counts: {
        persons: one("SELECT COUNT(*) AS c FROM persons WHERE status = 'active'"),
        teams: one('SELECT COUNT(*) AS c FROM teams'),
        libraries: one('SELECT COUNT(*) AS c FROM libraries'),
        pages: one('SELECT COUNT(*) AS c FROM pages'),
        sources: one('SELECT COUNT(*) AS c FROM sources'),
        claims: one('SELECT COUNT(*) AS c FROM claims'),
        links: one('SELECT COUNT(*) AS c FROM links'),
      },
      jobs: group('SELECT status AS key, COUNT(*) AS c FROM ingest_jobs GROUP BY status'),
      security: group("SELECT severity AS key, COUNT(*) AS c FROM security_events WHERE created_at > ? GROUP BY severity"),
      search: {
        last24h: one("SELECT COUNT(*) AS c FROM search_queries WHERE created_at > ?"),
        saved: one('SELECT COUNT(*) AS c FROM saved_searches'),
      },
      storage: {
        databaseBytes: fileInfo(rc.app.env.dbPath),
        walBytes: fileInfo(`${rc.app.env.dbPath}-wal`),
        uploadsDir: rc.app.env.uploadsDir,
        backups,
      },
      features: { dsh: rc.app.env.dsh.enabled, llm: Boolean(rc.app.env.llm), wecom: Boolean(rc.app.env.wecom.enabled) },
    });
  });

}
