import type { Router } from '../http/router.ts';
import { requireActor } from '../http/auth.ts';
import { requireLibrary, effectivePageRole, effectiveSourceRole } from '../domain/access.ts';
import { errors } from '../http/respond.ts';
import { pageToView } from '../knowledge/pages.ts';
import { pageAccess } from './helpers.ts';
import { parseJson } from '../lib/ids.ts';
import type { PageRow } from '../types.ts';

function yaml(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function pageMarkdown(db: import('../db/index.ts').Db, page: PageRow, actor?: import('../types.ts').Actor): string {
  const view = pageToView(db, page);
  const claims = db
    .prepare(
      `SELECT text, subject, predicate, object, confidence, status FROM claims
        WHERE page_id = ? AND status NOT IN ('ignored', 'resolved') ORDER BY created_at ASC`,
    )
    .all(page.id) as unknown as {
    text: string;
    subject: string;
    predicate: string;
    object: string;
    confidence: number;
    status: string;
  }[];
  const sources = db
    .prepare(
      `SELECT s.id, s.title, s.filename, ps.relation FROM page_sources ps JOIN sources s ON s.id = ps.source_id WHERE ps.page_id = ?`,
    )
    .all(page.id) as unknown as { id: string; title: string; filename: string; relation: string }[];
  const visibleSources = actor
    ? sources.filter((source) => Boolean(effectiveSourceRole(db, actor, db.prepare('SELECT * FROM sources WHERE id = ?').get(source.id) as unknown as import('../types.ts').SourceRow)))
    : sources;
  const links = db
    .prepare(
      `SELECT p.slug, p.title, l.relation FROM links l JOIN pages p ON p.id = l.to_page_id WHERE l.from_page_id = ? ORDER BY l.weight DESC`,
    )
    .all(page.id) as unknown as { slug: string; title: string; relation: string }[];
  const visibleLinks = actor
    ? links.filter((link) => {
        const target = db.prepare('SELECT * FROM pages WHERE slug = ? AND library_id = ?').get(link.slug, page.library_id) as unknown as PageRow | undefined;
        return Boolean(target && effectivePageRole(db, actor, target));
      })
    : links;
  const lines = [
    '---',
    `title: ${yaml(page.title)}`,
    `type: ${yaml(page.class_key)}`,
    `slug: ${yaml(page.slug)}`,
    `status: ${yaml(page.status)}`,
    `review_status: ${yaml(page.review_status)}`,
    `confidence: ${Number(page.confidence)}`,
    `tags: ${yaml(view.tagsList)}`,
    `aliases: ${yaml(view.aliasesList)}`,
    `read_when: ${yaml(view.readWhenList)}`,
    `sources: ${yaml(visibleSources.map((source) => ({ id: source.id, title: source.title, filename: source.filename, relation: source.relation })))}`,
    `links: ${yaml(visibleLinks.map((link) => ({ slug: link.slug, title: link.title, relation: link.relation })))}`,
    'claims:',
    ...claims.map(
      (claim) =>
        `  - text: ${yaml(claim.text)}\n    subject: ${yaml(claim.subject)}\n    predicate: ${yaml(claim.predicate)}\n    object: ${yaml(claim.object)}\n    confidence: ${Number(claim.confidence)}\n    status: ${yaml(claim.status)}`,
    ),
    '---',
    '',
    page.body.trim(),
    '',
  ];
  return lines.join('\n');
}

export function registerExportRoutes(router: Router): void {
  router.get('/api/pages/:id/markdown', (rc) => {
    const actor = requireActor(rc);
    const { page } = pageAccess(rc, rc.params.id!);
    const markdown = pageMarkdown(rc.app.db, page, actor);
    const filename = `${page.slug.replace(/\//g, '-')}.md`;
    rc.res.statusCode = 200;
    rc.res.setHeader('content-type', 'text/markdown; charset=utf-8');
    rc.res.setHeader('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(filename)}`);
    rc.res.end(markdown);
  });

  router.get('/api/libraries/:id/export.md', (rc) => {
    const actor = requireActor(rc);
    const { library } = requireLibrary(rc.app.db, actor, rc.params.id!);
    const pages = rc.app.db
      .prepare('SELECT * FROM pages WHERE library_id = ? ORDER BY class_key, title')
      .all(library.id) as unknown as PageRow[];
    const visiblePages = pages.filter((page) => Boolean(effectivePageRole(rc.app.db, actor, page)));
    const header = [
      '---',
      `library: ${yaml(library.name)}`,
      `library_slug: ${yaml(library.slug)}`,
      `exported_at: ${yaml(new Date().toISOString())}`,
      `pages: ${visiblePages.length}`,
      'format: alexandria-markdown-bundle-v1',
      '---',
      '',
      `# ${library.name}`,
      '',
      library.description,
      '',
      '> 本文件由 Alexandria 导出。每个知识页以 HTML 注释和 YAML frontmatter 分隔，可直接交给 LLM 或纳入 git。',
      '',
    ].join('\n');
    const bundle = visiblePages
      .map(
        (page) =>
          `\n<!-- alexandria:page slug=${yaml(page.slug)} -->\n\n${pageMarkdown(rc.app.db, page, actor)}\n`,
      )
      .join('\n---\n');
    rc.res.statusCode = 200;
    rc.res.setHeader('content-type', 'text/markdown; charset=utf-8');
    rc.res.setHeader(
      'content-disposition',
      `inline; filename*=UTF-8''${encodeURIComponent(`${library.slug}-wiki.md`)}`,
    );
    rc.res.end(`${header}${bundle}`);
  });

  router.get('/api/pages/:id/frontmatter', (rc) => {
    const actor = requireActor(rc);
    const { page } = pageAccess(rc, rc.params.id!);
    rc.json({
      format: 'alexandria-page-v1',
      frontmatter: {
        title: page.title,
        type: page.class_key,
        slug: page.slug,
        status: page.status,
        review_status: page.review_status,
        confidence: page.confidence,
        tags: parseJson<string[]>(page.tags, []),
        aliases: parseJson<string[]>(page.aliases, []),
        read_when: parseJson<string[]>(page.read_when, []),
      },
      body: page.body,
    });
  });
}
