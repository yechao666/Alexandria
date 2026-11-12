import type { Db } from '../db/index.ts';
import type { Env } from '../env.ts';
import type { RequestContext } from '../http/context.ts';
import { createSession, sessionCookie } from '../http/auth.ts';
import { actorFor, personRowToPerson } from './access.ts';
import { securityEvent, requestIp } from './security.ts';
import { nowIso, randomToken } from '../lib/ids.ts';

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  issuer: string;
}

const cache = new Map<string, { expires: number; value: Discovery }>();

function config(env: Env) {
  return env.oidc;
}

export function oidcConfigured(env: Env): boolean {
  return Boolean(config(env));
}

async function discovery(env: Env): Promise<Discovery | null> {
  const oidc = config(env);
  if (!oidc) return null;
  const cached = cache.get(oidc.issuer);
  if (cached && cached.expires > Date.now()) return cached.value;
  try {
    const response = await fetch(`${oidc.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    const value = (await response.json()) as Discovery;
    if (!value.authorization_endpoint || !value.token_endpoint) return null;
    cache.set(oidc.issuer, { expires: Date.now() + 10 * 60_000, value });
    return value;
  } catch {
    return null;
  }
}

function safeReturnTo(value: string): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/#/';
  return value;
}

export async function beginOidc(rc: RequestContext): Promise<string | null> {
  const oidc = config(rc.app.env);
  if (!oidc) return null;
  const endpoints = await discovery(rc.app.env);
  if (!endpoints) return null;
  const state = randomToken(24);
  const now = nowIso();
  rc.app.db.prepare('DELETE FROM oidc_states WHERE expires_at < ?').run(now);
  rc.app.db
    .prepare('INSERT INTO oidc_states (state, return_to, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(state, safeReturnTo(rc.query('returnTo') || '/#/'), now, new Date(Date.now() + 10 * 60_000).toISOString());
  const target = new URL(endpoints.authorization_endpoint);
  target.searchParams.set('response_type', 'code');
  target.searchParams.set('client_id', oidc.clientId);
  target.searchParams.set('redirect_uri', oidc.redirectUri);
  target.searchParams.set('scope', oidc.scopes);
  target.searchParams.set('state', state);
  return target.toString();
}

export interface OidcResult {
  ok: boolean;
  returnTo?: string;
  error?: string;
}

/** 完成 OIDC 授权码回调，创建本地会话；仅映射已存在的本地账号。 */
export async function completeOidc(rc: RequestContext): Promise<OidcResult> {
  const db: Db = rc.app.db;
  const oidc = config(rc.app.env);
  if (!oidc) return { ok: false, error: 'oidc_unavailable' };
  const state = rc.query('state');
  const code = rc.query('code');
  if (!state || !code) return { ok: false, error: 'oidc_state' };
  const stateRow = db.prepare('SELECT * FROM oidc_states WHERE state = ?').get(state) as unknown as
    | { state: string; return_to: string; expires_at: string }
    | undefined;
  if (!stateRow || stateRow.expires_at <= nowIso()) return { ok: false, error: 'oidc_state' };
  db.prepare('DELETE FROM oidc_states WHERE state = ?').run(state);
  const endpoints = await discovery(rc.app.env);
  if (!endpoints) return { ok: false, error: 'oidc_api' };
  try {
    const tokenResponse = await fetch(endpoints.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: oidc.redirectUri,
        client_id: oidc.clientId,
        client_secret: oidc.clientSecret,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const token = (await tokenResponse.json()) as { access_token?: string };
    if (!token.access_token) return { ok: false, error: 'oidc_token' };
    const userResponse = await fetch(endpoints.userinfo_endpoint, {
      headers: { authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!userResponse.ok) return { ok: false, error: 'oidc_userinfo' };
    const user = (await userResponse.json()) as { email?: string; preferred_username?: string; name?: string; sub?: string };
    const email = String(user.email ?? user.preferred_username ?? '').trim().toLowerCase();
    if (!email) return { ok: false, error: 'oidc_email' };
    const personRow = db.prepare("SELECT * FROM persons WHERE lower(email) = ? AND status = 'active'").get(email) as unknown as
      | Record<string, unknown>
      | undefined;
    if (!personRow) return { ok: false, error: 'oidc_unmapped' };
    const person = personRowToPerson(personRow);
    const actor = actorFor(db, person);
    const session = createSession(db, person.id, rc.app.env.sessionTtlHours, rc);
    securityEvent(db, { kind: 'login.success', actorId: person.id, subject: email, ip: requestIp(rc), detail: { provider: 'oidc' } });
    rc.res.setHeader('set-cookie', sessionCookie(session, rc.app.env.sessionTtlHours, rc.app.env.wecom.publicUrl.startsWith('https://')));
    return { ok: true, returnTo: stateRow.return_to };
  } catch {
    return { ok: false, error: 'oidc_api' };
  }
}
