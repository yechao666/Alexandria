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

test('知识页可以追加评论、列出评论并标记解决', async () => {
  const { token } = await login(base, 'lin@alex.dev');
  const page = ctx.db.prepare("SELECT id, owner_person_id FROM pages WHERE slug = 'howtos/requirement-review'").get() as unknown as {
    id: string;
    owner_person_id: string | null;
  };
  const created = await j<{ comment: { id: string; body: string; status: string } }>(`/api/pages/${page.id}/comments`, {
    method: 'POST',
    token,
    body: JSON.stringify({ body: '验收标准需要补充失败路径。' }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.comment.status, 'open');
  const list = await j<{ comments: { id: string; body: string }[] }>(`/api/pages/${page.id}/comments`, { token });
  assert.ok(list.data.comments.some((comment) => comment.body.includes('失败路径')));
  const resolved = await j<{ comment: { status: string } }>(`/api/comments/${created.data.comment.id}`, {
    method: 'PATCH',
    token,
    body: JSON.stringify({ status: 'resolved' }),
  });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.data.comment.status, 'resolved');
});

test('评论会通知页面负责人', async () => {
  const admin = await login(base, 'lin@alex.dev');
  const page = ctx.db.prepare("SELECT id, owner_person_id FROM pages WHERE slug = 'howtos/user-interview'").get() as unknown as {
    id: string;
    owner_person_id: string;
  };
  const created = await j(`/api/pages/${page.id}/comments`, {
    method: 'POST',
    token: admin.token,
    body: JSON.stringify({ body: '补充一段访谈提纲。' }),
  });
  assert.equal(created.status, 201);
  const su = await login(base, 'su@alex.dev');
  const notifications = await j<{ unread: number; notifications: { title: string; kind: string; link: string }[] }>(
    '/api/notifications?unread=1',
    { token: su.token },
  );
  assert.ok(notifications.data.unread >= 1);
  assert.ok(notifications.data.notifications.some((item) => item.kind === 'comment' && item.title.includes('用户访谈')));
});

test('退回审核会通知页面负责人，并可从通知页标记已读', async () => {
  const admin = await login(base, 'lin@alex.dev');
  const page = ctx.db.prepare("SELECT id FROM pages WHERE slug = 'howtos/requirement-review'").get() as unknown as { id: string };
  const review = await j(`/api/pages/${page.id}/review`, {
    method: 'POST',
    token: admin.token,
    body: JSON.stringify({ action: 'request_changes', note: '补充异常流程' }),
  });
  assert.equal(review.status, 200);
  const su = await login(base, 'su@alex.dev');
  const inbox = await j<{ unread: number; notifications: { id: string; kind: string; title: string }[] }>('/api/notifications?unread=1', {
    token: su.token,
  });
  assert.ok(inbox.data.notifications.some((item) => item.kind === 'review' && item.title.includes('要求修改')));
  const readAll = await j<{ unread: number }>('/api/notifications/read-all', { method: 'POST', token: su.token });
  assert.equal(readAll.status, 200);
  assert.equal(readAll.data.unread, 0);
});
