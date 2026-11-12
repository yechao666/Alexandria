import { timingSafeEqual } from 'node:crypto';
import type { Router } from '../http/router.ts';
import type { RequestContext } from '../http/context.ts';
import { errors } from '../http/respond.ts';
import { hashPassword } from '../lib/password.ts';
import { newId, nowIso, randomToken, slugify } from '../lib/ids.ts';
import { securityEvent, requestIp } from '../domain/security.ts';

const SCIM_TYPE = 'application/scim+json';

function scim(rc: RequestContext, body: unknown, status = 200): void {
  rc.res.statusCode = status;
  rc.res.setHeader('content-type', `${SCIM_TYPE}; charset=utf-8`);
  rc.res.end(JSON.stringify(body));
}

function scimError(rc: RequestContext, status: number, detail: string, scimType = 'invalidValue'): void {
  scim(rc, { schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: String(status), scimType, detail }, status);
}

function requireScim(rc: RequestContext): void {
  const configured = process.env.ALEXANDRIA_SCIM_TOKEN?.trim();
  if (!configured) throw errors.notFound('SCIM 未启用');
  const auth = String(rc.req.headers.authorization ?? '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const expected = Buffer.from(configured);
  const actual = Buffer.from(token);
  if (!token || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw errors.unauthorized('SCIM 认证失败');
  }
}

function userNameOf(person: Record<string, unknown>): string {
  return String(person.email);
}

function scimUser(person: Record<string, unknown>, teams: string[] = []): Record<string, unknown> {
  const name = String(person.name ?? '');
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    id: String(person.id),
    externalId: person.wecom_userid ? String(person.wecom_userid) : undefined,
    userName: userNameOf(person),
    name: { formatted: name, givenName: name.slice(0, 1), familyName: name.slice(1) },
    displayName: name,
    title: String(person.title ?? ''),
    active: person.status === 'active',
    groups: teams.map((teamId) => ({ value: teamId })),
    meta: {
      resourceType: 'User',
      created: String(person.created_at ?? ''),
      lastModified: String(person.updated_at ?? person.created_at ?? ''),
    },
  };
}

function findUser(db: import('../db/index.ts').Db, id: string): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM persons WHERE id = ?').get(id) as unknown as Record<string, unknown> | undefined;
}

function teamsOf(db: import('../db/index.ts').Db, personId: string): string[] {
  return (db.prepare('SELECT team_id FROM team_members WHERE person_id = ?').all(personId) as unknown as { team_id: string }[]).map((row) => row.team_id);
}

function createUser(rc: RequestContext, body: Record<string, unknown>) {
  const db = rc.app.db;
  const userName = String(body.userName ?? '').trim().toLowerCase();
  if (!userName || !userName.includes('@')) throw errors.badRequest('userName 必须是邮箱');
  if (db.prepare('SELECT 1 FROM persons WHERE lower(email) = ?').get(userName)) throw errors.conflict('用户已存在');
  const name = String((body.name as Record<string, unknown> | undefined)?.formatted ?? body.displayName ?? userName.split('@')[0]).trim();
  const id = newId('usr');
  const now = nowIso();
  db.prepare(
    `INSERT INTO persons (id, email, name, title, avatar_color, is_admin, password_hash, wecom_userid, status, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'active', ?)`,
  ).run(id, userName, name, String(body.title ?? 'SCIM 供给成员'), 'slate', hashPassword(randomToken(24)), body.externalId ? String(body.externalId) : null, now);
  securityEvent(db, { kind: 'scim.user.create', actorId: null, subject: userName, ip: requestIp(rc), detail: { id } });
  return id;
}

function groupResource(db: import('../db/index.ts').Db, team: Record<string, unknown>) {
  const members = db.prepare('SELECT person_id FROM team_members WHERE team_id = ?').all(String(team.id)) as unknown as { person_id: string }[];
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
    id: String(team.id),
    displayName: String(team.name),
    members: members.map((member) => ({ value: member.person_id })),
    meta: { resourceType: 'Group', created: String(team.created_at ?? ''), lastModified: String(team.created_at ?? '') },
  };
}

export function registerScimRoutes(router: Router): void {
  router.get('/scim/v2/Users', (rc) => {
    requireScim(rc);
    const db = rc.app.db;
    const startIndex = Math.max(1, rc.queryInt('startIndex', 1));
    const count = Math.max(1, Math.min(100, rc.queryInt('count', 50)));
    const filter = rc.query('filter');
    let rows = db.prepare('SELECT * FROM persons ORDER BY created_at DESC').all() as unknown as Record<string, unknown>[];
    if (filter) {
      const match = filter.match(/userName\s+eq\s+"([^"]+)"/i) ?? filter.match(/externalId\s+eq\s+"([^"]+)"/i);
      if (match) {
        const value = match[1].toLowerCase();
        rows = rows.filter((row) => String(row.email).toLowerCase() === value || String(row.wecom_userid ?? '').toLowerCase() === value);
      }
    }
    const page = rows.slice(startIndex - 1, startIndex - 1 + count);
    scim(rc, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: rows.length,
      startIndex,
      itemsPerPage: page.length,
      Resources: page.map((row) => scimUser(row, teamsOf(db, String(row.id)))),
    });
  });

  router.get('/scim/v2/Users/:id', (rc) => {
    requireScim(rc);
    const row = findUser(rc.app.db, rc.params.id!);
    if (!row) return scimError(rc, 404, '用户不存在');
    scim(rc, scimUser(row, teamsOf(rc.app.db, String(row.id))));
  });

  router.post('/scim/v2/Users', async (rc) => {
    requireScim(rc);
    const body = (await rc.body<Record<string, unknown>>()) ?? {};
    const id = createUser(rc, body);
    const row = findUser(rc.app.db, id)!;
    scim(rc, scimUser(row), 201);
  });

  router.patch('/scim/v2/Users/:id', async (rc) => {
    requireScim(rc);
    const db = rc.app.db;
    const row = findUser(db, rc.params.id!);
    if (!row) return scimError(rc, 404, '用户不存在');
    const body = await rc.body<{ Operations?: { op?: string; path?: string; value?: unknown }[] }>();
    for (const operation of body.Operations ?? []) {
      const path = String(operation.path ?? '').replace(/^urn:ietf:params:scim:schemas:core:2.0:User:/, '');
      if (path === 'active') {
        const active = operation.value === true || operation.value === 'true';
        db.prepare("UPDATE persons SET status = ? WHERE id = ?").run(active ? 'active' : 'inactive', String(row.id));
        securityEvent(db, { kind: active ? 'scim.user.activate' : 'scim.user.deactivate', severity: 'warning', subject: String(row.email), ip: requestIp(rc), detail: { id: String(row.id) } });
      } else if (path === 'displayName' || path === 'name.formatted') {
        db.prepare('UPDATE persons SET name = ? WHERE id = ?').run(String(operation.value ?? row.name), String(row.id));
      } else if (path === 'externalId') {
        db.prepare('UPDATE persons SET wecom_userid = ? WHERE id = ?').run(operation.value ? String(operation.value) : null, String(row.id));
      }
    }
    const updated = findUser(db, String(row.id))!;
    scim(rc, scimUser(updated, teamsOf(db, String(updated.id))));
  });

  router.delete('/scim/v2/Users/:id', (rc) => {
    requireScim(rc);
    const row = findUser(rc.app.db, rc.params.id!);
    if (!row) return scimError(rc, 404, '用户不存在');
    rc.app.db.prepare("UPDATE persons SET status = 'inactive' WHERE id = ?").run(String(row.id));
    securityEvent(rc.app.db, { kind: 'scim.user.delete', severity: 'warning', subject: String(row.email), ip: requestIp(rc), detail: { id: String(row.id) } });
    rc.res.statusCode = 204;
    rc.res.end();
  });

  router.get('/scim/v2/Groups', (rc) => {
    requireScim(rc);
    const rows = rc.app.db.prepare('SELECT * FROM teams ORDER BY name').all() as unknown as Record<string, unknown>[];
    scim(rc, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: rows.length,
      startIndex: 1,
      itemsPerPage: rows.length,
      Resources: rows.map((row) => groupResource(rc.app.db, row)),
    });
  });

  router.post('/scim/v2/Groups', async (rc) => {
    requireScim(rc);
    const body = await rc.body<{ displayName?: string; members?: { value?: string }[] }>();
    const name = String(body.displayName ?? '').trim();
    if (!name) return scimError(rc, 400, 'displayName 不能为空');
    const id = newId('team');
    let slug = slugify(name, 'team');
    let i = 2;
    while (rc.app.db.prepare('SELECT 1 FROM teams WHERE slug = ?').get(slug)) { slug = `${slugify(name, 'team')}-${i}`; i += 1; }
    rc.app.db.prepare('INSERT INTO teams (id, name, slug, parent_id, description, lead_person_id, wecom_dept_id, sort_order, created_at) VALUES (?, ?, ?, NULL, ?, NULL, NULL, 500, ?)').run(id, name, slug, 'SCIM 供给组', nowIso());
    for (const member of body.members ?? []) {
      if (member.value) rc.app.db.prepare("INSERT OR IGNORE INTO team_members (team_id, person_id, role, created_at) VALUES (?, ?, 'member', ?)").run(id, String(member.value), nowIso());
    }
    securityEvent(rc.app.db, { kind: 'scim.group.create', subject: name, ip: requestIp(rc), detail: { id } });
    scim(rc, groupResource(rc.app.db, rc.app.db.prepare('SELECT * FROM teams WHERE id = ?').get(id) as unknown as Record<string, unknown>), 201);
  });

  router.patch('/scim/v2/Groups/:id', async (rc) => {
    requireScim(rc);
    const team = rc.app.db.prepare('SELECT * FROM teams WHERE id = ?').get(rc.params.id!) as unknown as Record<string, unknown> | undefined;
    if (!team) return scimError(rc, 404, '组不存在');
    const body = await rc.body<{ Operations?: { op?: string; path?: string; value?: unknown }[] }>();
    for (const operation of body.Operations ?? []) {
      const op = String(operation.op ?? '').toLowerCase();
      const path = String(operation.path ?? '');
      const values = Array.isArray(operation.value) ? operation.value : [];
      if (path === 'members') {
        for (const value of values) {
          const memberId = String((value as { value?: string }).value ?? '');
          if (!memberId) continue;
          if (op === 'remove') rc.app.db.prepare('DELETE FROM team_members WHERE team_id = ? AND person_id = ?').run(String(team.id), memberId);
          else rc.app.db.prepare("INSERT OR IGNORE INTO team_members (team_id, person_id, role, created_at) VALUES (?, ?, 'member', ?)").run(String(team.id), memberId, nowIso());
        }
      } else if (path === 'displayName') {
        rc.app.db.prepare('UPDATE teams SET name = ? WHERE id = ?').run(String(operation.value ?? team.name), String(team.id));
      }
    }
    scim(rc, groupResource(rc.app.db, rc.app.db.prepare('SELECT * FROM teams WHERE id = ?').get(String(team.id)) as unknown as Record<string, unknown>));
  });
}
