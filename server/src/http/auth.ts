import { createHash, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/index.ts';
import type { Actor, Person } from '../types.ts';
import { errors } from './respond.ts';
import type { RequestContext } from './context.ts';
import { newId, nowIso, randomToken, sha256 } from '../lib/ids.ts';
import { verifyPassword } from '../lib/password.ts';
import { actorFor, personRowToPerson } from '../domain/access.ts';

const SESSION_PREFIX = 'alex_sess_';
const KEY_PREFIX = 'alex_ak_';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createSession(db: Db, personId: string, ttlHours: number, rc: RequestContext): string {
  const token = `${SESSION_PREFIX}${randomToken(32)}`;
  db.prepare(
    'INSERT INTO sessions (token_hash, person_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    hashToken(token),
    personId,
    nowIso(),
    new Date(Date.now() + ttlHours * 3_600_000).toISOString(),
    rc.req.socket.remoteAddress ?? null,
    String(rc.req.headers['user-agent'] ?? '').slice(0, 200) || null,
  );
  db.prepare('UPDATE persons SET last_seen_at = ? WHERE id = ?').run(nowIso(), personId);
  return token;
}

export function sessionCookie(token: string, ttlHours: number, secure = false): string {
  return `${SESSION_PREFIX}cookie=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}; Max-Age=${ttlHours * 3600}`;
}

function cookieToken(rc: RequestContext): string {
  const header = String(rc.req.headers.cookie ?? '');
  for (const part of header.split(';')) {
    const [name, value] = part.trim().split('=');
    if (name === `${SESSION_PREFIX}cookie` && value) return decodeURIComponent(value);
  }
  return '';
}

function personById(db: Db, id: string): Person | null {
  const row = db.prepare('SELECT * FROM persons WHERE id = ? AND status = ?').get(id, 'active') as unknown as
    | Record<string, unknown>
    | undefined;
  return row ? personRowToPerson(row) : null;
}

function apiKeyPerson(db: Db, token: string): { person: Person; scope: 'read' | 'write' | 'admin' } | null {
  if (!token.startsWith(KEY_PREFIX)) return null;
  const row = db
    .prepare(
      `SELECT p.*, k.id AS key_id, k.scope AS key_scope
         FROM api_keys k JOIN persons p ON p.id = k.person_id
        WHERE k.key_hash = ? AND k.revoked_at IS NULL AND p.status = 'active'`,
    )
    .get(hashToken(token)) as unknown as (Record<string, unknown> & { key_id: string; key_scope: string }) | undefined;
  if (!row) return null;
  db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(nowIso(), row.key_id);
  return { person: personRowToPerson(row), scope: (row.key_scope as 'read' | 'write' | 'admin') ?? 'read' };
}

export function authenticate(rc: RequestContext, required = true): Actor | null {
  if (rc.actor) return rc.actor;
  const auth = String(rc.req.headers.authorization ?? '');
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const token = bearer || cookieToken(rc);

  if (token) {
    const key = apiKeyPerson(rc.app.db, token);
    if (key) {
      rc.actor = { ...actorFor(rc.app.db, key.person), viaApiKey: true, apiScope: key.scope };
      return rc.actor;
    }
    const row = rc.app.db
      .prepare(
        `SELECT p.* FROM sessions s JOIN persons p ON p.id = s.person_id
          WHERE s.token_hash = ? AND s.expires_at > ? AND p.status = 'active'`,
      )
      .get(hashToken(token), nowIso()) as unknown as Record<string, unknown> | undefined;
    if (row) {
      rc.actor = actorFor(rc.app.db, personRowToPerson(row));
      return rc.actor;
    }
  }
  if (required) throw errors.unauthorized('登录状态已失效，请重新登录');
  return null;
}

const READ_ONLY_POST_PATHS = new Set([
  '/api/query',
  '/api/agent/search',
  '/api/agent/ask',
  '/api/agent/read',
  '/api/agent/graph',
  '/api/agent/lint',
]);

export function requireActor(rc: RequestContext): Actor {
  const actor = authenticate(rc, true)!;
  if (rc.method !== 'GET' && actor.viaApiKey && actor.apiScope === 'read' && !READ_ONLY_POST_PATHS.has(rc.pathname)) {
    throw errors.forbidden('只读 API Key 不能执行写操作');
  }
  return actor;
}

export function requireAdmin(rc: RequestContext): Actor {
  const actor = requireActor(rc);
  if (!actor.person.isAdmin) throw errors.forbidden('需要组织管理员权限');
  return actor;
}

export function login(
  rc: RequestContext,
  email: string,
  password: string,
  options: { createSession?: boolean } = {},
): { token: string; actor: Actor } {
  const row = rc.app.db
    .prepare('SELECT * FROM persons WHERE lower(email) = lower(?) AND status = ?')
    .get(email.trim(), 'active') as unknown as (Record<string, unknown> & { password_hash: string }) | undefined;
  if (!row || !verifyPassword(password, row.password_hash)) {
    throw errors.unauthorized('邮箱或密码不正确');
  }
  const person = personRowToPerson(row);
  const token = options.createSession === false ? '' : createSession(rc.app.db, person.id, rc.app.env.sessionTtlHours, rc);
  return { token, actor: actorFor(rc.app.db, person) };
}

export function currentSessionHash(rc: RequestContext): string | null {
  const auth = String(rc.req.headers.authorization ?? '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : cookieToken(rc);
  return token ? hashToken(token) : null;
}

export function logout(rc: RequestContext): void {
  const header = String(rc.req.headers.cookie ?? '');
  for (const part of header.split(';')) {
    const [name, value] = part.trim().split('=');
    if (name === `${SESSION_PREFIX}cookie` && value) {
      rc.app.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(decodeURIComponent(value)));
    }
  }
}

export function createApiKey(db: Db, personId: string, name: string, scope: 'read' | 'write' | 'admin'): { token: string; id: string } {
  const token = `${KEY_PREFIX}${randomToken(32)}`;
  const id = newId('key');
  db.prepare(
    'INSERT INTO api_keys (id, person_id, name, prefix, key_hash, scope, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, personId, name, token.slice(0, 12), hashToken(token), scope, nowIso());
  return { token, id };
}

export function safeTokenEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export { sha256 };
