#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const BASE = process.env.ALEXANDRIA_URL || 'http://127.0.0.1:4520';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const login = async () => {
  const response = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'lin@alex.dev', password: 'alex-demo' }) });
  if (!response.ok) throw new Error(`login ${response.status}`);
  return response.headers.get('set-cookie')?.split(';')[0];
};
const api = async (path, cookie, options = {}) => {
  const response = await fetch(`${BASE}${path}`, { ...options, headers: { cookie, ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `HTTP ${response.status}`);
  return data;
};
const safe = (value) => String(value).replace(/[^\w\u4e00-\u9fa5.-]+/g, '_');

async function main() {
  const cookie = await login();
  const libraries = (await api('/api/libraries', cookie)).libraries ?? [];
  for (const library of libraries) await api(`/api/libraries/${library.id}`, cookie, { method: 'DELETE' });

  const power = (await api('/api/libraries', cookie, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '电力行业资料库', slug: 'power-industry', description: '只保留电力行业公开资料。', visibility: 'internal', color: 'jade' }) })).library;
  const standards = (await api('/api/libraries', cookie, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '电力行业标准库', slug: 'power-standards', description: '电力行业标准真实 PDF，不录入跳转页或条目页。', visibility: 'internal', color: 'indigo' }) })).library;
  console.log('libraries', power.id, standards.id);

  const powerNodes = new Map();
  const powerCategories = ['发电', '输电', '变电', '配电', '用电', '电力市场', '电力设备', '政策标准'];
  for (const name of powerCategories) {
    const created = await api(`/api/libraries/${power.id}/nodes`, cookie, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, kind: 'section' }) });
    powerNodes.set(name, created.node.id);
  }
  const standardNodes = new Map();
  const standardCategories = ['基础与通用', '发电与新能源', '输电', '变电', '配电与用电', '工程建设', '设备与试验', '安全与环保', '市场与调度'];
  for (const name of standardCategories) {
    const created = await api(`/api/libraries/${standards.id}/nodes`, cookie, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, kind: 'section' }) });
    standardNodes.set(name, created.node.id);
  }

  const powerManifest = JSON.parse(readFileSync(join(ROOT, 'data/power-corpus/manifest.json'), 'utf8')).documents ?? [];
  let powerUploaded = 0, powerFailed = 0;
  for (const doc of powerManifest) {
    const node = powerNodes.get(doc.topic || '发电') ?? powerNodes.get('发电');
    const file = join(ROOT, 'data/power-corpus', doc.file);
    if (!existsSync(file)) { powerFailed++; continue; }
    try {
      const response = await fetch(`${BASE}/api/libraries/${power.id}/sources`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(`${doc.id}.md`), 'x-title': encodeURIComponent(doc.title), 'x-node-id': node },
        body: readFileSync(file),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      powerUploaded++;
      if (powerUploaded % 25 === 0) console.log(`power ${powerUploaded}/${powerManifest.length}`);
    } catch (error) { powerFailed++; console.warn('power fail', doc.title, error.message); }
    await sleep(35);
  }

  const manifest = JSON.parse(readFileSync(join(ROOT, 'data/power-standards/manifest.json'), 'utf8')).standards ?? [];
  const pdfFiles = new Map();
  for (const file of readdirSync(join(ROOT, 'data/power-standards-fulltext'))) {
    if (file.endsWith('.pdf')) pdfFiles.set(file, join(ROOT, 'data/power-standards-fulltext', file));
  }
  let standardUploaded = 0, standardSkipped = 0, standardFailed = 0;
  for (const item of manifest) {
    const pdfName = `${safe(item.code)}.pdf`;
    //文件名在不同 code 中会有差异，按去掉扩展名的前缀匹配
    const match = [...pdfFiles.entries()].find(([file]) => file.replace(/\.pdf$/, '').replace(/[-_]/g, '') === pdfName.replace(/\.pdf$/, '').replace(/[-_]/g, ''));
    if (!match) { standardSkipped++; continue; }
    try {
      const response = await fetch(`${BASE}/api/libraries/${standards.id}/sources`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/pdf', 'x-filename': encodeURIComponent(match[0]), 'x-title': encodeURIComponent(`${item.code} ${item.title}`), 'x-node-id': standardNodes.get(item.category) ?? standardNodes.get('基础与通用') },
        body: readFileSync(match[1]),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      standardUploaded++;
      if (standardUploaded % 50 === 0) console.log(`standards ${standardUploaded}/${manifest.length}`);
    } catch (error) { standardFailed++; console.warn('standard fail', item.code, error.message); }
    await sleep(35);
  }
  console.log({ powerUploaded, powerFailed, standardUploaded, standardSkipped, standardFailed });
}
main().catch((error) => { console.error(error); process.exit(1); });
