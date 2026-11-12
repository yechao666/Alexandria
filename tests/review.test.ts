import test from 'node:test';
import assert from 'node:assert/strict';
import { closeServer, createTestContext, login, startTestServer } from './helpers.ts';
import { detectConflicts } from '../server/src/knowledge/claims.ts';

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

test('校对队列包含自动编译的草稿，并统计待办', async () => {
  const { token } = await login(base, 'lin@alex.dev');
  const review = await j<{ items: { page: { title: string; reviewStatus: string } }[]; summary: { pending: number; conflicts: number } }>(
    '/api/review',
    { token },
  );
  assert.equal(review.status, 200);
  assert.ok(review.data.items.length >= 3);
  assert.equal(review.data.summary.pending, review.data.items.length);
  assert.ok(review.data.items.every((item) => item.page.reviewStatus === 'unreviewed'));
});

test('批准草稿会转为有效并记录审核人', async () => {
  const { token } = await login(base, 'lin@alex.dev');
  const review = await j<{ items: { page: { id: string; title: string } }[] }>('/api/review', { token });
  const target = review.data.items[0]!.page;
  const approved = await j<{ page: { status: string; reviewStatus: string; reviewerName: string } }>(
    `/api/pages/${target.id}/review`,
    { method: 'POST', token, body: JSON.stringify({ action: 'approve', note: '定义与来源已核对' }) },
  );
  assert.equal(approved.status, 200);
  assert.equal(approved.data.page.status, 'active');
  assert.equal(approved.data.page.reviewStatus, 'approved');
  assert.equal(approved.data.page.reviewerName, '林知远');
});

test('退回必须填写说明，并进入 changes_requested', async () => {
  const { token } = await login(base, 'lin@alex.dev');
  const review = await j<{ items: { page: { id: string } }[] }>('/api/review', { token });
  const target = review.data.items[0]!.page;
  const missing = await j(`/api/pages/${target.id}/review`, {
    method: 'POST',
    token,
    body: JSON.stringify({ action: 'request_changes' }),
  });
  assert.equal(missing.status, 400);
  const changed = await j<{ page: { status: string; reviewStatus: string; reviewNote: string } }>(
    `/api/pages/${target.id}/review`,
    { method: 'POST', token, body: JSON.stringify({ action: 'request_changes', note: '补充验收标准' }) },
  );
  assert.equal(changed.status, 200);
  assert.equal(changed.data.page.status, 'draft');
  assert.equal(changed.data.page.reviewStatus, 'changes_requested');
  assert.match(changed.data.page.reviewNote, /验收标准/);
});

test('只读成员不能审核', async () => {
  const { token } = await login(base, 'guest@alex.dev');
  const admin = await login(base, 'lin@alex.dev');
  const review = await j<{ items: { page: { id: string } }[] }>('/api/review', { token: admin.token });
  const target = review.data.items[0]!.page;
  const denied = await j(`/api/pages/${target.id}/review`, {
    method: 'POST',
    token,
    body: JSON.stringify({ action: 'approve' }),
  });
  assert.equal(denied.status, 403);
});

test('矛盾主张可保留一方并将另一方标记为 resolved', async () => {
  const { token } = await login(base, 'lin@alex.dev');
  const pageA = ctx.db.prepare("SELECT id FROM pages WHERE slug = 'concepts/knowledge-compilation'").get() as unknown as { id: string };
  const pageB = ctx.db.prepare("SELECT id FROM pages WHERE slug = 'concepts/atomic-page'").get() as unknown as { id: string };
  const now = new Date().toISOString();
  ctx.db
    .prepare(
      `INSERT INTO claims (id, page_id, text, subject, predicate, object, confidence, source_id, section, status, created_at)
       VALUES ('clm_review_a', ?, '测试主题是 A', '测试主题', '定义', 'A 说法', 0.6, NULL, '测试', 'active', ?)`,
    )
    .run(String(pageA.id), now);
  ctx.db
    .prepare(
      `INSERT INTO claims (id, page_id, text, subject, predicate, object, confidence, source_id, section, status, created_at)
       VALUES ('clm_review_b', ?, '测试主题是 B', '测试主题', '定义', 'B 说法', 0.6, NULL, '测试', 'active', ?)`,
    )
    .run(String(pageB.id), now);
  const conflicts = detectConflicts(ctx.db, String(pageA.id));
  assert.ok(conflicts.count > 0);
  const resolved = await j<{ claim: { status: string }; rivals: { id: string; status: string }[] }>(
    '/api/claims/clm_review_a/resolve',
    { method: 'POST', token, body: JSON.stringify({ resolution: 'keep', note: '采用 A' }) },
  );
  assert.equal(resolved.status, 200);
  assert.equal(resolved.data.claim.status, 'active');
  assert.ok(resolved.data.rivals.every((rival) => rival.status === 'resolved'));
  const rival = ctx.db.prepare("SELECT status FROM claims WHERE id = 'clm_review_b'").get() as unknown as { status: string };
  assert.equal(rival.status, 'resolved');
});
