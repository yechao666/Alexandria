import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, closeDatabase } from '../db/index.ts';
import { loadEnv } from '../env.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const env = loadEnv(root);
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

for (const [name, dir] of [['uploads', env.uploadsDir], ['thumbnails', env.thumbnailsDir]] as const) {
  if (!existsSync(dir)) continue;
  cpSync(dir, join(target, name), { recursive: true });
}
writeFileSync(
  join(target, 'manifest.json'),
  JSON.stringify(
    {
      createdAt: new Date().toISOString(),
      database: env.dbPath,
      target,
      includes: ['database (VACUUM INTO)', 'uploads', 'thumbnails'],
      note: '备份包含原始资料，请按敏感数据要求加密保存与访问控制。',
    },
    null,
    2,
  ),
);

const keepDays = Number(process.env.ALEXANDRIA_BACKUP_KEEP_DAYS ?? 14);
if (Number.isFinite(keepDays) && keepDays > 0) {
  const backups = join(env.dataDir, 'backups');
  const cutoff = Date.now() - keepDays * 86_400_000;
  const fs = await import('node:fs');
  for (const entry of fs.readdirSync(backups)) {
    const full = join(backups, entry);
    const stat = fs.statSync(full);
    if (stat.isDirectory() && stat.mtimeMs < cutoff) rmSync(full, { recursive: true, force: true });
  }
}
console.log(`[backup] 已创建 ${target}`);
