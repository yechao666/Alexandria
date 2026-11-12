import { createHash, createHmac } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type { Env } from '../env.ts';

function sha256(data: string | Buffer | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function encodePath(path: string): string {
  return path.split('/').map((part) => encodeURIComponent(part)).join('/');
}

/** S3 兼容对象存储：用于把备份复制到外部存储。 */
export function s3Configured(env: Env): boolean {
  const s3 = env.s3;
  return Boolean(s3?.endpoint && s3.bucket && s3.accessKey && s3.secretKey);
}

export async function s3Put(env: Env, key: string, body: Buffer, contentType = 'application/octet-stream'): Promise<void> {
  const s3 = env.s3;
  if (!s3Configured(env) || !s3) throw new Error('S3 未配置');
  const endpoint = new URL(s3.endpoint);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256(body);
  const host = endpoint.host;
  const canonicalUri = `${endpoint.pathname.replace(/\/$/, '')}/${encodePath(`${s3.bucket}/${key}`)}`;
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = `PUT\n${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${dateStamp}/${s3.region}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonicalRequest)}`;
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${s3.secretKey}`, dateStamp), s3.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${s3.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const response = await fetch(`${endpoint.origin}${canonicalUri}`, {
    method: 'PUT',
    headers: {
      authorization,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      'content-type': contentType,
    },
    body: new Uint8Array(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`S3 PUT ${response.status}: ${await response.text().catch(() => '')}`);
}

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

/** 将一份备份目录递归上传到 S3，失败只返回错误由调用方记录。 */
export async function uploadBackupToS3(env: Env, targetDir: string): Promise<{ uploaded: number }> {
  if (!s3Configured(env)) return { uploaded: 0 };
  const prefix = env.s3?.prefix?.replace(/^\/+|\/+$/g, '') ?? 'alexandria';
  const files = walk(targetDir);
  let uploaded = 0;
  for (const file of files) {
    const rel = relative(targetDir, file).split('\\').join('/');
    const key = `${prefix}/backups/${basename(targetDir)}/${rel}`;
    const contentType = file.endsWith('.db') ? 'application/x-sqlite3' : file.endsWith('.json') ? 'application/json' : 'application/octet-stream';
    await s3Put(env, key, readFileSync(file), contentType);
    uploaded += 1;
  }
  return { uploaded };
}
