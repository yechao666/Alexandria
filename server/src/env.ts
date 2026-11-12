import { join, resolve } from 'node:path';

export interface Env {
  root: string;
  dataDir: string;
  dbPath: string;
  uploadsDir: string;
  thumbnailsDir: string;
  webDir: string;
  port: number;
  host: string;
  sessionTtlHours: number;
  maxUploadBytes: number;
  llm?: {
    baseUrl: string;
    apiKey: string;
    model: string;
    timeoutMs: number;
  };
}

function bool(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes';
}

export function loadEnv(root: string): Env {
  const dataDir = resolve(root, process.env.ALEXANDRIA_DATA_DIR ?? 'data');
  const llmBase = process.env.ALEXANDRIA_LLM_BASE_URL?.trim();
  const llmKey = process.env.ALEXANDRIA_LLM_API_KEY?.trim();
  return {
    root,
    dataDir,
    dbPath: process.env.ALEXANDRIA_DB_PATH?.trim() || join(dataDir, 'alexandria.db'),
    uploadsDir: process.env.ALEXANDRIA_UPLOADS_DIR?.trim() || join(dataDir, 'uploads'),
    thumbnailsDir: process.env.ALEXANDRIA_THUMBS_DIR?.trim() || join(dataDir, 'thumbnails'),
    webDir: process.env.ALEXANDRIA_WEB_DIR?.trim() || join(root, 'web'),
    port: Number(process.env.ALEXANDRIA_PORT ?? process.env.PORT ?? 4520),
    host: process.env.ALEXANDRIA_HOST ?? '127.0.0.1',
    sessionTtlHours: Number(process.env.ALEXANDRIA_SESSION_TTL_HOURS ?? 24 * 14),
    maxUploadBytes: Number(process.env.ALEXANDRIA_MAX_UPLOAD_MB ?? 80) * 1024 * 1024,
    llm:
      llmBase && llmKey
        ? {
            baseUrl: llmBase.replace(/\/+$/, ''),
            apiKey: llmKey,
            model: process.env.ALEXANDRIA_LLM_MODEL ?? 'deepseek-chat',
            timeoutMs: Number(process.env.ALEXANDRIA_LLM_TIMEOUT_MS ?? 60_000),
          }
        : undefined,
  };
}

export const envFlag = bool;
