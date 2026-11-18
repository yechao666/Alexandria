import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext } from './helpers.ts';
import { openDatabase, migrate } from '../server/src/db/index.ts';
import { loadRegexRules, extractRegexMatches } from '../server/src/knowledge/regex-rules.ts';

test('公共正则规则已种子化且能处理重叠匹配', () => {
  const ctx = createTestContext();
  try {
    const db = openDatabase(ctx.env.dbPath);
    migrate(db);
    const rules = loadRegexRules(db, 'lib_eng');
    assert.ok(rules.length >= 20);
    const text = '邮箱 a@b.com，手机 13812345678，身份证 110105199001011234，邮编 100031，合同 HT-2026-00123，快递 SF1234567890123。';
    const matches = extractRegexMatches(rules, text);
    const names = matches.map((match) => match.name);
    assert.ok(names.includes('邮箱'));
    assert.ok(names.includes('手机号'));
    assert.equal(names.filter((name) => name === '身份证号').length, 1);
    // 身份证号不应同时被识别为银行卡/统一社会信用代码/发票号
    assert.equal(names.filter((name) => ['银行卡号', '统一社会信用代码', '发票号码'].includes(name)).length, 0);
    assert.ok(names.includes('合同编号'));
    assert.ok(names.includes('快递单号'));
    db.close();
  } finally {
    ctx.cleanup();
  }
});
