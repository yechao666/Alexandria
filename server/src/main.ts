import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.ts';
import { migrate, openDatabase } from './db/index.ts';
import { createRouter } from './routes/index.ts';
import { createHttpServer } from './http/server.ts';
import type { AppContext } from './http/context.ts';
import { seedDatabase } from './seed/seed.ts';
import { ensureDefaultOntology } from './knowledge/ontology.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const env = loadEnv(root);

mkdirSync(env.dataDir, { recursive: true });
mkdirSync(env.uploadsDir, { recursive: true });
mkdirSync(env.thumbnailsDir, { recursive: true });

const db = openDatabase(env.dbPath);
migrate(db);

const personCount = db.prepare('SELECT COUNT(*) AS c FROM persons').get() as unknown as { c: number };
if (Number(personCount.c) === 0) {
  console.log('[alexandria] 空库，正在写入演示数据…');
  seedDatabase(db, env);
}

// 幂等补齐内置本体属性（老库也会获得缺失的定义）。
for (const row of db.prepare('SELECT id FROM libraries').all() as unknown as { id: string }[]) {
  ensureDefaultOntology(db, row.id);
}

const app: AppContext = { db, env, now: () => new Date().toISOString() };
const server = createHttpServer(app, createRouter());

server.listen(env.port, env.host, () => {
  const url = `http://${env.host}:${env.port}`;
  console.log(`\n  Alexandria · 亚历山大知识库`);
  console.log(`  ${url}`);
  console.log(`  数据目录 ${env.dataDir}`);
  console.log(`  演示账号：lin@alex.dev / alex-demo（组织管理员）\n`);
});

function shutdown(signal: string) {
  console.log(`\n[alexandria] ${signal}，正在关闭…`);
  server.close(() => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
