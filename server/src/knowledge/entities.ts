import type { Db } from '../db/index.ts';
import type { Actor, PageRow } from '../types.ts';
import { normalizeTitle } from './terms.ts';
import { effectivePageRole } from '../domain/access.ts';

export interface MergeSuggestion {
  source: { id: string; title: string; slug: string; classKey: string; confidence: number; status: string };
  target: { id: string; title: string; slug: string; classKey: string; confidence: number; status: string };
  score: number;
  reasons: string[];
}

function bigrams(value: string): Set<string> {
  const text = normalizeTitle(value).replace(/\s+/g, '');
  const grams = new Set<string>();
  for (let i = 0; i < text.length - 1; i += 1) grams.add(text.slice(i, i + 2));
  return grams;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function titleKey(page: PageRow): string {
  return normalizeTitle(page.title);
}

function aliasesOf(page: PageRow): string[] {
  try {
    const parsed = JSON.parse(page.aliases) as unknown;
    return Array.isArray(parsed) ? parsed.map(String).map(normalizeTitle).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** 计算两条知识页的重复概率（0–1），用于人工确认合并。 */
export function duplicateScore(a: PageRow, b: PageRow): { score: number; reasons: string[] } {
  if (a.class_key !== b.class_key) return { score: 0, reasons: [] };
  if (a.library_id !== b.library_id) return { score: 0, reasons: [] };
  const reasons: string[] = [];
  const aTitle = titleKey(a);
  const bTitle = titleKey(b);
  const aAliases = aliasesOf(a);
  const bAliases = aliasesOf(b);
  let score = 0;
  if (aTitle && aTitle === bTitle) {
    score = 1;
    reasons.push('标题相同');
  } else if (aTitle.length >= 3 && (aTitle.includes(bTitle) || bTitle.includes(aTitle))) {
    score = Math.max(score, 0.82);
    reasons.push('标题包含');
  }
  if (aAliases.some((alias) => alias === bTitle) || bAliases.some((alias) => alias === aTitle)) {
    score = Math.max(score, 0.94);
    reasons.push('标题与对方别名一致');
  }
  const sharedAlias = aAliases.find((alias) => bAliases.includes(alias));
  if (sharedAlias) {
    score = Math.max(score, 0.92);
    reasons.push('共享别名');
  }
  const titleJaccard = jaccard(bigrams(a.title), bigrams(b.title));
  if (titleJaccard >= 0.55) {
    score = Math.max(score, 0.6 + titleJaccard * 0.22);
    reasons.push(`标题相似 ${(titleJaccard * 100).toFixed(0)}%`);
  }
  const summaryJaccard = jaccard(bigrams(`${a.summary} ${a.tldr}`), bigrams(`${b.summary} ${b.tldr}`));
  if (titleJaccard >= 0.35 && summaryJaccard >= 0.3) {
    score = Math.max(score, 0.55 + summaryJaccard * 0.2);
    reasons.push('摘要语境相近');
  }
  return { score: Math.round(score * 100) / 100, reasons };
}

export function mergeSuggestions(db: Db, actor: Actor, libraryId: string, minimum = 0.62): MergeSuggestion[] {
  const rows = (db.prepare('SELECT * FROM pages WHERE library_id = ?').all(libraryId) as unknown as PageRow[])
    .filter((page) => page.class_key !== 'source' && page.status !== 'archived')
    .filter((page) => Boolean(effectivePageRole(db, actor, page)));
  const suggestions: MergeSuggestion[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const a = rows[i]!;
      const b = rows[j]!;
      const { score, reasons } = duplicateScore(a, b);
      if (score < minimum) continue;
      const target = a.confidence >= b.confidence ? a : b;
      const source = target.id === a.id ? b : a;
      suggestions.push({
        source: { id: source.id, title: source.title, slug: source.slug, classKey: source.class_key, confidence: source.confidence, status: source.status },
        target: { id: target.id, title: target.title, slug: target.slug, classKey: target.class_key, confidence: target.confidence, status: target.status },
        score,
        reasons,
      });
    }
  }
  return suggestions.sort((a, b) => b.score - a.score).slice(0, 40);
}

// ---------------------------------------------------------------------------
// 规则编译器的实体抽取：只接受可验证的机构、设备与标准，拒绝从句片段。
// ---------------------------------------------------------------------------

export interface RuleEntity {
  name: string;
  canonical: string;
  type: string;
  description: string;
}

const KNOWN_ORGANIZATIONS: { canonical: string; aliases: string[] }[] = [
  { canonical: '国家电网', aliases: ['国家电网有限公司', '国家电网公司', '国家电网'] },
  { canonical: '南方电网', aliases: ['中国南方电网有限责任公司', '中国南方电网公司', '南方电网'] },
  { canonical: '内蒙古电力集团', aliases: ['内蒙古电力（集团）有限责任公司', '内蒙古电力(集团)有限责任公司', '内蒙古电力集团'] },
  { canonical: '国网蒙东电力', aliases: ['国网内蒙古东部电力有限公司', '国网蒙东电力', '蒙东电力'] },
  { canonical: '中国华能', aliases: ['中国华能集团有限公司', '中国华能集团', '中国华能'] },
  { canonical: '中国大唐', aliases: ['中国大唐集团有限公司', '中国大唐集团', '中国大唐'] },
  { canonical: '中国华电', aliases: ['中国华电集团有限公司', '中国华电集团', '中国华电'] },
  { canonical: '国家能源集团', aliases: ['国家能源投资集团有限责任公司', '国家能源投资集团', '国家能源集团'] },
  { canonical: '国家电投', aliases: ['国家电力投资集团有限公司', '国家电力投资集团', '国家电投'] },
  { canonical: '三峡集团', aliases: ['中国长江三峡集团有限公司', '中国长江三峡集团', '三峡集团'] },
  { canonical: '中核集团', aliases: ['中国核工业集团有限公司', '中国核工业集团', '中核集团'] },
  { canonical: '中广核', aliases: ['中国广核集团有限公司', '中国广核集团', '中广核'] },
  { canonical: '中国电建', aliases: ['中国电力建设集团有限公司', '中国电力建设集团', '中国电建'] },
  { canonical: '中国能建', aliases: ['中国能源建设集团有限公司', '中国能源建设集团', '中国能建'] },
  { canonical: '国家能源局', aliases: ['中国国家能源局', '国家能源局'] },
  { canonical: '国家发展改革委', aliases: ['国家发展和改革委员会', '国家发展改革委', '国家发改委'] },
  { canonical: '中电联', aliases: ['中国电力企业联合会', '中电联'] },
  { canonical: '华北电网', aliases: ['华北电网有限公司', '华北电网'] },
  { canonical: '华东电网', aliases: ['华东电网有限公司', '华东电网'] },
  { canonical: '华中电网', aliases: ['华中电网有限公司', '华中电网'] },
  { canonical: '西南电网', aliases: ['西南电网有限公司', '西南电网'] },
  { canonical: '西北电网', aliases: ['西北电网有限公司', '西北电网'] },
  { canonical: '东北电网', aliases: ['东北电网有限公司', '东北电网'] },
  { canonical: '内蒙古东部电网', aliases: ['内蒙古东部电网', '蒙东电网'] },
  { canonical: '南方能源监管局', aliases: ['国家能源局南方监管局', '南方能源监管局'] },
  { canonical: '华北能源监管局', aliases: ['国家能源局华北监管局', '华北能源监管局'] },
  { canonical: '华东能源监管局', aliases: ['国家能源局华东监管局', '华东能源监管局'] },
  { canonical: '华中能源监管局', aliases: ['国家能源局华中监管局', '华中能源监管局'] },
  { canonical: '西北能源监管局', aliases: ['国家能源局西北监管局', '西北能源监管局'] },
  { canonical: '东北能源监管局', aliases: ['国家能源局东北监管局', '东北能源监管局'] },

  { canonical: '中国电力科学研究院', aliases: ['中国电力科学研究院有限公司', '中国电力科学研究院'] },
  { canonical: '国网能源研究院', aliases: ['国网能源研究院有限公司', '国网能源研究院'] },
  { canonical: '中国能源传媒集团', aliases: ['中国能源传媒集团有限公司', '中国能源传媒集团'] },
  { canonical: '中国长江电力', aliases: ['中国长江电力股份有限公司', '中国长江电力'] },
];

const BAD_START = /^(为|也|该|由|从|与|和|及|对|在|是|将|把|被|让|使|实现|推动|推进|加强|提升|形成|打造|建设|促进|落实|包括|其中|主要|相关|有关|后续|目前|今年|本次|一批|两家|三家|三省|多省|国内|我国|全省|全市|全区|时期|同时|以及|并且|此外|从而|进而|可|能|应|需|要|已|正|还|又|再|就|才|只|均|都|等|各|本|其|此|这|那|之|所|者|All|集团|有限|资产|商贸|实业|投资|发展|运营|管理|论坛|会议|年内|先后|联合|协同|会同|不|未|无|拟|没有)/;
const BAD_CONTAINS = /(的|与|及|和|、|，|。|；|：|分别|包括|以及|通过|实现|成为|作为|标准由|资料中|企业分别为|一批|多个|我国|国内|今年|本次|后续|同时|时期|All是|等企业|等公司|在|对|向|从|由|将|把|被|让|使|推进|举行|召开|论坛|会议|工作|情况|问题|方面|领域|期间|年内|先后|目前|联合|协同|会同|所属|旗下|下属)/;
const LOCATION_PREFIX = /^(国家|南方|内蒙古|蒙东|蒙西|华东|华北|华中|西南|西北|东北|上海|北京|天津|重庆|河北|山西|山东|江苏|浙江|安徽|福建|江西|河南|湖北|湖南|广东|广西|海南|四川|贵州|云南|陕西|甘肃|青海|宁夏|新疆|西藏|辽宁|吉林|黑龙江|深圳|雄安)/;
const EQUIPMENT = ['特高压', '变压器', '换流阀', '换流站', 'GIS', '风机', '光伏组件', '储能电池', '电缆', '电抗器', '断路器', '智能电表', '储能电站', '抽水蓄能', '电化学储能'];

function normalizeEntity(value: string): string {
  return value.replace(/[「」『』“”"'《》\s]/g, '').trim();
}

export function canonicalEntityName(name: string): string {
  const clean = normalizeEntity(name);
  for (const organization of KNOWN_ORGANIZATIONS) {
    if (organization.canonical === clean || organization.aliases.includes(clean)) return organization.canonical;
  }
  return clean;
}

export function isValidEntityName(name: string): boolean {
  const clean = normalizeEntity(name);
  if (clean.length < 2 || clean.length > 32) return false;
  if (!/[\u4e00-\u9fa5]/.test(clean)) return false;
  if (BAD_START.test(clean) || BAD_CONTAINS.test(clean)) return false;
  if (/^(上市公司|项目公司|公司|企业|集团|电网|电站|集团有限公司|有限公司|有限责任公司|资产管理有限公司|商贸有限公司)$/.test(clean)) return false;
  if (/^(GB|DL|NB|JB|YD|IEC|IEEE)\s*\/?\s*T?\s*[\d.]/i.test(clean)) return false;
  if (KNOWN_ORGANIZATIONS.some((organization) => organization.canonical === clean)) return true;
  if (clean.endsWith('电网')) return false;
  if (/^[一二三四五六七八九十百千万两0-9]+(家|个|座|项|条|批)/.test(clean)) return false;
  if (/^[0-9]/.test(clean)) return false;
  const companyPrefix = clean.match(/^(.+?)(?:有限责任公司|股份有限公司|有限公司)$/)?.[1] ?? '';
  if (companyPrefix && companyPrefix.length < 4) return false;
  return true;
}

export function isKnownEntityName(name: string): boolean {
  const clean = normalizeEntity(name);
  if (KNOWN_ORGANIZATIONS.some((organization) => organization.canonical === clean)) return true;
  return EQUIPMENT.includes(clean);
}

export function extractRuleEntities(text: string, title: string): RuleEntity[] {
  const found = new Map<string, RuleEntity>();
  const body = `${title}\n${text}`;
  const add = (raw: string, type: string, description: string) => {
    const name = canonicalEntityName(raw);
    if (!isValidEntityName(name)) return;
    if (!found.has(name)) found.set(name, { name, canonical: name, type, description });
  };

  for (const organization of KNOWN_ORGANIZATIONS) {
    for (const alias of [...organization.aliases].sort((a, b) => b.length - a.length)) {
      if (body.includes(alias)) { add(organization.canonical, '组织', '资料中出现的组织机构'); break; }
    }
  }

  for (const match of title.matchAll(/([\u4e00-\u9fa5]{2,24}(?:有限责任公司|股份有限公司|有限公司|集团|研究院|设计院|大学|交易所))/g)) {
    const candidate = match[1];
    if (candidate.length >= 6) add(candidate, '组织', '资料中出现的组织机构');
  }

  for (const name of EQUIPMENT) {
    if (body.includes(name)) add(name, '设备', '资料中出现的电力设备或技术');
  }
  return [...found.values()].slice(0, 10);
}
