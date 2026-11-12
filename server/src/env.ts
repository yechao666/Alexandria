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
  trashRetentionDays: number;
  auditRetentionDays: number;
  autoBackupHours: number;
  maintenanceIntervalMinutes: number;
  dsh: {
    enabled: boolean;
    bin: string;
    profile: string;
    timeoutMs: number;
    searchTimeoutMs: number;
    sourceHome: string;
  };
  wecom: {
    enabled: boolean;
    baseUrl: string;
    authorizeBase: string;
    corpId: string;
    agentId: string;
    secret: string;
    callbackToken: string;
    encodingAesKey: string;
    publicUrl: string;
    mock: boolean;
  };
  oidc?: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    scopes: string;
    label: string;
  };
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
  const port = Number(process.env.ALEXANDRIA_PORT ?? process.env.PORT ?? 4520);
  const host = process.env.ALEXANDRIA_HOST ?? '127.0.0.1';
  const wecomBase = (process.env.ALEXANDRIA_WECOM_BASE_URL?.trim() || 'http://127.0.0.1:4800').replace(/\/+$/, '');
  const wecomAuthorizeBase = (process.env.ALEXANDRIA_WECOM_AUTHORIZE_BASE?.trim() || wecomBase).replace(/\/+$/, '');
  const wecomPublicUrl = (process.env.ALEXANDRIA_PUBLIC_URL?.trim() || `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`).replace(/\/+$/, '');
  return {
    root,
    dataDir,
    dbPath: process.env.ALEXANDRIA_DB_PATH?.trim() || join(dataDir, 'alexandria.db'),
    uploadsDir: process.env.ALEXANDRIA_UPLOADS_DIR?.trim() || join(dataDir, 'uploads'),
    thumbnailsDir: process.env.ALEXANDRIA_THUMBS_DIR?.trim() || join(dataDir, 'thumbnails'),
    webDir: process.env.ALEXANDRIA_WEB_DIR?.trim() || join(root, 'web'),
    port,
    host,
    sessionTtlHours: Number(process.env.ALEXANDRIA_SESSION_TTL_HOURS ?? 24 * 14),
    maxUploadBytes: Number(process.env.ALEXANDRIA_MAX_UPLOAD_MB ?? 80) * 1024 * 1024,
    trashRetentionDays: Number(process.env.ALEXANDRIA_TRASH_RETENTION_DAYS ?? 30),
    auditRetentionDays: Number(process.env.ALEXANDRIA_AUDIT_RETENTION_DAYS ?? 180),
    autoBackupHours: Number(process.env.ALEXANDRIA_AUTO_BACKUP_HOURS ?? 0),
    maintenanceIntervalMinutes: Number(process.env.ALEXANDRIA_MAINTENANCE_INTERVAL_MINUTES ?? 60),
    dsh: {
      enabled: bool(process.env.ALEXANDRIA_DSH_ENABLED ?? '1'),
      bin: process.env.ALEXANDRIA_DSH_BIN?.trim() || process.env.HIVE_DSH_BIN?.trim() || 'dsh',
      profile: process.env.ALEXANDRIA_DSH_PROFILE?.trim() || 'headless',
      timeoutMs: Number(process.env.ALEXANDRIA_DSH_TIMEOUT_MS ?? 90_000),
      searchTimeoutMs: Number(process.env.ALEXANDRIA_DSH_SEARCH_TIMEOUT_MS ?? 2_500),
      sourceHome: process.env.ALEXANDRIA_DSH_SOURCE_HOME?.trim() || join(process.env.HOME || '', '.dsh'),
    },
    wecom: {
      enabled: bool(process.env.ALEXANDRIA_WECOM_ENABLED ?? 'true'),
      baseUrl: wecomBase,
      authorizeBase: wecomAuthorizeBase,
      corpId: process.env.ALEXANDRIA_WECOM_CORP_ID?.trim() || 'wwmockcorp',
      agentId: process.env.ALEXANDRIA_WECOM_AGENT_ID?.trim() || '1000002',
      secret: process.env.ALEXANDRIA_WECOM_SECRET?.trim() || 'mock-secret',
      callbackToken: process.env.ALEXANDRIA_WECOM_CALLBACK_TOKEN?.trim() || 'mock-token',
      encodingAesKey:
        process.env.ALEXANDRIA_WECOM_ENCODING_AES_KEY?.trim() || 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
      publicUrl: wecomPublicUrl,
      mock: process.env.ALEXANDRIA_WECOM_MODE === 'mock' || wecomBase.includes('127.0.0.1:4800') || wecomBase.includes('localhost:4800'),
    },
    oidc:
      process.env.ALEXANDRIA_OIDC_ISSUER && process.env.ALEXANDRIA_OIDC_CLIENT_ID && process.env.ALEXANDRIA_OIDC_CLIENT_SECRET
        ? {
            issuer: process.env.ALEXANDRIA_OIDC_ISSUER.replace(/\/+$/, ''),
            clientId: process.env.ALEXANDRIA_OIDC_CLIENT_ID,
            clientSecret: process.env.ALEXANDRIA_OIDC_CLIENT_SECRET,
            redirectUri: process.env.ALEXANDRIA_OIDC_REDIRECT_URI?.trim() || `${wecomPublicUrl}/api/auth/oidc/callback`,
            scopes: process.env.ALEXANDRIA_OIDC_SCOPES?.trim() || 'openid email profile',
            label: process.env.ALEXANDRIA_OIDC_LABEL?.trim() || '企业 SSO',
          }
        : undefined,
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
