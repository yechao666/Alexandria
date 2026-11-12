import type { Router } from '../http/router.ts';
import type { RequestContext } from '../http/context.ts';
import { createSession, sessionCookie } from '../http/auth.ts';
import { errors } from '../http/respond.ts';
import { actorFor } from '../domain/access.ts';
import { audit } from '../domain/audit.ts';
import { getWecomConfig, wecomConfigured, wecomAccessToken, wecomUserInfo } from '../domain/wecom.ts';
import { newId, nowIso, randomToken } from '../lib/ids.ts';
import { answerWecomText } from '../domain/wecom-bot.ts';
import { oidcConfigured } from '../domain/oidc.ts';
import {
  buildWecomEncryptedReply,
  buildWecomReplyXml,
  decryptWeCom,
  parseWecomXml,
  verifyWecomSignature,
} from '../domain/wecom-crypto.ts';

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
      oidc: rc.app.env.oidc
        ? { enabled: oidcConfigured(rc.app.env), label: rc.app.env.oidc.label }
        : { enabled: false, label: '企业 SSO' },
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
      'set-cookie': sessionCookie(session, rc.app.env.sessionTtlHours, rc.app.env.wecom.publicUrl.startsWith('https://')),
    });
  });

  /**
   * WeCom Mock / 自定义 IM 的 JSON 回调入口。
   * 生产环境使用下方加密 XML 回调；JSON 模式用于本地 mock 与内网联调。
   */
  router.post('/api/integrations/wecom/im', async (rc) => {
    const body = await rc.body<{
      senderWecomId?: string;
      senderName?: string;
      text?: string;
      chatId?: string;
      kind?: string;
    }>();
    const senderId = String(body.senderWecomId ?? '').trim();
    if (!senderId) throw errors.badRequest('缺少 senderWecomId');
    const result = await answerWecomText(rc.app.db, rc.app.env, {
      senderWecomId: senderId,
      text: String(body.text ?? ''),
      chatId: body.chatId,
    });
    rc.json({
      reply: result.reply,
      mode: result.mode,
      citations: result.citations,
      link: `/#/search?q=${encodeURIComponent(String(body.text ?? '').replace(/^\/(ask|search|s)\s+/i, ''))}`,
    });
  });

  /** 企业微信官方加密 XML 回调：GET 验证 + POST 消息。 */
  router.get('/api/wecom/callback', (rc) => {
    const config = getWecomConfig(rc.app.db, rc.app.env);
    const timestamp = rc.query('timestamp');
    const nonce = rc.query('nonce');
    const signature = rc.query('msg_signature');
    const echostr = rc.query('echostr');
    if (!verifyWecomSignature(config.callbackToken, timestamp, nonce, echostr, signature)) {
      throw errors.forbidden('企业微信回调签名校验失败');
    }
    try {
      const plain = decryptWeCom(echostr, config.encodingAesKey, config.corpId);
      rc.res.statusCode = 200;
      rc.res.setHeader('content-type', 'text/plain; charset=utf-8');
      rc.res.end(plain);
    } catch (error) {
      throw errors.badRequest(`回调验证失败：${(error as Error).message}`);
    }
  });

  router.post('/api/wecom/callback', async (rc) => {
    const config = getWecomConfig(rc.app.db, rc.app.env);
    const raw = (await rc.rawBody(2 * 1024 * 1024)).toString('utf8');
    const encrypted = raw.match(/<Encrypt>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/Encrypt>/)?.[1]?.trim() ?? '';
    if (!encrypted) throw errors.badRequest('缺少 Encrypt 内容');
    if (!verifyWecomSignature(config.callbackToken, rc.query('timestamp'), rc.query('nonce'), encrypted, rc.query('msg_signature'))) {
      throw errors.forbidden('企业微信回调签名校验失败');
    }
    let inboundXml = '';
    try {
      inboundXml = decryptWeCom(encrypted, config.encodingAesKey, config.corpId);
    } catch (error) {
      throw errors.badRequest(`回调解密失败：${(error as Error).message}`);
    }
    const inbound = parseWecomXml(inboundXml);
    if (inbound.MsgType && inbound.MsgType !== 'text') {
      const replyXml = buildWecomReplyXml({ toUser: inbound.FromUserName ?? '', fromUser: config.corpId, content: '暂只支持文本消息。' });
      rc.res.statusCode = 200;
      rc.res.setHeader('content-type', 'text/xml; charset=utf-8');
      rc.res.end(buildWecomEncryptedReply({ replyXml, token: config.callbackToken, encodingAesKey: config.encodingAesKey, corpId: config.corpId }));
      return;
    }
    const result = await answerWecomText(rc.app.db, rc.app.env, {
      senderWecomId: inbound.FromUserName ?? '',
      text: inbound.Content ?? '',
      chatId: inbound.ChatId,
    });
    const replyXml = buildWecomReplyXml({
      toUser: inbound.FromUserName ?? '',
      fromUser: config.corpId,
      content: result.reply,
    });
    rc.res.statusCode = 200;
    rc.res.setHeader('content-type', 'text/xml; charset=utf-8');
    rc.res.end(buildWecomEncryptedReply({ replyXml, token: config.callbackToken, encodingAesKey: config.encodingAesKey, corpId: config.corpId }));
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
