import type { Db } from '../db/index.ts';
import type { RequestContext } from '../http/context.ts';
import { newId, nowIso } from '../lib/ids.ts';

export interface SecurityEventInput {
  kind: string;
  severity?: 'info' | 'warning' | 'critical';
  actorId?: string | null;
  subject?: string;
  ip?: string | null;
  detail?: Record<string, unknown>;
}

export function securityEvent(db: Db, input: SecurityEventInput): void {
  try {
    db.prepare(
      `INSERT INTO security_events (id, kind, severity, actor_id, subject, ip, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId('sec'),
      input.kind,
      input.severity ?? 'info',
      input.actorId ?? null,
      input.subject ?? '',
      input.ip ?? null,
      JSON.stringify(input.detail ?? {}),
      nowIso(),
    );
  } catch {
    /* 安全审计不可阻塞主流程 */
  }
}

export function requestIp(rc: RequestContext): string | null {
  const forwarded = String(rc.req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim();
  return forwarded || rc.req.socket.remoteAddress || null;
}

export function notifyTeamLeads(db: Db, teamId: string): string[] {
  return (db.prepare("SELECT person_id FROM team_members WHERE team_id = ? AND role = 'lead'").all(teamId) as unknown as {
    person_id: string;
  }[]).map((row) => row.person_id);
}

export function grantRecipients(db: Db, subjectType: string, subjectId: string): string[] {
  if (subjectType === 'person') return [subjectId];
  if (subjectType === 'team') return notifyTeamLeads(db, subjectId);
  return [];
}
