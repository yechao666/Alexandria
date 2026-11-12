import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeServer, createTestContext, login, startTestServer } from './helpers.ts';

const root = mkdtempSync(join(tmpdir(), 'alex-dsh-'));
const fakeHome = join(root, 'source-home');
mkdirSync(join(fakeHome, 'profiles', 'headless'), { recursive: true });
writeFileSync(join(fakeHome, 'profiles', 'headless', 'package.json'), JSON.stringify({ name: 'fake-headless', private: true, dsh: { profile: { bundles: [] } } }));

const fakeDsh = join(root, 'fake-dsh.mjs');
writeFileSync(
  fakeDsh,
  `#!/usr/bin/env node
let input = '';
process.stdin.on('data', (chunk) => input += chunk.toString('utf8'));
process.stdin.on('end', () => {
  const ids = [...input.matchAll(/(?:页面 ID：|id=)(pg_[A-Za-z0-9]+)/g)].map((m) => m[1]);
  let payload;
  if (input.includes('知识编译器')) {
    payload = {
      sourceSummary: 'DSH 生成的摘要',
      tldr: 'DSH 生成的一句话结论',
      claims: [{ text: 'DSH 编译测试主张', subject: 'DSH 编译测试概念', predicate: '定义', object: '由本机 DSH 编译', confidence: 0.8 }],
      entities: [{ name: 'DSH 实体测试', type: '产品', description: '由 DSH 抽取的实体。', aliases: ['DSH Entity'] }],
      facts: [{ subject: 'DSH 实体测试', predicate: '属于', object: 'DSH 编译测试概念', confidence: 0.8 }],
      concepts: [{
        title: 'DSH 编译测试概念',
        classKey: 'concept',
        summary: '由本机 DSH 生成的概念',
        definition: 'DSH 编译测试概念是指由本机 DSH 在入库时生成的概念页。',
        points: ['概念、主张与关联由 DSH 生成。'],
        tags: ['DSH', '编译'],
        aliases: ['DSH Compile Test'],
        readWhen: ['验证 DSH 编译时'],
        confidence: 0.66,
        claims: [{ text: 'DSH 在入库时生成概念页。', subject: 'DSH 编译测试概念', predicate: '定义', object: '入库时生成的页面', confidence: 0.7 }],
        related: []
      }]
    };
  } else if (input.includes('检索排序器')) {
    payload = { selected: ids[0] ? [{ id: ids[0], reason: '重排命中' }] : [] };
  } else if (input.includes('检索与知识合成器')) {
    payload = { selected: ids[0] ? [{ pageId: ids[0], reason: '直接命中' }] : [], answer: 'DSH 合成的答案：知识编译在入库时完成。', gaps: [] };
  } else {
    payload = { answer: 'OK' };
  }
  console.log(JSON.stringify({ type: 'final', text: JSON.stringify(payload) }));
});
`,
);
chmodSync(fakeDsh, 0o755);
const previousKey = process.env.DEEPSEEK_API_KEY;
process.env.DEEPSEEK_API_KEY = 'test-key';

const ctx = createTestContext();
ctx.env.dsh = { enabled: true, bin: fakeDsh, profile: 'headless', timeoutMs: 10_000, sourceHome: fakeHome };
const { server, base } = await startTestServer(ctx.app);
const { token } = await login(base, 'lin@alex.dev');

test.after(async () => {
  await closeServer(server);
  ctx.cleanup();
  if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = previousKey;
});

async function j<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  return (await response.json()) as T;
}

function sourcePageIdForTest(): string {
  return (ctx.db.prepare("SELECT id FROM pages WHERE title = 'DSH 编译测试资料'").get() as unknown as { id: string }).id;
}

test('DSH 编译：入库任务使用本机 DSH 生成概念页', async () => {
  const response = await fetch(`${base}/api/libraries/lib_eng/sources`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/octet-stream',
      'x-filename': encodeURIComponent('dsh-source.md'),
      'x-title': encodeURIComponent('DSH 编译测试资料'),
    },
    body: Buffer.from('# DSH 编译测试\n\n## 背景\n这是一个用于验证 DSH 编译的资料。DSH 编译测试概念用于说明本机编译流程。\n'),
  });
  assert.equal(response.status, 202);
  const ingested = (await response.json()) as { jobId: string };
  let job: Record<string, unknown> | null = null;
  for (let i = 0; i < 100; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const data = await j<{ job: Record<string, unknown> }>(`/api/jobs/${ingested.jobId}`);
    job = data.job;
    if (job && (job.status === 'succeeded' || job.status === 'failed')) break;
  }
  assert.equal(job?.status, 'succeeded');
  assert.equal(job?.compiler, 'dsh');
  const page = ctx.db.prepare("SELECT * FROM pages WHERE title = 'DSH 编译测试概念'").get() as unknown as { id: string; metadata: string } | undefined;
  assert.ok(page, 'DSH 应创建概念页');
  assert.match(page.metadata, /"compiledBy":"dsh"/);
  const source = ctx.db.prepare("SELECT body FROM pages WHERE title = 'DSH 编译测试资料'").get() as unknown as { body: string };
  assert.match(source.body, /本机 DSH/);
  const entity = ctx.db.prepare("SELECT * FROM pages WHERE title = 'DSH 实体测试'").get() as unknown as { id: string } | undefined;
  assert.ok(entity, 'DSH 应创建实体页');
  const fact = ctx.db.prepare("SELECT * FROM claims WHERE page_id = ? AND predicate = '属于'").get(sourcePageIdForTest()) as unknown as { text: string } | undefined;
  assert.ok(fact, 'DSH 应抽取事实');
});

test('DSH 语义重排用于 /api/search', async () => {
  const result = await j<{ strategy: string; hits: { signals: Record<string, number> }[] }>('/api/search?q=DSH%20%E7%BC%96%E8%AF%91');
  assert.match(result.strategy, /DSH/);
  assert.ok(result.hits.some((hit) => hit.signals.dsh === 1));
});

test('DSH 检索与合成：/api/query 返回 dsh 模式与引用', async () => {
  const response = await j<{ mode: string; answer: string; citations: unknown[] }>('/api/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ q: '知识编译' }),
  });
  assert.equal(response.mode, 'dsh');
  assert.match(response.answer, /DSH 合成的答案/);
  assert.ok(response.citations.length > 0);
});
