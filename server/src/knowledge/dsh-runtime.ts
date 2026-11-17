import { spawn, spawnSync } from 'node:child_process';
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Env } from '../env.ts';

let queue: Promise<unknown> = Promise.resolve();
let cachedKey: string | null = null;

function credentialKey(sourceHome: string): string {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  if (cachedKey) return cachedKey;
  try {
    const yaml = readFileSync(join(sourceHome, '.credentials.yaml'), 'utf8');
    const match = yaml.match(/DEEPSEEK_API_KEY:\s*["']?([^\s"']+)/);
    cachedKey = match?.[1] ?? '';
    return cachedKey;
  } catch {
    return '';
  }
}

/** 准备 workspace 内的 DSH_HOME，避免写入 ~/.dsh（沙箱/权限受限）。 */
function prepareHome(env: Env): { home: string; cwd: string } | null {
  const home = join(env.dataDir, 'dsh-home');
  const profile = join(home, 'profiles', env.dsh.profile);
  const source = join(env.dsh.sourceHome, 'profiles', env.dsh.profile);
  try {
    if (!existsSync(join(profile, 'package.json'))) {
      if (!existsSync(source)) return null;
      mkdirSync(join(home, 'profiles'), { recursive: true });
      cpSync(source, profile, { recursive: true, force: true });
    }
    const cwd = join(env.dataDir, 'dsh-work');
    mkdirSync(cwd, { recursive: true });
    return { home, cwd };
  } catch {
    return null;
  }
}

export function dshAvailable(env: Env): boolean {
  if (!env.dsh.enabled) return false;
  return Boolean(prepareHome(env) && credentialKey(env.dsh.sourceHome));
}

/**
 * 调用本机 DSH headless，返回最终文本；失败返回 null。
 * 所有调用串行，避免并发写 profile 缓存。
 */
export async function runDsh(env: Env, prompt: string, options: { timeoutMs?: number; maxChars?: number } = {}): Promise<string | null> {
  if (!env.dsh.enabled) return null;
  const key = credentialKey(env.dsh.sourceHome);
  if (!key) return null;
  const prepared = prepareHome(env);
  if (!prepared) return null;
  const run = queue.then(
    () =>
      new Promise<string | null>((resolve) => {
        const child = spawn(env.dsh.bin, ['--profile', env.dsh.profile, '--json', '-'], {
          cwd: prepared.cwd,
          env: {
            ...process.env,
            DSH_HOME: prepared.home,
            DEEPSEEK_API_KEY: key,
            DSH_HIVE_RUNTIME_DISABLED: '1',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let buffer = '';
        let text = '';
        let finalText = '';
        let settled = false;
        const finish = (value: string | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        };
        const timer = setTimeout(() => {
          try {
            child.kill('SIGTERM');
          } catch {
            /* ignore */
          }
          finish(null);
        }, options.timeoutMs ?? env.dsh.timeoutMs);
        timer.unref?.();
        child.stdout.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line) as { type?: string; text?: string };
              if (event.type === 'text' && event.text) text = event.text;
              if (event.type === 'final' && event.text) finalText = event.text;
            } catch {
              /* ignore non-JSON logs */
            }
          }
        });
        child.stderr.on('data', () => {
          /* 模型/插件日志不进入业务日志，避免泄漏 */
        });
        child.on('error', () => finish(null));
        child.on('close', () => {
          const result = String(finalText || text || '').trim();
          finish(result ? result.slice(0, options.maxChars ?? 24_000) : null);
        });
        child.stdin.end(prompt);
      }),
  );
  queue = run.catch(() => null);
  return run;
}

/** 从 DSH 输出中提取 JSON（容忍 Markdown 代码围栏/前后说明）。 */
export function extractJson<T>(text: string | null): T | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}


/** 同步版本，供入库任务在现有同步流水线中使用。 */
export function runDshSync(env: Env, prompt: string, options: { timeoutMs?: number; maxChars?: number } = {}): string | null {
  if (!env.dsh.enabled) return null;
  const key = credentialKey(env.dsh.sourceHome);
  if (!key) return null;
  const prepared = prepareHome(env);
  if (!prepared) return null;
  const directory = mkdtempSync(join(tmpdir(), 'alexandria-dsh-'));
  const outputPath = join(directory, 'stdout.jsonl');
  const fd = openSync(outputPath, 'w');
  let result;
  try {
    result = spawnSync(env.dsh.bin, ['--profile', env.dsh.profile, '--json', '-'], {
      cwd: prepared.cwd,
      env: {
        ...process.env,
        DSH_HOME: prepared.home,
        DEEPSEEK_API_KEY: key,
        DSH_HIVE_RUNTIME_DISABLED: '1',
      },
      input: prompt,
      stdio: ['pipe', fd, 'ignore'],
      timeout: options.timeoutMs ?? env.dsh.timeoutMs,
      killSignal: 'SIGKILL',
    });
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
  let stdout = '';
  try { stdout = readFileSync(outputPath, 'utf8'); } catch { /* ignore */ }
  try { rmSync(directory, { recursive: true, force: true }); } catch { /* ignore */ }
  if (result.error || result.status !== 0 || !stdout) return null;
  let text = '';
  let finalText = '';
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { type?: string; text?: string };
      if (event.type === 'text' && event.text) text = event.text;
      if (event.type === 'final' && event.text) finalText = event.text;
    } catch {
      /* ignore logs */
    }
  }
  const output = String(finalText || text || '').trim();
  return output ? output.slice(0, options.maxChars ?? 24_000) : null;
}
