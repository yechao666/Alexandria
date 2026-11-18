#!/usr/bin/env node
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const ROOT = new URL('..', import.meta.url).pathname;
const BASE = process.env.ALEXANDRIA_URL || 'http://127.0.0.1:4520';
const LIB = 'lib_a316905460c5420a99c0';
const LIMIT = Number(process.env.STANDARDS_FULLTEXT_LIMIT || 18);
const REPROCESS = process.env.STANDARDS_REPROCESS === '1';
const OUT = join(ROOT, 'data', 'power-standards-fulltext');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Alexandria/1.0';
const PYTHON = process.env.ALEXANDRIA_PYTHON || '/Users/yechao/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function get(url, timeout = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { headers: { 'user-agent': UA, referer: 'https://hbba.sacinfo.org.cn/' }, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  } finally { clearTimeout(timer); }
}
async function login() {
  const response = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'lin@alex.dev', password: 'alex-demo' }) });
  if (!response.ok) throw new Error(`login ${response.status}`);
  return response.headers.get('set-cookie')?.split(';')[0];
}
async function api(path, cookie, options = {}) {
  const response = await fetch(`${BASE}${path}`, { ...options, headers: { cookie, ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `HTTP ${response.status}`);
  return data;
}
function makePdf(dir, file) {
  const script = `from PIL import Image\nimport os,sys\nfolder=sys.argv[1]\nfiles=sorted([f for f in os.listdir(folder) if f.endswith('.png')], key=lambda x:int(x.split('.')[0]))\nimages=[Image.open(os.path.join(folder,f)).convert('RGB') for f in files]\nif not images: sys.exit(2)\nimages[0].save(sys.argv[2], 'PDF', resolution=150.0, save_all=True, append_images=images[1:])\n`;
  const py = join(dir, 'make_pdf.py');
  writeFileSync(py, script);
  execFileSync(PYTHON, [py, dir, file], { stdio: 'ignore', timeout: 180_000 });
}
async function pageCount(pk) {
  const html = await (await get(`https://hbba.sacinfo.org.cn/attachment/onlineRead/${pk}`)).text();
  return Number(html.match(/size\s*:\s*parseInt\('(\d+)'\)/)?.[1] ?? 0);
}
async function main() {
  mkdirSync(OUT, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(ROOT, 'data/power-standards/manifest.json'), 'utf8')).standards;
  const cookie = await login();
  const sources = (await api(`/api/sources?library=${LIB}&limit=2000`, cookie)).sources ?? [];
  const byCode = new Map();
  for (const source of sources) {
    const code = manifest.find((item) => source.title.startsWith(item.code))?.code;
    if (code) byCode.set(code, source);
  }
  // 每个分类先取得候选页数，选最小的两篇，保证全文字段覆盖多个类别。
  const candidates = [];
  const groups = new Map();
  for (const item of manifest) {
    if (!groups.has(item.category)) groups.set(item.category, []);
    groups.get(item.category).push(item);
  }
  for (const [category, items] of groups) {
    const probe = items.slice(0, 8);
    for (const item of probe) {
      try {
        const pk = item.officialUrl.split('/').pop();
        const pages = await pageCount(pk);
        if (pages > 0) candidates.push({ ...item, pk, pages });
      } catch { /* ignore */ }
      await sleep(120);
      if (candidates.filter((x) => x.category === category).length >= 2) break;
    }
  }
  candidates.sort((a, b) => a.pages - b.pages);
  const picked = candidates.slice(0, LIMIT);
  console.log(`[fulltext] picked ${picked.length} standards, pages=${picked.reduce((sum, item) => sum + item.pages, 0)}`);
  let done = 0;
  for (const item of picked) {
    const source = byCode.get(item.code);
    if (!source) { console.warn(`[fulltext] no source ${item.code}`); continue; }
    const dir = join(tmpdir(), `alex-std-${item.pk}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    try {
      let downloaded = 0;
      const workers = Array.from({ length: 6 }, async () => {
        while (downloaded < item.pages) {
          const page = downloaded++;
          const response = await get(`https://hbba.sacinfo.org.cn/hbba_onlineRead_page/${item.pk}/${page}.png`);
          writeFileSync(join(dir, `${String(page).padStart(4, '0')}.png`), Buffer.from(await response.arrayBuffer()));
        }
      });
      await Promise.all(workers);
      const pdf = join(OUT, `${item.code.replace(/[^\w\u4e00-\u9fa5.-]+/g, '_')}.pdf`);
      makePdf(dir, pdf);
      const buffer = readFileSync(pdf);
      const response = await fetch(`${BASE}/api/sources/${encodeURIComponent(source.id)}/fulltext?reprocess=${REPROCESS ? '1' : '0'}&compiler=rule`, { method: 'POST', headers: { cookie, 'content-type': 'application/pdf' }, body: buffer });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result?.error?.message || `upload HTTP ${response.status}`);
      done += 1;
      console.log(`[fulltext] ${done}/${picked.length} ${item.code} ${item.pages}p ${(buffer.length / 1024 / 1024).toFixed(1)}MB${result.jobId ? ` job=${result.jobId}` : ''}`);
    } catch (error) {
      console.warn(`[fulltext] skip ${item.code}: ${error.message}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    await sleep(200);
  }
  console.log(`[fulltext] done ${done}/${picked.length} -> ${OUT}`);
}
main().catch((error) => { console.error(error); process.exit(1); });
