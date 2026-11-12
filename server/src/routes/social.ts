import type { Router } from '../http/router.ts';
import { requireActor } from '../http/auth.ts';
import { requireLibrary } from '../domain/access.ts';
import { audit } from '../domain/audit.ts';
import { errors } from '../http/respond.ts';
import { newId, nowIso } from '../lib/ids.ts';
import { createNotification, notifyPerson, unreadNotificationCount } from '../domain/notifications.ts';
import { getPage } from '../knowledge/pages.ts';

function commentView(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    pageId: row.page_id,
    parentId: row.parent_id,
    body: row.body,
    status: row.status,
    authorId: row.author_id,
    authorName: row.author_name ?? '已注销成员',
    authorColor: row.author_color ?? 'slate',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    resolvedByName: row.resolved_by_name ?? null,
  };
}

function pageAccess(rc: Parameters<Parameters<Router['get']>[1]>[0], pageId: string) {
  const actor = requireActor(rc);
  const page = getPage(rc.app.db, pageId);
  if (!page) throw errors.notFound('知识页不存在');
  const { library, role } = requireLibrary(rc.app.db, actor, page.library_id);
  return { actor, page, library, role };
}

export function registerSocialRoutes(router: Router): void {
  router.get('/api/pages/:id/comments', (rc) => {
    const { page } = pageAccess(rc, rc.params.id!);
    const rows = rc.app.db
      .prepare(
        `SELECT c.*, p.name AS author_name, p.avatar_color AS author_color, r.name AS resolved_by_name
           FROM comments c
           LEFT JOIN persons p ON p.id = c.author_id
           LEFT JOIN persons r ON r.id = c.resolved_by
          WHERE c.page_id = ? ORDER BY c.created_at ASC`,
      )
      .all(page.id) as unknown as Record<string, unknown>[];
    rc.json({ comments: rows.map(commentView) });
  });

  router.post('/api/pages/:id/comments', async (rc) => {
    const { actor, page, library } = pageAccess(rc, rc.params.id!);
    const body = await rc.body<{ body?: string; parentId?: string }>();
    const text = String(body.body ?? '').trim();
    if (!text) throw errors.badRequest('评论内容不能为空');
    if (text.length > 4000) throw errors.badRequest('评论不能超过 4000 字');
    const parentId = body.parentId ? String(body.parentId) : null;
    if (parentId) {
      const parent = rc.app.db.prepare('SELECT 1 FROM comments WHERE id = ? AND page_id = ?').get(parentId, page.id);
      if (!parent) throw errors.badRequest('回复的评论不存在');
    }
    const id = newId('cmt');
    const now = nowIso();
    rc.app.db
      .prepare(
        'INSERT INTO comments (id, library_id, page_id, parent_id, author_id, body, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, library.id, page.id, parentId, actor.person.id, text, 'open', now, now);
    audit(rc.app.db, { actor, action: 'comment.create', targetType: 'page', targetId: page.id, libraryId: library.id, detail: { commentId: id } });

    const link = `/#/page/${encodeURIComponent(page.id)}`;
    const recipients = new Set<string>();
    if (page.owner_person_id) recipients.add(page.owner_person_id);
    if (page.created_by) recipients.add(page.created_by);
    if (parentId) {
      const parent = rc.app.db.prepare('SELECT author_id FROM comments WHERE id = ?').get(parentId) as unknown as
        | { author_id: string | null }
        | undefined;
      if (parent?.author_id) recipients.add(parent.author_id);
    }
    recipients.delete(actor.person.id);
    for (const personId of recipients) {
      await notifyPerson(rc.app.db, rc.app.env, {
        personId,
        actorId: actor.person.id,
        kind: 'comment',
        title: `《${page.title}》有新评论`,
        body: `${actor.person.name}：${text.slice(0, 160)}`,
        link,
        libraryId: library.id,
        pageId: page.id,
      });
    }

    const row = rc.app.db
      .prepare(
        `SELECT c.*, p.name AS author_name, p.avatar_color AS author_color
           FROM comments c LEFT JOIN persons p ON p.id = c.author_id WHERE c.id = ?`,
      )
      .get(id) as unknown as Record<string, unknown>;
    rc.json({ comment: commentView(row), notified: recipients.size }, 201);
  });

  router.patch('/api/comments/:id', async (rc) => {
    const actor = requireActor(rc);
    const comment = rc.app.db.prepare('SELECT * FROM comments WHERE id = ?').get(rc.params.id!) as unknown as
      | { id: string; page_id: string; author_id: string | null; library_id: string }
      | undefined;
    if (!comment) throw errors.notFound('评论不存在');
    const { library, role } = requireLibrary(rc.app.db, actor, comment.library_id);
    const body = await rc.body<{ status?: string; body?: string }>();
    const isAuthor = comment.author_id === actor.person.id;
    const canModerate = role === 'owner' || role === 'editor';
    if (body.body !== undefined) {
      if (!isAuthor && !canModerate) throw errors.forbidden('只能修改自己的评论');
      const text = String(body.body).trim();
      if (!text) throw errors.badRequest('评论内容不能为空');
      rc.app.db.prepare('UPDATE comments SET body = ?, updated_at = ? WHERE id = ?').run(text, nowIso(), comment.id);
    }
    if (body.status !== undefined) {
      if (!canModerate && !isAuthor) throw errors.forbidden('需要编辑权限才能标记评论');
      const status = body.status === 'resolved' ? 'resolved' : 'open';
      rc.app.db
        .prepare('UPDATE comments SET status = ?, resolved_by = ?, resolved_at = ?, updated_at = ? WHERE id = ?')
        .run(status, status === 'resolved' ? actor.person.id : null, status === 'resolved' ? nowIso() : null, nowIso(), comment.id);
    }
    audit(rc.app.db, { actor, action: 'comment.update', targetType: 'page', targetId: comment.page_id, libraryId: library.id, detail: { commentId: comment.id } });
    const row = rc.app.db
      .prepare(
        `SELECT c.*, p.name AS author_name, p.avatar_color AS author_color, r.name AS resolved_by_name
           FROM comments c LEFT JOIN persons p ON p.id = c.author_id LEFT JOIN persons r ON r.id = c.resolved_by
          WHERE c.id = ?`,
      )
      .get(comment.id) as unknown as Record<string, unknown>;
    rc.json({ comment: commentView(row) });
  });

  router.delete('/api/comments/:id', (rc) => {
    const actor = requireActor(rc);
    const comment = rc.app.db.prepare('SELECT * FROM comments WHERE id = ?').get(rc.params.id!) as unknown as
      | { id: string; page_id: string; author_id: string | null; library_id: string }
      | undefined;
    if (!comment) throw errors.notFound('评论不存在');
    const { library, role } = requireLibrary(rc.app.db, actor, comment.library_id);
    if (comment.author_id !== actor.person.id && role !== 'owner' && role !== 'editor' && !actor.person.isAdmin) {
      throw errors.forbidden('只能删除自己的评论');
    }
    rc.app.db.prepare('DELETE FROM comments WHERE id = ?').run(comment.id);
    audit(rc.app.db, { actor, action: 'comment.delete', targetType: 'page', targetId: comment.page_id, libraryId: library.id });
    rc.json({ ok: true });
  });

  router.get('/api/notifications', (rc) => {
    const actor = requireActor(rc);
    const unread = rc.query('unread') === '1';
    const limit = Math.max(1, Math.min(100, rc.queryInt('limit', 40)));
    const rows = rc.app.db
      .prepare(
        `SELECT n.*, p.name AS actor_name FROM notifications n LEFT JOIN persons p ON p.id = n.actor_id
          WHERE n.person_id = ? ${unread ? 'AND n.read_at IS NULL' : ''} ORDER BY n.created_at DESC LIMIT ?`,
      )
      .all(actor.person.id, limit) as unknown as Record<string, unknown>[];
    rc.json({
      unread: unreadNotificationCount(rc.app.db, actor.person.id),
      notifications: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        title: row.title,
        body: row.body,
        link: row.link,
        libraryId: row.library_id,
        pageId: row.page_id,
        actorName: row.actor_name ?? null,
        readAt: row.read_at,
        createdAt: row.created_at,
      })),
    });
  });

  router.post('/api/notifications/:id/read', (rc) => {
    const actor = requireActor(rc);
    rc.app.db
      .prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND person_id = ?')
      .run(nowIso(), rc.params.id!, actor.person.id);
    rc.json({ ok: true, unread: unreadNotificationCount(rc.app.db, actor.person.id) });
  });

  router.post('/api/notifications/read-all', (rc) => {
    const actor = requireActor(rc);
    rc.app.db.prepare('UPDATE notifications SET read_at = ? WHERE person_id = ? AND read_at IS NULL').run(nowIso(), actor.person.id);
    rc.json({ ok: true, unread: 0 });
  });

  router.get('/api/notifications/unread', (rc) => {
    const actor = requireActor(rc);
    rc.json({ unread: unreadNotificationCount(rc.app.db, actor.person.id) });
  });
}
