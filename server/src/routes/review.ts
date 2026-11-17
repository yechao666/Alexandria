import type { Router } from '../http/router.ts';
import type { Db } from '../db/index.ts';
import type { Actor, LibraryRow, PageRow } from '../types.ts';
import { requireActor } from '../http/auth.ts';
import { requireLibrary, visibleLibraries, effectivePageRole } from '../domain/access.ts';
import { audit } from '../domain/audit.ts';
import { errors } from '../http/respond.ts';
import { nowIso } from '../lib/ids.ts';
import { getPage, reviewPage, pageToView } from '../knowledge/pages.ts';
import { pageAccess, pageListDto } from './helpers.ts';
import { normalizeTitle } from '../knowledge/terms.ts';
import { notifyPerson } from '../domain/notifications.ts';

export interface ReviewItem {
  page: ReturnType<typeof pageListDto>;
  library: { id: string; name: string; slug: string };
  reviewStatus: string;
  reviewNote: string;
  reviewerName: string | null;
  reviewedAt: string | null;
  conflicts: number;
  sources: number;
  reasons: string[];
  assigneeName: string | null;
}

function pageConflicts(db: Db, pageId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM claims WHERE page_id = ? AND status = 'conflicted'")
    .get(pageId) as unknown as { c: number };
  return Number(row.c);
}

function pageSources(db: Db, pageId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS c FROM page_sources WHERE page_id = ?')
    .get(pageId) as unknown as { c: number };
  return Number(row.c);
}

export function reviewQueue(
  db: Db,
  actor: Actor,
  options: { libraryId?: string; status?: string; limit?: number; conflictsOnly?: boolean; confidenceMax?: number; assignee?: string; classKey?: string } = {},
): ReviewItem[] {
  const libraries = visibleLibraries(db, actor).filter((library) => !options.libraryId || library.id === options.libraryId);
  if (options.libraryId && !libraries.length) throw errors.notFound('知识库不存在');
  const items: ReviewItem[] = [];
  for (const library of libraries) {
    const rows = db
      .prepare(
        `SELECT * FROM pages WHERE library_id = ?
          AND (review_status <> 'approved' OR status = 'draft')
          ORDER BY updated_at DESC LIMIT 200`,
      )
      .all(library.id) as unknown as PageRow[];
    for (const page of rows) {
      if (!effectivePageRole(db, actor, page)) continue;
      if (options.status && options.status !== 'all' && page.review_status !== options.status) continue;
      if (options.classKey && page.class_key !== options.classKey) continue;
      if (options.confidenceMax !== undefined && page.confidence > options.confidenceMax) continue;
      if (options.assignee === 'me' && page.review_assignee !== actor.person.id) continue;
      if (options.assignee && options.assignee !== 'me' && page.review_assignee !== options.assignee) continue;
      const view = pageToView(db, page);
      const conflicts = pageConflicts(db, page.id);
      if (options.conflictsOnly && conflicts === 0) continue;
      const reasons: string[] = [];
      if (page.review_status === 'unreviewed') reasons.push('待首次校对');
      if (page.review_status === 'changes_requested') reasons.push('要求修改');
      if (page.status === 'draft') reasons.push('草稿状态');
      if (conflicts > 0) reasons.push(`${conflicts} 条矛盾待裁决`);
      if (page.confidence < 0.55) reasons.push('置信度偏低');
      items.push({
        page: pageListDto(db, page),
        library: { id: library.id, name: library.name, slug: library.slug },
        reviewStatus: view.reviewStatus,
        reviewNote: view.reviewNote,
        reviewerName: page.reviewed_by
          ? ((db.prepare('SELECT name FROM persons WHERE id = ?').get(page.reviewed_by) as unknown as { name: string } | undefined)?.name ?? null)
          : null,
        reviewedAt: page.reviewed_at,
        conflicts,
        sources: pageSources(db, page.id),
        reasons,
        assigneeName: page.review_assignee
          ? ((db.prepare('SELECT name FROM persons WHERE id = ?').get(page.review_assignee) as unknown as { name: string } | undefined)?.name ?? null)
          : null,
      });
    }
  }
  return items
    .sort(
      (a, b) =>
        (b.conflicts > 0 ? 1 : 0) - (a.conflicts > 0 ? 1 : 0) ||
        String(b.page.updatedAt ?? '').localeCompare(String(a.page.updatedAt ?? '')),
    )
    .slice(0, Math.max(1, Math.min(200, options.limit ?? 100)));
}

export function reviewSummary(db: Db, actor: Actor): {
  pending: number;
  unreviewed: number;
  changesRequested: number;
  drafts: number;
  conflicts: number;
} {
  const libraries = visibleLibraries(db, actor);
  let pending = 0;
  let unreviewed = 0;
  let changesRequested = 0;
  let drafts = 0;
  let conflicts = 0;
  for (const library of libraries) {
    const rows = db
      .prepare(
        `SELECT status, review_status,
           (SELECT COUNT(*) FROM claims c WHERE c.page_id = pages.id AND c.status = 'conflicted') AS conflicts
         FROM pages WHERE library_id = ? AND (review_status <> 'approved' OR status = 'draft')`,
      )
      .all(library.id) as unknown as { status: string; review_status: string; conflicts: number }[];
    pending += rows.length;
    unreviewed += rows.filter((row) => row.review_status === 'unreviewed').length;
    changesRequested += rows.filter((row) => row.review_status === 'changes_requested').length;
    drafts += rows.filter((row) => row.status === 'draft').length;
    conflicts += rows.reduce((sum, row) => sum + Number(row.conflicts), 0);
  }
  return { pending, unreviewed, changesRequested, drafts, conflicts };
}

export function registerReviewRoutes(router: Router): void {
  router.get('/api/review', (rc) => {
    const actor = requireActor(rc);
    const libraryRef = rc.query('library');
    const libraryId = libraryRef
      ? requireLibrary(rc.app.db, actor, libraryRef).library.id
      : undefined;
    const items = reviewQueue(rc.app.db, actor, {
      libraryId,
      status: rc.query('status') || 'all',
      limit: rc.queryInt('limit', 100),
      conflictsOnly: rc.query('conflicts') === '1',
      confidenceMax: rc.query('confidenceMax') ? Number(rc.query('confidenceMax')) : undefined,
      assignee: rc.query('assignee') || undefined,
      classKey: rc.query('class') || undefined,
    });
    rc.json({ items, summary: reviewSummary(rc.app.db, actor) });
  });

  router.get('/api/libraries/:id/review', (rc) => {
    const actor = requireActor(rc);
    const { library } = requireLibrary(rc.app.db, actor, rc.params.id!);
    const items = reviewQueue(rc.app.db, actor, {
      libraryId: library.id,
      status: rc.query('status') || 'all',
      limit: rc.queryInt('limit', 100),
      conflictsOnly: rc.query('conflicts') === '1',
      confidenceMax: rc.query('confidenceMax') ? Number(rc.query('confidenceMax')) : undefined,
      assignee: rc.query('assignee') || undefined,
      classKey: rc.query('class') || undefined,
    });
    rc.json({ items, summary: reviewSummary(rc.app.db, actor) });
  });

  router.get('/api/review/summary', (rc) => {
    const actor = requireActor(rc);
    rc.json(reviewSummary(rc.app.db, actor));
  });

  router.post('/api/pages/:id/review', async (rc) => {
    const actor = requireActor(rc);
    const { page } = pageAccess(rc, rc.params.id!, 'editor');
    if (!page) throw errors.notFound('知识页不存在');
    const { library, role } = requireLibrary(rc.app.db, actor, page.library_id, 'editor');
    if (role !== 'owner' && role !== 'editor') throw errors.forbidden('需要编辑权限');
    const body = await rc.body<{ action?: string; note?: string; confidence?: number }>();
    const action = String(body.action ?? '');
    if (!['approve', 'request_changes', 'reopen', 'archive'].includes(action)) {
      throw errors.badRequest('审核动作不合法');
    }
    if (action === 'request_changes' && !String(body.note ?? '').trim()) {
      throw errors.badRequest('要求修改时必须填写说明');
    }
    if (body.confidence !== undefined) {
      const confidence = Number(body.confidence);
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw errors.badRequest('置信度应在 0–1 之间');
      rc.app.db.prepare('UPDATE pages SET confidence = ? WHERE id = ?').run(confidence, page.id);
      page.confidence = confidence;
    }
    const updated = reviewPage(rc.app.db, page, action as 'approve' | 'request_changes' | 'reopen' | 'archive', String(body.note ?? ''), actor);
    const conflicts = pageConflicts(rc.app.db, page.id);
    const target = page.owner_person_id ?? page.created_by;
    if (target && target !== actor.person.id && (action === 'request_changes' || action === 'approve')) {
      await notifyPerson(rc.app.db, rc.app.env, {
        personId: target,
        actorId: actor.person.id,
        kind: 'review',
        title: action === 'approve' ? `《${page.title}》已通过校对` : `《${page.title}》被要求修改`,
        body: action === 'approve' ? `${actor.person.name} 批准了此页` : `${actor.person.name}：${String(body.note ?? '').slice(0, 160)}`,
        link: `/#/page/${encodeURIComponent(page.id)}`,
        libraryId: library.id,
        pageId: page.id,
      });
    }
    audit(rc.app.db, {
      actor,
      action: `page.review.${action}`,
      targetType: 'page',
      targetId: page.id,
      libraryId: library.id,
      detail: { note: body.note ?? '', conflicts },
    });
    rc.json({ page: pageListDto(rc.app.db, updated), conflicts, summary: reviewSummary(rc.app.db, actor) });
  });

  router.post('/api/claims/:id/resolve', async (rc) => {
    const actor = requireActor(rc);
    const claim = rc.app.db
      .prepare('SELECT * FROM claims WHERE id = ?')
      .get(rc.params.id!) as unknown as
      | { id: string; page_id: string; subject: string; predicate: string; object: string; status: string }
      | undefined;
    if (!claim) throw errors.notFound('主张不存在');
    const { page } = pageAccess(rc, claim.page_id, 'editor');
    if (!page) throw errors.notFound('知识页不存在');
    const { library } = requireLibrary(rc.app.db, actor, page.library_id, 'editor');
    const body = await rc.body<{ resolution?: string; note?: string }>();
    const resolution = String(body.resolution ?? '');
    if (resolution !== 'keep' && resolution !== 'dismiss') throw errors.badRequest('裁决动作应为 keep 或 dismiss');
    const rivals = rc.app.db
      .prepare(
        `SELECT id, page_id, object FROM claims WHERE subject = ? AND predicate = ? AND status = 'conflicted' AND id <> ?`,
      )
      .all(claim.subject, claim.predicate, claim.id) as unknown as { id: string; page_id: string; object: string }[];
    const keep = resolution === 'keep';
    rc.app.db.prepare('UPDATE claims SET status = ? WHERE id = ?').run(keep ? 'active' : 'ignored', claim.id);
    for (const rival of rivals) {
      rc.app.db.prepare('UPDATE claims SET status = ? WHERE id = ?').run(keep ? 'resolved' : 'active', rival.id);
    }
    const affectedPages = new Set([page.id, ...rivals.map((rival) => rival.page_id)]);
    for (const pageId of affectedPages) {
      rc.app.db
        .prepare(
          "UPDATE pages SET review_status = 'unreviewed', review_note = ?, updated_at = ? WHERE id = ? AND review_status = 'approved'",
        )
        .run(`矛盾裁决：${keep ? '采用' : '驳回'}「${claim.object}」`, nowIso(), pageId);
    }
    audit(rc.app.db, {
      actor,
      action: 'claim.resolve',
      targetType: 'claim',
      targetId: claim.id,
      libraryId: library.id,
      detail: { resolution, note: body.note ?? '', rivals: rivals.length, subject: claim.subject, predicate: claim.predicate },
    });
    rc.json({
      ok: true,
      resolution,
      claim: { ...claim, status: keep ? 'active' : 'ignored' },
      rivals: rivals.map((rival) => ({ ...rival, status: keep ? 'resolved' : 'active' })),
      summary: reviewSummary(rc.app.db, actor),
    });
  });

  router.patch('/api/contradictions/:id', async (rc) => {
    const actor = requireActor(rc);
    const row = rc.app.db.prepare('SELECT * FROM contradictions WHERE id = ?').get(rc.params.id!) as unknown as { id: string; library_id: string } | undefined;
    if (!row) throw errors.notFound('矛盾对象不存在');
    requireLibrary(rc.app.db, actor, row.library_id, 'editor');
    const body = await rc.body<{ status?: string; severity?: string; ownerPersonId?: string | null; effectiveDate?: string | null }>();
    const fields: string[] = [];
    const values: (string | null)[] = [];
    if (body.status !== undefined) { if (!['unresolved', 'resolved', 'ignored'].includes(String(body.status))) throw errors.badRequest('矛盾状态无效'); fields.push('status = ?'); values.push(String(body.status)); }
    if (body.severity !== undefined) { if (!['low', 'medium', 'high'].includes(String(body.severity))) throw errors.badRequest('严重度无效'); fields.push('severity = ?'); values.push(String(body.severity)); }
    if (body.ownerPersonId !== undefined) { fields.push('owner_person_id = ?'); values.push(body.ownerPersonId ? String(body.ownerPersonId) : null); }
    if (body.effectiveDate !== undefined) { fields.push('effective_date = ?'); values.push(body.effectiveDate ? String(body.effectiveDate) : null); }
    if (!fields.length) throw errors.badRequest('没有可更新的字段');
    fields.push('resolved_at = ?'); values.push(body.status === 'resolved' ? nowIso() : null);
    values.push(row.id);
    rc.app.db.prepare(`UPDATE contradictions SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    audit(rc.app.db, { actor, action: 'contradiction.update', targetType: 'contradiction', targetId: row.id, libraryId: row.library_id, detail: body });
    rc.json({ ok: true });
  });

  router.get('/api/review/conflicts', (rc) => {
    const actor = requireActor(rc);
    const libraries = visibleLibraries(rc.app.db, actor);
    const result: {
      claimId: string;
      pageId: string;
      pageTitle: string;
      libraryId: string;
      libraryName: string;
      subject: string;
      predicate: string;
      object: string;
      text: string;
      contradictionId: string | null;
      severity: string;
      contradictionStatus: string;
      effectiveDate: string | null;
    }[] = [];
    for (const library of libraries) {
      const rows = rc.app.db
        .prepare(
          `SELECT c.id, c.page_id, c.subject, c.predicate, c.object, c.text, p.title AS page_title,
                  con.id AS contradiction_id, con.severity, con.status AS contradiction_status, con.effective_date
             FROM claims c JOIN pages p ON p.id = c.page_id
             LEFT JOIN contradictions con ON con.claim_id = c.id
            WHERE p.library_id = ? AND c.status = 'conflicted' ORDER BY p.updated_at DESC LIMIT 100`,
        )
        .all(library.id) as unknown as {
        id: string;
        page_id: string;
        subject: string;
        predicate: string;
        object: string;
        text: string;
        page_title: string;
        contradiction_id: string | null;
        severity: string | null;
        contradiction_status: string | null;
        effective_date: string | null;
      }[];
      for (const row of rows) {
        result.push({
          claimId: row.id,
          pageId: row.page_id,
          pageTitle: row.page_title,
          libraryId: library.id,
          libraryName: library.name,
          subject: row.subject,
          predicate: row.predicate,
          object: row.object,
          text: row.text,
          contradictionId: row.contradiction_id ?? null,
          severity: row.severity ?? 'medium',
          contradictionStatus: row.contradiction_status ?? 'unresolved',
          effectiveDate: row.effective_date ?? null,
        });
      }
    }
    rc.json({ conflicts: result, summary: reviewSummary(rc.app.db, actor) });
  });
  router.post('/api/review/bulk', async (rc) => {
    const actor = requireActor(rc);
    const body = await rc.body<{ ids?: string[]; action?: string; note?: string; forceConflicts?: boolean }>();
    const action = body.action === 'request_changes' ? 'request_changes' : 'approve';
    const ids = [...new Set(Array.isArray(body.ids) ? body.ids.map(String) : [])].slice(0, 50);
    if (!ids.length) throw errors.badRequest('请选择页面');
    let approved = 0;
    let skipped = 0;
    for (const id of ids) {
      try {
        const { page, role } = pageAccess(rc, id, 'editor');
        if (role === 'viewer') { skipped += 1; continue; }
        if (action === 'approve' && pageConflicts(rc.app.db, page.id) > 0 && !body.forceConflicts) {
          skipped += 1;
          continue;
        }
        reviewPage(rc.app.db, page, action === 'approve' ? 'approve' : 'request_changes', String(body.note ?? '批量校对'), actor);
        approved += 1;
      } catch {
        skipped += 1;
      }
    }
    audit(rc.app.db, { actor, action: 'review.bulk', targetType: 'page', targetId: ids.join(','), detail: { action, approved, skipped } });
    rc.json({ ok: true, action, approved, skipped });
  });

  router.patch('/api/pages/:id/review-assignee', async (rc) => {
    const actor = requireActor(rc);
    const body = await rc.body<{ personId?: string | null }>();
    const { page, library, role } = pageAccess(rc, rc.params.id!, 'editor');
    if (role === 'viewer') throw errors.forbidden('需要编辑权限');
    const personId = body.personId ? String(body.personId) : null;
    if (personId) {
      const person = rc.app.db.prepare("SELECT id, name FROM persons WHERE id = ? AND status = 'active'").get(personId) as unknown as { id: string; name: string } | undefined;
      if (!person) throw errors.badRequest('指派成员不存在');
      rc.app.db.prepare('UPDATE pages SET review_assignee = ? WHERE id = ?').run(personId, page.id);
      if (personId !== actor.person.id) {
        await notifyPerson(rc.app.db, rc.app.env, {
          personId,
          actorId: actor.person.id,
          kind: 'review',
          title: `你被指派校对「${page.title}」`,
          body: '请确认定义、来源与矛盾后批准或退回。',
          link: `/#/page/${encodeURIComponent(page.id)}`,
          libraryId: library.id,
          pageId: page.id,
        });
      }
    } else {
      rc.app.db.prepare('UPDATE pages SET review_assignee = NULL WHERE id = ?').run(page.id);
    }
    audit(rc.app.db, { actor, action: 'page.review.assign', targetType: 'page', targetId: page.id, libraryId: library.id, detail: { assignee: personId } });
    rc.json({ ok: true, assignee: personId });
  });

  router.post('/api/review/conflicts/bulk', async (rc) => {
    const actor = requireActor(rc);
    const body = await rc.body<{ ids?: string[]; resolution?: string; note?: string }>();
    const resolution = String(body.resolution ?? '');
    if (resolution !== 'keep' && resolution !== 'dismiss') throw errors.badRequest('裁决动作应为 keep 或 dismiss');
    const ids = [...new Set(Array.isArray(body.ids) ? body.ids.map(String) : [])].slice(0, 50);
    if (!ids.length) throw errors.badRequest('请选择冲突主张');
    let resolved = 0;
    let skipped = 0;
    const libraryIds = new Set<string>();
    for (const id of ids) {
      try {
        const claim = rc.app.db.prepare('SELECT * FROM claims WHERE id = ?').get(id) as unknown as
          | { id: string; page_id: string; subject: string; predicate: string; object: string; status: string }
          | undefined;
        if (!claim || claim.status !== 'conflicted') { skipped += 1; continue; }
        const { page } = pageAccess(rc, claim.page_id, 'editor');
        requireLibrary(rc.app.db, actor, page.library_id, 'editor');
        libraryIds.add(page.library_id);
        const rivals = rc.app.db
          .prepare("SELECT id, page_id FROM claims WHERE subject = ? AND predicate = ? AND status = 'conflicted' AND id <> ?")
          .all(claim.subject, claim.predicate, claim.id) as unknown as { id: string; page_id: string }[];
        const keep = resolution === 'keep';
        rc.app.db.prepare('UPDATE claims SET status = ? WHERE id = ?').run(keep ? 'active' : 'ignored', claim.id);
        for (const rival of rivals) rc.app.db.prepare('UPDATE claims SET status = ? WHERE id = ?').run(keep ? 'resolved' : 'active', rival.id);
        rc.app.db.prepare("UPDATE contradictions SET status = 'resolved', resolved_at = ? WHERE claim_id = ?").run(nowIso(), claim.id);
        for (const pageId of new Set([page.id, ...rivals.map((rival) => rival.page_id)])) {
          rc.app.db
            .prepare("UPDATE pages SET review_status = 'unreviewed', review_note = ?, updated_at = ? WHERE id = ? AND review_status = 'approved'")
            .run(`批量矛盾裁决：${keep ? '采用' : '驳回'}`, nowIso(), pageId);
        }
        resolved += 1;
      } catch {
        skipped += 1;
      }
    }
    audit(rc.app.db, { actor, action: 'review.conflicts.bulk', targetType: 'claim', targetId: ids.join(','), libraryId: [...libraryIds][0] ?? null, detail: { resolution, resolved, skipped } });
    rc.json({ ok: true, resolution, resolved, skipped, summary: reviewSummary(rc.app.db, actor) });
  });

  router.get('/api/review/analytics', (rc) => {
    const actor = requireActor(rc);
    const days = Math.max(1, Math.min(365, rc.queryInt('days', 30)));
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const libraries = visibleLibraries(rc.app.db, actor);
    const libraryName = new Map(libraries.map((library) => [library.id, library.name]));
    const pages = (rc.app.db.prepare('SELECT * FROM pages').all() as unknown as PageRow[]).filter((page) => Boolean(effectivePageRole(rc.app.db, actor, page)));
    const byStatus = new Map<string, number>();
    const byClass = new Map<string, number>();
    const byLibrary = new Map<string, { pending: number; approved: number; conflicts: number }>();
    const byAssignee = new Map<string, number>();
    const confidence = { low: 0, medium: 0, high: 0 };
    for (const page of pages) {
      byStatus.set(page.review_status, (byStatus.get(page.review_status) ?? 0) + 1);
      byClass.set(page.class_key, (byClass.get(page.class_key) ?? 0) + 1);
      const entry = byLibrary.get(page.library_id) ?? { pending: 0, approved: 0, conflicts: 0 };
      if (page.review_status !== 'approved') entry.pending += 1;
      else if (page.reviewed_at && page.reviewed_at >= cutoff) entry.approved += 1;
      const conflicts = pageConflicts(rc.app.db, page.id);
      entry.conflicts += conflicts;
      byLibrary.set(page.library_id, entry);
      if (page.review_assignee) byAssignee.set(page.review_assignee, (byAssignee.get(page.review_assignee) ?? 0) + 1);
      if (page.confidence < 0.55) confidence.low += 1;
      else if (page.confidence < 0.75) confidence.medium += 1;
      else confidence.high += 1;
    }
    const assignees = [...byAssignee.entries()].map(([id, count]) => ({
      id,
      name: (rc.app.db.prepare('SELECT name FROM persons WHERE id = ?').get(id) as unknown as { name: string } | undefined)?.name ?? id,
      count,
    })).sort((a, b) => b.count - a.count);
    const recentApprovals = rc.app.db
      .prepare("SELECT id, title, reviewed_at FROM pages WHERE review_status = 'approved' AND reviewed_at >= ? ORDER BY reviewed_at DESC LIMIT 10")
      .all(cutoff) as unknown as { id: string; title: string; reviewed_at: string }[];
    rc.json({
      days,
      total: pages.length,
      pending: pages.filter((page) => page.review_status !== 'approved').length,
      approvedInPeriod: recentApprovals.length,
      byStatus: [...byStatus.entries()].map(([key, count]) => ({ key, count })),
      byClass: [...byClass.entries()].map(([key, count]) => ({ key, count })),
      byLibrary: [...byLibrary.entries()].map(([id, value]) => ({ id, name: libraryName.get(id) ?? id, ...value })),
      byAssignee: assignees,
      confidence,
      recentApprovals,
    });
  });

}

export { normalizeTitle };
