import type { Db } from '../db/index.ts';
import type { Env } from '../env.ts';
import { newId, nowIso } from '../lib/ids.ts';
import { getWecomConfig, wecomConfigured } from './wecom.ts';

export interface NotificationInput {
  personId: string;
  actorId?: string | null;
  kind?: string;
  title: string;
  body?: string;
  link?: string;
  libraryId?: string | null;
  pageId?: string | null;
}

export function createNotification(db: Db, input: NotificationInput): string {
  const id = newId('ntf');
  db.prepare(
    `INSERT INTO notifications (id, person_id, actor_id, kind, title, body, link, library_id, page_id, read_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    id,
    input.personId,
    input.actorId ?? null,
    input.kind ?? 'info',
    input.title,
    input.body ?? '',
    input.link ?? '',
    input.libraryId ?? null,
    input.pageId ?? null,
    nowIso(),
  );
  return id;
}

export function unreadNotificationCount(db: Db, personId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS c FROM notifications WHERE person_id = ? AND read_at IS NULL')
    .get(personId) as unknown as { c: number };
  return Number(row.c);
}

let tokenCache: { key: string; token: string; expiresAt: number } | null = null;

async function accessToken(db: Db, env: Env): Promise<string | null> {
  const config = getWecomConfig(db, env);
  const key = `${config.baseUrl}|${config.corpId}`;
  if (tokenCache && tokenCache.key === key && tokenCache.expiresAt > Date.now()) return tokenCache.token;
  const response = await fetch(
    `${config.baseUrl}/cgi-bin/gettoken?corpid=${encodeURIComponent(config.corpId)}&corpsecret=${encodeURIComponent(config.secret)}`,
    { signal: AbortSignal.timeout(8000) },
  );
  const data = (await response.json()) as { access_token?: string; expires_in?: number; errcode?: number };
  if (!data.access_token) return null;
  tokenCache = { key, token: data.access_token, expiresAt: Date.now() + Math.max(60, (data.expires_in ?? 7200) - 120) * 1000 };
  return tokenCache.token;
}

/** 向绑定的企微账号发送应用消息；失败只记录日志，不阻塞业务请求。 */
export async function sendWecomText(db: Db, env: Env, personId: string, text: string): Promise<boolean> {
  const config = getWecomConfig(db, env);
  if (!wecomConfigured(config)) return false;
  const person = db.prepare('SELECT wecom_userid FROM persons WHERE id = ?').get(personId) as unknown as
    | { wecom_userid: string | null }
    | undefined;
  if (!person?.wecom_userid) return false;
  try {
    const token = await accessToken(db, env);
    if (!token) return false;
    const response = await fetch(`${config.baseUrl}/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        touser: person.wecom_userid,
        msgtype: 'text',
        agentid: Number(config.agentId) || 1000002,
        text: { content: text.slice(0, 1800) },
      }),
      signal: AbortSignal.timeout(8000),
    });
    const data = (await response.json()) as { errcode?: number; errmsg?: string };
    if (Number(data.errcode ?? 0) !== 0) {
      console.warn('[wecom] message/send failed', data.errcode, data.errmsg);
      return false;
    }
    return true;
  } catch (error) {
    console.warn('[wecom] message/send error', (error as Error).message);
    return false;
  }
}

/** 站内通知 + 可选企微推送。 */
export async function notifyPerson(db: Db, env: Env, input: NotificationInput): Promise<string> {
  const id = createNotification(db, input);
  const text = `【Alexandria】${input.title}${input.body ? `\n${input.body}` : ''}${
    input.link ? `\n${env.wecom.publicUrl}${input.link}` : ''
  }`;
  void sendWecomText(db, env, input.personId, text);
  return id;
}
