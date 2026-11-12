import type { Db } from '../db/index.ts';
import type { Actor, LibraryRow, Person, Role } from '../types.ts';
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

  if (library.owner_team_id && actor.teamIds.includes(library.owner_team_id)) {
    const lead = db
      .prepare("SELECT 1 FROM team_members WHERE team_id = ? AND person_id = ? AND role = 'lead'")
      .get(library.owner_team_id, actor.person.id);
    bump(lead ? 'owner' : 'editor');
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
  if (library.visibility === 'internal' && actor.person.id) bump('viewer');
  return best;
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
