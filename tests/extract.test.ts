import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractBuffer, extractFile } from '../server/src/extract/index.ts';
import { sectionsFromMarkdown } from '../server/src/extract/sections.ts';
import { extractTex } from '../server/src/extract/tex.ts';
import { createDocxFixture, createImageFixture, createPdfFixture, createPptxFixture, createXlsxFixture } from './helpers.ts';

test('Markdown 按标题切分章节', () => {
  const parsed = sectionsFromMarkdown('# 标题\n\n## 第一节\n内容一\n\n## 第二节\n内容二');
  assert.equal(parsed.sections.length, 2);
  assert.equal(parsed.sections[0]?.title, '第一节');
  assert.equal(parsed.text.match(/内容一/g)?.length, 1, '正文不应重复首段');
});

test('TeX 抽取章节并去掉命令', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alex-tex-'));
  const path = join(dir, 'demo.tex');
  writeFileSync(
    path,
    '\\documentclass{article}\n\\begin{document}\n\\section{知识编译}\n知识编译在入库时完成。\n\\section{检索}\n检索使用 FTS5 与图谱。\n\\end{document}',
    'utf8',
  );
  const result = extractTex(path);
  assert.equal(result.kind, 'tex');
  assert.ok(result.sections.length >= 2);
  assert.match(result.text, /知识编译/);
  assert.doesNotMatch(result.text, /documentclass/);
});

test('DOCX 抽取标题、段落与表格', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alex-docx-'));
  const path = createDocxFixture(dir);
  const result = extractFile(path, 'demo.docx');
  assert.equal(result.kind, 'docx');
  assert.ok(result.sections.some((section) => section.title.includes('评审')), JSON.stringify(result.sections));
  assert.match(result.text, /验收标准/);
  assert.match(result.text, /产品经理/);
  assert.ok(result.warnings.length === 0);
});

test('PPTX 逐页抽取', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alex-pptx-'));
  const path = createPptxFixture(dir);
  const result = extractFile(path, 'demo.pptx');
  assert.equal(result.kind, 'pptx');
  assert.equal(result.pageCount, 2);
  assert.ok(result.sections.some((section) => section.title.includes('知识库架构')));
});

test('XLSX 多工作表转表格', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alex-xlsx-'));
  const path = createXlsxFixture(dir);
  const result = extractFile(path, 'demo.xlsx');
  assert.equal(result.kind, 'xlsx');
  assert.match(result.text, /入库时延/);
  assert.match(result.text, /周砚/);
});

test('PDF 抽取文本层', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alex-pdf-'));
  const path = createPdfFixture(dir);
  const result = extractFile(path, 'demo.pdf');
  assert.equal(result.kind, 'pdf');
  assert.match(result.text.toLowerCase(), /alexandria/);
});

test('图片 OCR 识别中文并保留尺寸', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alex-img-'));
  const path = createImageFixture(dir);
  const result = extractFile(path, 'ocr.png');
  assert.equal(result.kind, 'image');
  assert.match(result.text, /亚历山大知识库/);
  assert.equal(result.metadata.width, 900);
});

test('WPS 的 OOXML 变体按 DOCX 解析', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alex-wps-'));
  const docx = createDocxFixture(dir);
  const buffer = readFileSync(docx);
  const result = extractBuffer(buffer, 'legacy.wps');
  assert.equal(result.kind, 'docx');
  assert.match(result.text, /需求评审/);
});

test('RTF 抽取中文', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alex-rtf-'));
  const path = join(dir, 'demo.rtf');
  writeFileSync(path, '{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Helvetica;}}\\f0 \\u30693?\\u35782?\\u32534?\\u35793?\\par \\u20837?\\u24211?\\u25191?\\u34892?}', 'utf8');
  const result = extractFile(path, 'demo.rtf');
  assert.match(result.text, /知识编译/);
});

test('HTML 抽取标题与正文', () => {
  const buffer = Buffer.from('<html><head><title>知识库</title></head><body><h1>知识编译</h1><p>在入库时编译。</p><h2>检索</h2><p>沿图谱导航。</p></body></html>');
  const result = extractBuffer(buffer, 'demo.html');
  assert.equal(result.kind, 'html');
  assert.ok(result.sections.some((section) => section.title === '知识编译'));
});
