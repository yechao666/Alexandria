import test from 'node:test';
import assert from 'node:assert/strict';
import { closeServer, createTestContext, login, startTestServer } from './helpers.ts';
import { totpCode } from '../server/src/domain/totp.ts';

const ctx = createTestContext();
const { server, base } = await startTestServer(ctx.app);

test.after(async () => {
  await closeServer(server);
  ctx.cleanup();
});

async function j<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  return (await response.json()) as T;
}

test('2FA 启用后密码登录需要动态码，验证后建立会话', async () => {
  const first = await login(base, 'shen@alex.dev');
  const setup = await j<{ secret: string; otpauth: string }>('/api/auth/2fa/setup', first.token, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.match(setup.otpauth, /^otpauth:\/\/totp/);
  const enable = await j<{ ok: boolean; recoveryCodes: string[] }>('/api/auth/2fa/enable', first.token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: totpCode(setup.secret) }),
  });
  assert.equal(enable.ok, true);
  assert.equal(enable.recoveryCodes.length, 10);
  const passwordLogin = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'shen@alex.dev', password: 'alex-demo' }),
  });
  const challenge = (await passwordLogin.json()) as { requires2fa: boolean; challengeToken: string };
  assert.equal(challenge.requires2fa, true);
  assert.ok(challenge.challengeToken);
  const wrong = await fetch(`${base}/api/auth/2fa/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeToken: challenge.challengeToken, code: '000000' }),
  });
  assert.equal(wrong.status, 401);
  const verified = await fetch(`${base}/api/auth/2fa/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeToken: challenge.challengeToken, code: enable.recoveryCodes[0] }),
  });
  const verifiedData = (await verified.json()) as { token: string; person: { email: string } };
  assert.equal(verified.status, 200);
  assert.ok(verifiedData.token);
  const me = await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${verifiedData.token}` } });
  assert.equal(me.status, 200);
  const sessions = await j<{ sessions: { current: boolean; id: string }[] }>('/api/auth/sessions', verifiedData.token);
  assert.ok(sessions.sessions.some((session) => session.current));
  const revoke = await j<{ revoked: number }>('/api/auth/sessions/revoke-others', verifiedData.token, { method: 'POST' });
  assert.ok(revoke.revoked >= 0);
  const disable = await j<{ ok: boolean }>('/api/auth/2fa/disable', verifiedData.token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: totpCode(setup.secret) }),
  });
  assert.equal(disable.ok, true);
});

test('弱密码修改被拒绝', async () => {
  const user = await login(base, 'su@alex.dev');
  const response = await fetch(`${base}/api/auth/password`, {
    method: 'POST',
    headers: { authorization: `Bearer ${user.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ currentPassword: 'alex-demo', newPassword: 'weak' }),
  });
  assert.equal(response.status, 400);
});
