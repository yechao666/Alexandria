import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext } from './helpers.ts';
import { runMaintenance } from '../server/src/maintenance/scheduler.ts';
import { createBackup } from '../server/src/maintenance/backup.ts';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { newId, nowIso } from '../server/src/lib/ids.ts';

const ctx = createTestContext();

test.after(() => ctx.cleanup());

test('维护任务清理过期会话、挑战与超期回收站', () => {
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  ctx.db.prepare("INSERT INTO sessions (token_hash, person_id, created_at, expires_at) VALUES ('expired-test', 'usr_lin', ?, ?)").run(old, old);
  ctx.db.prepare("INSERT INTO login_challenges (token_hash, person_id, expires_at, attempts, created_at) VALUES ('challenge-test', 'usr_lin', ?, 0, ?)").run(old, old);
  ctx.db
    .prepare("INSERT INTO trash_pages (id, page_id, library_id, snapshot, deleted_by, deleted_at) VALUES (?, 'page-gone', 'lib_eng', '{}', 'usr_lin', ?)")
    .run(newId('trash'), old);
  const result = runMaintenance(ctx.db, ctx.env);
  assert.equal(result.sessions, 1);
  assert.equal(result.challenges, 1);
  assert.equal(result.trash, 1);
  assert.equal((ctx.db.prepare("SELECT COUNT(*) c FROM trash_pages WHERE page_id = 'page-gone'").get() as unknown as { c: number }).c, 0);
});

test('备份完成后会校验数据库并写入 manifest', () => {
  const backup = createBackup(ctx.env);
  try {
    const manifest = JSON.parse(readFileSync(join(backup.target, 'manifest.json'), 'utf8')) as { verification: { ok: boolean; counts: { pages: number } } };
    assert.equal(manifest.verification.ok, true);
    assert.ok(manifest.verification.counts.pages > 0);
  } finally {
    rmSync(backup.target, { recursive: true, force: true });
  }
});
