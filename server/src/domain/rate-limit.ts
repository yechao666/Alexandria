/** 单节点内存滑动窗口限流；用于登录等高风险入口。多副本部署需替换为 Redis。 */
const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(key: string, limit = 8, windowMs = 15 * 60_000): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }
  current.count += 1;
  if (current.count > limit) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
  }
  return { ok: true, retryAfter: 0 };
}

export function resetRateLimit(key: string): void {
  buckets.delete(key);
}

export function rateLimitKey(rc: { req: { socket: { remoteAddress?: string | null } } }, prefix: string, subject: string): string {
  return `${prefix}:${rc.req.socket.remoteAddress ?? 'unknown'}:${subject.toLowerCase()}`;
}
