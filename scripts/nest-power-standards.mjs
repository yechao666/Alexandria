#!/usr/bin/env node
const BASE = process.env.ALEXANDRIA_URL || 'http://127.0.0.1:4520';
const LIB = 'lib_a316905460c5420a99c0';
const CHILDREN = {
  '发电与新能源': [
    ['火电', /火电|煤电|燃煤|燃气|热电|锅炉|汽机|发电厂|电厂/],
    ['水电', /水电|水电站|抽水蓄能|水轮/],
    ['核电', /核电|核电厂|核岛|核安全/],
    ['风电', /风电|风机|海上风电|风电场/],
    ['光伏与光热', /光伏|太阳能|光热/],
    ['储能与氢能', /储能|电池|氢能/],
    ['综合', /./],
  ],
  '输电': [
    ['特高压与直流', /特高压|直流|换流/],
    ['电网与线路', /电网|线路|架空|电缆/],
    ['综合', /./],
  ],
  '变电': [
    ['变电站', /变电站|开关站|GIS/],
    ['换流站', /换流站|换流阀/],
    ['主设备', /变压器|电抗器|套管|断路器/],
    ['综合', /./],
  ],
  '配电与用电': [
    ['配网', /配电|配网|台区|农网|微电网/],
    ['用电服务', /用电|供电|客户|营商环境/],
    ['充电设施', /充电/],
    ['综合', /./],
  ],
  '工程建设': [['施工与安装', /施工|安装|土建/], ['设计与验收', /设计|验收|监理|评价/], ['综合', /./]],
  '设备与试验': [['一次设备', /变压器|开关|电缆|绝缘|电抗器/], ['二次与自动化', /继电保护|自动化|通信|计量/], ['试验检测', /试验|检测|校准/], ['综合', /./]],
  '安全与环保': [['安全', /安全|消防|职业/], ['环保与节能', /环保|节能|碳|排放/], ['综合', /./]],
  '市场与调度': [['电力市场', /市场|交易|现货|辅助服务|电价/], ['调度运行', /调度|运行|并网/], ['综合', /./]],
  '基础与通用': [['术语与导则', /术语|导则|总则|通用/], ['综合', /./]],
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function login() {
  const response = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'lin@alex.dev', password: 'alex-demo' }) });
  if (!response.ok) throw new Error(`login ${response.status}`);
  return response.headers.get('set-cookie')?.split(';')[0];
}
async function req(path, cookie, options = {}) {
  const response = await fetch(`${BASE}${path}`, { ...options, headers: { cookie, ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `HTTP ${response.status}`);
  return data;
}
async function main() {
  const cookie = await login();
  const detail = await req(`/api/libraries/${LIB}`, cookie);
  const parents = new Map((detail.nodes ?? []).filter((node) => node.sourceCount > 0 || Boolean(CHILDREN[node.name])).map((node) => [node.name, node]));
  const childIds = new Map();
  for (const [parentName, children] of Object.entries(CHILDREN)) {
    const parent = parents.get(parentName);
    if (!parent) continue;
    const existing = new Map((parent.children ?? []).map((child) => [child.name, child]));
    for (const [name] of children) {
      if (existing.has(name)) { childIds.set(`${parentName}/${name}`, existing.get(name).id); continue; }
      const created = await req(`/api/libraries/${LIB}/nodes`, cookie, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, parentId: parent.id, kind: 'section', description: `${parentName} / ${name}` }) });
      childIds.set(`${parentName}/${name}`, created.node.id);
    }
  }
  const sources = (await req(`/api/sources?library=${LIB}&limit=2000`, cookie)).sources ?? [];
  let moved = 0;
  for (const source of sources) {
    const parentName = source.nodeName;
    const rules = CHILDREN[parentName];
    if (!rules) continue;
    const matched = rules.find(([, pattern]) => pattern.test(source.title)) ?? rules[rules.length - 1];
    const childId = childIds.get(`${parentName}/${matched[0]}`);
    if (!childId || source.nodeId === childId) continue;
    try {
      await req(`/api/sources/${encodeURIComponent(source.id)}`, cookie, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: source.title, nodeId: childId }) });
      moved += 1;
    } catch (error) { console.warn(`[nest] skip ${source.title.slice(0, 24)}: ${error.message}`); }
    await sleep(30);
  }
  console.log(`[nest] moved ${moved}/${sources.length} sources into nested nodes`);
}
main().catch((error) => { console.error(error); process.exit(1); });
