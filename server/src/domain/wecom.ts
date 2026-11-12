import type { Db } from '../db/index.ts';
import type { Env } from '../env.ts';
import { errors } from '../http/respond.ts';

export interface WecomConfig {
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
}

export interface WecomDepartment {
  id: number;
  name: string;
  parentid?: number;
}

export interface WecomUser {
  userid: string;
  name: string;
  email?: string;
  department?: number[];
  position?: string;
  status?: number;
}

function meta(db: Db, key: string): string {
  return (
    (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as unknown as { value: string } | undefined)?.value ?? ''
  );
}

/** 环境变量提供默认值，管理员配置覆盖；Secret 永不返回给浏览器。 */
export function getWecomConfig(db: Db, env: Env): WecomConfig {
  const baseUrl = (meta(db, 'wecom_base_url') || env.wecom.baseUrl).replace(/\/+$/, '');
  const authorizeBase = (meta(db, 'wecom_authorize_base') || env.wecom.authorizeBase).replace(/\/+$/, '');
  const explicitMode = meta(db, 'wecom_mode');
  const mock = explicitMode
    ? explicitMode === 'mock'
    : env.wecom.mock || baseUrl.includes('127.0.0.1:4800') || baseUrl.includes('localhost:4800');
  return {
    enabled: (meta(db, 'wecom_enabled') || (env.wecom.enabled ? '1' : '0')) === '1',
    baseUrl,
    authorizeBase,
    corpId: meta(db, 'wecom_corp_id') || env.wecom.corpId,
    agentId: meta(db, 'wecom_agent_id') || env.wecom.agentId,
    secret: meta(db, 'wecom_secret') || env.wecom.secret,
    callbackToken: meta(db, 'wecom_callback_token') || env.wecom.callbackToken,
    encodingAesKey: meta(db, 'wecom_encoding_aes_key') || env.wecom.encodingAesKey,
    publicUrl: (meta(db, 'wecom_public_url') || env.wecom.publicUrl).replace(/\/+$/, ''),
    mock,
  };
}

export function wecomConfigured(config: WecomConfig): boolean {
  return Boolean(config.enabled && config.corpId && config.secret);
}

async function jsonFetch(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw errors.serviceUnavailable(`企业微信接口返回 HTTP ${response.status}`);
  const data = (await response.json()) as Record<string, unknown>;
  if (data.errcode && Number(data.errcode) !== 0) {
    throw errors.serviceUnavailable(`企业微信接口错误：${String(data.errcode)} ${String(data.errmsg ?? '')}`);
  }
  return data;
}

export async function wecomAccessToken(config: WecomConfig): Promise<string> {
  const url = `${config.baseUrl}/cgi-bin/gettoken?corpid=${encodeURIComponent(config.corpId)}&corpsecret=${encodeURIComponent(config.secret)}`;
  const data = await jsonFetch(url);
  const token = String(data.access_token ?? '');
  if (!token) throw errors.serviceUnavailable('企业微信未返回 access_token');
  return token;
}

export async function wecomUserInfo(config: WecomConfig, token: string, code: string): Promise<{ userid: string; name?: string }> {
  const url = `${config.baseUrl}/cgi-bin/auth/getuserinfo?access_token=${encodeURIComponent(token)}&code=${encodeURIComponent(code)}`;
  const data = await jsonFetch(url);
  const userid = String(data.UserId ?? data.userid ?? '');
  if (!userid) throw errors.serviceUnavailable('企业微信未返回 UserId');
  return { userid, name: data.name ? String(data.name) : undefined };
}

export async function wecomDepartments(config: WecomConfig, token: string): Promise<WecomDepartment[]> {
  const url = `${config.baseUrl}/cgi-bin/department/list?access_token=${encodeURIComponent(token)}`;
  const data = await jsonFetch(url);
  const list = (data.department ?? []) as WecomDepartment[];
  return list.map((item) => ({ id: Number(item.id), name: String(item.name), parentid: item.parentid ? Number(item.parentid) : 0 }));
}

export async function wecomUsers(config: WecomConfig, token: string, departments: WecomDepartment[]): Promise<WecomUser[]> {
  const seen = new Map<string, WecomUser>();
  const ids = departments.length ? departments.map((department) => department.id) : [1];
  for (const departmentId of ids) {
    const url = `${config.baseUrl}/cgi-bin/user/list?access_token=${encodeURIComponent(token)}&department_id=${departmentId}&fetch_child=1`;
    const data = await jsonFetch(url);
    const list = (data.userlist ?? []) as WecomUser[];
    for (const user of list) {
      if (!user.userid) continue;
      seen.set(String(user.userid), {
        userid: String(user.userid),
        name: String(user.name ?? user.userid),
        email: user.email ? String(user.email) : undefined,
        department: (user.department ?? []).map(Number),
        position: user.position ? String(user.position) : undefined,
        status: user.status ? Number(user.status) : undefined,
      });
    }
  }
  return [...seen.values()];
}
