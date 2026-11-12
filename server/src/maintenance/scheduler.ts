import type { Db } from '../db/index.ts';
import type { Env } from '../env.ts';
import { audit } from '../domain/audit.ts';
import { securityEvent } from '../domain/security.ts';
import { notifyPerson } from '../domain/notifications.ts';
import { nowIso } from '../lib/ids.ts';
import { createBackup } from './backup.ts';
import { uploadBackupToS3 } from './s3.ts';

let running = false;

export interface MaintenanceResult {
  sessions: number;
  challenges: number;
  oidcStates: number;
  wecomStates: number;
  auditDeleted: number;
  securityDeleted: number;
  reviewReminders: number;
  trash: number;
  backup: string | null;
}

/** 清理过期会话/状态与超期回收站；可选自动备份。 */
export function runMaintenance(db: Db, env: Env): MaintenanceResult {
  if (running) return { sessions: 0, challenges: 0, oidcStates: 0, wecomStates: 0, auditDeleted: 0, securityDeleted: 0, reviewReminders: 0, trash: 0, backup: null };
  running = true;
  try {
    const now = nowIso();
    const sessions = Number(db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now).changes);
    const challenges = Number(db.prepare('DELETE FROM login_challenges WHERE expires_at <= ?').run(now).changes);
    const oidcStates = Number(db.prepare('DELETE FROM oidc_states WHERE expires_at <= ?').run(now).changes);
    const wecomStates = Number(db.prepare('DELETE FROM wecom_auth_states WHERE expires_at <= ?').run(now).changes);
    const reviewCutoff = new Date(Date.now() - env.reviewSlaDays * 86_400_000).toISOString();
    const dueReviews = db.prepare("SELECT id, title, review_assignee FROM pages WHERE review_assignee IS NOT NULL AND review_status <> 'approved' AND status NOT IN ('archived','deleted') AND updated_at < ? AND (review_reminded_at IS NULL OR review_reminded_at < ?)").all(reviewCutoff, new Date(Date.now() - 86_400_000).toISOString()) as unknown as { id: string; title: string; review_assignee: string }[];
    for (const page of dueReviews) {
      void notifyPerson(db, env, { personId: page.review_assignee, kind: 'review', title: `校对超时提醒：「${page.title}」`, body: `该页已超过 ${env.reviewSlaDays} 天未完成校对。`, link: `/#/page/${encodeURIComponent(page.id)}` });
      db.prepare('UPDATE pages SET review_reminded_at = ? WHERE id = ?').run(now, page.id);
    }
    const auditCutoff = new Date(Date.now() - env.auditRetentionDays * 86_400_000).toISOString();
    const auditDeleted = Number(db.prepare('DELETE FROM audit_events WHERE created_at < ?').run(auditCutoff).changes);
    const securityDeleted = Number(db.prepare('DELETE FROM security_events WHERE created_at < ?').run(auditCutoff).changes);
    const cutoff = new Date(Date.now() - env.trashRetentionDays * 86_400_000).toISOString();
    const expired = db.prepare('SELECT id, library_id FROM trash_pages WHERE restored_at IS NULL AND deleted_at < ?').all(cutoff) as unknown as { id: string; library_id: string }[];
    for (const item of expired) {
      db.prepare('DELETE FROM trash_pages WHERE id = ?').run(item.id);
      audit(db, { action: 'trash.retention_purge', targetType: 'trash', targetId: item.id, libraryId: item.library_id });
    }
    if (expired.length) securityEvent(db, { kind: 'trash.retention_purge', severity: 'info', subject: `${expired.length} 个回收站快照`, detail: { cutoff } });
    let backup: string | null = null;
    if (env.autoBackupHours > 0) {
      const meta = db.prepare("SELECT value FROM meta WHERE key = 'last_auto_backup'").get() as unknown as { value: string } | undefined;
      const due = !meta || Date.now() - Date.parse(meta.value) >= env.autoBackupHours * 3_600_000;
      if (due) {
        backup = createBackup(env).target;
        void uploadBackupToS3(env, backup).catch((error) => console.warn('[maintenance] S3 备份失败', (error as Error).message));
        db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('last_auto_backup', ?)").run(now);
      }
    }
    return { sessions, challenges, oidcStates, wecomStates, auditDeleted, securityDeleted, reviewReminders: dueReviews.length, trash: expired.length, backup };
  } finally {
    running = false;
  }
}

export function startMaintenance(db: Db, env: Env): void {
  const interval = Math.max(5, env.maintenanceIntervalMinutes) * 60_000;
  const tick = () => {
    try {
      const result = runMaintenance(db, env);
      if (result.trash || result.backup) console.log('[maintenance]', result);
    } catch (error) {
      console.warn('[maintenance] failed', (error as Error).message);
    }
  };
  setTimeout(tick, 60_000).unref?.();
  setInterval(tick, interval).unref?.();
}
