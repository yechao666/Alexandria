#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const BASE = process.env.ALEXANDRIA_URL || 'http://127.0.0.1:4520';
const MANIFEST = join(ROOT, 'data', 'power-corpus', 'manifest.json');
const LIB_SLUG = 'power-industry';
const TOPICS = [
  ['发电', 'power-generation', '发电、火电、水电、核电、风电、光伏、储能与新能源'],
  ['输电', 'power-transmission', '特高压、输电通道、电网与外送'],
  ['变电', 'power-substation', '变电站、换流站、变压器与主设备'],
  ['配电', 'power-distribution', '配网、台区、农网、微电网与供电服务'],
  ['用电', 'power-consumption', '用电负荷、营商环境、充电与客户服务'],
  ['电力市场', 'power-market', '交易、现货、辅助服务、绿电绿证、价格与结算'],
  ['电力设备', 'power-equipment', '发电/输变电/储能设备、组件与装备'],
  ['政策标准', 'power-policy', '政策、规划、标准、监管与行业治理'],
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, { ...options, headers: { ...(options.headers || {}) } });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: { message: text } }; }
  if (!response.ok) {
    const error = new Error(data?.error?.message || `HTTP ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return { data, response };
}

async function login() {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'lin@alex.dev', password: 'alex-demo' }),
  });
  if (!response.ok) throw new Error(`login failed: ${response.status}`);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('login did not return session cookie');
  return cookie;
}

async function ensureLibrary(cookie) {
  const { data } = await req('/api/libraries', { headers: { cookie } });
  const existing = (data.libraries || []).find((library) => library.slug === LIB_SLUG);
  if (existing) return existing;
  const { data: created } = await req('/api/libraries', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      name: '电力行业资料库', slug: LIB_SLUG, description: '覆盖发电、输电、变电、配电、用电、电力市场、电力设备与政策标准的中国电力行业公开资料。',
      visibility: 'internal', ownerTeamId: 'team_knowledge', color: 'teal',
    }),
  });
  return created.library;
}

async function ensureNodes(cookie, libraryId) {
  const { data } = await req(`/api/libraries/${encodeURIComponent(libraryId)}`, { headers: { cookie } });
  const nodes = data.nodes || [];
  const map = new Map();
  const walk = (items) => { for (const item of items) { map.set(item.name, item.id); walk(item.children || []); } };
  walk(nodes);
  for (const [name, code, description] of TOPICS) {
    if (map.has(name)) continue;
    const { data: created } = await req(`/api/libraries/${encodeURIComponent(libraryId)}/nodes`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name, kind: 'section', code, description }),
    });
    map.set(name, created.node.id);
  }
  return map;
}

async function upload(cookie, libraryId, nodeId, doc) {
  const buffer = readFileSync(join(ROOT, 'data', 'power-corpus', doc.file));
  const response = await fetch(`${BASE}/api/libraries/${encodeURIComponent(libraryId)}/sources`, {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/octet-stream',
      'x-filename': encodeURIComponent(`${doc.id}.md`),
      'x-title': encodeURIComponent(doc.title),
      'x-node-id': nodeId,
      'x-compile': 'rule',
    },
    body: buffer,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `HTTP ${response.status}`);
  return data;
}

async function main() {
  if (!existsSync(MANIFEST)) throw new Error(`manifest missing: ${MANIFEST}`);
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const cookie = await login();
  const library = await ensureLibrary(cookie);
  const nodes = await ensureNodes(cookie, library.id);
  console.log(`[ingest] library=${library.id} ${library.name} docs=${manifest.documents.length}`);
  let ok = 0, duplicate = 0, failed = 0;
  const failures = [];
  const queue = [...manifest.documents];
  const workers = Array.from({ length: 3 }, async () => {
    while (queue.length) {
      const doc = queue.shift();
      const nodeId = nodes.get(doc.topic || '发电') || nodes.get('发电');
      try {
        const result = await upload(cookie, library.id, nodeId, doc);
        if (result.duplicate) duplicate += 1; else ok += 1;
        if ((ok + duplicate) % 20 === 0) console.log(`[ingest] ${ok + duplicate}/${manifest.documents.length} ok=${ok} dup=${duplicate} failed=${failed}`);
      } catch (error) {
        failed += 1; failures.push({ id: doc.id, title: doc.title, error: error.message });
        console.warn(`[ingest] fail ${doc.title.slice(0, 30)}: ${error.message}`);
      }
      await sleep(80);
    }
  });
  await Promise.all(workers);
  console.log(`[ingest] uploaded ok=${ok} duplicate=${duplicate} failed=${failed}`);
  if (failures.length) console.log(JSON.stringify(failures.slice(0, 20), null, 2));
  // Wait for the worker queue to drain.
  let last = '';
  for (let i = 0; i < 240; i += 1) {
    await sleep(5000);
    try {
      const { data } = await req('/api/tasks?limit=1', { headers: { cookie } });
      const queueState = data.queue || {};
      const line = `active=${queueState.active ?? '?'} pending=${queueState.pending ?? '?'}`;
      if (line !== last) { console.log(`[ingest] queue ${line}`); last = line; }
      if (!queueState.active && !queueState.pending) break;
    } catch (error) { console.warn('[ingest] poll', error.message); }
  }
  const { data: detail } = await req(`/api/libraries/${encodeURIComponent(library.id)}`, { headers: { cookie } });
  console.log(`[ingest] done pages=${detail.counts?.pages} sources=${detail.counts?.sources} reviewPending=${detail.counts?.reviewPending}`);
}
main().catch((error) => { console.error(error); process.exit(1); });
