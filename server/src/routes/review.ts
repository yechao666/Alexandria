import type { Router } from '../http/router.ts';
import type { Db } from '../db/index.ts';
import type { Actor, LibraryRow, PageRow } from '../types.ts';
import { requireActor } from '../http/auth.ts';
import { requireLibrary, visibleLibraries } from '../domain/access.ts';
import { audit } from '../domain/audit.ts';
import { errors } from '../http/respond.ts';
import { nowIso } from '../lib/ids.ts';
import { getPage, reviewPage, pageToView } from '../knowledge/pages.ts';
import { pageListDto } from './helpers.ts';
import { normalizeTitle } from '../knowledge/terms.ts';

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
  options: { libraryId?: string; status?: string; limit?: number } = {},
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
      if (options.status && options.status !== 'all' && page.review_status !== options.status) continue;
      const view = pageToView(db, page);
      const conflicts = pageConflicts(db, page.id);
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
    });
    rc.json({ items, summary: reviewSummary(rc.app.db, actor) });
  });

  router.get('/api/review/summary', (rc) => {
    const actor = requireActor(rc);
    rc.json(reviewSummary(rc.app.db, actor));
  });

  router.post('/api/pages/:id/review', async (rc) => {
    const actor = requireActor(rc);
    const page = getPage(rc.app.db, rc.params.id!);
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
    const page = getPage(rc.app.db, claim.page_id);
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
    }[] = [];
    for (const library of libraries) {
      const rows = rc.app.db
        .prepare(
          `SELECT c.id, c.page_id, c.subject, c.predicate, c.object, c.text, p.title AS page_title
             FROM claims c JOIN pages p ON p.id = c.page_id
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
        });
      }
    }
    rc.json({ conflicts: result, summary: reviewSummary(rc.app.db, actor) });
  });
}

export { normalizeTitle };
