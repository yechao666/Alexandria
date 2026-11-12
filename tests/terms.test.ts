import test from 'node:test';
import assert from 'node:assert/strict';
import { keyphrases, normalizeTitle, queryTokens, termsString, tokenize, splitSentences } from '../server/src/knowledge/terms.ts';

test('中文分词产生单字与双字，供 FTS5 使用', () => {
  const tokens = tokenize('知识编译');
  for (const expected of ['知', '知识', '识编', '编译', '知识编译']) {
    assert.ok(tokens.includes(expected), `缺少 ${expected}`);
  }
});

test('查询分词去掉被长词覆盖的单字噪声', () => {
  const tokens = queryTokens('为什么不用查询期 RAG？');
  assert.ok(tokens.includes('查询'));
  assert.ok(tokens.includes('rag'));
  assert.ok(!tokens.includes('查'));
});

test('关键短语抽取不产生以虚词开头/结尾的碎片', () => {
  const text =
    '知识编译是指在资料入库时把原文转化为原子知识页、主张与关联的过程。' +
    '知识编译不同于查询期 RAG。编译流程包括解析、抽取、合并与索引。编译器会更新已有页面并标记矛盾。';
  const phrases = keyphrases(text, 12);
  assert.ok(phrases.includes('知识编译'));
  for (const phrase of phrases) {
    assert.ok(!/^[的了和与及或在是为对从把被将让给由于中上下内外这那其之而也都就还又很更最]/.test(phrase), `bad start: ${phrase}`);
    assert.ok(!/[的了和与及或在是为对从把被将让给由于之而都就还又很更最]$/.test(phrase), `bad end: ${phrase}`);
  }
  assert.ok(!phrases.some((phrase) => phrase.includes('分钟讲问题')), '不应出现跨词的碎片');
});

test('标题归一化忽略空白与标点', () => {
  assert.equal(normalizeTitle('知识 编译：实践'), normalizeTitle('知识编译实践'));
});

test('FTS terms 去重并保留空格', () => {
  const terms = termsString('知识编译 知识编译');
  assert.ok(terms.split(' ').length > 1);
  assert.equal(new Set(terms.split(' ')).size, terms.split(' ').length);
});

test('句子切分保留中文句号', () => {
  const sentences = splitSentences('知识编译在入库时完成。检索沿图谱导航！');
  assert.equal(sentences.length, 2);
});
