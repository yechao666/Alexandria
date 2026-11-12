import type { Router } from '../http/router.ts';
import type { RequestContext } from '../http/context.ts';
import { authenticate, hashToken, login, logout, sessionCookie, createSession, currentSessionHash } from '../http/auth.ts';
import { rateLimit, resetRateLimit, rateLimitKey } from '../domain/rate-limit.ts';
import { securityEvent, requestIp } from '../domain/security.ts';
import { notifyAdmins } from '../domain/notifications.ts';
import { generateTotpSecret, totpUri, verifyTotp, passwordPolicyError } from '../domain/totp.ts';
import { newId, nowIso, randomToken } from '../lib/ids.ts';
import { hashPassword, verifyPassword } from '../lib/password.ts';
import { requireActor } from '../http/auth.ts';
import { errors } from '../http/respond.ts';
import { visibleLibraries } from '../domain/access.ts';
import { parseJson } from '../lib/ids.ts';
import { libraryCounts, nodeTree, serializeLibrary, teamTree } from './helpers.ts';
import { reviewSummary } from './review.ts';
import { getWecomConfig, wecomConfigured } from '../domain/wecom.ts';
import { unreadNotificationCount } from '../domain/notifications.ts';
import type { LibraryRow, PageRow } from '../types.ts';

export function mePayload(rc: RequestContext) {
  const actor = requireActor(rc);
  return {
    person: actor.person,
    teams: actor.teamIds,
    viaApiKey: Boolean(actor.viaApiKey),
    apiScope: actor.apiScope ?? null,
  };
}

export function registerAuthRoutes(router: Router): void {
  router.get('/api/health', (rc) => {
    rc.json({
      ok: true,
      service: 'alexandria',
      version: '0.1.0',
      time: new Date().toISOString(),
      llm: Boolean(rc.app.env.llm),
      dsh: Boolean(rc.app.env.dsh.enabled),
    });
  });

  router.post('/api/auth/login', async (rc) => {
    const body = await rc.body<{ email?: string; password?: string }>();
    if (!body.email || !body.password) throw errors.badRequest('请输入邮箱和密码');
    const limitKey = rateLimitKey(rc, 'login', body.email);
    const limited = rateLimit(limitKey, 8, 15 * 60_000);
    if (!limited.ok) {
      securityEvent(rc.app.db, { kind: 'login.rate_limited', severity: 'warning', subject: body.email, ip: requestIp(rc) });
      void notifyAdmins(rc.app.db, rc.app.env, { title: '异常登录告警', body: `账号 ${body.email} 触发登录限流，来源 IP ${requestIp(rc) ?? '未知'}`, kind: 'security' });
      rc.res.setHeader('retry-after', String(limited.retryAfter));
      throw errors.tooManyRequests(`登录尝试过多，请 ${Math.ceil(limited.retryAfter / 60)} 分钟后再试`);
    }
    let result;
    try {
      result = login(rc, body.email, body.password, { createSession: false });
      resetRateLimit(limitKey);
    } catch (error) {
      securityEvent(rc.app.db, { kind: 'login.failed', severity: 'warning', subject: body.email, ip: requestIp(rc), detail: { status: (error as { status?: number }).status ?? 500 } });
      throw error;
    }
    const personRow = rc.app.db.prepare('SELECT totp_enabled FROM persons WHERE id = ?').get(result.actor.person.id) as unknown as { totp_enabled: number };
    if (Number(personRow.totp_enabled) === 1) {
      const challengeToken = randomToken(32);
      rc.app.db.prepare('DELETE FROM login_challenges WHERE expires_at < ?').run(new Date().toISOString());
      rc.app.db
        .prepare('INSERT INTO login_challenges (token_hash, person_id, expires_at, attempts, created_at) VALUES (?, ?, ?, 0, ?)')
        .run(hashToken(challengeToken), result.actor.person.id, new Date(Date.now() + 5 * 60_000).toISOString(), new Date().toISOString());
      rc.json({ requires2fa: true, challengeToken, person: result.actor.person, teams: result.actor.teamIds });
      return;
    }
    const session = createSession(rc.app.db, result.actor.person.id, rc.app.env.sessionTtlHours, rc);
    securityEvent(rc.app.db, { kind: 'login.success', actorId: result.actor.person.id, subject: body.email, ip: requestIp(rc) });
    rc.json(
      { person: result.actor.person, teams: result.actor.teamIds, token: session },
      200,
      { 'set-cookie': sessionCookie(session, rc.app.env.sessionTtlHours, rc.app.env.wecom.publicUrl.startsWith('https://')) },
    );
  });

  router.post('/api/auth/2fa/verify', async (rc) => {
    const body = await rc.body<{ challengeToken?: string; code?: string }>();
    const challengeToken = String(body.challengeToken ?? '');
    const code = String(body.code ?? '');
    if (!challengeToken || !code) throw errors.badRequest('需要 challengeToken 与验证码');
    const limitKey = rateLimitKey(rc, '2fa', challengeToken);
    const limited = rateLimit(limitKey, 6, 5 * 60_000);
    if (!limited.ok) throw errors.tooManyRequests('验证码尝试过多，请重新登录');
    const challenge = rc.app.db.prepare('SELECT * FROM login_challenges WHERE token_hash = ?').get(hashToken(challengeToken)) as unknown as
      | { person_id: string; expires_at: string; attempts: number }
      | undefined;
    if (!challenge || challenge.expires_at <= new Date().toISOString()) throw errors.unauthorized('验证码已过期，请重新登录');
    const person = rc.app.db.prepare("SELECT * FROM persons WHERE id = ? AND status = 'active'").get(challenge.person_id) as unknown as Record<string, unknown> | undefined;
    if (!person?.totp_secret) throw errors.unauthorized('该账号未启用 2FA');
    const totpOk = verifyTotp(String(person.totp_secret), code);
    if (!totpOk) {
      const normalized = code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      const recovery = rc.app.db.prepare('SELECT * FROM recovery_codes WHERE person_id = ? AND code_hash = ? AND used_at IS NULL').get(String(person.id), hashToken(normalized)) as unknown as { id: string } | undefined;
      if (recovery) {
        rc.app.db.prepare('UPDATE recovery_codes SET used_at = ? WHERE id = ?').run(nowIso(), recovery.id);
        securityEvent(rc.app.db, { kind: 'login.2fa_recovery', severity: 'warning', subject: String(person.email), ip: requestIp(rc) });
      } else {
      const attempts = Number(challenge.attempts) + 1;
      rc.app.db.prepare('UPDATE login_challenges SET attempts = ? WHERE token_hash = ?').run(attempts, hashToken(challengeToken));
      securityEvent(rc.app.db, { kind: 'login.2fa_failed', severity: 'warning', subject: String(person.email), ip: requestIp(rc), detail: { attempts } });
      if (attempts >= 6) rc.app.db.prepare('DELETE FROM login_challenges WHERE token_hash = ?').run(hashToken(challengeToken));
      throw errors.unauthorized('验证码不正确');
      }
    }
    rc.app.db.prepare('DELETE FROM login_challenges WHERE token_hash = ?').run(hashToken(challengeToken));
    const session = createSession(rc.app.db, String(person.id), rc.app.env.sessionTtlHours, rc);
    securityEvent(rc.app.db, { kind: 'login.success', actorId: String(person.id), subject: String(person.email), ip: requestIp(rc), detail: { twoFactor: true } });
    rc.json({ person: { id: person.id, email: person.email, name: person.name, title: person.title, isAdmin: Boolean(person.is_admin) }, token: session }, 200, {
      'set-cookie': sessionCookie(session, rc.app.env.sessionTtlHours, rc.app.env.wecom.publicUrl.startsWith('https://')),
    });
  });

  router.get('/api/auth/2fa', (rc) => {
    const actor = requireActor(rc);
    const row = rc.app.db.prepare('SELECT totp_enabled FROM persons WHERE id = ?').get(actor.person.id) as unknown as { totp_enabled: number };
    rc.json({ enabled: Number(row.totp_enabled) === 1 });
  });

  router.post('/api/auth/2fa/setup', (rc) => {
    const actor = requireActor(rc);
    if (actor.viaApiKey) throw errors.forbidden('API Key 不能设置 2FA');
    const secret = generateTotpSecret();
    rc.app.db.prepare('UPDATE persons SET totp_secret = ?, totp_enabled = 0 WHERE id = ?').run(secret, actor.person.id);
    securityEvent(rc.app.db, { kind: '2fa.setup', actorId: actor.person.id, subject: actor.person.email, ip: requestIp(rc) });
    rc.json({ secret, otpauth: totpUri(secret, actor.person.email) });
  });

  router.post('/api/auth/2fa/enable', async (rc) => {
    const actor = requireActor(rc);
    if (actor.viaApiKey) throw errors.forbidden('API Key 不能修改 2FA');
    const body = await rc.body<{ code?: string }>();
    const row = rc.app.db.prepare('SELECT totp_secret FROM persons WHERE id = ?').get(actor.person.id) as unknown as { totp_secret: string | null };
    if (!row.totp_secret) throw errors.badRequest('请先生成 2FA 密钥');
    if (!verifyTotp(row.totp_secret, String(body.code ?? ''))) throw errors.unauthorized('验证码不正确');
    rc.app.db.prepare('UPDATE persons SET totp_enabled = 1 WHERE id = ?').run(actor.person.id);
    rc.app.db.prepare('DELETE FROM recovery_codes WHERE person_id = ?').run(actor.person.id);
    const recoveryCodes: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const code = `${randomToken(4).toUpperCase()}-${randomToken(4).toUpperCase()}`;
      recoveryCodes.push(code);
      rc.app.db.prepare('INSERT INTO recovery_codes (id, person_id, code_hash, used_at, created_at) VALUES (?, ?, ?, NULL, ?)').run(newId('rc'), actor.person.id, hashToken(code.replace(/-/g, '')), nowIso());
    }
    securityEvent(rc.app.db, { kind: '2fa.enable', actorId: actor.person.id, subject: actor.person.email, ip: requestIp(rc) });
    rc.json({ ok: true, recoveryCodes });
  });

  router.post('/api/auth/2fa/disable', async (rc) => {
    const actor = requireActor(rc);
    const body = await rc.body<{ code?: string }>();
    const row = rc.app.db.prepare('SELECT totp_secret, totp_enabled FROM persons WHERE id = ?').get(actor.person.id) as unknown as { totp_secret: string | null; totp_enabled: number };
    if (Number(row.totp_enabled) !== 1) throw errors.badRequest('2FA 未启用');
    if (!row.totp_secret || !verifyTotp(row.totp_secret, String(body.code ?? ''))) throw errors.unauthorized('验证码不正确');
    rc.app.db.prepare('UPDATE persons SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(actor.person.id);
    securityEvent(rc.app.db, { kind: '2fa.disable', severity: 'warning', actorId: actor.person.id, subject: actor.person.email, ip: requestIp(rc) });
    rc.json({ ok: true });
  });

  router.get('/api/auth/sessions', (rc) => {
    const actor = requireActor(rc);
    const current = currentSessionHash(rc);
    const rows = rc.app.db
      .prepare('SELECT token_hash, created_at, expires_at, ip, user_agent FROM sessions WHERE person_id = ? ORDER BY created_at DESC')
      .all(actor.person.id) as unknown as Record<string, unknown>[];
    rc.json({
      sessions: rows.map((row) => ({
        id: String(row.token_hash),
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        ip: row.ip,
        userAgent: row.user_agent,
        current: row.token_hash === current,
      })),
    });
  });

  router.delete('/api/auth/sessions/:id', (rc) => {
    const actor = requireActor(rc);
    const result = rc.app.db.prepare('DELETE FROM sessions WHERE token_hash = ? AND person_id = ?').run(rc.params.id!, actor.person.id);
    if (Number(result.changes) === 0) throw errors.notFound('会话不存在');
    securityEvent(rc.app.db, { kind: 'session.revoke', severity: 'warning', actorId: actor.person.id, subject: actor.person.email, ip: requestIp(rc) });
    rc.json({ ok: true });
  });

  router.post('/api/auth/sessions/revoke-others', (rc) => {
    const actor = requireActor(rc);
    const current = currentSessionHash(rc);
    const result = rc.app.db.prepare('DELETE FROM sessions WHERE person_id = ? AND token_hash <> ?').run(actor.person.id, current ?? '');
    securityEvent(rc.app.db, { kind: 'session.revoke_others', severity: 'warning', actorId: actor.person.id, subject: actor.person.email, ip: requestIp(rc), detail: { count: Number(result.changes) } });
    rc.json({ ok: true, revoked: Number(result.changes) });
  });

  router.post('/api/auth/2fa/recovery-codes', (rc) => {
    const actor = requireActor(rc);
    if (actor.viaApiKey) throw errors.forbidden('API Key 不能生成恢复码');
    const codes: string[] = [];
    rc.app.db.prepare('DELETE FROM recovery_codes WHERE person_id = ?').run(actor.person.id);
    for (let i = 0; i < 10; i += 1) {
      const code = `${randomToken(4).toUpperCase()}-${randomToken(4).toUpperCase()}`;
      codes.push(code);
      rc.app.db.prepare('INSERT INTO recovery_codes (id, person_id, code_hash, used_at, created_at) VALUES (?, ?, ?, NULL, ?)').run(newId('rc'), actor.person.id, hashToken(code.replace(/-/g, '')), nowIso());
    }
    securityEvent(rc.app.db, { kind: '2fa.recovery_regenerate', severity: 'warning', actorId: actor.person.id, subject: actor.person.email, ip: requestIp(rc) });
    rc.json({ recoveryCodes: codes });
  });

  router.post('/api/auth/password', async (rc) => {
    const actor = requireActor(rc);
    if (actor.viaApiKey) throw errors.forbidden('API Key 不能修改密码');
    const body = await rc.body<{ currentPassword?: string; newPassword?: string }>();
    const row = rc.app.db.prepare('SELECT password_hash FROM persons WHERE id = ?').get(actor.person.id) as unknown as { password_hash: string };
    if (!verifyPassword(String(body.currentPassword ?? ''), row.password_hash)) throw errors.unauthorized('当前密码不正确');
    const error = passwordPolicyError(String(body.newPassword ?? ''));
    if (error) throw errors.badRequest(error);
    rc.app.db.prepare('UPDATE persons SET password_hash = ? WHERE id = ?').run(hashPassword(String(body.newPassword)), actor.person.id);
    securityEvent(rc.app.db, { kind: 'password.change', actorId: actor.person.id, subject: actor.person.email, ip: requestIp(rc) });
    rc.json({ ok: true });
  });

  router.post('/api/auth/logout', (rc) => {
    logout(rc);
    rc.json({ ok: true }, 200, {
      'set-cookie': 'alex_sess_cookie=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    });
  });

  router.get('/api/me', (rc) => {
    rc.json(mePayload(rc));
  });

  router.get('/api/bootstrap', (rc) => {
    const actor = requireActor(rc);
    const libraries = visibleLibraries(rc.app.db, actor);
    const libraryIds = libraries.map((library) => library.id);
    const placeholders = libraryIds.map(() => '?').join(',') || "''";
    const recentPages = (
      libraryIds.length
        ? (rc.app.db
            .prepare(
              `SELECT p.*, l.name AS library_name, l.slug AS library_slug FROM pages p JOIN libraries l ON l.id = p.library_id
                WHERE p.library_id IN (${placeholders}) ORDER BY p.updated_at DESC LIMIT 12`,
            )
            .all(...libraryIds) as unknown as (PageRow & { library_name: string; library_slug: string })[])
        : []
    ).map((page) => ({
      id: page.id,
      title: page.title,
      summary: page.summary,
      classKey: page.class_key,
      status: page.status,
      confidence: page.confidence,
      updatedAt: page.updated_at,
      libraryId: page.library_id,
      libraryName: page.library_name,
      librarySlug: page.library_slug,
      tags: parseJson<string[]>(page.tags, []),
    }));

    const people = rc.app.db
      .prepare('SELECT id, name, email, title, avatar_color, is_admin FROM persons WHERE status = ? ORDER BY name')
      .all('active') as unknown as {
      id: string;
      name: string;
      email: string;
      title: string;
      avatar_color: string;
      is_admin: number;
    }[];

    const teams = teamTree(rc.app.db);
    const classDistribution = rc.app.db
      .prepare(
        `SELECT c.key, c.name, c.color, COUNT(p.id) AS count FROM ontology_classes c
          LEFT JOIN pages p ON p.class_key = c.key AND p.library_id = c.library_id
          WHERE c.library_id IN (${placeholders}) GROUP BY c.library_id, c.key ORDER BY count DESC`,
      )
      .all(...(libraryIds.length ? libraryIds : [''])) as unknown as { key: string; name: string; color: string; count: number }[];

    const totals = libraryIds.length
      ? (rc.app.db
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM pages WHERE library_id IN (${placeholders})) AS pages,
               (SELECT COUNT(*) FROM sources WHERE library_id IN (${placeholders})) AS sources,
               (SELECT COUNT(*) FROM links WHERE library_id IN (${placeholders})) AS links,
               (SELECT COUNT(*) FROM claims WHERE page_id IN (SELECT id FROM pages WHERE library_id IN (${placeholders}))) AS claims,
               (SELECT COUNT(*) FROM claims WHERE status = 'conflicted' AND page_id IN (SELECT id FROM pages WHERE library_id IN (${placeholders}))) AS conflicts`,
          )
          .get(...libraryIds, ...libraryIds, ...libraryIds, ...libraryIds, ...libraryIds) as unknown as Record<string, number>)
      : { pages: 0, sources: 0, links: 0, claims: 0, conflicts: 0 };

    const review = reviewSummary(rc.app.db, actor);
    rc.json({
      me: { person: actor.person, teams: actor.teamIds },
      libraries: libraries.map((library) => serializeLibrary(rc.app.db, library as LibraryRow, library.role)),
      recentPages,
      teams,
      people: people.map((person) => ({
        id: person.id,
        name: person.name,
        email: person.email,
        title: person.title,
        avatarColor: person.avatar_color,
        isAdmin: Boolean(person.is_admin),
      })),
      stats: {
        ...totals,
        libraries: libraries.length,
        members: people.length,
        reviewPending: review.pending,
        conflicts: review.conflicts,
        notificationsUnread: unreadNotificationCount(rc.app.db, actor.person.id),
      },
      review,
      classes: classDistribution,
      features: {
        llm: Boolean(rc.app.env.llm),
        dsh: rc.app.env.dsh.enabled,
        wecom: wecomConfigured(getWecomConfig(rc.app.db, rc.app.env)),
        ocr: true,
      },
    });
  });

  router.get('/api/stats', (rc) => {
    const actor = requireActor(rc);
    const libraries = visibleLibraries(rc.app.db, actor);
    const ids = libraries.map((library) => library.id);
    const ph = ids.map(() => '?').join(',') || "''";
    const stats = ids.length
      ? (rc.app.db
          .prepare(
            `SELECT (SELECT COUNT(*) FROM pages WHERE library_id IN (${ph})) AS pages,
                    (SELECT COUNT(*) FROM sources WHERE library_id IN (${ph})) AS sources,
                    (SELECT COUNT(*) FROM links WHERE library_id IN (${ph})) AS links,
                    (SELECT COUNT(*) FROM claims WHERE page_id IN (SELECT id FROM pages WHERE library_id IN (${ph}))) AS claims,
                    (SELECT COUNT(*) FROM claims WHERE status = 'conflicted' AND page_id IN (SELECT id FROM pages WHERE library_id IN (${ph}))) AS conflicts`,
          )
          .get(...ids, ...ids, ...ids, ...ids, ...ids) as unknown as Record<string, number>)
      : { pages: 0, sources: 0, links: 0, claims: 0, conflicts: 0 };
    rc.json({ ...stats, libraries: libraries.map((library) => ({ id: library.id, name: library.name, counts: libraryCounts(rc.app.db, library.id) })) });
  });
}
