import type { Db } from '../db/index.ts';
import type { Actor } from '../types.ts';
import { newId, nowIso } from '../lib/ids.ts';

export interface AuditInput {
  actor?: Actor | null;
  action: string;
  targetType?: string;
  targetId?: string;
  libraryId?: string | null;
  detail?: unknown;
  ip?: string | null;
}

export function audit(db: Db, input: AuditInput): void {
  db.prepare(
    `INSERT INTO audit_events (id, actor_id, actor_name, action, target_type, target_id, library_id, detail, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId('aud'),
    input.actor?.person.id ?? null,
    input.actor?.person.name ?? 'system',
    input.action,
    input.targetType ?? '',
    input.targetId ?? '',
    input.libraryId ?? null,
    JSON.stringify(input.detail ?? {}),
    input.ip ?? null,
    nowIso(),
  );
}
