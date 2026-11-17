#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const BASE = process.env.ALEXANDRIA_URL || 'http://127.0.0.1:4520';
const MANIFEST = join(ROOT, 'data', 'power-standards', 'manifest.json');
const LIB_SLUG = 'power-standards';
const LIB_NAME = '电力行业标准库';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function login() {
  const response = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'lin@alex.dev', password: 'alex-demo' }) });
  if (!response.ok) throw new Error(`login ${response.status}`);
  return response.headers.get('set-cookie')?.split(';')[0];
}
async function req(path, cookie, options = {}) {
  const response = await fetch(`${BASE}${path}`, { ...options, headers: { cookie, ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `HTTP ${response.status}`);
  return data;
}
async function main() {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const standards = manifest.standards ?? [];
  const cookie = await login();
  const libraries = await req('/api/libraries', cookie);
  let library = (libraries.libraries ?? []).find((item) => item.slug === LIB_SLUG);
  if (!library) {
    library = (await req('/api/libraries', cookie, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: LIB_NAME, slug: LIB_SLUG, description: '我国电力行业 DL/T、NB/T 等标准条目录入：标准号、状态、适用范围、发布/实施日期与官方链接。', visibility: 'internal', ownerTeamId: 'team_knowledge', color: 'indigo' }) })).library;
  }
  const detail = await req(`/api/libraries/${library.id}`, cookie);
  const nodeMap = new Map();
  const walk = (nodes) => { for (const node of nodes) { nodeMap.set(node.name, node.id); walk(node.children ?? []); } };
  walk(detail.nodes ?? []);
  const categories = [...new Set(standards.map((item) => item.category))];
  for (const category of categories) {
    if (nodeMap.has(category)) continue;
    const created = await req(`/api/libraries/${library.id}/nodes`, cookie, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: category, kind: 'section', description: `${category}标准` }) });
    nodeMap.set(category, created.node.id);
  }
  console.log(`[standards] library=${library.id} docs=${standards.length} categories=${categories.length}`);
  let index = 0;
  let ok = 0, duplicate = 0, failed = 0;
  const failures = [];
  const workers = Array.from({ length: 3 }, async () => {
    while (index < standards.length) {
      const item = standards[index++];
      try {
        const buffer = readFileSync(join(ROOT, 'data', 'power-standards', item.file));
        const response = await fetch(`${BASE}/api/libraries/${encodeURIComponent(library.id)}/sources`, { method: 'POST', headers: { cookie, 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(item.code.replace(/[/\\]/g, '_') + '.md'), 'x-title': encodeURIComponent(`${item.code} ${item.title}`), 'x-node-id': nodeMap.get(item.category) || '', 'x-compile': 'rule' }, body: buffer });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result?.error?.message || `HTTP ${response.status}`);
        if (result.duplicate) duplicate += 1; else ok += 1;
        if ((ok + duplicate) % 50 === 0) console.log(`[standards] ${ok + duplicate}/${standards.length} ok=${ok} dup=${duplicate}`);
      } catch (error) {
        failed += 1; failures.push({ code: item.code, error: error.message });
        console.warn(`[standards] fail ${item.code}: ${error.message}`);
      }
      await sleep(60);
    }
  });
  await Promise.all(workers);
  console.log(`[standards] uploaded ok=${ok} duplicate=${duplicate} failed=${failed}`);
  if (failures.length) console.log(JSON.stringify(failures.slice(0, 10), null, 2));
  let last = '';
  for (let i = 0; i < 600; i += 1) {
    await sleep(3000);
    const tasks = await req('/api/tasks?limit=1', cookie);
    const queue = tasks.queue || {};
    const line = `active=${queue.active ?? 0} pending=${queue.pending ?? 0}`;
    if (line !== last) { console.log(`[standards] queue ${line}`); last = line; }
    if (!queue.active && !queue.pending) break;
  }
  const final = await req(`/api/libraries/${library.id}`, cookie);
  console.log(`[standards] done pages=${final.counts?.pages} sources=${final.counts?.sources}`);
}
main().catch((error) => { console.error(error); process.exit(1); });
