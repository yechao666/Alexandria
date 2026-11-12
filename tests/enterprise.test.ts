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

test('文献级 ACL 可限制并定向共享', async () => {
  const sources = await j<{ sources: { id: string }[] }>('/api/libraries/lib_product/sources', admin.token);
  const sourceId = sources.sources[0].id;
  const before = await fetch(`${base}/api/sources/${sourceId}`, { headers: { authorization: `Bearer ${guest.token}` } });
  assert.equal(before.status, 200);
  await j(`/api/sources/${sourceId}/access`, admin.token, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ visibility: 'restricted', grants: [] }),
  });
  const hidden = await fetch(`${base}/api/sources/${sourceId}`, { headers: { authorization: `Bearer ${guest.token}` } });
  assert.equal(hidden.status, 404);
  await j(`/api/sources/${sourceId}/access`, admin.token, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ visibility: 'restricted', grants: [{ subjectType: 'person', subjectId: 'usr_guest', role: 'viewer' }] }),
  });
  const visible = await fetch(`${base}/api/sources/${sourceId}`, { headers: { authorization: `Bearer ${guest.token}` } });
  assert.equal(visible.status, 200);
  await j(`/api/sources/${sourceId}/access`, admin.token, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ visibility: 'inherit', grants: [] }),
  });
});

test('重复页面可以合并并保留归档指针', async () => {
  const create = async (title: string) =>
    j<{ page: { id: string } }>('/api/libraries/lib_eng/pages', admin.token, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, classKey: 'concept', body: `## 定义\n${title}`, status: 'draft' }),
    });
  const source = await create('合并测试重复页 A');
  const target = await create('合并测试重复页 B');
  const merged = await j<{ ok: boolean; mergedInto: string }>(`/api/pages/${source.page.id}/merge`, admin.token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetId: target.page.id }),
  });
  assert.equal(merged.ok, true);
  assert.equal(merged.mergedInto, target.page.id);
  const archived = ctx.db.prepare('SELECT status, superseded_by FROM pages WHERE id = ?').get(source.page.id) as unknown as { status: string; superseded_by: string };
  assert.equal(archived.status, 'archived');
  assert.equal(archived.superseded_by, target.page.id);
  const targetRow = ctx.db.prepare('SELECT aliases FROM pages WHERE id = ?').get(target.page.id) as unknown as { aliases: string };
  assert.match(targetRow.aliases, /合并测试重复页 A/);
});

test('层级图谱接口返回权限过滤后的 broader-than 树', async () => {
  const tree = await j<{ nodes: { id: string; level: number }[]; edges: unknown[] }>('/api/graph/hierarchy', admin.token);
  assert.ok(tree.nodes.length > 0);
  const guestTree = await j<{ nodes: { libraryId?: string }[] }>('/api/graph/hierarchy', guest.token);
  assert.ok(guestTree.nodes.every((node) => node.libraryId === 'lib_product' || node.libraryId === undefined));
});

test('页面可以设置上位概念并出现在层级图', async () => {
  const create = async (title: string) =>
    j<{ page: { id: string } }>('/api/libraries/lib_eng/pages', admin.token, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, classKey: 'concept', body: `## 定义\n${title}`, status: 'draft' }),
    });
  const parent = await create('层级测试上位');
  const child = await create('层级测试下位');
  const response = await j<{ ok: boolean }>(`/api/pages/${child.page.id}/parent`, admin.token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ parentId: parent.page.id }),
  });
  assert.equal(response.ok, true);
  const tree = await j<{ nodes: { id: string; level: number }[] }>('/api/graph/hierarchy?library=lib_eng', admin.token);
  assert.equal(tree.nodes.find((node) => node.id === child.page.id)?.level, 1);
  assert.equal(tree.nodes.find((node) => node.id === parent.page.id)?.level, 0);
});

test('系统会给出重复页合并建议', async () => {
  const create = async (title: string, aliases: string[] = []) =>
    j<{ page: { id: string } }>('/api/libraries/lib_eng/pages', admin.token, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, classKey: 'concept', body: `## 定义\n${title}`, aliases, status: 'draft' }),
    });
  await create('知识编译引擎同名');
  await create('知识编译引擎同名', ['Knowledge Compilation Engine']);
  const result = await j<{ suggestions: { score: number; reasons: string[] }[] }>('/api/libraries/lib_eng/merge-suggestions', admin.token);
  assert.ok(result.suggestions.some((suggestion) => suggestion.score >= 0.55));
});

test('检索历史、保存检索与自动补全可用', async () => {
  await fetch(`${base}/api/search?q=${encodeURIComponent('知识编译')}`, { headers: { authorization: `Bearer ${admin.token}` } });
  const history = await j<{ history: { query: string }[] }>('/api/search/history', admin.token);
  assert.ok(history.history.some((item) => item.query.includes('知识编译')));
  const created = await j<{ saved: { id: string } }>('/api/search/saved', admin.token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '知识编译检索', params: { q: '知识编译' } }),
  });
  assert.ok(created.saved.id);
  const saved = await j<{ saved: { name: string }[] }>('/api/search/saved', admin.token);
  assert.ok(saved.saved.some((item) => item.name === '知识编译检索'));
  const suggest = await j<{ suggestions: { title: string }[] }>('/api/search/suggest?q=%E7%9F%A5%E8%AF%86', admin.token);
  assert.ok(suggest.suggestions.length > 0);
  await j(`/api/search/saved/${created.saved.id}`, admin.token, { method: 'DELETE' });
});

test('安全审计与权限变更通知可用', async () => {
  const security = await j<{ events: { kind: string }[] }>('/api/admin/security?limit=20', admin.token);
  assert.ok(security.events.some((event) => event.kind === 'login.success' || event.kind === 'library.grant'));
  const denied = await fetch(`${base}/api/admin/security`, { headers: { authorization: `Bearer ${guest.token}` } });
  assert.equal(denied.status, 403);
  const pageRef = encodeURIComponent('concepts/knowledge-compilation');
  await j(`/api/pages/${pageRef}/access`, admin.token, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ visibility: 'restricted', grants: [{ subjectType: 'person', subjectId: 'usr_guest', role: 'viewer' }] }),
  });
  const notes = await j<{ notifications: { kind: string; title: string }[] }>('/api/notifications', guest.token);
  assert.ok(notes.notifications.some((note) => note.kind === 'permission' && note.title.includes('知识编译')));
  await j(`/api/pages/${pageRef}/access`, admin.token, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ visibility: 'inherit', grants: [] }),
  });
});

test('管理员可以查看页面有效访问名单与原因', async () => {
  const audit = await j<{ people: { email: string; role: string; reason: string }[] }>('/api/pages/concepts%2Fknowledge-compilation/access-audit', admin.token);
  assert.ok(audit.people.some((person) => person.email === 'lin@alex.dev'));
  const denied = await fetch(`${base}/api/pages/concepts%2Fknowledge-compilation/access-audit`, { headers: { authorization: `Bearer ${guest.token}` } });
  assert.equal(denied.status, 403);
});

test('合并建议可以进入审批流并批准', async () => {
  const create = async (title: string) =>
    j<{ page: { id: string } }>('/api/libraries/lib_eng/pages', admin.token, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, classKey: 'concept', body: `## 定义\n${title}`, status: 'draft' }),
    });
  const source = await create('审批合并测试同名');
  const target = await create('审批合并测试同名');
  const scan = await j<{ created: number }>('/api/libraries/lib_eng/merge-proposals/scan', admin.token, { method: 'POST' });
  assert.ok(scan.created >= 1);
  const proposals = await j<{ proposals: { id: string; source_page_id: string; target_page_id: string; status: string }[] }>('/api/libraries/lib_eng/merge-proposals', admin.token);
  const proposal = proposals.proposals.find((item) => item.status === 'pending' && ((item.source_page_id === source.page.id && item.target_page_id === target.page.id) || (item.source_page_id === target.page.id && item.target_page_id === source.page.id)));
  assert.ok(proposal, '应生成待审批建议');
  const approved = await j<{ ok: boolean }>(`/api/merge-proposals/${proposal.id}/approve`, admin.token, { method: 'POST' });
  assert.equal(approved.ok, true);
  const archived = ctx.db.prepare('SELECT status FROM pages WHERE id = ?').get(proposal.source_page_id) as unknown as { status: string };
  assert.equal(archived.status, 'archived');
});
