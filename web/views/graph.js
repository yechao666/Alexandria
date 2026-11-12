import { api, state, icon, escapeHtml as esc, libraryColor, toast, go, openModal } from '../assets/core.js';
import { mountGraph } from '../assets/graph.js';

export async function renderGraph(libraryRef) {
  const library = state.libraries.find((item) => item.slug === libraryRef || item.id === libraryRef);
  const query = library ? `?library=${encodeURIComponent(library.id)}` : '';
  const graph = await api(`/api/graph${query}`);
  const hierarchy = await api(`/api/graph/hierarchy${query}`).catch(() => ({ nodes: [], edges: [] }));
  const classes = [...new Map(graph.nodes.map((node) => [node.classKey, { key: node.classKey, name: node.className, color: node.color }])).values()];
  return `
    <div class="between" style="align-items:flex-end;margin-bottom:16px">
      <div>
        <div class="eyebrow">TYPED GRAPH · WIKILINKS · SEMANTIC EDGES</div>
        <h1 style="font-size:38px;letter-spacing:-.03em;margin:6px 0 4px">${library ? esc(library.name) + ' · 图谱' : '知识图谱'}</h1>
        <p class="muted" style="margin:0">${graph.nodes.length} 个知识节点 · ${graph.edges.length} 条类型化关联。节点大小约等于连接度，颜色代表本体类型。</p>
      </div>
      <div class="btn-row">
        <select class="select" id="graph-library" style="width:auto">${state.libraries.map((item) => `<option value="${esc(item.slug)}" ${library && item.id === library.id ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</select>
        <select class="select" id="graph-class" style="width:auto"><option value="">全部类型</option>${classes.map((item) => `<option value="${esc(item.key)}">${esc(item.name)}</option>`).join('')}</select>
        <button class="btn btn-sm" id="graph-path">${icon('graph', 14)} 路径</button>
        <button class="btn btn-sm" id="graph-fit">${icon('refresh', 14)} 重置</button>
      </div>
    </div>
    <div class="graph-shell">
      <canvas class="graph-canvas" id="graph-canvas"></canvas>
      <div class="graph-legend" id="graph-legend">${classes.map((item) => `<span class="item"><span class="swatch" style="background:${libraryColor(item.color)}"></span>${esc(item.name)}</span>`).join('')}</div>
      <div class="graph-toolbar"><button class="btn btn-sm" id="graph-refit">${icon('refresh', 14)} 重置视图</button></div>
    </div>
    <div class="grid grid-3" style="margin-top:16px">
      <div class="panel panel-pad"><div class="small faint">高连接节点</div><div class="rail-list" style="margin-top:8px">${graph.nodes
        .slice()
        .sort((a, b) => (b.degree ?? 0) - (a.degree ?? 0))
        .slice(0, 5)
        .map((node) => `<a class="rail-item" href="#/page/${encodeURIComponent(node.id)}"><span class="dot" style="background:${libraryColor(node.color)}"></span><span>${esc(node.title)} <span class="faint">${node.degree ?? 0}</span></span></a>`)
        .join('')}</div></div>
      <div class="panel panel-pad"><div class="small faint">关系分布</div><div class="rail-list" style="margin-top:8px">${relationCounts(graph.edges).map((item) => `<div class="stat-row"><span>${esc(relationLabel(item.relation))}</span><b>${item.count}</b></div>`).join('') || '<div class="rail-empty">暂无关系</div>'}</div></div>
      <div class="panel panel-pad"><div class="small faint">读图方式</div><p class="small muted" style="margin-top:8px">实线是正文 wikilink 或编译建立的关联；<span class="badge jade">虚线圈</span>表示草稿页。点击节点进入知识页，滚轮缩放，拖动空白处平移。</p></div>
    </div>
    <div class="panel" style="margin-top:16px">
      <div class="panel-head"><h3>层级视图</h3><span class="small muted">broader-than / parent-of · ${hierarchy.nodes.length} 个节点</span></div>
      <div class="panel-body">
        ${hierarchy.nodes.length ? `<div class="hierarchy-list">${hierarchy.nodes.slice(0, 80).map((node) => `<a class="hierarchy-row" style="padding-left:${8 + Math.min(8, node.level) * 26}px" href="#/page/${encodeURIComponent(node.id)}"><span class="dot" style="background:${libraryColor(node.color)}"></span><span class="h-name">${esc(node.title)}</span><span class="badge outline">${esc(node.className)}</span><span class="faint small">${node.level === 0 ? '根节点' : `第 ${node.level} 层`}</span></a>`).join('')}</div>` : '<div class="rail-empty">当前范围还没有上下位关系。DSH 编译时会在概念 JSON 中写入 parent，图谱随后显示层级。</div>'}
      </div>
    </div>`;
}

export function mountGraphView() {
  const canvas = document.getElementById('graph-canvas');
  if (!canvas) return;
  const legend = document.getElementById('graph-legend');
  let handle = null;
  let current = null;
  const mountFiltered = () => {
    if (!current) return;
    const classKey = document.getElementById('graph-class')?.value ?? '';
    const nodes = classKey ? current.nodes.filter((node) => node.classKey === classKey) : current.nodes;
    const ids = new Set(nodes.map((node) => node.id));
    const edges = current.edges.filter((edge) => (!classKey || (ids.has(edge.source) && ids.has(edge.target))));
    handle?.destroy?.();
    handle = mountGraph(canvas, { nodes, edges }, { onSelect: (node) => go(`#/page/${encodeURIComponent(node.id)}`) });
  };
  const load = async () => {
    const select = document.getElementById('graph-library');
    const library = state.libraries.find((item) => item.slug === select?.value || item.id === select?.value) ?? state.libraries[0];
    const graph = await api(library ? `/api/graph?library=${encodeURIComponent(library.id)}` : '/api/graph');
    current = graph;
    const classes = [...new Map(graph.nodes.map((node) => [node.classKey, { key: node.classKey, name: node.className, color: node.color }])).values()];
    if (legend) legend.innerHTML = classes.map((item) => `<span class="item"><span class="swatch" style="background:${libraryColor(item.color)}"></span>${esc(item.name)}</span>`).join('') + '<span class="item"><span class="swatch" style="background:var(--ochre)"></span>草稿</span>';
    mountFiltered();
  };
  load().catch((error) => toast(error.message, 'error'));
  document.getElementById('graph-library')?.addEventListener('change', () => load().catch((error) => toast(error.message, 'error')));
  document.getElementById('graph-class')?.addEventListener('change', mountFiltered);
  document.getElementById('graph-path')?.addEventListener('click', () => {
    if (!current?.nodes?.length) return;
    const options = current.nodes.map((node) => `<option value="${esc(node.id)}">${esc(node.title)}</option>`).join('');
    openModal({
      title: '知识路径',
      body: `<p class="small muted">沿着已编译的关联寻找两点之间的最短路径。</p><div class="field" style="margin-top:12px"><label>起点</label><select class="select" id="path-from">${options}</select></div><div class="field" style="margin-top:8px"><label>终点</label><select class="select" id="path-to">${options}</select></div><div id="path-result" style="margin-top:12px"></div>`,
      footer: `<button class="btn" data-close-modal>关闭</button><button class="btn btn-primary" id="find-path">查找路径</button>`,
      onMount: (modal) => {
        modal.querySelector('#find-path')?.addEventListener('click', async () => {
          const from = modal.querySelector('#path-from')?.value;
          const to = modal.querySelector('#path-to')?.value;
          try {
            const path = await api(`/api/graph/path?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
            const result = path.pages.map((page, index) => `<div class="rail-item"><span class="dot" style="background:${libraryColor('jade')}"></span><span>${index + 1}. ${esc(page.title)}${path.edges[index - 1] ? ` <span class="faint">—${esc(relationLabel(path.edges[index - 1].relation))}→</span>` : ''}</span></div>`).join('');
            modal.querySelector('#path-result').innerHTML = result || '<div class="rail-empty">没有路径</div>';
          } catch (error) { modal.querySelector('#path-result').innerHTML = `<div class="small muted">${esc(error.message)}</div>`; }
        });
      },
    });
  });
  document.getElementById('graph-fit')?.addEventListener('click', () => handle?.fit?.());
  document.getElementById('graph-refit')?.addEventListener('click', () => handle?.fit?.());
}

function relationLabel(relation) {
  return { references: '引用', 'derived-from': '源自', 'depends-on': '依赖', 'related-to': '相关', mentions: '提及', contradicts: '矛盾', supersedes: '取代', 'source-document': '文献入口', 'broader-than': '上位', 'parent-of': '父级' }[relation] ?? relation;
}

function relationCounts(edges) {
  const map = new Map();
  for (const edge of edges) map.set(edge.relation, (map.get(edge.relation) ?? 0) + 1);
  return [...map.entries()].map(([relation, count]) => ({ relation, count })).sort((a, b) => b.count - a.count);
}
