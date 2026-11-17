#!/usr/bin/env node
const BASE = process.env.ALEXANDRIA_URL || 'http://127.0.0.1:4520';
const LIB = process.env.ALEXANDRIA_POWER_LIBRARY || 'lib_a7296d68b2884bbc86de';
const mode = process.argv[2] === 'dsh' ? 'dsh' : 'rule';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
async function drain(cookie) {
  let last = '';
  for (let i = 0; i < 1200; i += 1) {
    const data = await req('/api/tasks?limit=1', cookie);
    const queue = data.queue || {};
    const line = `active=${queue.active ?? 0} pending=${queue.pending ?? 0}`;
    if (line !== last) { console.log(`[recompile] ${line}`); last = line; }
    if (!queue.active && !queue.pending) return;
    await sleep(3000);
  }
}
async function main() {
  const cookie = await login();
  const data = await req(`/api/sources?library=${encodeURIComponent(LIB)}&limit=500`, cookie);
  let sources = data.sources || [];
  if (mode === 'dsh') {
    const priority = new Set(['政策标准', '电力市场', '电力设备']);
    sources = sources.filter((source) => priority.has(source.nodeName));
  }
  console.log(`[recompile] mode=${mode} sources=${sources.length}`);
  let queued = 0;
  for (const source of sources) {
    try {
      await req(`/api/sources/${encodeURIComponent(source.id)}/reprocess?compiler=${mode}`, cookie, { method: 'POST' });
      queued += 1;
    } catch (error) { console.warn(`[recompile] skip ${source.title.slice(0, 30)}: ${error.message}`); }
    if (queued % 20 === 0) console.log(`[recompile] queued ${queued}/${sources.length}`);
    await sleep(120);
  }
  console.log(`[recompile] queued=${queued}; waiting queue`);
  await drain(cookie);
  const library = await req(`/api/libraries/${encodeURIComponent(LIB)}`, cookie);
  console.log(`[recompile] done pages=${library.counts?.pages} sources=${library.counts?.sources} conflicts=${library.counts?.conflicts}`);
}
main().catch((error) => { console.error(error); process.exit(1); });
