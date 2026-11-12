import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { closeServer, createTestContext, login, startTestServer } from './helpers.ts';
// @ts-ignore wecom-mock is a plain ESM fixture outside this package
import { createMockWeCom } from '../../wecom-mock/src/server.mjs';

const ctx = createTestContext();
const { server, base } = await startTestServer(ctx.app);
const mock = createMockWeCom({ port: 0, configPath: join(ctx.root, 'wecom-config.json') });
await new Promise<void>((resolve) => mock.server.listen(0, '127.0.0.1', () => resolve()));
const address = mock.server.address();
const mockBase = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
ctx.env.wecom.baseUrl = mockBase;
ctx.env.wecom.authorizeBase = mockBase;
ctx.env.wecom.publicUrl = base;
ctx.env.wecom.mock = true;
ctx.env.wecom.enabled = true;

test.after(async () => {
  await mock.close();
  await closeServer(server);
  ctx.cleanup();
});

test('登录页可发现企业微信登录提供方', async () => {
  const response = await fetch(`${base}/api/auth/providers`);
  const data = (await response.json()) as { wecom: { enabled: boolean; mode: string; label: string } };
  assert.equal(response.status, 200);
  assert.equal(data.wecom.enabled, true);
  assert.equal(data.wecom.mode, 'mock');
  assert.match(data.wecom.label, /企业微信/);
});

test('WeCom Mock OAuth 回调能把企微 userid 映射到本地账号并建立会话', async () => {
  const start = await fetch(`${base}/api/auth/wecom/start?returnTo=%2F%23%2F`, { redirect: 'manual' });
  assert.equal(start.status, 302);
  const authorizeUrl = new URL(start.headers.get('location')!);
  assert.match(authorizeUrl.toString(), /\/connect\/oauth2\/authorize/);
  assert.equal(authorizeUrl.searchParams.get('appid'), 'wwmockcorp');

  authorizeUrl.searchParams.set('mock_user', 'LinWei');
  const authorized = await fetch(authorizeUrl, { redirect: 'manual' });
  assert.equal(authorized.status, 302);
  const callbackUrl = authorized.headers.get('location')!;
  assert.match(callbackUrl, /\/api\/auth\/wecom\/callback/);

  const callback = await fetch(callbackUrl, { redirect: 'manual' });
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('location'), '/#/');
  const cookie = callback.headers.get('set-cookie');
  assert.ok(cookie?.includes('alex_sess_cookie='));

  const me = await fetch(`${base}/api/me`, { headers: { cookie: cookie!.split(';')[0]! } });
  const data = (await me.json()) as { person: { name: string; email: string } };
  assert.equal(me.status, 200);
  assert.equal(data.person.email, 'lin@alex.dev');
  assert.equal(data.person.name, '林知远');
});

test('管理员可以读取通讯录并生成/应用同步计划', async () => {
  const { token } = await login(base, 'lin@alex.dev');
  const get = await fetch(`${base}/api/integrations/wecom`, { headers: { authorization: `Bearer ${token}` } });
  const config = (await get.json()) as { mode: string; configured: boolean };
  assert.equal(config.mode, 'mock');
  assert.equal(config.configured, true);

  const dry = await fetch(`${base}/api/integrations/wecom/sync`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  const plan = (await dry.json()) as { dryRun: boolean; plan: { departments: unknown[]; users: unknown[] } };
  assert.equal(dry.status, 200);
  assert.equal(plan.dryRun, true);
  assert.ok(plan.plan.departments.length >= 2);
  assert.ok(plan.plan.users.length >= 4);

  const applied = await fetch(`${base}/api/integrations/wecom/sync`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ apply: true }),
  });
  const result = (await applied.json()) as { dryRun: boolean; applied: { departments: number; users: number } };
  assert.equal(applied.status, 200);
  assert.equal(result.dryRun, false);
  assert.ok(result.applied);
});
