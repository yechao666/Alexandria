import test from 'node:test';
import assert from 'node:assert/strict';
import { closeServer, createTestContext, login, startTestServer } from './helpers.ts';

const ctx = createTestContext();
const { server, base } = await startTestServer(ctx.app);
const admin = await login(base, 'lin@alex.dev');
const guest = await login(base, 'guest@alex.dev');

test.after(async () => {
  await closeServer(server);
  ctx.cleanup();
});

async function j<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  return (await response.json()) as T;
}

test('处理任务记录结构化步骤并进入任务中心', async () => {
  const response = await fetch(`${base}/api/libraries/lib_eng/sources`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${admin.token}`,
      'content-type': 'application/octet-stream',
      'x-filename': encodeURIComponent('task-events.md'),
      'x-title': encodeURIComponent('任务步骤验收资料'),
    },
    body: Buffer.from('# 任务步骤\n\n## 定义\n任务步骤验收用于检查解析、索引与编译时间线。\n'),
  });
  assert.equal(response.status, 202);
  const ingested = (await response.json()) as { jobId: string };
  let job: Record<string, unknown> | null = null;
  for (let i = 0; i < 100; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const data = await j<{ job: Record<string, unknown> }>(`/api/jobs/${ingested.jobId}`, admin.token);
    job = data.job;
    if (job && (job.status === 'succeeded' || job.status === 'failed')) break;
  }
  assert.equal(job?.status, 'succeeded');
  const events = job?.events as { step: string; status: string; duration_ms?: number }[];
  assert.ok(events.some((event) => event.step === 'extract' && event.status === 'succeeded'));
  assert.ok(events.some((event) => event.step === 'index' && event.status === 'succeeded'));
  assert.ok(events.some((event) => event.step === 'compile' && event.status === 'succeeded'));
  assert.ok(events.some((event) => event.step === 'done'));
  const tasks = await j<{ tasks: unknown[] }>('/api/tasks?limit=10', admin.token);
  assert.ok(tasks.tasks.length > 0);
});

test('页面级访问策略可限制并定向共享给指定成员', async () => {
  const pageRef = encodeURIComponent('concepts/knowledge-compilation');
  const before = await fetch(`${base}/api/pages/${pageRef}`, { headers: { authorization: `Bearer ${guest.token}` } });
  assert.equal(before.status, 200);
  const restricted = await j<{ ok: boolean }>(`/api/pages/${pageRef}/access`, admin.token, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ visibility: 'restricted', grants: [] }),
  });
  assert.equal(restricted.ok, true);
  const hidden = await fetch(`${base}/api/pages/${pageRef}`, { headers: { authorization: `Bearer ${guest.token}` } });
  assert.equal(hidden.status, 404);
  const shared = await j<{ ok: boolean }>(`/api/pages/${pageRef}/access`, admin.token, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ visibility: 'restricted', grants: [{ subjectType: 'person', subjectId: 'usr_guest', role: 'viewer' }] }),
  });
  assert.equal(shared.ok, true);
  const visible = await fetch(`${base}/api/pages/${pageRef}`, { headers: { authorization: `Bearer ${guest.token}` } });
  assert.equal(visible.status, 200);
  const denied = await fetch(`${base}/api/pages/${pageRef}/access`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${guest.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ visibility: 'inherit', grants: [] }),
  });
  assert.equal(denied.status, 403);
  await j(`/api/pages/${pageRef}/access`, admin.token, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ visibility: 'inherit', grants: [] }),
  });
});

test('检索分面只统计当前成员可见的知识', async () => {
  const adminFacets = await j<{ libraries: { id: string }[]; tags: unknown[] }>('/api/search/facets', admin.token);
  assert.ok(adminFacets.libraries.length >= 3);
  const guestFacets = await j<{ libraries: { id: string }[] }>('/api/search/facets', guest.token);
  assert.deepEqual(guestFacets.libraries.map((library) => library.id), ['lib_product']);
});
