import type { Db } from '../db/index.ts';
import type { RequestContext } from '../http/context.ts';
import { requireActor } from '../http/auth.ts';
import { requireLibrary, getLibrary, effectivePageRole, effectiveSourceRole, roleAtLeast } from '../domain/access.ts';
import { errors } from '../http/respond.ts';
import { getPage } from '../knowledge/pages.ts';
import type { Actor, LibraryRow, PageRow } from '../types.ts';
import { parseJson } from '../lib/ids.ts';
import { pageToView } from '../knowledge/pages.ts';

export function parseList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === 'string') {
    return value
      .split(/[\n,，;；]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

export function pagination(rc: { queryInt(name: string, fallback: number): number }): { limit: number; offset: number } {
  const limit = Math.max(1, Math.min(200, rc.queryInt('limit', 50)));
  const offset = Math.max(0, rc.queryInt('offset', 0));
  return { limit, offset };
}

export function libraryCounts(db: Db, libraryId: string): {
  pages: number;
  sources: number;
  links: number;
  claims: number;
  conflicts: number;
  nodes: number;
  reviewPending: number;
} {
  const one = (sql: string) => Number((db.prepare(sql).get(libraryId) as unknown as { c: number } | undefined)?.c ?? 0);
  return {
    pages: one('SELECT COUNT(*) AS c FROM pages WHERE library_id = ?'),
    sources: one('SELECT COUNT(*) AS c FROM sources WHERE library_id = ?'),
    links: one('SELECT COUNT(*) AS c FROM links WHERE library_id = ?'),
    claims: one('SELECT COUNT(*) AS c FROM claims WHERE page_id IN (SELECT id FROM pages WHERE library_id = ?)'),
    conflicts: one(
      "SELECT COUNT(*) AS c FROM claims WHERE status = 'conflicted' AND page_id IN (SELECT id FROM pages WHERE library_id = ?)",
    ),
    nodes: one('SELECT COUNT(*) AS c FROM catalog_nodes WHERE library_id = ?'),
    reviewPending: one("SELECT COUNT(*) AS c FROM pages WHERE library_id = ? AND (review_status <> 'approved' OR status = 'draft')"),
  };
}

export function serializeLibrary(db: Db, library: LibraryRow, role: string): Record<string, unknown> {
  const ownerTeam = library.owner_team_id
    ? (db.prepare('SELECT name FROM teams WHERE id = ?').get(library.owner_team_id) as unknown as { name: string } | undefined)
    : undefined;
  return {
    ...library,
    settings: parseJson<Record<string, unknown>>(library.settings, {}),
    role,
    counts: libraryCounts(db, library.id),
    ownerTeamName: ownerTeam?.name ?? null,
    nodes: nodeTree(db, library.id).slice(0, 4).map((node) => ({ id: node.id, name: node.name, kind: node.kind, pageCount: node.pageCount })),
  };
}

export interface NodeTree {
  id: string;
  libraryId: string;
  parentId: string | null;
  name: string;
  slug: string;
  kind: string;
  code: string;
  description: string;
  icon: string;
  sortOrder: number;
  pageCount: number;
  sourceCount: number;
  children: NodeTree[];
}

export function nodeTree(db: Db, libraryId: string): NodeTree[] {
  const rows = db
    .prepare('SELECT * FROM catalog_nodes WHERE library_id = ? ORDER BY sort_order ASC, created_at ASC')
    .all(libraryId) as unknown as {
    id: string;
    library_id: string;
    parent_id: string | null;
    name: string;
    slug: string;
    kind: string;
    code: string;
    description: string;
    icon: string;
    sort_order: number;
  }[];
  const countPages = new Map<string, number>();
  const countSources = new Map<string, number>();
  for (const row of db
    .prepare('SELECT node_id, COUNT(*) AS c FROM pages WHERE library_id = ? AND node_id IS NOT NULL GROUP BY node_id')
    .all(libraryId) as unknown as { node_id: string; c: number }[]) {
    countPages.set(row.node_id, Number(row.c));
  }
  for (const row of db
    .prepare('SELECT node_id, COUNT(*) AS c FROM sources WHERE library_id = ? AND node_id IS NOT NULL GROUP BY node_id')
    .all(libraryId) as unknown as { node_id: string; c: number }[]) {
    countSources.set(row.node_id, Number(row.c));
  }
  const map = new Map<string, NodeTree>();
  for (const row of rows) {
    map.set(row.id, {
      id: row.id,
      libraryId: row.library_id,
      parentId: row.parent_id,
      name: row.name,
      slug: row.slug,
      kind: row.kind,
      code: row.code,
      description: row.description,
      icon: row.icon,
      sortOrder: row.sort_order,
      pageCount: countPages.get(row.id) ?? 0,
      sourceCount: countSources.get(row.id) ?? 0,
      children: [],
    });
  }
  const roots: NodeTree[] = [];
  for (const node of map.values()) {
    if (node.parentId && map.has(node.parentId)) map.get(node.parentId)!.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export function pageListDto(db: Db, page: PageRow): Record<string, unknown> {
  const view = pageToView(db, page);
  return {
    id: view.id,
    libraryId: view.library_id,
    nodeId: view.node_id,
    classKey: view.class_key,
    className: view.className,
    classColor: view.classColor,
    slug: view.slug,
    title: view.title,
    summary: view.summary,
    tldr: view.tldr,
    status: view.status,
    reviewStatus: view.reviewStatus,
    reviewNote: view.reviewNote,
    effectiveDate: view.effectiveDate,
    expiresAt: view.expiresAt,
    supersededAt: view.supersededAt,
    reviewerName: view.reviewerName,
    reviewedAt: view.reviewed_at,
    confidence: view.confidence,
    tags: view.tagsList,
    aliases: view.aliasesList,
    readWhen: view.readWhenList,
    updatedAt: view.updated_at,
    createdAt: view.created_at,
    version: view.version,
    nodeName: view.nodeName,
    creatorName: view.creatorName,
    updaterName: view.updaterName,
  };
}

export function teamTree(db: Db): unknown[] {
  const teams = db.prepare('SELECT * FROM teams ORDER BY sort_order ASC, name ASC').all() as unknown as {
    id: string;
    name: string;
    slug: string;
    parent_id: string | null;
    description: string;
    lead_person_id: string | null;
    wecom_dept_id: string | null;
  }[];
  const members = db
    .prepare(
      `SELECT tm.team_id, tm.role, p.id, p.name, p.email, p.avatar_color, p.title
         FROM team_members tm JOIN persons p ON p.id = tm.person_id`,
    )
    .all() as unknown as {
    team_id: string;
    role: string;
    id: string;
    name: string;
    email: string;
    avatar_color: string;
    title: string;
  }[];
  const byTeam = new Map<string, typeof members>();
  for (const member of members) {
    if (!byTeam.has(member.team_id)) byTeam.set(member.team_id, []);
    byTeam.get(member.team_id)!.push(member);
  }
  const map = new Map<string, Record<string, unknown>>();
  for (const team of teams) {
    map.set(team.id, {
      id: team.id,
      name: team.name,
      slug: team.slug,
      parentId: team.parent_id,
      description: team.description,
      leadPersonId: team.lead_person_id,
      wecomDeptId: team.wecom_dept_id,
      members: (byTeam.get(team.id) ?? []).map((member) => ({
        id: member.id,
        name: member.name,
        email: member.email,
        role: member.role,
        avatarColor: member.avatar_color,
        title: member.title,
      })),
      children: [],
    });
  }
  const roots: Record<string, unknown>[] = [];
  for (const team of map.values()) {
    const parentId = team.parentId as string | null;
    if (parentId && map.has(parentId)) (map.get(parentId)!.children as Record<string, unknown>[]).push(team);
    else roots.push(team);
  }
  return roots;
}

export function canEdit(role: string): boolean {
  return role === 'owner' || role === 'editor';
}

export function actorName(actor: Actor): string {
  return actor.person.name;
}


export function pageAccess(rc: RequestContext, pageId: string, level: 'viewer' | 'editor' | 'owner' = 'viewer') {
  const actor = requireActor(rc);
  const page = getPage(rc.app.db, pageId);
  if (!page) throw errors.notFound('知识页不存在');
  const library = getLibrary(rc.app.db, page.library_id);
  if (!library) throw errors.notFound('知识页不存在');
  const role = effectivePageRole(rc.app.db, actor, page);
  if (!role) throw errors.notFound('知识页不存在');
  if (!roleAtLeast(role, level)) throw errors.forbidden(level === 'viewer' ? '无权访问该知识页' : '需要更高的知识页权限');
  if (actor.viaApiKey && actor.apiScope === 'read' && level !== 'viewer') throw errors.forbidden('只读 API Key 不能修改知识页');
  return { actor, page, library, role };
}

export function sourceAccess(rc: RequestContext, sourceId: string, level: 'viewer' | 'editor' | 'owner' = 'viewer') {
  const actor = requireActor(rc);
  const source = rc.app.db.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId) as unknown as import('../types.ts').SourceRow | undefined;
  if (!source) throw errors.notFound('文献不存在');
  const library = getLibrary(rc.app.db, source.library_id);
  if (!library) throw errors.notFound('文献不存在');
  const role = effectiveSourceRole(rc.app.db, actor, source);
  if (!role) throw errors.notFound('文献不存在');
  if (!roleAtLeast(role, level)) throw errors.forbidden(level === 'viewer' ? '无权访问该文献' : '需要更高的文献权限');
  return { actor, source, library, role };
}
