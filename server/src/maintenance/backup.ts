import { cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase, closeDatabase } from '../db/index.ts';
import { DatabaseSync } from 'node:sqlite';
import type { Env } from '../env.ts';

export function createBackup(env: Env): { target: string; files: number; verification: Record<string, unknown> } {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(env.dataDir, 'backups', `alexandria-${stamp}`);
  mkdirSync(target, { recursive: true });
  const dbTarget = join(target, 'alexandria.db');
  const db = openDatabase(env.dbPath);
  try {
    db.exec(`VACUUM INTO '${dbTarget.replace(/'/g, "''")}'`);
  } finally {
    closeDatabase(db);
  }
  let files = 1;
  for (const [name, dir] of [['uploads', env.uploadsDir], ['thumbnails', env.thumbnailsDir]] as const) {
    if (!existsSync(dir)) continue;
    cpSync(dir, join(target, name), { recursive: true });
  }
  const verify = new DatabaseSync(dbTarget, { readOnly: true });
  let verification: Record<string, unknown>;
  try {
    const checks = verify.prepare('PRAGMA integrity_check').all() as unknown as { integrity_check: string }[];
    const version = verify.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as unknown as { value: string } | undefined;
    const count = (table: string) => Number((verify.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as unknown as { c: number }).c);
    verification = {
      ok: checks.every((row) => row.integrity_check === 'ok'),
      integrity: checks.map((row) => row.integrity_check),
      schemaVersion: version?.value ?? null,
      counts: { persons: count('persons'), pages: count('pages'), sources: count('sources') },
    };
  } finally {
    verify.close();
  }
  writeFileSync(
    join(target, 'manifest.json'),
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        database: env.dbPath,
        target,
        includes: ['database (VACUUM INTO)', 'uploads', 'thumbnails'],
        verification,
        note: '备份包含原始资料，请按敏感数据要求加密保存与访问控制。',
      },
      null,
      2,
    ),
  );
  if (!(verification.ok === true)) throw new Error('备份数据库完整性校验失败');
  for (const entry of readdirSync(target)) files += 1;
  const keepDays = Number(process.env.ALEXANDRIA_BACKUP_KEEP_DAYS ?? 14);
  if (Number.isFinite(keepDays) && keepDays > 0) {
    const backups = join(env.dataDir, 'backups');
    const cutoff = Date.now() - keepDays * 86_400_000;
    for (const entry of readdirSync(backups)) {
      const full = join(backups, entry);
      try {
        if (statSync(full).isDirectory() && statSync(full).mtimeMs < cutoff) rmSync(full, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  }
  return { target, files, verification };
}
