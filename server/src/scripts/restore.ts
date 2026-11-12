import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { loadEnv } from '../env.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const env = loadEnv(root);
const args = process.argv.slice(2);
const source = args.find((arg) => !arg.startsWith('--'));
const force = args.includes('--force');
const targetRoot = resolve(env.dataDir);
if (!source) {
  console.error('用法: npm run restore -- <backupDir> [--force]');
  process.exit(2);
}
const backupDir = resolve(source);
const backupDb = join(backupDir, 'alexandria.db');
if (!existsSync(backupDb)) {
  console.error(`备份数据库不存在: ${backupDb}`);
  process.exit(2);
}
if (existsSync(join(targetRoot, 'alexandria.db')) && !force) {
  console.error(`目标已有数据库: ${join(targetRoot, 'alexandria.db')}；确认覆盖请加 --force`);
  process.exit(2);
}
if (!force && existsSync(targetRoot) && statSync(targetRoot).isDirectory()) {
  const entries = readFileSync(join(backupDir, 'manifest.json'), 'utf8');
  console.log('[restore] 清单', entries.slice(0, 200));
}
const verify = new DatabaseSync(backupDb, { readOnly: true });
try {
  const result = verify.prepare('PRAGMA integrity_check').all() as unknown as { integrity_check: string }[];
  const version = verify.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as unknown as { value: string } | undefined;
  console.log('[restore] SQLite integrity_check:', result.map((row) => row.integrity_check).join(', '));
  console.log('[restore] schema_version:', version?.value ?? 'unknown');
  if (result.some((row) => row.integrity_check !== 'ok')) {
    console.error('[restore] 备份数据库完整性失败，已中止');
    process.exit(1);
  }
} finally {
  verify.close();
}
mkdirSync(targetRoot, { recursive: true });
if (force) {
  for (const target of [join(targetRoot, 'alexandria.db'), join(targetRoot, 'alexandria.db-wal'), join(targetRoot, 'alexandria.db-shm')]) {
    if (existsSync(target)) rmSync(target, { force: true });
  }
}
cpSync(backupDb, join(targetRoot, 'alexandria.db'));
for (const name of ['uploads', 'thumbnails']) {
  const from = join(backupDir, name);
  if (!existsSync(from)) continue;
  cpSync(from, join(targetRoot, name), { recursive: true, force: true });
}
console.log(`[restore] 已恢复到 ${targetRoot}。请重启 Alexandria，并核对账号/权限/文件。`);
console.log(`[restore] 源备份: ${basename(backupDir)}`);
