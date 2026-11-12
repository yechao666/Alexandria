import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { RequestContext } from './context.ts';
import { errors, sendJson } from './respond.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
};

function mimeOf(file: string): string {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

export function serveStatic(rc: RequestContext): void {
  const webDir = resolve(rc.app.env.webDir);
  const requested = rc.pathname === '/' ? '/index.html' : rc.pathname;
  let filePath = resolve(join(webDir, normalize(requested).replace(/^(\.\.[/\\])+/, '')));
  if (!filePath.startsWith(webDir + sep) && filePath !== webDir) {
    throw errors.notFound('资源不存在');
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    filePath = join(webDir, 'index.html');
    if (!existsSync(filePath)) throw errors.notFound('前端尚未构建');
  }
  const stat = statSync(filePath);
  rc.res.statusCode = 200;
  rc.res.setHeader('content-type', mimeOf(filePath));
  rc.res.setHeader('content-length', String(stat.size));
  rc.res.setHeader('cache-control', filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600');
  if (rc.method === 'HEAD') {
    rc.res.end();
    return;
  }
  createReadStream(filePath).pipe(rc.res);
}

export function sendBinary(rc: RequestContext, buffer: Buffer, filename: string, mime: string): void {
  rc.res.statusCode = 200;
  rc.res.setHeader('content-type', mime);
  rc.res.setHeader('content-length', String(buffer.length));
  rc.res.setHeader(
    'content-disposition',
    `inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );
  rc.res.end(buffer);
}
