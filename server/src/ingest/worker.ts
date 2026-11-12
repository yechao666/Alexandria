import { parentPort, workerData } from 'node:worker_threads';
import { closeDatabase, migrate, openDatabase } from '../db/index.ts';
import type { Env } from '../env.ts';
import { processJob } from './pipeline.ts';

const data = workerData as { dbPath: string; env: Env; jobId: string };
const db = openDatabase(data.dbPath);
migrate(db);
try {
  processJob(db, data.env, data.jobId);
  parentPort?.postMessage({ ok: true });
} catch (error) {
  parentPort?.postMessage({ ok: false, error: (error as Error).message });
} finally {
  closeDatabase(db);
}
