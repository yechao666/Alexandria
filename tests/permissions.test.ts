import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext } from './helpers.ts';
import {
  actorFor,
  effectiveRole,
  requireLibrary,
  visibleLibraries,
  effectivePageRole,
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

test('组织层级：上级可读下级团队的知识库，下级不能反向读取上级', () => {
  const engLead: Actor = actorFor(ctx.db, personById('usr_zhou'));
  const marketLead: Actor = actorFor(ctx.db, personById('usr_chen'));
  const knowledgeLead: Actor = actorFor(ctx.db, personById('usr_shen'));
  // 研发中心负责人可读下级知识运营组的库。
  assert.equal(effectiveRole(ctx.db, engLead, library('lib_research')), 'viewer');
  // 市场负责人不是产品上级，不能读取产品库。
  assert.equal(effectiveRole(ctx.db, marketLead, library('lib_product')), null);
  // 知识运营负责人可编辑自己团队的库，但不能编辑上级研发库（只读或无权）。
  assert.equal(effectiveRole(ctx.db, knowledgeLead, library('lib_research')), 'owner');
});

test('下级成员看不到上级知识库，除非显式共享', () => {
  const now = new Date().toISOString();
  ctx.db
    .prepare("INSERT INTO persons (id, email, name, title, avatar_color, is_admin, password_hash, status, created_at) VALUES ('usr_child', 'child@alex.dev', '子团队成员', '', 'slate', 0, 'x', 'active', ?)")
    .run(now);
  ctx.db
    .prepare("INSERT INTO team_members (team_id, person_id, role, created_at) VALUES ('team_knowledge', 'usr_child', 'member', ?)")
    .run(now);
  const child: Actor = actorFor(ctx.db, personById('usr_child'));
  assert.equal(effectiveRole(ctx.db, child, library('lib_eng')), null);
  ctx.db
    .prepare("INSERT INTO library_grants (id, library_id, subject_type, subject_id, role, created_by, created_at) VALUES ('grant_child_eng', 'lib_eng', 'person', 'usr_child', 'viewer', 'usr_lin', ?)")
    .run(now);
  assert.equal(effectiveRole(ctx.db, child, library('lib_eng')), 'viewer');
  ctx.db.prepare("DELETE FROM library_grants WHERE id = 'grant_child_eng'").run();
  ctx.db.prepare("DELETE FROM team_members WHERE person_id = 'usr_child'").run();
  ctx.db.prepare("DELETE FROM persons WHERE id = 'usr_child'").run();
});

test('页面级 ACL：restricted 页面仅所有者与显式共享者可见', () => {
  const page = ctx.db.prepare("SELECT * FROM pages WHERE library_id = 'lib_product' LIMIT 1").get() as unknown as import('../server/src/types.ts').PageRow;
  ctx.db.prepare("UPDATE pages SET visibility = 'restricted' WHERE id = ?").run(page.id);
  const restricted = ctx.db.prepare('SELECT * FROM pages WHERE id = ?').get(page.id) as unknown as import('../server/src/types.ts').PageRow;
  assert.equal(effectivePageRole(ctx.db, guest, restricted), null);
  ctx.db
    .prepare("INSERT INTO resource_grants (id, resource_type, resource_id, subject_type, subject_id, role, created_by, created_at) VALUES ('rg_test_guest', 'page', ?, 'person', 'usr_guest', 'viewer', 'usr_lin', ?)")
    .run(page.id, new Date().toISOString());
  assert.equal(effectivePageRole(ctx.db, guest, restricted), 'viewer');
  ctx.db.prepare("DELETE FROM resource_grants WHERE id = 'rg_test_guest'").run();
  ctx.db.prepare("UPDATE pages SET visibility = 'inherit' WHERE id = ?").run(page.id);
});
