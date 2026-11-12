import test from 'node:test';
import assert from 'node:assert/strict';
import { closeServer, createTestContext, login, makeMarkdown, startTestServer } from './helpers.ts';

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

test('登录后可以读取 bootstrap 与可见知识库', async () => {
  const { token } = await login(base, 'lin@alex.dev');
  const me = await j<{ person: { name: string } }>('/api/me', { token });
  assert.equal(me.status, 200);
  assert.equal(me.data.person.name, '林知远');
  const bootstrap = await j<{ libraries: { id: string }[]; stats: { pages: number } }>('/api/bootstrap', { token });
  assert.equal(bootstrap.status, 200);
  assert.ok(bootstrap.data.libraries.length >= 4);
  assert.ok(bootstrap.data.stats.pages > 0);
});

test('私有库对无权限成员返回 404，搜索也不会泄漏', async () => {
  const { token } = await login(base, 'guest@alex.dev');
  const privateLib = await j('/api/libraries/lib_strategy', { token });
  assert.equal(privateLib.status, 404);
  const search = await j<{ hits: { libraryId: string }[] }>('/api/search?q=%E5%AE%9A%E4%BB%B7', { token });
  assert.equal(search.status, 200);
  assert.ok(!search.data.hits.some((hit) => hit.libraryId === 'lib_strategy'));
});

test('只读成员不能上传资料', async () => {
  const { token } = await login(base, 'guest@alex.dev');
  const upload = await fetch(`${base}/api/libraries/lib_product/sources`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-filename': encodeURIComponent('blocked.md'), 'content-type': 'application/octet-stream' },
    body: Buffer.from('# blocked'),
  });
  assert.equal(upload.status, 403);
});

test('管理员上传 Markdown 后任务成功并立即可检索', async () => {
  const { token } = await login(base, 'lin@alex.dev');
  const response = await fetch(`${base}/api/libraries/lib_product/sources`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'x-filename': encodeURIComponent('api-upload.md'),
      'x-title': encodeURIComponent('API 上传验证'),
      'content-type': 'application/octet-stream',
    },
    body: Buffer.from(makeMarkdown().replace(/知识编译/g, '增量编译')),
  });
  const data = (await response.json()) as { source: { id: string; status: string }; jobId: string };
  assert.equal(response.status, 202);
  assert.equal(data.source.status, 'queued');

  let job: Record<string, unknown> | null = null;
  for (let i = 0; i < 80; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const result = await j<{ job: Record<string, unknown> }>(`/api/jobs/${data.jobId}`, { token });
    job = result.data.job;
    if (job && (job.status === 'succeeded' || job.status === 'failed')) break;
  }
  assert.equal(job?.status, 'succeeded', JSON.stringify(job));
  assert.ok(Number(job?.pages_created) > 0);

  const search = await j<{ hits: { title: string }[] }>('/api/search?q=%E5%A2%9E%E9%87%8F%E7%BC%96%E8%AF%91', { token });
  assert.ok(search.data.hits.some((hit) => hit.title.includes('增量编译') || hit.title.includes('API 上传验证')));
});

test('只读 API Key 能检索但不能写入', async () => {
  const { token } = await login(base, 'lin@alex.dev');
  const key = await j<{ token: string }>('/api/api-keys', { method: 'POST', token, body: JSON.stringify({ name: 'read-test', scope: 'read' }) });
  assert.equal(key.status, 201);
  const search = await j<{ hits: unknown[] }>('/api/agent/search', {
    method: 'POST',
    token: key.data.token,
    body: JSON.stringify({ query: '知识编译', limit: 3 }),
  });
  assert.equal(search.status, 200);
  const write = await j('/api/agent/page', {
    method: 'POST',
    token: key.data.token,
    body: JSON.stringify({ libraryId: 'lib_product', title: '越权测试', classKey: 'concept', body: '# 不应写入' }),
  });
  assert.equal(write.status, 403);
});

test('读写 API Key 可以创建知识页并读取上下文', async () => {
  const { token } = await login(base, 'lin@alex.dev');
  const key = await j<{ token: string }>('/api/api-keys', { method: 'POST', token, body: JSON.stringify({ name: 'write-test', scope: 'write' }) });
  const created = await j<{ page: { id: string; title: string } }>('/api/agent/page', {
    method: 'POST',
    token: key.data.token,
    body: JSON.stringify({
      libraryId: 'lib_product',
      title: '智能体写入测试',
      classKey: 'concept',
      body: '## 定义\n这是由 DSH 智能体通过 API 写入的概念页。\n\n## 关联\n[[concepts/knowledge-compilation]]',
      tags: ['测试', '智能体'],
      confidence: 0.6,
    }),
  });
  assert.equal(created.status, 201);
  const read = await j<{ page: { title: string }; context: string }>('/api/agent/read', {
    method: 'POST',
    token: key.data.token,
    body: JSON.stringify({ pageId: created.data.page.id }),
  });
  assert.equal(read.status, 200);
  assert.match(read.data.context, /智能体/);
});

test('未显式传 limit 时使用默认分页而非 1 条', async () => {
  const { token } = await login(base, 'lin@alex.dev');
  const search = await j<{ hits: unknown[] }>('/api/search?q=%E7%9F%A5%E8%AF%86', { token });
  assert.ok(search.data.hits.length > 1, '默认 limit 应生效');
  const sources = await j<{ sources: unknown[] }>('/api/libraries/lib_eng/sources', { token });
  assert.ok(sources.data.sources.length > 1, '文献列表默认 limit 应生效');
});

test('读写 API Key 可以通过 Agent API 入库文本并编译', async () => {
  const { token } = await login(base, 'lin@alex.dev');
  const key = await j<{ token: string }>('/api/api-keys', { method: 'POST', token, body: JSON.stringify({ name: 'ingest-test', scope: 'write' }) });
  const ingested = await j<{ jobId: string; source: { id: string } }>('/api/agent/ingest', {
    method: 'POST',
    token: key.data.token,
    body: JSON.stringify({
      libraryId: 'lib_eng',
      filename: 'agent-ingest.md',
      title: '智能体入库验证',
      text: '# 智能体入库\n\n## 概念\n智能体入库验证是指通过 Agent API 提交资料并由流水线编译。\n\n## 要点\n- 使用只读密钥应被拒绝。\n- 编译完成后可检索。',
    }),
  });
  assert.equal(ingested.status, 202);
  let job: Record<string, unknown> | null = null;
  for (let i = 0; i < 80; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const result = await j<{ job: Record<string, unknown> }>(`/api/jobs/${ingested.data.jobId}`, { token });
    job = result.data.job;
    if (job && (job.status === 'succeeded' || job.status === 'failed')) break;
  }
  assert.equal(job?.status, 'succeeded', JSON.stringify(job));
  const search = await j<{ hits: { title: string }[] }>('/api/search?q=%E6%99%BA%E8%83%BD%E4%BD%93%E5%85%A5%E5%BA%93', { token });
  assert.ok(search.data.hits.some((hit) => hit.title.includes('智能体入库')));
});

test('知识页与整库可以导出为 LLM Wiki 风格 Markdown', async () => {
  const { token } = await login(base, 'lin@alex.dev');
  const page = await fetch(`${base}/api/pages/concepts%2Fknowledge-compilation/markdown`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(page.status, 200);
  const markdown = await page.text();
  assert.match(markdown, /^---\n/);
  assert.match(markdown, /type: "concept"/);
  assert.match(markdown, /## 定义/);
  const bundle = await fetch(`${base}/api/libraries/lib_product/export.md`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(bundle.status, 200);
  const text = await bundle.text();
  assert.match(text, /alexandria-markdown-bundle-v1/);
  assert.match(text, /知识编译/);
});

test('检索接口返回信号分解，查询接口返回引用', async () => {
  const { token } = await login(base, 'lin@alex.dev');
  const search = await j<{ hits: { signals: Record<string, number> }[] }>('/api/search?q=%E7%9F%A5%E8%AF%86%E7%BC%96%E8%AF%91', { token });
  assert.ok(search.data.hits.length > 0);
  assert.ok(search.data.hits[0]?.signals.title !== undefined);
  const query = await j<{ citations: unknown[]; answer: string; mode: string }>('/api/query', {
    method: 'POST',
    token,
    body: JSON.stringify({ q: '知识编译与 RAG 的区别是什么？' }),
  });
  assert.equal(query.status, 200);
  assert.ok(query.data.citations.length > 0);
  assert.ok(query.data.answer.length > 0);
});
