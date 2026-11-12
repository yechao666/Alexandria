import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext } from './helpers.ts';
import {
  actorFor,
  effectiveRole,
  requireLibrary,
  visibleLibraries,
} from '../server/src/domain/access.ts';
import type { Actor, Person } from '../server/src/types.ts';

const ctx = createTestContext();

function personById(id: string): Person {
  const row = ctx.db.prepare('SELECT * FROM persons WHERE id = ?').get(id) as unknown as Record<string, unknown>;
  return {
    id: String(row.id),
    email: String(row.email),
    name: String(row.name),
    title: String(row.title),
    avatarColor: String(row.avatar_color),
    isAdmin: Boolean(row.is_admin),
  };
}

const admin = ctx.actor;
const guest: Actor = actorFor(ctx.db, personById('usr_guest'));
const productLead: Actor = actorFor(ctx.db, personById('usr_su'));
const strategist: Actor = actorFor(ctx.db, personById('usr_shen'));

function library(id: string) {
  return ctx.db.prepare('SELECT * FROM libraries WHERE id = ?').get(id) as unknown as import('../server/src/types.ts').LibraryRow;
}

test.after(() => ctx.cleanup());

test('组织管理员对所有库拥有 owner 角色', () => {
  assert.equal(effectiveRole(ctx.db, admin, library('lib_strategy')), 'owner');
  assert.equal(effectiveRole(ctx.db, admin, library('lib_product')), 'owner');
});

test('团队负责人因团队归属获得所有者，普通成员获得只读', () => {
  assert.equal(effectiveRole(ctx.db, productLead, library('lib_product')), 'owner');
  assert.equal(effectiveRole(ctx.db, guest, library('lib_product')), 'viewer');
});

test('私有库对无授权成员完全隐藏（404 而非 403）', () => {
  assert.equal(effectiveRole(ctx.db, guest, library('lib_strategy')), null);
  assert.throws(() => requireLibrary(ctx.db, guest, 'lib_strategy'), (error: any) => error.status === 404);
  assert.equal(effectiveRole(ctx.db, strategist, library('lib_strategy')), 'owner');
});

test('可见库列表按权限过滤', () => {
  const adminLibs = visibleLibraries(ctx.db, admin).map((item) => item.id);
  const guestLibs = visibleLibraries(ctx.db, guest).map((item) => item.id);
  assert.ok(adminLibs.includes('lib_strategy'));
  assert.ok(!guestLibs.includes('lib_strategy'));
  assert.ok(guestLibs.includes('lib_product'));
});

test('按个人授权后私有库变为可见', () => {
  ctx.db
    .prepare(
      "INSERT INTO library_grants (id, library_id, subject_type, subject_id, role, created_by, created_at) VALUES ('grant_test_guest', 'lib_strategy', 'person', 'usr_guest', 'viewer', 'usr_lin', ?)",
    )
    .run(new Date().toISOString());
  assert.equal(effectiveRole(ctx.db, guest, library('lib_strategy')), 'viewer');
  assert.ok(visibleLibraries(ctx.db, guest).some((item) => item.id === 'lib_strategy'));
  ctx.db.prepare("DELETE FROM library_grants WHERE id = 'grant_test_guest'").run();
});

test('只读 API Key 不能执行写权限检查', () => {
  const readActor: Actor = { ...admin, viaApiKey: true, apiScope: 'read' };
  assert.throws(
    () => requireLibrary(ctx.db, readActor, 'lib_product', 'editor'),
    (error: any) => error.status === 403,
  );
});
