import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from '../db/index.ts';
import type { Actor, Person } from '../types.ts';
import type { Env } from '../env.ts';
import { errors, sendJson } from './respond.ts';

export interface AppContext {
  db: Db;
  env: Env;
  now: () => string;
}

export interface RequestContext {
  app: AppContext;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
  pathname: string;
  params: Record<string, string>;
  requestId: string;
  actor?: Actor;
  json(payload: unknown, status?: number, headers?: Record<string, string>): void;
  body<T = unknown>(): Promise<T>;
  rawBody(maxBytes?: number): Promise<Buffer>;
  query(name: string, fallback?: string): string;
  queryInt(name: string, fallback: number): number;
  header(name: string): string;
}

export function createContext(input: {
  app: AppContext;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
  pathname: string;
  params: Record<string, string>;
  requestId: string;
}): RequestContext {
  const { app, req, res, url, method, pathname, params, requestId } = input;
  let bodyCache: Promise<Buffer> | null = null;

  const rawBody = (maxBytes = 2 * 1024 * 1024): Promise<Buffer> => {
    if (bodyCache) return bodyCache;
    bodyCache = new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          reject(errors.payloadTooLarge(`请求体超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
    return bodyCache;
  };

  return {
    app,
    req,
    res,
    url,
    method,
    pathname,
    params,
    requestId,
    json(payload, status = 200, headers) {
      if (headers) for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
      sendJson(res, requestId, status, payload);
    },
    async body<T>() {
      const raw = await rawBody();
      if (!raw.length) return {} as T;
      try {
        return JSON.parse(raw.toString('utf8')) as T;
      } catch {
        throw errors.badRequest('请求体不是合法的 JSON');
      }
    },
    rawBody,
    query(name, fallback = '') {
      return url.searchParams.get(name) ?? fallback;
    },
    queryInt(name, fallback) {
      const value = Number(url.searchParams.get(name));
      return Number.isFinite(value) ? value : fallback;
    },
    header(name) {
      const value = req.headers[name.toLowerCase()];
      return Array.isArray(value) ? value.join(',') : (value ?? '');
    },
  };
}

export function publicPerson(person: Person): Person & { isAdmin: boolean } {
  return person;
}
