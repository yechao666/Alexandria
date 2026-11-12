import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeServer,
  createDocxFixture,
  createEpubFixture,
  createImageFixture,
  createOdtFixture,
  createPdfFixture,
  createPptxFixture,
  createScannedPdfFixture,
  createTestContext,
  createXlsxFixture,
  login,
  startTestServer,
} from './helpers.ts';

const ctx = createTestContext();
const { server, base } = await startTestServer(ctx.app);
const { token } = await login(base, 'lin@alex.dev');

test.after(async () => {
  await closeServer(server);
  ctx.cleanup();
});

async function j<T>(path: string): Promise<T> {
  const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return (await response.json()) as T;
}

async function upload(libraryId: string, path: string, title: string, filename = path.split('/').pop()!) {
  const response = await fetch(`${base}/api/libraries/${libraryId}/sources`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/octet-stream',
      'x-filename': encodeURIComponent(filename),
      'x-title': encodeURIComponent(title),
    },
    body: readFileSync(path),
  });
  const data = (await response.json()) as { source: { id: string; kind: string; status: string }; jobId: string; duplicate: boolean };
  assert.equal(response.status, 202, JSON.stringify(data));
  assert.equal(data.duplicate, false);
  let job: Record<string, unknown> | null = null;
  for (let i = 0; i < 600; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const result = await j<{ job: Record<string, unknown> }>(`/api/jobs/${data.jobId}`);
    job = result.job;
    if (job && (job.status === 'succeeded' || job.status === 'failed')) break;
  }
  assert.equal(job?.status, 'succeeded', JSON.stringify(job));
  const source = await j<{ source: { status: string; kind: string; wordCount: number } }>(`/api/sources/${data.source.id}`);
  assert.equal(source.source.status, 'ready');
  assert.ok(source.source.wordCount >= 0);
  return { source: source.source, job };
}

test('全格式入库流水线：PDF/DOCX/PPTX/XLSX/TeX/RTF/图片/扫描PDF/MD/HTML/CSV/JSON/ODT/EPUB/WPS', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'alex-formats-'));
  const cases: { path: string; title: string; filename?: string; kind: string; library?: string }[] = [
    { path: createPdfFixture(dir), title: '格式验收 PDF', kind: 'pdf' },
    { path: createScannedPdfFixture(dir), title: '格式验收扫描PDF', kind: 'pdf' },
    { path: createDocxFixture(dir), title: '格式验收 DOCX', kind: 'docx' },
    { path: createPptxFixture(dir), title: '格式验收 PPTX', kind: 'pptx' },
    { path: createXlsxFixture(dir), title: '格式验收 XLSX', kind: 'xlsx' },
    { path: createImageFixture(dir), title: '格式验收图片OCR', kind: 'image' },
    { path: createOdtFixture(dir), title: '格式验收 ODT', kind: 'odt' },
    { path: createEpubFixture(dir), title: '格式验收 EPUB', kind: 'epub' },
    { path: createDocxFixture(dir), title: '格式验收 WPS', filename: 'legacy.wps', kind: 'docx', library: 'lib_research' },
  ];
  const rtf = join(dir, 'demo.rtf');
  writeFileSync(rtf, '{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Helvetica;}}\\f0 \\u30693?\\u35782?\\u32534?\\u35793?\\par \\u20837?\\u24211?\\u26102?\\u32534?\\u35793?\\u12290?}', 'utf8');
  cases.push({ path: rtf, title: '格式验收 RTF', kind: 'rtf' });

  const textCases: { filename: string; title: string; content: string; kind: string }[] = [
    { filename: 'demo.md', title: '格式验收 Markdown', kind: 'markdown', content: '# 知识编译\n\n## 定义\n知识编译是入库时的结构化过程。\n' },
    { filename: 'demo.html', title: '格式验收 HTML', kind: 'html', content: '<html><body><h1>知识编译</h1><p>HTML 入库测试。</p></body></html>' },
    { filename: 'demo.csv', title: '格式验收 CSV', kind: 'csv', content: '名称,值\n知识编译,1\n检索,2\n' },
    { filename: 'demo.json', title: '格式验收 JSON', kind: 'json', content: '[{"名称":"知识编译","值":1}]' },
    { filename: 'demo.tex', title: '格式验收 TeX', kind: 'tex', content: '\\documentclass{article}\\begin{document}\\section{知识编译}知识编译在入库时完成。\\end{document}' },
  ];
  for (const item of textCases) {
    const path = join(dir, item.filename);
    writeFileSync(path, item.content, 'utf8');
    cases.push({ path, title: item.title, kind: item.kind });
  }

  for (const item of cases) {
    const library = item.library ?? 'lib_eng';
    const { source } = await upload(library, item.path, item.title, item.filename);
    assert.equal(source.kind, item.kind, `${item.title} kind`);
    const result = await j<{ hits: { title: string }[] }>(`/api/search?library=${library}&q=${encodeURIComponent(item.title)}`);
    assert.ok(result.hits.length > 0, `${item.title} 应可检索`);
  }
});
