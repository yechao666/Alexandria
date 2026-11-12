import type { Router } from '../http/router.ts';
import type { RequestContext } from '../http/context.ts';
import { authenticate, login, logout, sessionCookie } from '../http/auth.ts';
import { requireActor } from '../http/auth.ts';
import { errors } from '../http/respond.ts';
import { visibleLibraries } from '../domain/access.ts';
import { parseJson } from '../lib/ids.ts';
import { libraryCounts, nodeTree, serializeLibrary, teamTree } from './helpers.ts';
import { reviewSummary } from './review.ts';
import { getWecomConfig, wecomConfigured } from '../domain/wecom.ts';
import { unreadNotificationCount } from '../domain/notifications.ts';
import type { LibraryRow, PageRow } from '../types.ts';

export function mePayload(rc: RequestContext) {
  const actor = requireActor(rc);
  return {
    person: actor.person,
    teams: actor.teamIds,
    viaApiKey: Boolean(actor.viaApiKey),
    apiScope: actor.apiScope ?? null,
  };
}

export function registerAuthRoutes(router: Router): void {
  router.get('/api/health', (rc) => {
    rc.json({
      ok: true,
      service: 'alexandria',
      version: '0.1.0',
      time: new Date().toISOString(),
      llm: Boolean(rc.app.env.llm),
    });
  });

  router.post('/api/auth/login', async (rc) => {
    const body = await rc.body<{ email?: string; password?: string }>();
    if (!body.email || !body.password) throw errors.badRequest('请输入邮箱和密码');
    const result = login(rc, body.email, body.password);
    rc.json(
      { person: result.actor.person, teams: result.actor.teamIds, token: result.token },
      200,
      { 'set-cookie': sessionCookie(result.token, rc.app.env.sessionTtlHours) },
    );
  });

  router.post('/api/auth/logout', (rc) => {
    logout(rc);
    rc.json({ ok: true }, 200, {
      'set-cookie': 'alex_sess_cookie=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    });
  });

  router.get('/api/me', (rc) => {
    rc.json(mePayload(rc));
  });

  router.get('/api/bootstrap', (rc) => {
    const actor = requireActor(rc);
    const libraries = visibleLibraries(rc.app.db, actor);
    const libraryIds = libraries.map((library) => library.id);
    const placeholders = libraryIds.map(() => '?').join(',') || "''";
    const recentPages = (
      libraryIds.length
        ? (rc.app.db
            .prepare(
              `SELECT p.*, l.name AS library_name, l.slug AS library_slug FROM pages p JOIN libraries l ON l.id = p.library_id
                WHERE p.library_id IN (${placeholders}) ORDER BY p.updated_at DESC LIMIT 12`,
            )
            .all(...libraryIds) as unknown as (PageRow & { library_name: string; library_slug: string })[])
        : []
    ).map((page) => ({
      id: page.id,
      title: page.title,
      summary: page.summary,
      classKey: page.class_key,
      status: page.status,
      confidence: page.confidence,
      updatedAt: page.updated_at,
      libraryId: page.library_id,
      libraryName: page.library_name,
      librarySlug: page.library_slug,
      tags: parseJson<string[]>(page.tags, []),
    }));

    const people = rc.app.db
      .prepare('SELECT id, name, email, title, avatar_color, is_admin FROM persons WHERE status = ? ORDER BY name')
      .all('active') as unknown as {
      id: string;
      name: string;
      email: string;
      title: string;
      avatar_color: string;
      is_admin: number;
    }[];

    const teams = teamTree(rc.app.db);
    const classDistribution = rc.app.db
      .prepare(
        `SELECT c.key, c.name, c.color, COUNT(p.id) AS count FROM ontology_classes c
          LEFT JOIN pages p ON p.class_key = c.key AND p.library_id = c.library_id
          WHERE c.library_id IN (${placeholders}) GROUP BY c.library_id, c.key ORDER BY count DESC`,
      )
      .all(...(libraryIds.length ? libraryIds : [''])) as unknown as { key: string; name: string; color: string; count: number }[];

    const totals = libraryIds.length
      ? (rc.app.db
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM pages WHERE library_id IN (${placeholders})) AS pages,
               (SELECT COUNT(*) FROM sources WHERE library_id IN (${placeholders})) AS sources,
               (SELECT COUNT(*) FROM links WHERE library_id IN (${placeholders})) AS links,
               (SELECT COUNT(*) FROM claims WHERE page_id IN (SELECT id FROM pages WHERE library_id IN (${placeholders}))) AS claims,
               (SELECT COUNT(*) FROM claims WHERE status = 'conflicted' AND page_id IN (SELECT id FROM pages WHERE library_id IN (${placeholders}))) AS conflicts`,
          )
          .get(...libraryIds, ...libraryIds, ...libraryIds, ...libraryIds, ...libraryIds) as unknown as Record<string, number>)
      : { pages: 0, sources: 0, links: 0, claims: 0, conflicts: 0 };

    const review = reviewSummary(rc.app.db, actor);
    rc.json({
      me: { person: actor.person, teams: actor.teamIds },
      libraries: libraries.map((library) => serializeLibrary(rc.app.db, library as LibraryRow, library.role)),
      recentPages,
      teams,
      people: people.map((person) => ({
        id: person.id,
        name: person.name,
        email: person.email,
        title: person.title,
        avatarColor: person.avatar_color,
        isAdmin: Boolean(person.is_admin),
      })),
      stats: {
        ...totals,
        libraries: libraries.length,
        members: people.length,
        reviewPending: review.pending,
        conflicts: review.conflicts,
        notificationsUnread: unreadNotificationCount(rc.app.db, actor.person.id),
      },
      review,
      classes: classDistribution,
      features: {
        llm: Boolean(rc.app.env.llm),
        wecom: wecomConfigured(getWecomConfig(rc.app.db, rc.app.env)),
        ocr: true,
      },
    });
  });

  router.get('/api/stats', (rc) => {
    const actor = requireActor(rc);
    const libraries = visibleLibraries(rc.app.db, actor);
    const ids = libraries.map((library) => library.id);
    const ph = ids.map(() => '?').join(',') || "''";
    const stats = ids.length
      ? (rc.app.db
          .prepare(
            `SELECT (SELECT COUNT(*) FROM pages WHERE library_id IN (${ph})) AS pages,
                    (SELECT COUNT(*) FROM sources WHERE library_id IN (${ph})) AS sources,
                    (SELECT COUNT(*) FROM links WHERE library_id IN (${ph})) AS links,
                    (SELECT COUNT(*) FROM claims WHERE page_id IN (SELECT id FROM pages WHERE library_id IN (${ph}))) AS claims,
                    (SELECT COUNT(*) FROM claims WHERE status = 'conflicted' AND page_id IN (SELECT id FROM pages WHERE library_id IN (${ph}))) AS conflicts`,
          )
          .get(...ids, ...ids, ...ids, ...ids, ...ids) as unknown as Record<string, number>)
      : { pages: 0, sources: 0, links: 0, claims: 0, conflicts: 0 };
    rc.json({ ...stats, libraries: libraries.map((library) => ({ id: library.id, name: library.name, counts: libraryCounts(rc.app.db, library.id) })) });
  });
}
