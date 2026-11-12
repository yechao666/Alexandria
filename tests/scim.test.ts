import test from 'node:test';
import assert from 'node:assert/strict';
import { closeServer, createTestContext, startTestServer } from './helpers.ts';

const token = 'scim-test-token';
const previous = process.env.ALEXANDRIA_SCIM_TOKEN;
process.env.ALEXANDRIA_SCIM_TOKEN = token;
const ctx = createTestContext();
const { server, base } = await startTestServer(ctx.app);

test.after(async () => {
  await closeServer(server);
  ctx.cleanup();
  if (previous === undefined) delete process.env.ALEXANDRIA_SCIM_TOKEN;
  else process.env.ALEXANDRIA_SCIM_TOKEN = previous;
});

async function scim<T>(path: string, init: RequestInit = {}): Promise<{ status: number; data: T }> {
  const response = await fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/scim+json', ...(init.headers ?? {}) } });
  const text = await response.text();
  return { status: response.status, data: (text ? JSON.parse(text) : null) as T };
}

test('SCIM 2.0 用户/组供给与停用', async () => {
  const unauthorized = await fetch(`${base}/scim/v2/Users`);
  assert.equal(unauthorized.status, 401);
  const list = await scim<{ totalResults: number }>('/scim/v2/Users');
  assert.equal(list.status, 200);
  assert.ok(list.data.totalResults >= 7);
  const created = await scim<{ id: string; userName: string; active: boolean }>('/scim/v2/Users', {
    method: 'POST',
    body: JSON.stringify({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'scim-user@alex.dev', name: { formatted: 'SCIM 测试成员' }, active: true }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.userName, 'scim-user@alex.dev');
  const id = created.data.id;
  const patched = await scim<{ active: boolean }>(`/scim/v2/Users/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'replace', path: 'active', value: false }] }),
  });
  assert.equal(patched.data.active, false);
  const group = await scim<{ id: string; displayName: string }>('/scim/v2/Groups', {
    method: 'POST',
    body: JSON.stringify({ displayName: 'SCIM 测试组', members: [{ value: id }] }),
  });
  assert.equal(group.status, 201);
  const groups = await scim<{ Resources: { id: string }[] }>('/scim/v2/Groups');
  assert.ok(groups.data.Resources.some((item) => item.id === group.data.id));
  const removed = await scim(`/scim/v2/Users/${id}`, { method: 'DELETE' });
  assert.equal(removed.status, 204);
  const after = await scim<{ active: boolean }>(`/scim/v2/Users/${id}`);
  assert.equal(after.data.active, false);
});
