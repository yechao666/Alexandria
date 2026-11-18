import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import type { Db } from '../db/index.ts';
import type { Env } from '../env.ts';
import { newId, nowIso } from '../lib/ids.ts';

const workerPath = fileURLToPath(new URL('./worker.ts', import.meta.url));
let active = 0;
const pending: { db: Db; env: Env; jobId: string }[] = [];
const seen = new Set<string>();
const maxConcurrency = Math.max(1, Math.min(4, Number(process.env.ALEXANDRIA_INGEST_CONCURRENCY ?? 1)));

function failMain(db: Db, jobId: string, message: string): void {
  try {
    db.prepare("UPDATE ingest_jobs SET status = 'failed', stage = 'failed', error = ?, finished_at = ? WHERE id = ? AND status IN ('queued','running')").run(message, nowIso(), jobId);
    db.prepare(
      'INSERT INTO job_events (id, job_id, step, status, message, progress, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)',
    ).run(newId('jevt'), jobId, 'failed', 'failed', message, 100, nowIso());
  } catch {
    /* best effort */
  }
}

function pump(): void {
  if (process.env.ALEXANDRIA_PAUSE_QUEUE === '1') return;
  while (active < maxConcurrency && pending.length) {
    const item = pending.shift()!;
    active += 1;
    let settled = false;
    const worker = new Worker(new URL(workerPath, import.meta.url), {
      workerData: { dbPath: item.env.dbPath, env: item.env, jobId: item.jobId },
      stdout: false,
      stderr: false,
    });
    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      if (error) failMain(item.db, item.jobId, error);
      active = Math.max(0, active - 1);
      seen.delete(item.jobId);
      pump();
    };
    worker.once('error', (error) => finish(`worker 异常：${error.message}`));
    worker.once('exit', (code) => {
      if (code !== 0) finish(`worker 退出码 ${code}`);
      else finish();
    });
    // 防止 5 分钟内没有任何退出事件
    const timer = setTimeout(() => {
      try { void worker.terminate(); } catch { /* ignore */ }
      finish(`worker 超时（${item.jobId}）`);
    }, 5 * 60_000);
    timer.unref?.();
    worker.once('exit', () => clearTimeout(timer));
  }
}

/** 把资料处理任务交给独立 worker，避免 DSH/解析阻塞 HTTP 事件循环。 */
export function enqueueJob(db: Db, env: Env, jobId: string): void {
  if (seen.has(jobId)) return;
  seen.add(jobId);
  pending.push({ db, env, jobId });
  pump();
}

export function queueSnapshot(): { active: number; pending: number } {
  return { active, pending: pending.length };
}

/** 启动时恢复排队任务；上次进程中断的 running 任务回到 queued。 */
export function resumeQueuedJobs(db: Db, env: Env): number {
  const rows = db.prepare("SELECT id, status FROM ingest_jobs WHERE status IN ('queued','running') ORDER BY created_at ASC").all() as unknown as {
    id: string;
    status: string;
  }[];
  for (const row of rows) {
    if (row.status === 'running') {
      db.prepare("UPDATE ingest_jobs SET status = 'queued', stage = 'queued', progress = 0, error = NULL WHERE id = ?").run(row.id);
    }
    enqueueJob(db, env, row.id);
  }
  return rows.length;
}
