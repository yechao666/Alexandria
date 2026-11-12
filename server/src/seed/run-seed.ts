import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../env.ts';
import { closeDatabase, migrate, openDatabase } from '../db/index.ts';
import { seedDatabase } from './seed.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const env = loadEnv(root);
const force = process.argv.includes('--force');

if (force) {
  for (const target of [env.dbPath, `${env.dbPath}-wal`, `${env.dbPath}-shm`]) {
    rmSync(target, { force: true });
  }
  rmSync(env.uploadsDir, { recursive: true, force: true });
}
mkdirSync(env.uploadsDir, { recursive: true });
mkdirSync(env.thumbnailsDir, { recursive: true });

const db = openDatabase(env.dbPath);
migrate(db);
seedDatabase(db, env);
const counts = {
  persons: (db.prepare('SELECT COUNT(*) AS c FROM persons').get() as unknown as { c: number }).c,
  teams: (db.prepare('SELECT COUNT(*) AS c FROM teams').get() as unknown as { c: number }).c,
  libraries: (db.prepare('SELECT COUNT(*) AS c FROM libraries').get() as unknown as { c: number }).c,
  pages: (db.prepare('SELECT COUNT(*) AS c FROM pages').get() as unknown as { c: number }).c,
  sources: (db.prepare('SELECT COUNT(*) AS c FROM sources').get() as unknown as { c: number }).c,
  links: (db.prepare('SELECT COUNT(*) AS c FROM links').get() as unknown as { c: number }).c,
};
console.log('[seed] 完成', counts);
closeDatabase(db);
