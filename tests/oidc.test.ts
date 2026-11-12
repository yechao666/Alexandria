import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { closeServer, createTestContext, startTestServer } from './helpers.ts';

const ctx = createTestContext();
const { server, base } = await startTestServer(ctx.app);
const oidc = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  res.setHeader('content-type', 'application/json');
  if (url.pathname === '/.well-known/openid-configuration') {
    res.end(JSON.stringify({
      issuer: fakeBase,
      authorization_endpoint: `${fakeBase}/authorize`,
      token_endpoint: `${fakeBase}/token`,
      userinfo_endpoint: `${fakeBase}/userinfo`,
      jwks_uri: `${fakeBase}/jwks`,
    }));
    return;
  }
  if (url.pathname === '/token') {
    res.end(JSON.stringify({ access_token: 'fake-access', token_type: 'Bearer' }));
    return;
  }
  if (url.pathname === '/userinfo') {
    res.end(JSON.stringify({ sub: 'oidc-lin', email: 'lin@alex.dev', name: '林知远' }));
    return;
  }
  res.statusCode = 404;
  res.end('{}');
});
await new Promise<void>((resolve) => oidc.listen(0, '127.0.0.1', () => resolve()));
const address = oidc.address();
const fakeBase = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
ctx.env.oidc = {
  issuer: fakeBase,
  clientId: 'alex-client',
  clientSecret: 'alex-secret',
  redirectUri: `${base}/api/auth/oidc/callback`,
  scopes: 'openid email profile',
  label: '测试企业 SSO',
};

test.after(async () => {
  await new Promise<void>((resolve) => oidc.close(() => resolve()));
  await closeServer(server);
  ctx.cleanup();
});

test('OIDC 授权码登录可以映射本地账号并建立会话', async () => {
  const providers = await (await fetch(`${base}/api/auth/providers`)).json() as { oidc: { enabled: boolean } };
  assert.equal(providers.oidc.enabled, true);
  const start = await fetch(`${base}/api/auth/oidc/start?returnTo=%2F%23%2F`, { redirect: 'manual' });
  assert.equal(start.status, 302);
  const location = new URL(start.headers.get('location')!);
  assert.equal(location.origin + location.pathname, `${fakeBase}/authorize`);
  const state = location.searchParams.get('state');
  assert.ok(state);
  const callback = await fetch(`${base}/api/auth/oidc/callback?code=fake-code&state=${encodeURIComponent(state)}`, { redirect: 'manual' });
  assert.equal(callback.status, 302);
  assert.match(callback.headers.get('location') ?? '', /#\/$/);
  const cookie = String(callback.headers.get('set-cookie') ?? '').split(';')[0];
  assert.match(cookie, /alex_sess_cookie=/);
  const me = await fetch(`${base}/api/me`, { headers: { cookie } });
  const meData = await me.json() as { person: { email: string } };
  assert.equal(me.status, 200);
  assert.equal(meData.person.email, 'lin@alex.dev');
});
