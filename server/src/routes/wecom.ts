import type { Router } from '../http/router.ts';
import type { RequestContext } from '../http/context.ts';
import { createSession, sessionCookie } from '../http/auth.ts';
import { errors } from '../http/respond.ts';
import { actorFor } from '../domain/access.ts';
import { audit } from '../domain/audit.ts';
import { getWecomConfig, wecomConfigured, wecomAccessToken, wecomUserInfo } from '../domain/wecom.ts';
import { newId, nowIso, randomToken } from '../lib/ids.ts';

function redirect(rc: RequestContext, location: string, headers: Record<string, string> = {}): void {
  rc.res.statusCode = 302;
  rc.res.setHeader('location', location);
  for (const [key, value] of Object.entries(headers)) rc.res.setHeader(key, value);
  rc.res.end();
}

function loginError(rc: RequestContext, code: string): void {
  redirect(rc, `/#/login?error=${encodeURIComponent(code)}`);
}

function safeReturnTo(value: string): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/#/';
  return value;
}

export function registerWecomAuthRoutes(router: Router): void {
  router.get('/api/auth/providers', (rc) => {
    const config = getWecomConfig(rc.app.db, rc.app.env);
    rc.json({
      wecom: {
        enabled: wecomConfigured(config),
        label: config.mock ? '企业微信登录（Mock）' : '企业微信登录',
        mode: config.mock ? 'mock' : 'wecom',
        configureHint: wecomConfigured(config) ? '' : '管理员尚未配置 CorpID / Secret',
      },
    });
  });

  router.get('/api/auth/wecom/start', (rc) => {
    const config = getWecomConfig(rc.app.db, rc.app.env);
    if (!wecomConfigured(config)) return loginError(rc, 'wecom_unavailable');
    const returnTo = safeReturnTo(rc.query('returnTo') || '/#/');
    const state = randomToken(24);
    const now = nowIso();
    rc.app.db.prepare('DELETE FROM wecom_auth_states WHERE expires_at < ?').run(now);
    rc.app.db
      .prepare('INSERT INTO wecom_auth_states (state, return_to, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(state, returnTo, now, new Date(Date.now() + 10 * 60_000).toISOString());

    const target = new URL(`${config.authorizeBase}/connect/oauth2/authorize`);
    target.searchParams.set('appid', config.corpId);
    target.searchParams.set('redirect_uri', `${config.publicUrl}/api/auth/wecom/callback`);
    target.searchParams.set('response_type', 'code');
    target.searchParams.set('scope', 'snsapi_base');
    target.searchParams.set('state', state);
    if (config.mock) {
      const mockUser = rc.query('mock_user') || process.env.ALEXANDRIA_WECOM_MOCK_USER || '';
      if (mockUser) target.searchParams.set('mock_user', mockUser);
    } else {
      target.hash = 'wechat_redirect';
    }
    redirect(rc, target.toString());
  });

  router.get('/api/auth/wecom/callback', async (rc) => {
    const config = getWecomConfig(rc.app.db, rc.app.env);
    const state = rc.query('state');
    const code = rc.query('code');
    if (!state) return loginError(rc, 'wecom_state');
    const row = rc.app.db.prepare('SELECT * FROM wecom_auth_states WHERE state = ?').get(state) as unknown as
      | { state: string; return_to: string; expires_at: string }
      | undefined;
    if (!row || new Date(row.expires_at).getTime() < Date.now()) return loginError(rc, 'wecom_state');
    rc.app.db.prepare('DELETE FROM wecom_auth_states WHERE state = ?').run(state);
    if (!code) return loginError(rc, 'wecom_denied');

    let userid = '';
    try {
      const token = await wecomAccessToken(config);
      const user = await wecomUserInfo(config, token, code);
      userid = user.userid;
    } catch (error) {
      console.warn('[wecom] callback failed', (error as Error).message);
      return loginError(rc, 'wecom_api');
    }

    const personRow = rc.app.db
      .prepare("SELECT * FROM persons WHERE lower(wecom_userid) = lower(?) AND status = 'active'")
      .get(userid) as unknown as Record<string, unknown> | undefined;
    if (!personRow) {
      return redirect(rc, `/#/login?error=wecom_unmapped&userid=${encodeURIComponent(userid)}`);
    }
    const person = {
      id: String(personRow.id),
      email: String(personRow.email),
      name: String(personRow.name),
      title: String(personRow.title ?? ''),
      avatarColor: String(personRow.avatar_color ?? 'clay'),
      isAdmin: Boolean(personRow.is_admin),
    };
    const session = createSession(rc.app.db, person.id, rc.app.env.sessionTtlHours, rc);
    audit(rc.app.db, {
      actor: actorFor(rc.app.db, person),
      action: 'auth.wecom.login',
      targetType: 'person',
      targetId: person.id,
      detail: { wecomUserid: userid, mode: config.mock ? 'mock' : 'wecom' },
    });
    redirect(rc, safeReturnTo(row.return_to), {
      'set-cookie': sessionCookie(session, rc.app.env.sessionTtlHours),
    });
  });

  // 供管理员查看当前 WeCom 配置（不返回 Secret）
  router.get('/api/auth/wecom/status', (rc) => {
    const config = getWecomConfig(rc.app.db, rc.app.env);
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
    });
  });
}

export { newId };
