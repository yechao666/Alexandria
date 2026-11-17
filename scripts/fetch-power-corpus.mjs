#!/usr/bin/env node
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'data', 'power-corpus');
const SOURCE = '中国能源新闻网';
const CATEGORIES = [
  ['power', '电力', 'https://www.cpnn.com.cn/news/dianli2023/'],
  ['headline', '能源要闻', 'https://www.cpnn.com.cn/news/xwtt/'],
  ['industry', '行业观察', 'https://www.cpnn.com.cn/news/hy/'],
  ['regulation', '监管与市场', 'https://www.cpnn.com.cn/news/nyjg/'],
  ['new-energy', '新能源', 'https://www.cpnn.com.cn/news/xny/'],
  ['policy', '政策与宏观', 'https://www.cpnn.com.cn/news/hg/'],
];
const PAGES = 3;
const TARGET = 220;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Alexandria/1.0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decode = (value) => String(value ?? '')
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
const strip = (html) => decode(String(html ?? '')
  .replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/<(?:br|\/p|\/div|\/h[1-6]|\/li|\/tr)[^>]*>/gi, '\n\n')
  .replace(/<[^>]+>/g, ' '))
  .replace(/[ \t\u00a0]+/g, ' ')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

async function get(url, timeout = 25000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,*/*' }, signal: controller.signal, redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally { clearTimeout(timer); }
}

function categoryUrl(base, page) {
  const url = new URL(base);
  if (page <= 1) return url.href;
  return new URL(`index_${page - 1}.html`, url).href;
}

async function listing(category, page) {
  const url = categoryUrl(category[2], page);
  const html = await get(url);
  const links = [];
  const seen = new Set();
  for (const match of html.matchAll(/<a[^>]+href=['"]([^'"]+\.html)['"][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = match[1];
    if (!/t20\d{6}_\d+\.html/.test(href)) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    const title = strip(match[2]);
    if (title.length < 5) continue;
    links.push({ url: new URL(href, url).href, title });
  }
  return links;
}

async function article(item, category) {
  const html = await get(item.url);
  const title = strip(html.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)?.[1] ?? item.title);
  const time = strip(html.match(/<p class="times"[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? '').match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? '';
  const start = html.search(/<meta\s+name="ContentStart"/i);
  const end = html.search(/<meta\s+name="ContentEnd"/i);
  if (start < 0 || end <= start) throw new Error('no article content marker');
  const body = strip(html.slice(start, end));
  if (body.length < 120) throw new Error('body too short');
  return { title, published: time, body };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const manifestPath = join(OUT, 'manifest.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { documents: [] };
  manifest.documents = manifest.documents.filter((doc) => doc.sourceUrl?.includes('cpnn.com.cn'));
  const urls = new Set(manifest.documents.map((doc) => doc.sourceUrl));
  const titles = new Set(manifest.documents.map((doc) => doc.title));
  let added = 0;
  for (const category of CATEGORIES) {
    for (let page = 1; page <= PAGES; page += 1) {
      if (manifest.documents.length >= TARGET) break;
      console.log(`[fetch] ${category[1]} page ${page}`);
      let items = [];
      try { items = await listing(category, page); } catch (error) { console.warn('listing failed', error.message); break; }
      console.log(`  links ${items.length}`);
      for (const item of items) {
        if (manifest.documents.length >= TARGET) break;
        if (urls.has(item.url) || titles.has(item.title)) continue;
        try {
          const parsed = await article(item, category);
          if (titles.has(parsed.title)) continue;
          const id = item.url.match(/_(\d+)\.html/)?.[1] ?? String(Date.now());
          const dir = join(OUT, category[0]);
          mkdirSync(dir, { recursive: true });
          const file = `${category[0]}-${id}.md`;
          const markdown = `# ${parsed.title}\n\n> 来源：${SOURCE} · ${category[1]}\n> 原文链接：${item.url}\n> 发布时间：${parsed.published || '未知'}\n> 抓取时间：${new Date().toISOString()}\n\n${parsed.body}\n`;
          writeFileSync(join(dir, file), markdown, 'utf8');
          manifest.documents.push({ id: `${category[0]}-${id}`, title: parsed.title, categoryKey: category[0], categoryName: category[1], sourceUrl: item.url, publishedAt: parsed.published, fetchedAt: new Date().toISOString(), file: `${category[0]}/${file}`, chars: parsed.body.length });
          urls.add(item.url); titles.add(parsed.title); added += 1;
          console.log(`  + ${manifest.documents.length} ${parsed.title.slice(0, 40)}`);
        } catch (error) {
          console.warn(`  ! ${item.title.slice(0, 24)}: ${error.message}`);
        }
        await sleep(90);
      }
    }
    if (manifest.documents.length >= TARGET) break;
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`[fetch] done ${added} new / ${manifest.documents.length} total -> ${OUT}`);
}
main().catch((error) => { console.error(error); process.exit(1); });
