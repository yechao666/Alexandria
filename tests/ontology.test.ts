import test from 'node:test';
import assert from 'node:assert/strict';
import { closeServer, createTestContext, login, startTestServer } from './helpers.ts';

const ctx = createTestContext();
const { server, base } = await startTestServer(ctx.app);

test.after(async () => {
  await closeServer(server);
  ctx.cleanup();
});

async function j<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<{ status: number; data: T }> {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('authorization', `Bearer ${init.token}`);
  if (init.body && typeof init.body === 'string') headers.set('content-type', 'application/json');
  const response = await fetch(`${base}${path}`, { ...init, headers });
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, data: data as T };
}

test('默认本体包含类型与属性定义', async () => {
  const { token } = await login(base, 'lin@alex.dev');
  const library = await j<{ properties: { key: string; class_key: string }[] }>('/api/libraries/lib_product', { token });
  assert.equal(library.status, 200);
  assert.ok(library.data.properties.some((property) => property.class_key === 'concept' && property.key === 'domain'));
  assert.ok(library.data.properties.some((property) => property.class_key === 'decision' && property.key === 'decidedAt'));
});

test('预置知识页带本体属性值', async () => {
  const { token } = await login(base, 'lin@alex.dev');
  const page = await j<{ properties: { key: string; value: unknown }[] }>('/api/pages/concepts%2Fknowledge-compilation', { token });
  assert.equal(page.status, 200);
  const domain = page.data.properties.find((property) => property.key === 'domain');
  assert.equal(domain?.value, '知识管理');
});

test('管理员可以定义属性，并在创建页面时写入值', async () => {
  const { token } = await login(base, 'lin@alex.dev');
  const created = await j<{ property: { id: string; key: string } }>('/api/libraries/lib_product/properties', {
    method: 'POST',
    token,
    body: JSON.stringify({
      classKey: 'concept',
      key: 'maturity',
      name: '成熟度',
      type: 'enum',
      options: ['草稿', '稳定', '成熟'],
    }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.property.key, 'maturity');

  const page = await j<{ page: { id: string } }>('/api/libraries/lib_product/pages', {
    method: 'POST',
    token,
    body: JSON.stringify({
      title: '属性测试页',
      classKey: 'concept',
      status: 'draft',
      body: '## 定义\n属性测试。',
      properties: { maturity: '稳定', domain: '测试领域' },
    }),
  });
  assert.equal(page.status, 201);
  const detail = await j<{ properties: { key: string; value: unknown }[] }>(`/api/pages/${page.data.page.id}`, { token });
  const values = Object.fromEntries(detail.data.properties.map((property) => [property.key, property.value]));
  assert.equal(values.maturity, '稳定');
  assert.equal(values.domain, '测试领域');

  const invalid = await j('/api/libraries/lib_product/pages', {
    method: 'POST',
    token,
    body: JSON.stringify({
      title: '非法属性页',
      classKey: 'concept',
      properties: { not_defined: 'x' },
    }),
  });
  assert.equal(invalid.status, 400);
});

test('只读成员不能定义本体属性', async () => {
  const { token } = await login(base, 'guest@alex.dev');
  const created = await j('/api/libraries/lib_product/properties', {
    method: 'POST',
    token,
    body: JSON.stringify({ classKey: 'concept', key: 'guest_prop', name: '越权', type: 'string' }),
  });
  assert.equal(created.status, 403);
});
