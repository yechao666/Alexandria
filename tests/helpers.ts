import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { loadEnv, type Env } from '../server/src/env.ts';
import { migrate, openDatabase, type Db } from '../server/src/db/index.ts';
import { seedDatabase } from '../server/src/seed/seed.ts';
import { createRouter } from '../server/src/routes/index.ts';
import { createHttpServer } from '../server/src/http/server.ts';
import type { AppContext } from '../server/src/http/context.ts';
import { actorFor } from '../server/src/domain/access.ts';
import type { Actor } from '../server/src/types.ts';

export interface TestContext {
  root: string;
  env: Env;
  db: Db;
  app: AppContext;
  actor: Actor;
  cleanup: () => void;
}

export function pythonBin(): string {
  if (process.env.DSH_PYTHON) return process.env.DSH_PYTHON;
  const bundled = '/Users/yechao/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3';
  return existsSync(bundled) ? bundled : 'python3';
}

export function createTestContext(options: { seed?: boolean } = {}): TestContext {
  const root = mkdtempSync(join(tmpdir(), 'alex-test-'));
  mkdirSync(join(root, 'data', 'uploads'), { recursive: true });
  mkdirSync(join(root, 'data', 'thumbs'), { recursive: true });
  const env = loadEnv(root);
  env.dataDir = join(root, 'data');
  env.dbPath = join(root, 'data', 'test.db');
  env.uploadsDir = join(root, 'data', 'uploads');
  env.thumbnailsDir = join(root, 'data', 'thumbs');
  env.webDir = join(root, 'web');
  env.dsh.enabled = false;
  const db = openDatabase(env.dbPath);
  migrate(db);
  if (options.seed !== false) seedDatabase(db, env);
  const app: AppContext = { db, env, now: () => new Date().toISOString() };
  const person = db.prepare("SELECT * FROM persons WHERE id = 'usr_lin'").get() as unknown as Record<string, unknown>;
  const actor = actorFor(db, {
    id: String(person.id),
    email: String(person.email),
    name: String(person.name),
    title: String(person.title),
    avatarColor: String(person.avatar_color),
    isAdmin: true,
  });
  return {
    root,
    env,
    db,
    app,
    actor,
    cleanup: () => {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    },
  };
}

export async function startTestServer(app: AppContext): Promise<{ server: Server; base: string }> {
  const server = createHttpServer(app, createRouter());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server address unavailable');
  return { server, base: `http://127.0.0.1:${address.port}` };
}

export async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

export async function login(base: string, email: string, password = 'alex-demo'): Promise<{ token: string; person: unknown }> {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = (await response.json()) as { token: string; person: unknown };
  if (!response.ok) throw new Error(`login failed: ${JSON.stringify(data)}`);
  return data;
}

export function makeMarkdown(): string {
  return `# 知识编译实践

## 什么是知识编译
知识编译是指在资料入库时把原文转化为原子知识页、主张与关联的过程。它不同于查询期 RAG，不会在每次提问时重新切块。

## 编译流程
1. 解析原始文件，识别章节与图片。
2. 抽取概念与定义，合并到已有页面。
3. 建立类型化关联，标记矛盾。
4. 写入全文索引，使知识立即可检索。

## 检索策略
检索使用 SQLite FTS5 做词法召回，再沿知识图谱扩展一跳，最后按标题覆盖与置信度重排。不需要在查询时调用向量模型。

## 结论
知识库应当先写清楚知识，再谈检索。
`;
}

export function createDocxFixture(dir: string): string {
  const path = join(dir, 'demo.docx');
  const script = `
from docx import Document
doc = Document()
doc.add_heading('产品需求评审规范', level=1)
doc.add_paragraph('需求评审用于在研发投入前确认价值、边界与验收标准。')
doc.add_heading('评审流程', level=2)
doc.add_paragraph('产品经理先讲问题与证据，研发评估技术风险，设计确认边界状态。')
doc.add_heading('验收标准', level=2)
doc.add_paragraph('在 4G 网络下首屏可交互时间小于 2 秒。')
table = doc.add_table(rows=2, cols=2)
table.cell(0,0).text = '角色'
table.cell(0,1).text = '职责'
table.cell(1,0).text = '产品经理'
table.cell(1,1).text = '定义问题与验收标准'
doc.save(${JSON.stringify(path)})
`;
  execFileSync(pythonBin(), ['-c', script], { timeout: 60_000 });
  return path;
}

export function createPptxFixture(dir: string): string {
  const path = join(dir, 'demo.pptx');
  const script = `
from pptx import Presentation
prs = Presentation()
slide = prs.slides.add_slide(prs.slide_layouts[1])
slide.shapes.title.text = '知识库架构'
slide.placeholders[1].text = '资料入库后编译为知识页\\n检索沿图谱导航'
slide2 = prs.slides.add_slide(prs.slide_layouts[1])
slide2.shapes.title.text = '权限模型'
slide2.placeholders[1].text = '组织 / 团队 / 个人三层授权'
prs.save(${JSON.stringify(path)})
`;
  execFileSync(pythonBin(), ['-c', script], { timeout: 60_000 });
  return path;
}

export function createXlsxFixture(dir: string): string {
  const path = join(dir, 'demo.xlsx');
  const script = `
from openpyxl import Workbook
wb = Workbook()
ws = wb.active
ws.title = '指标'
ws.append(['指标', '目标', '负责人'])
ws.append(['入库时延', '30 秒', '周砚'])
ws.append(['引用率', '60%', '沈书言'])
wb.save(${JSON.stringify(path)})
`;
  execFileSync(pythonBin(), ['-c', script], { timeout: 60_000 });
  return path;
}

export function createPdfFixture(dir: string): string {
  const textPath = join(dir, 'demo.txt');
  const pdfPath = join(dir, 'demo.pdf');
  writeFileSync(textPath, 'Alexandria PDF test\nKnowledge compilation and ontology.\nSearch uses FTS5 and a typed graph.\n');
  const output = execFileSync('cupsfilter', [textPath], {
    timeout: 60_000,
    maxBuffer: 20 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  writeFileSync(pdfPath, output);
  return pdfPath;
}

export function createOdtFixture(dir: string): string {
  const path = join(dir, 'demo.odt');
  const script = `
import zipfile
path = ${JSON.stringify(path)}
content = '''<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:h text:outline-level="1">知识编译</text:h><text:p>知识编译在入库时完成。</text:p><text:h text:outline-level="2">检索</text:h><text:p>检索使用 FTS5 与图谱。</text:p></office:text></office:body></office:document-content>'''
with zipfile.ZipFile(path, 'w') as z:
    z.writestr('mimetype', 'application/vnd.oasis.opendocument.text')
    z.writestr('content.xml', content)
`;
  execFileSync(pythonBin(), ['-c', script], { timeout: 60_000 });
  return path;
}

export function createEpubFixture(dir: string): string {
  const path = join(dir, 'demo.epub');
  const script = `
import zipfile
path = ${JSON.stringify(path)}
html = '''<html><body><h1>知识编译</h1><p>知识编译是入库时的结构化过程。</p></body></html>'''
with zipfile.ZipFile(path, 'w') as z:
    z.writestr('mimetype', 'application/epub+zip')
    z.writestr('OEBPS/chapter1.xhtml', html)
`;
  execFileSync(pythonBin(), ['-c', script], { timeout: 60_000 });
  return path;
}

export function createScannedPdfFixture(dir: string): string {
  const path = join(dir, 'scanned.pdf');
  const script = `
from PIL import Image, ImageDraw, ImageFont
img = Image.new('RGB', (900, 1200), 'white')
d = ImageDraw.Draw(img)
font = ImageFont.truetype('/System/Library/Fonts/Hiragino Sans GB.ttc', 44)
d.text((40, 60), '扫描版 PDF 测试', font=font, fill='black')
d.text((40, 160), '知识编译与图像识别', font=font, fill='black')
d.text((40, 260), '这一页没有文本层。', font=font, fill='black')
img.save(${JSON.stringify(path)})
`;
  execFileSync(pythonBin(), ['-c', script], { timeout: 60_000 });
  return path;
}

export function createImageFixture(dir: string): string {
  const path = join(dir, 'ocr.png');
  const script = `
from PIL import Image, ImageDraw, ImageFont
img = Image.new('RGB', (900, 320), 'white')
d = ImageDraw.Draw(img)
font = ImageFont.truetype('/System/Library/Fonts/Hiragino Sans GB.ttc', 44)
d.text((30, 60), '亚历山大知识库', font=font, fill='black')
d.text((30, 150), '知识编译与图像识别', font=font, fill='black')
img.save(${JSON.stringify(path)})
`;
  execFileSync(pythonBin(), ['-c', script], { timeout: 60_000 });
  return path;
}
