import test from 'node:test';
import assert from 'node:assert/strict';
import { extractRuleEntities, isValidEntityName } from '../server/src/knowledge/entities.ts';

test('实体校验拒绝从句碎片和泛化名称', () => {
  for (const bad of ['为新型电网', '实现电网', '该标准由南方电网', '时期西宁电网', '也為新型电网', '东北能源监管局通报电网', '1S098铁塔', '集团有限公司', '论坛在苏州大学']) {
    assert.equal(isValidEntityName(bad), false, bad);
  }
  for (const good of ['国家电网', '南方电网', '国网蒙东电力', '中国华能', '特高压', '中国电建集团北京勘测设计研究院有限公司']) {
    assert.equal(isValidEntityName(good), true, good);
  }
});

test('实体抽取只保留可验证机构与设备', () => {
  const entities = extractRuleEntities('为新型电网 实现电网 该标准由南方电网 国家电网有限公司 中国华能集团有限公司 国网内蒙古东部电力有限公司 特高压', '测试资料');
  const names = entities.map((entity) => entity.name);
  assert.ok(names.includes('国家电网'));
  assert.ok(names.includes('南方电网'));
  assert.ok(names.includes('中国华能'));
  assert.ok(names.includes('国网蒙东电力'));
  assert.ok(!names.some((name) => name.includes('新型电网')));
  assert.ok(!names.some((name) => name.includes('标准由')));
});
