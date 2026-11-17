#!/usr/bin/env node
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'data', 'power-standards');
const API = 'https://hbba.sacinfo.org.cn/stdQueryList';
const TARGET = Number(process.env.STANDARDS_TARGET || 500);
const PAGES = Math.ceil(Math.min(1800, TARGET * 2) / 50);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Alexandria/1.0';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const decode = (value) => String(value ?? '')
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
const strip = (html) => decode(String(html ?? '')
  .replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/<(?:br|\/p|\/div|\/h[1-6]|\/li|\/tr)[^>]*>/gi, '\n')
  .replace(/<[^>]+>/g, ' '))
  .replace(/[ \t\u00a0]+/g, ' ')
  .replace(/\n{3,}/g, '\n\n')
  .trim();
const date = (value) => {
  const stamp = Number(value);
  if (!Number.isFinite(stamp) || stamp <= 0) return '';
  return new Date(stamp).toISOString().slice(0, 10);
};

async function get(url, timeout = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,*/*' }, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally { clearTimeout(timer); }
}

async function listing(page) {
  const response = await fetch(API, {
    method: 'POST',
    headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ current: String(page), size: '50', industry: '电力' }),
  });
  if (!response.ok) throw new Error(`listing HTTP ${response.status}`);
  const data = await response.json();
  return { records: data.records ?? [], total: Number(data.total ?? 0) };
}

function categoryOf(title, scope) {
  const text = `${title} ${scope}`;
  if (/变电站|变压器|换流站|开关站|GIS|电抗器/.test(text)) return '变电';
  if (/配电|配网|台区|农网|供电服务|用电|充电|负荷|需求侧/.test(text)) return '配电与用电';
  if (/电力市场|交易|调度|现货|辅助服务|绿证|电价/.test(text)) return '市场与调度';
  if (/输电|特高压|线路|电网|外送|直流|交流/.test(text)) return '输电';
  if (/风电|光伏|光热|储能|氢能|新能源|水电|核电|火电|煤电|发电|机组|电站/.test(text)) return '发电与新能源';
  if (/安全|环保|节能|碳排放|职业健康|消防/.test(text)) return '安全与环保';
  if (/施工|工程|建设|验收|监理|土建|安装/.test(text)) return '工程建设';
  if (/试验|检测|计量|设备|仪器|绝缘|继电保护|自动化|通信/.test(text)) return '设备与试验';
  return '基础与通用';
}

function detailText(html) {
  const text = strip(html);
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const between = (start, end) => {
    const from = lines.findIndex((line) => line.includes(start));
    if (from < 0) return '';
    const to = end ? lines.findIndex((line, index) => index > from && line.includes(end)) : -1;
    return lines.slice(from + 1, to > from ? to : undefined).join('\n').trim();
  };
  const title = lines[0] ?? '';
  const code = lines[1] ?? '';
  const scope = between('适用范围', '起草单位') || between('范围', '起草单位') || between('适用范围', '起草人') || '';
  const field = (name) => {
    const index = lines.findIndex((line) => line.includes(name));
    return index >= 0 ? (lines[index + 1] ?? '') : '';
  };
  return {
    title: title || field('标准名称'),
    code: code || field('标准号'),
    scope: scope.slice(0, 6000),
    publishDate: field('发布日期'),
    implementDate: field('实施日期'),
    status: field('标准状态') || field('状态'),
    committee: field('技术归口'),
    publisher: field('批准发布部门'),
    ccs: field('中国标准分类号'),
    ics: field('国际标准分类号'),
    drafters: between('起草单位', '起草人').slice(0, 1600),
  };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const manifestPath = join(OUT, 'manifest.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { standards: [] };
  const seen = new Set(manifest.standards.map((item) => item.code));
  let candidates = [];
  for (let page = 1; page <= PAGES; page += 1) {
    const data = await listing(page);
    if (page === 1) console.log(`[standards] total=${data.total} pages=${Math.ceil(data.total / 50)}`);
    candidates.push(...data.records);
    if (candidates.length >= TARGET * 2 || data.records.length === 0) break;
    await sleep(120);
  }
  candidates = candidates
    .filter((record) => record.status === '现行' || String(record.code).startsWith('DL/T') || String(record.code).startsWith('NB/T'))
    .sort((left, right) => Number(right.issueDate ?? 0) - Number(left.issueDate ?? 0));
  const picked = [];
  for (const record of candidates) {
    if (picked.length >= TARGET) break;
    if (seen.has(record.code)) continue;
    seen.add(record.code);
    picked.push(record);
  }
  console.log(`[standards] picked ${picked.length} records for detail fetch`);
  let added = 0;
  let index = 0;
  const workers = Array.from({ length: 4 }, async () => {
    while (index < picked.length) {
      const record = picked[index++];
      try {
        const html = await get(`https://hbba.sacinfo.org.cn/stdDetail/${record.pk}`);
        const detail = detailText(html);
        const code = record.code || detail.code;
        const title = record.chName || detail.title;
        const category = categoryOf(title, detail.scope);
        const scope = detail.scope || '官方页面未提供适用范围，请查看原文。';
        const implementStamp = Number(record.actDate);
        const status = implementStamp > Date.now() ? '即将实施' : (record.status || detail.status || '未知');
        const markdown = [
          `# ${code} ${title}`,
          '',
          `> 标准号：${code}`,
          `> 标准名称：${title}`,
          `> 状态：${status}`,
          `> 发布日期：${date(record.issueDate) || detail.publishDate || '未知'}`,
          `> 实施日期：${date(record.actDate) || detail.implementDate || '未知'}`,
          `> 批准发布部门：${record.chargeDept || detail.publisher || '国家能源局'}`,
          `> 技术归口：${detail.committee || '未提供'}`,
          `> 中国标准分类号：${detail.ccs || '未提供'}`,
          `> 国际标准分类号：${detail.ics || '未提供'}`,
          `> 行业：${record.industry || '电力'}`,
          `> 官方条目：https://hbba.sacinfo.org.cn/stdDetail/${record.pk}`,
          `> 在线预览：https://hbba.sacinfo.org.cn/attachment/onlineRead/${record.pk}`,
          `> 抓取时间：${new Date().toISOString()}`,
          '',
          '## 适用范围',
          scope,
          '',
          detail.drafters ? `## 起草单位\n${detail.drafters}\n` : '',
          '## 使用说明',
          '本标准条目录入自全国标准信息公共服务平台（行业标准备案）。全文版权归发布机构所有；在线预览与正式文本请以官方页面为准。',
          '',
        ].join('\n');
        const dir = join(OUT, category);
        mkdirSync(dir, { recursive: true });
        const safeCode = code.replace(/[^\w\u4e00-\u9fa5.\-—]+/g, '_').slice(0, 64);
        const file = `${safeCode}.md`;
        writeFileSync(join(dir, file), markdown, 'utf8');
        manifest.standards.push({ code, title, category, status, publishDate: date(record.issueDate), implementDate: date(record.actDate), publisher: record.chargeDept || detail.publisher || '', officialUrl: `https://hbba.sacinfo.org.cn/stdDetail/${record.pk}`, file: `${category}/${file}`, chars: markdown.length });
        added += 1;
        if (added % 25 === 0) console.log(`[standards] saved ${added}/${picked.length}`);
      } catch (error) {
        console.warn(`[standards] skip ${record.code}: ${error.message}`);
      }
      await sleep(90);
    }
  });
  await Promise.all(workers);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`[standards] done ${added} new / ${manifest.standards.length} total -> ${OUT}`);
}
main().catch((error) => { console.error(error); process.exit(1); });
