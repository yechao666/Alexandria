#!/usr/bin/env node
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const ROOT = new URL('..', import.meta.url).pathname;
const BASE = process.env.ALEXANDRIA_URL || 'http://127.0.0.1:4520';
const LIB = 'lib_a316905460c5420a99c0';
const OUT = join(ROOT, 'data', 'power-standards-fulltext');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Alexandria/1.0';
const PYTHON = process.env.ALEXANDRIA_PYTHON || '/Users/yechao/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (url) => {
  const response = await fetch(url, { headers: { 'user-agent': UA, referer: 'https://hbba.sacinfo.org.cn/' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
};
const login = async () => {
  const response = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'lin@alex.dev', password: 'alex-demo' }) });
  if (!response.ok) throw new Error(`login ${response.status}`);
  return response.headers.get('set-cookie')?.split(';')[0];
};
function makePdf(dir, file) {
  const script = `from PIL import Image\nimport os,sys\nfolder=sys.argv[1]\nfiles=sorted([f for f in os.listdir(folder) if f.endswith('.png')], key=lambda x:int(x.split('.')[0]))\nimages=[Image.open(os.path.join(folder,f)).convert('RGB') for f in files]\nif not images: sys.exit(2)\nimages[0].save(sys.argv[2], 'PDF', resolution=150.0, save_all=True, append_images=images[1:])\n`;
  const py = join(dir, 'make_pdf.py');
  writeFileSync(py, script);
  execFileSync(PYTHON, [py, dir, file], { stdio: 'ignore', timeout: 600_000 });
}
async function main() {
  mkdirSync(OUT, { recursive: true });
  const standards = JSON.parse(readFileSync(join(ROOT, 'data/power-standards/manifest.json'), 'utf8')).standards;
  const cookie = await login();
  const sources = (await (await fetch(`${BASE}/api/sources?library=${LIB}&limit=2000`, { headers: { cookie } })).json()).sources ?? [];
  const byCode = new Map();
  for (const source of sources) {
    const item = standards.find((entry) => source.title.startsWith(entry.code));
    if (item) byCode.set(item.code, source);
  }
  let ok = 0, skipped = 0, failed = 0;
  for (const item of standards) {
    const source = byCode.get(item.code);
    if (!source) { skipped++; continue; }
    if (source.filename === 'standard-fulltext.pdf') { skipped++; continue; }
    try {
      const pk = item.officialUrl.split('/').pop();
      const html = await (await get(`https://hbba.sacinfo.org.cn/attachment/onlineRead/${pk}`)).text();
      const pages = Number(html.match(/size\s*:\s*parseInt\('(\d+)'\)/)?.[1] ?? 0);
      if (!pages || pages > 400) { skipped++; continue; }
      const dir = join(tmpdir(), `alex-all-${pk}`);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      let next = 0;
      const workers = Array.from({ length: 6 }, async () => {
        while (next < pages) {
          const page = next++;
          const response = await get(`https://hbba.sacinfo.org.cn/hbba_onlineRead_page/${pk}/${page}.png`);
          writeFileSync(join(dir, `${String(page).padStart(4, '0')}.png`), Buffer.from(await response.arrayBuffer()));
        }
      });
      await Promise.all(workers);
      const pdf = join(OUT, `${item.code.replace(/[^\w\u4e00-\u9fa5.-]+/g, '_')}.pdf`);
      makePdf(dir, pdf);
      const buffer = readFileSync(pdf);
      const response = await fetch(`${BASE}/api/sources/${encodeURIComponent(source.id)}/fulltext?reprocess=0`, { method: 'POST', headers: { cookie, 'content-type': 'application/pdf' }, body: buffer });
      if (!response.ok) throw new Error(`upload ${response.status}`);
      ok++;
      console.log(`[all] ${ok} ${item.code} ${pages}p ${(buffer.length / 1024 / 1024).toFixed(1)}MB ok=${ok} skip=${skipped} fail=${failed}`);
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      failed++;
      console.warn(`[all] fail ${item.code}: ${error.message}`);
    }
    await sleep(100);
  }
  console.log(`[all] done ok=${ok} skipped=${skipped} failed=${failed}`);
}
main().catch((error) => { console.error(error); process.exit(1); });
