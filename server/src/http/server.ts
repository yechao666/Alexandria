import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AppContext } from './context.ts';
import { createContext } from './context.ts';
import { METHOD_MISMATCH, normalizePath, type Router } from './router.ts';
import { errors, sendError } from './respond.ts';
import { serveStatic } from './static.ts';
import { rateLimit } from '../domain/rate-limit.ts';

function requestId(req: import('node:http').IncomingMessage): string {
  const incoming = String(req.headers['x-request-id'] ?? '').trim();
  return incoming.length > 0 && incoming.length <= 128
    ? incoming
    : `req_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function createHttpServer(app: AppContext, router: Router): Server {
  return createServer(async (req, res) => {
    const method = (req.method ?? 'GET').toUpperCase();
    const id = requestId(req);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'same-origin');
    res.setHeader('permissions-policy', 'geolocation=(), microphone=(), camera=()');
    res.setHeader('content-security-policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'");
    if (String(process.env.ALEXANDRIA_PUBLIC_URL ?? '').startsWith('https://')) {
      res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }

    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      sendError(res, id, errors.badRequest('请求 URL 不合法'));
      return;
    }
    const pathname = normalizePath(url.pathname);
    if (pathname.startsWith('/api/') && pathname !== '/api/health' && pathname !== '/api/health/ready') {
      const ip = req.socket.remoteAddress ?? 'unknown';
      const limit = Math.max(60, Number(process.env.ALEXANDRIA_RATE_LIMIT_PER_MINUTE ?? 1200));
      const bucket = rateLimit(`api:${method === 'GET' || method === 'HEAD' ? 'read' : 'write'}:${ip}`, limit, 60_000);
      if (!bucket.ok) {
        res.setHeader('retry-after', String(bucket.retryAfter));
        sendError(res, id, errors.tooManyRequests('请求过于频繁，请稍后再试'));
        return;
      }
    }
    if (method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    const matched = router.match(method, pathname);
    if (matched === METHOD_MISMATCH) {
      sendError(res, id, errors.badRequest(`路由 ${pathname} 不支持 ${method}`));
      return;
    }
    if (matched === null) {
      if ((method === 'GET' || method === 'HEAD') && !pathname.startsWith('/api')) {
        const rc = createContext({ app, req, res, url, method, pathname, params: {}, requestId: id });
        try {
          serveStatic(rc);
        } catch (error) {
          sendError(res, id, error);
        }
        return;
      }
      sendError(res, id, errors.notFound(`未找到接口：${method} ${pathname}`));
      return;
    }

    const rc = createContext({ app, req, res, url, method, pathname, params: matched.params, requestId: id });
    const started = Date.now();
    try {
      await matched.route.handler(rc);
    } catch (error) {
      if (!res.headersSent) sendError(res, id, error);
      else res.destroy();
    } finally {
      if (pathname !== '/api/events' && res.statusCode >= 400) {
        console.warn(`[http] ${id} ${method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
      }
    }
  });
}
