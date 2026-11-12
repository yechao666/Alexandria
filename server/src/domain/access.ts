import type { Db } from '../db/index.ts';
import type { Actor, LibraryRow, PageRow, Person, Role, SourceRow } from '../types.ts';
import { HttpError, errors } from '../http/respond.ts';

const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

export function personRowToPerson(row: Record<string, unknown>): Person {
  return {
    id: String(row.id),
    email: String(row.email),
    name: String(row.name),
    title: String(row.title ?? ''),
    avatarColor: String(row.avatar_color ?? 'clay'),
    isAdmin: Boolean(row.is_admin),
    wecomUserid: row.wecom_userid ? String(row.wecom_userid) : null,
  };
}

export function teamIdsOf(db: Db, personId: string): string[] {
  const rows = db.prepare('SELECT team_id FROM team_members WHERE person_id = ?').all(personId) as unknown as {
    team_id: string;
  }[];
  return rows.map((row) => row.team_id);
}

export function leadTeamIds(db: Db, personId: string): string[] {
  const rows = db
    .prepare("SELECT team_id FROM team_members WHERE person_id = ? AND role = 'lead'")
    .all(personId) as unknown as { team_id: string }[];
  return rows.map((row) => row.team_id);
}

export function descendantTeamIds(db: Db, roots: string[]): string[] {
  if (!roots.length) return [];
  const placeholders = roots.map(() => '?').join(',');
  const rows = db
    .prepare(
      `WITH RECURSIVE subtree(id) AS (
         SELECT id FROM teams WHERE id IN (${placeholders})
         UNION
         SELECT t.id FROM teams t JOIN subtree s ON t.parent_id = s.id
       ) SELECT id FROM subtree`,
    )
    .all(...roots) as unknown as { id: string }[];
  return rows.map((row) => row.id);
}

export function actorFor(db: Db, person: Person): Actor {
  return { person, teamIds: teamIdsOf(db, person.id) };
}

export function parseActorFromPerson(db: Db, person: Person): Actor {
  return actorFor(db, person);
}

export function effectiveRole(db: Db, actor: Actor, library: LibraryRow): Role | null {
  if (actor.person.isAdmin) return 'owner';
  let best: Role | null = null;
  const bump = (role: string | null | undefined) => {
    if (!role || !(role in RANK)) return;
    const candidate = role as Role;
    if (!best || RANK[candidate] > RANK[best]) best = candidate;
  };

  // 本人所属团队：成员可编辑，负责人是所有者。
  if (library.owner_team_id && actor.teamIds.includes(library.owner_team_id)) {
    const lead = db
      .prepare("SELECT 1 FROM team_members WHERE team_id = ? AND person_id = ? AND role = 'lead'")
      .get(library.owner_team_id, actor.person.id);
    bump(lead ? 'owner' : 'editor');
  }

  // 组织层级：上级可以看到下级团队拥有的知识库，但只读；下级不能反向看到上级。
  const led = leadTeamIds(db, actor.person.id);
  if (led.length && library.owner_team_id) {
    const subtree = descendantTeamIds(db, led);
    if (subtree.includes(library.owner_team_id)) bump('viewer');
  }

  const grants = db
    .prepare('SELECT subject_type, subject_id, role FROM library_grants WHERE library_id = ?')
    .all(library.id) as unknown as { subject_type: string; subject_id: string; role: string }[];
  for (const grant of grants) {
    if (grant.subject_type === 'person' && grant.subject_id === actor.person.id) bump(grant.role);
    if (grant.subject_type === 'team' && actor.teamIds.includes(grant.subject_id)) bump(grant.role);
    if (grant.subject_type === 'org') bump(grant.role);
  }

  if (library.visibility === 'public') bump('viewer');
  // internal 不再等同于“所有登录用户可见”；必须由团队/层级/显式授权命中。
  return best;
}

export function resourceGrants(db: Db, resourceType: string, resourceId: string): { subjectType: string; subjectId: string; role: Role }[] {
  const rows = db
    .prepare('SELECT subject_type, subject_id, role FROM resource_grants WHERE resource_type = ? AND resource_id = ?')
    .all(resourceType, resourceId) as unknown as { subject_type: string; subject_id: string; role: string }[];
  return rows
    .filter((row) => row.role in RANK)
    .map((row) => ({ subjectType: row.subject_type, subjectId: row.subject_id, role: row.role as Role }));
}

function grantedResourceRole(
  db: Db,
  actor: Actor,
  resourceType: string,
  resourceId: string,
): Role | null {
  let best: Role | null = null;
  for (const grant of resourceGrants(db, resourceType, resourceId)) {
    const hit =
      (grant.subjectType === 'person' && grant.subjectId === actor.person.id) ||
      (grant.subjectType === 'team' && actor.teamIds.includes(grant.subjectId));
    if (hit && (!best || RANK[grant.role] > RANK[best])) best = grant.role;
  }
  return best;
}

/**
 * 文档/知识页 ACL：
 * - inherit：跟随知识库角色；
 * - restricted：仅知识库所有者、资源所有者、显式被共享者；
 * - private：仅资源所有者、显式被共享者与组织管理员。
 */
export function effectiveResourceRole(
  db: Db,
  actor: Actor,
  resourceType: 'page' | 'source',
  resourceId: string,
  libraryRole: Role | null,
  ownerId: string | null,
  visibility: string | null | undefined,
): Role | null {
  if (actor.person.isAdmin) return 'owner';
  const mode = visibility || 'inherit';
  if (mode === 'inherit') return libraryRole;
  if (!libraryRole && mode !== 'private') return null;
  const explicit = grantedResourceRole(db, actor, resourceType, resourceId);
  const isOwner = Boolean(ownerId && ownerId === actor.person.id);
  if (mode === 'private') {
    if (isOwner) return 'owner';
    return explicit;
  }
  // restricted
  if (libraryRole === 'owner') return 'owner';
  if (isOwner) return 'owner';
  return explicit;
}

export function effectivePageRole(db: Db, actor: Actor, page: PageRow): Role | null {
  const library = getLibrary(db, page.library_id);
  if (!library) return null;
  const libraryRole = effectiveRole(db, actor, library);
  return effectiveResourceRole(db, actor, 'page', page.id, libraryRole, page.owner_person_id ?? page.created_by ?? null, page.visibility);
}

export function effectiveSourceRole(db: Db, actor: Actor, source: SourceRow): Role | null {
  const library = getLibrary(db, source.library_id);
  if (!library) return null;
  const libraryRole = effectiveRole(db, actor, library);
  return effectiveResourceRole(db, actor, 'source', source.id, libraryRole, source.uploaded_by ?? null, source.visibility);
}

export function roleAtLeast(role: Role | null, level: Role): boolean {
  return Boolean(role && RANK[role] >= RANK[level]);
}

export function getLibrary(db: Db, idOrSlug: string): LibraryRow | null {
  const row = db
    .prepare('SELECT * FROM libraries WHERE id = ? OR slug = ?')
    .get(idOrSlug, idOrSlug) as unknown as LibraryRow | undefined;
  return row ?? null;
}

export function requireLibrary(
  db: Db,
  actor: Actor,
  idOrSlug: string,
  level: Role = 'viewer',
): { library: LibraryRow; role: Role } {
  const library = getLibrary(db, idOrSlug);
  if (!library) throw errors.notFound('知识库不存在');
  const role = effectiveRole(db, actor, library);
  if (!role) throw errors.notFound('知识库不存在'); // 严格隐藏私有库的存在
  if (!roleAtLeast(role, level)) throw errors.forbidden(level === 'viewer' ? '无权访问该知识库' : '需要更高的知识库权限');
  if (actor.viaApiKey && actor.apiScope === 'read' && level !== 'viewer') {
    throw errors.forbidden('只读 API Key 不能写入知识库');
  }
  return { library, role };
}

export function visibleLibraries(db: Db, actor: Actor): (LibraryRow & { role: Role })[] {
  const rows = db.prepare('SELECT * FROM libraries ORDER BY created_at ASC').all() as unknown as LibraryRow[];
  return rows
    .map((library) => ({ ...library, role: effectiveRole(db, actor, library) }))
    .filter((library): library is LibraryRow & { role: Role } => Boolean(library.role));
}

export function canManageLibrary(role: Role): boolean {
  return roleAtLeast(role, 'editor');
}

export function assertOwnership(role: Role): void {
  if (role !== 'owner') throw errors.forbidden('需要知识库所有者权限');
}

export { HttpError };
