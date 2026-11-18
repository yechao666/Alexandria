import type { Db } from '../db/index.ts';
import { newId, nowIso } from '../lib/ids.ts';

export interface RegexRule {
  id: string;
  name: string;
  category: string;
  description: string;
  pattern: string;
  flags: string;
  capture_group: number;
  scope: 'public' | 'library';
  library_id: string | null;
  enabled: number;
  priority: number;
}

export interface RegexMatch {
  ruleId: string;
  name: string;
  category: string;
  value: string;
  index: number;
}

const PUBLIC_RULES: Omit<RegexRule, 'id' | 'library_id' | 'created_at' | 'updated_at' | 'created_by'>[] = [
  { name: '邮箱', category: '联系方式', description: '电子邮箱地址', pattern: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}', flags: 'gi', capture_group: 0, scope: 'public', enabled: 1, priority: 10 },
  { name: '手机号', category: '联系方式', description: '中国大陆 11 位手机号，可带 +86', pattern: '(?<!\\d)(?:\\+?86[-\\s]?)?1[3-9]\\d{9}(?!\\d)', flags: 'g', capture_group: 0, scope: 'public', enabled: 1, priority: 11 },
  { name: '固定电话', category: '联系方式', description: '带区号的固定电话/传真', pattern: '(?<!\\d)(?:\\(?0\\d{2,3}\\)?[-\\s]?)?\\d{7,8}(?:-\\d{1,6})?(?!\\d)', flags: 'g', capture_group: 0, scope: 'public', enabled: 1, priority: 12 },
  { name: '身份证号', category: '证件', description: '18 位居民身份证号码', pattern: '(?<![0-9Xx])[1-9]\\d{5}(?:18|19|20)\\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\d|3[01])\\d{3}[\\dXx](?![0-9Xx])', flags: 'g', capture_group: 0, scope: 'public', enabled: 1, priority: 20 },
  { name: '邮政编码', category: '地址', description: '6 位中国邮政编码', pattern: '(?<!\\d)\\d{6}(?!\\d)', flags: 'g', capture_group: 0, scope: 'public', enabled: 1, priority: 21 },
  { name: '统一社会信用代码', category: '证件', description: '18 位统一社会信用代码', pattern: '(?<![0-9A-Z])[0-9A-HJ-NPQRTUWXY]{2}\\d{6}[0-9A-HJ-NPQRTUWXY]{10}(?![0-9A-Z])', flags: 'g', capture_group: 0, scope: 'public', enabled: 1, priority: 22 },
  { name: '银行卡号', category: '金融', description: '16–19 位银行卡号', pattern: '(?<!\\d)\\d{16,19}(?!\\d)', flags: 'g', capture_group: 0, scope: 'public', enabled: 1, priority: 30 },
  { name: '合同编号', category: '合同', description: '字母前缀 + 数字的合同/协议编号', pattern: '(?<![A-Z0-9])[A-Z]{2,6}[-—]\\d{4,}(?:[-—]\\d{2,})*(?![A-Z0-9])', flags: 'g', capture_group: 0, scope: 'public', enabled: 1, priority: 31 },
  { name: '快递单号', category: '物流', description: '常见快递单号/运单号', pattern: '(?:SF|YT|ZTO|STO|YD|JD|EMS|DBL|JTSD)[A-Z0-9]{8,18}', flags: 'gi', capture_group: 0, scope: 'public', enabled: 1, priority: 32 },
  { name: '发票号码', category: '金融', description: '发票号码（需上下文）', pattern: '(?:发票号码|发票号|Invoice\\s*No)[：:\\s]*([A-Z0-9]{8,20})', flags: 'gi', capture_group: 1, scope: 'public', enabled: 1, priority: 33 },
  { name: 'URL', category: '网络', description: 'http/https 链接', pattern: 'https?://[^\\s<>）)]+', flags: 'gi', capture_group: 0, scope: 'public', enabled: 1, priority: 40 },
  { name: 'IPv4', category: '网络', description: 'IPv4 地址', pattern: '(?<!\\d)(?:\\d{1,3}\\.){3}\\d{1,3}(?!\\d)', flags: 'g', capture_group: 0, scope: 'public', enabled: 1, priority: 41 },
  { name: '日期', category: '日期', description: '中文/数字日期', pattern: '(?<!\\d)(?:19|20)\\d{2}[年./-]\\d{1,2}[月./-]\\d{1,2}日?', flags: 'g', capture_group: 0, scope: 'public', enabled: 1, priority: 42 },
  { name: '标准编号', category: '标准', description: 'GB/DL/T/NB/T 等标准编号', pattern: '(?:GB(?:/T)?|DL(?:/T)?|NB(?:/T)?|JB(?:/T)?|YD(?:/T)?|IEC|IEEE)\\s?\\d{1,5}(?:[.-]\\d{1,4})*(?:[—\\-]\\d{4})?', flags: 'gi', capture_group: 0, scope: 'public', enabled: 1, priority: 43 },
  { name: '金额', category: '金额', description: '人民币金额', pattern: '(?:¥|￥|RMB|人民币)\\s?\\d[\\d,]*(?:\\.\\d{1,2})?', flags: 'gi', capture_group: 0, scope: 'public', enabled: 1, priority: 44 },
  { name: '百分比', category: '金额', description: '百分比数值', pattern: '(?<!\\d)\\d+(?:\\.\\d+)?%(?!\\d)', flags: 'g', capture_group: 0, scope: 'public', enabled: 1, priority: 45 },
  { name: '车牌号', category: '车辆', description: '中国大陆车牌号', pattern: '[\\u4e00-\\u9fa5][A-Z][A-Z0-9]{5,6}', flags: 'g', capture_group: 0, scope: 'public', enabled: 1, priority: 50 },
  { name: '护照号', category: '证件', description: '常见中国护照号码', pattern: '(?<![A-Z0-9])[EGP]\\d{8}(?![A-Z0-9])', flags: 'g', capture_group: 0, scope: 'public', enabled: 1, priority: 51 },
  { name: '经纬度', category: '地理', description: '经纬度坐标对', pattern: '[-+]?\\d{1,3}\\.\\d{3,}\\s*[,，]\\s*[-+]?\\d{1,3}\\.\\d{3,}', flags: 'g', capture_group: 0, scope: 'public', enabled: 1, priority: 52 },
  { name: '合同金额', category: '合同', description: '合同/订单中的金额表述', pattern: '(?:合同金额|订单金额|总价|价款)[：:为\\s]*[¥￥]?\\s?\\d[\\d,]*(?:\\.\\d{1,2})?\\s?(?:元|万元|亿元)?', flags: 'g', capture_group: 0, scope: 'public', enabled: 1, priority: 53 },
];

export function ensurePublicRegexRules(db: Db): void {
  const exists = db.prepare("SELECT 1 FROM regex_rules WHERE scope='public' AND name=?").get('邮箱');
  if (exists) return;
  const insert = db.prepare(
    `INSERT INTO regex_rules (id, name, category, description, pattern, flags, capture_group, scope, library_id, enabled, priority, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'public', NULL, ?, ?, NULL, ?, ?)`,
  );
  const now = nowIso();
  for (const rule of PUBLIC_RULES) {
    insert.run(newId('rx'), rule.name, rule.category, rule.description, rule.pattern, rule.flags, rule.capture_group, rule.enabled, rule.priority, now, now);
  }
}

export function loadRegexRules(db: Db, libraryId: string): RegexRule[] {
  return db.prepare(
    `SELECT * FROM regex_rules WHERE enabled = 1 AND (scope = 'public' OR (scope = 'library' AND library_id = ?)) ORDER BY priority ASC, name ASC`,
  ).all(libraryId) as unknown as RegexRule[];
}

export function extractRegexMatches(rules: RegexRule[], text: string): RegexMatch[] {
  const matches: RegexMatch[] = [];
  const perRule = new Map<string, number>();
  for (const rule of rules) {
    let regex: RegExp;
    try {
      const flags = rule.flags.includes('g') ? rule.flags : `${rule.flags}g`;
      regex = new RegExp(rule.pattern, flags);
    } catch {
      continue;
    }
    for (const match of text.matchAll(regex)) {
      const value = String(match[Math.max(0, Number(rule.capture_group ?? 0))] ?? match[0] ?? '').trim();
      if (!value || value.length > 200) continue;
      const count = perRule.get(rule.id) ?? 0;
      if (count >= 50 || matches.length >= 600) break;
      const index = Number(match.index ?? 0);
      if (matches.some((existing) => index < existing.index + existing.value.length && existing.index < index + value.length)) continue;
      perRule.set(rule.id, count + 1);
      matches.push({ ruleId: rule.id, name: rule.name, category: rule.category, value, index });
    }
  }
  return matches;
}

export function regexSummary(matches: RegexMatch[]): { total: number; byCategory: Record<string, number>; samples: RegexMatch[] } {
  const byCategory: Record<string, number> = {};
  for (const match of matches) byCategory[match.category] = (byCategory[match.category] ?? 0) + 1;
  const seen = new Set<string>();
  const samples: RegexMatch[] = [];
  for (const match of matches) {
    const key = `${match.name}:${match.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    samples.push(match);
    if (samples.length >= 60) break;
  }
  return { total: matches.length, byCategory, samples };
}
