#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const BASE = process.env.ALEXANDRIA_URL || 'http://127.0.0.1:4520';
const LIB = process.env.ALEXANDRIA_LIBRARY || 'power-industry';
const OUT = process.env.ALEXANDRIA_GIT_DIR || new URL('../data/wiki-git', import.meta.url).pathname;
const login = async () => {
  const response = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'lin@alex.dev', password: 'alex-demo' }) });
  if (!response.ok) throw new Error(`login ${response.status}`);
  return response.headers.get('set-cookie')?.split(';')[0];
};
const main = async () => {
  const cookie = await login();
  const libraryResponse = await fetch(`${BASE}/api/libraries/${encodeURIComponent(LIB)}`, { headers: { cookie } });
  if (!libraryResponse.ok) throw new Error(`library ${libraryResponse.status}`);
  const { library } = await libraryResponse.json();
  const bundleResponse = await fetch(`${BASE}/api/libraries/${encodeURIComponent(library.id)}/export.md`, { headers: { cookie } });
  if (!bundleResponse.ok) throw new Error(`export ${bundleResponse.status}`);
  const bundle = await bundleResponse.text();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `${library.slug}.md`), bundle, 'utf8');
  execFileSync('git', ['-C', OUT, 'init', '-q'], { stdio: 'ignore' });
  execFileSync('git', ['-C', OUT, 'add', `${library.slug}.md`]);
  try {
    execFileSync('git', ['-C', OUT, '-c', 'user.name=Alexandria Sync', '-c', 'user.email=sync@alex.dev', 'commit', '-q', '-m', `sync: ${library.name} ${new Date().toISOString()}`], { stdio: 'ignore' });
  } catch {
    // 没有变更时不创建提交
  }
  console.log(`[git-sync] ${library.name} -> ${join(OUT, `${library.slug}.md`)}`);
};
main().catch((error) => { console.error(error); process.exit(1); });
