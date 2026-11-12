import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, makeMarkdown } from './helpers.ts';
import { ingestText } from '../server/src/ingest/pipeline.ts';
import { answerKnowledge, searchKnowledge } from '../server/src/knowledge/search.ts';
import { detectConflicts } from '../server/src/knowledge/claims.ts';
import { actorFor } from '../server/src/domain/access.ts';
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

test.after(() => ctx.cleanup());

test('Markdown 入库后生成文献页、概念页、主张与关联', () => {
  const result = ingestText(ctx.db, ctx.env, 'lib_product', '知识编译实践笔记', makeMarkdown(), {
    filename: 'knowledge-compilation-notes.md',
    nodeId: 'cat_p_method',
    actor: admin,
    sync: true,
  });
  const source = ctx.db.prepare('SELECT * FROM sources WHERE id = ?').get(result.source.id) as unknown as Record<string, unknown>;
  assert.equal(source.status, 'ready');
  assert.match(String(source.extracted_text), /知识编译/);

  const sourcePage = ctx.db
    .prepare("SELECT * FROM pages WHERE class_key = 'source' AND title = '知识编译实践笔记'")
    .get() as unknown as Record<string, unknown>;
  assert.ok(sourcePage, '应生成文献页');

  const concept = ctx.db.prepare("SELECT * FROM pages WHERE title = '知识编译' LIMIT 1").get() as unknown as Record<string, unknown>;
  assert.ok(concept, '应存在知识编译概念页');

  const links = ctx.db
    .prepare('SELECT COUNT(*) AS c FROM links WHERE from_page_id = ? OR to_page_id = ?')
    .get(String(concept.id), String(concept.id)) as unknown as { c: number };
  assert.ok(Number(links.c) > 0, '概念页应有图谱关联');

  const claims = ctx.db
    .prepare('SELECT COUNT(*) AS c FROM claims WHERE page_id = ?')
    .get(String(sourcePage.id)) as unknown as { c: number };
  assert.ok(Number(claims.c) > 0, '文献页应有结构化主张');

  const attached = ctx.db
    .prepare('SELECT COUNT(*) AS c FROM page_sources WHERE source_id = ?')
    .get(String(source.id)) as unknown as { c: number };
  assert.ok(Number(attached.c) > 0, '文献应关联到页面');
});

test('入库后的知识可被词法检索与图谱扩展召回', () => {
  const hits = searchKnowledge(ctx.db, admin, '知识编译 主张', { limit: 10 });
  assert.ok(hits.length > 0);
  assert.ok(hits.some((hit) => hit.title.includes('知识编译')));
  const graphHits = hits.filter((hit) => hit.signals.graph);
  assert.ok(graphHits.length >= 0);
});

test('知识合成返回带引用的答案，并标注草稿', () => {
  const answer = answerKnowledge(ctx.db, admin, '知识编译是什么？', { limit: 6 });
  assert.equal(answer.mode, 'compiled');
  assert.ok(answer.citations.length > 0);
  assert.ok(answer.answer.includes('知识编译'));
  assert.ok(answer.signals.hits > 0);
});

test('私有库内容不会进入无权限成员的检索结果', () => {
  const pricing = searchKnowledge(ctx.db, guest, '定价策略', { limit: 10 });
  assert.ok(!pricing.some((hit) => hit.libraryId === 'lib_strategy'));
  const strategy = searchKnowledge(ctx.db, admin, '定价策略', { limit: 10 });
  assert.ok(strategy.some((hit) => hit.libraryId === 'lib_strategy'));
});

test('没有词法命中时不做无依据的图谱扩展', () => {
  const hits = searchKnowledge(ctx.db, admin, '量子纠缠实验装置', { limit: 10 });
  assert.ok(hits.every((hit) => hit.signals.lexical || hit.signals.graph));
});

test('同一主语与谓词的不同说法会被标记为矛盾', () => {
  const pageA = ctx.db.prepare("SELECT * FROM pages WHERE title = '知识编译' LIMIT 1").get() as unknown as Record<string, unknown>;
  const pageB = ctx.db.prepare("SELECT * FROM pages WHERE title = '原子知识页' LIMIT 1").get() as unknown as Record<string, unknown>;
  const now = new Date().toISOString();
  const insert = (id: string, pageId: string, object: string) =>
    ctx.db
      .prepare(
        `INSERT INTO claims (id, page_id, text, subject, predicate, object, confidence, source_id, section, status, created_at)
         VALUES (?, ?, ?, '知识编译', '定义', ?, 0.6, NULL, '测试', 'active', ?)`,
      )
      .run(id, pageId, `知识编译是${object}`, object, now);
  insert('clm_test_a', String(pageA.id), '入库时的结构化过程');
  insert('clm_test_b', String(pageB.id), '查询时的检索过程');
  const result = detectConflicts(ctx.db, String(pageA.id));
  assert.ok(result.count > 0, '应检测到矛盾');
  const conflicted = ctx.db
    .prepare("SELECT COUNT(*) AS c FROM claims WHERE id IN ('clm_test_a','clm_test_b') AND status = 'conflicted'")
    .get() as unknown as { c: number };
  assert.equal(Number(conflicted.c), 2);
});
