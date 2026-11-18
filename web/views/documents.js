import {
  api,
  state,
  icon,
  escapeHtml as esc,
  fmtNumber,
  fmtBytes,
  timeAgo,
  statusBadge,
  classBadge,
  confidence,
  libraryColor,
  go,
  toast,
  emptyState,
  loadBootstrap,
  openModal,
  closeModal,
} from '../assets/core.js';
import { openFilePreview } from '../assets/preview.js';

const STATUS_LABEL = {
  ready: '已编译',
  processing: '处理中',
  queued: '排队中',
  failed: '失败',
  uploaded: '待处理',
};

const KIND_LABEL = {
  pdf: 'PDF',
  docx: 'Word',
  doc: 'Word',
  pptx: 'PPT',
  ppt: 'PPT',
  xlsx: 'Excel',
  xls: 'Excel',
  md: 'Markdown',
  markdown: 'Markdown',
  txt: '文本',
  html: 'HTML',
  tex: 'TeX',
  rtf: 'RTF',
  wps: 'WPS',
  image: '图片',
  odt: 'ODT',
  epub: 'EPUB',
};

function kindLabel(source) {
  return KIND_LABEL[source.kind] ?? KIND_LABEL[String(source.ext ?? '').toLowerCase()] ?? String(source.ext ?? source.kind ?? '文档').toUpperCase();
}

function statusPill(status) {
  const tone = status === 'ready' ? 'jade' : status === 'failed' ? 'clay' : 'ochre';
  return `<span class="badge ${tone}">${STATUS_LABEL[status] ?? status}</span>`;
}

export async function renderDocuments(query = new URLSearchParams()) {
  if (!state.bootstrap) await loadBootstrap();
  const params = new URLSearchParams(query);
  const data = await api('/api/sources?limit=500').catch(() => ({ sources: [], summary: {}, facets: {} }));
  const sources = data.sources ?? [];
  const summary = data.summary ?? {};
  const selectedLibrary = params.get('library') ?? '';
  const selectedNode = params.get('node') ?? '';
  const selectedStatus = params.get('status') ?? '';
  const q = params.get('q') ?? '';
  const view = params.get('view') === 'grid' ? 'grid' : 'list';
  const libraries = state.libraries ?? [];
  const details = await Promise.all(libraries.map((library) => api(`/api/libraries/${encodeURIComponent(library.id)}`).catch(() => null)));
  const byId = new Map(libraries.map((library, index) => [library.id, details[index]]));
  const nodeSourceTotal = (node) => (Number(node.sourceCount ?? 0) + (node.children ?? []).reduce((sum, child) => sum + nodeSourceTotal(child), 0));
  const nodePath = new Map();
  const walkPaths = (nodes, parent = []) => {
    for (const node of nodes ?? []) {
      const path = [...parent, node.id];
      nodePath.set(node.id, path);
      walkPaths(node.children, path);
    }
  };
  for (const detail of byId.values()) walkPaths(detail.nodes ?? []);
  const departments = new Map();
  for (const library of libraries) {
    const name = library.ownerTeamName || '未绑定部门';
    if (!departments.has(name)) departments.set(name, []);
    departments.get(name).push(library);
  }
  const treeRows = [...departments.entries()].map(([department, items]) => `<div class="tree-dept">${esc(department)}</div>${items.map((library) => {
    const detail = byId.get(library.id);
    const nodes = detail?.nodes ?? [];
    const renderNode = (node, depth = 1) => {
      const active = selectedLibrary === library.id && selectedNode === node.id;
      const children = node.children ?? [];
      const row = `<button class="tree-row tree-child ${active ? 'active' : ''}" style="--tree-depth:${Math.min(depth, 6)}" data-doc-library="${esc(library.id)}" data-doc-node="${esc(node.id)}" data-name="${esc(node.name)}"><span class="tree-toggle ${children.length ? '' : 'tree-leaf'}" ${children.length ? `data-node-toggle="${esc(node.id)}"` : ''}>${children.length ? icon('chevron', 11) : ''}</span>${icon(children.length ? 'folder' : 'file', 13)}<span class="tree-name">${esc(node.name)}</span><span class="tree-count">${fmtNumber(nodeSourceTotal(node))}</span></button>`;
      return `${row}${children.length ? `<div class="tree-children" data-tree-children-node="${esc(node.id)}">${children.map((child) => renderNode(child, depth + 1)).join('')}</div>` : ''}`;
    };
    return `<button class="tree-row ${selectedLibrary === library.id && !selectedNode ? 'active' : ''}" data-doc-library="${esc(library.id)}" data-name="${esc(library.name)}"><span class="tree-toggle ${selectedLibrary === library.id ? '' : 'collapsed'}" data-tree-toggle="${esc(library.id)}">${icon('chevron', 11)}</span>${icon('layers', 13)}<span class="tree-name">${esc(library.name)}</span><span class="tree-count">${fmtNumber(library.counts?.sources)}</span></button><div class="tree-children" data-tree-children="${esc(library.id)}" ${selectedLibrary === library.id ? '' : 'hidden'}>${nodes.map((node) => renderNode(node)).join('')}</div>`;
  }).join('')}`).join('');
  const folderRows = `<button class="tree-row ${!selectedLibrary ? 'active' : ''}" data-doc-library="" data-doc-node="" data-name="全部文档"><span class="tree-toggle">${icon('file', 11)}</span><span class="tree-name">全部文档</span><span class="tree-count">${fmtNumber(summary.total)}</span></button>${treeRows}`;
  const current = libraries.find((library) => library.id === selectedLibrary);
  const currentNodeName = (() => {
    if (!current || !selectedNode) return '';
    const detail = byId.get(current.id);
    const walk = (nodes) => { for (const node of nodes ?? []) { if (node.id === selectedNode) return node.name; const found = walk(node.children); if (found) return found; } return ''; };
    return walk(detail?.nodes ?? []);
  })();
  const cards = sources.map((source) => `<div class="file-card ${view === 'list' ? 'file-row' : ''}" data-file-id="${esc(source.id)}" data-library="${esc(source.libraryId)}" data-node="${esc(source.nodeId || '')}" data-node-path="${esc((nodePath.get(source.nodeId) ?? []).join(','))}" data-status="${esc(source.status)}" data-search="${esc(`${source.title} ${source.filename} ${source.libraryName} ${source.departmentName}`.toLowerCase())}" tabindex="0">
    <span class="file-kind ${source.kind === 'image' ? 'image' : ''}">${icon(source.kind === 'image' ? 'image' : 'file', 20)}<b>${esc(kindLabel(source))}</b></span>
    <div class="file-main"><div class="file-name">${esc(source.title)}</div><div class="file-meta">${esc(source.departmentName && source.departmentName !== source.libraryName ? `${source.departmentName} · ${source.libraryName}` : (source.libraryName || source.departmentName || '未归档'))} · ${fmtNumber(source.wordCount)} 字 · ${timeAgo(source.createdAt)}</div></div>
    <div class="file-links"><b>${fmtNumber(source.compiledPages)}</b><span>知识点</span></div>
    ${statusPill(source.status)}
    <span class="file-chevron">${icon('chevron', 14)}</span>
  </div>`).join('');

  return `<section class="page-head">
    <div><div class="eyebrow">DOCUMENTS FIRST · KNOWLEDGE ATTACHED</div><h1>文档</h1><p>先管理熟悉的文件，再查看文件编译出的知识。按部门与知识库归档，原文、状态、来源与知识点都在同一处。</p></div>
    <div class="page-actions"><a class="btn" href="#/libraries">${icon('layers', 14)} 知识库视图</a><a class="btn btn-primary" href="#/upload">${icon('upload', 14)} 导入文档</a></div>
  </section>
  <div class="drive-layout">
    <aside class="drive-folders">
      <div class="drive-folders-head"><span>部门 / 知识库</span><span>${sources.length}</span></div>
      <div class="tree-tools"><input id="doc-tree-search" placeholder="筛选目录…"><button id="doc-tree-collapse" title="收起全部">${icon('layers', 12)}</button></div>
      ${folderRows}
    </aside>
    <section class="drive-main">
      <div class="drive-toolbar">
        <div class="drive-breadcrumb"><span>文档</span><span>/</span><b id="doc-current">${esc(current?.name ?? '全部文档')}${currentNodeName ? ` / ${esc(currentNodeName)}` : ''}</b></div>
        <form class="doc-search" id="doc-search"><input class="input" name="q" value="${esc(q)}" placeholder="搜索文档、文件名、部门…" aria-label="搜索文档"><button class="btn btn-sm" type="submit">${icon('search', 13)}</button></form>
        <select class="select" id="doc-status"><option value="">全部状态</option>${['ready', 'processing', 'failed'].map((status) => `<option value="${status}" ${selectedStatus === status ? 'selected' : ''}>${STATUS_LABEL[status]}</option>`).join('')}</select>
        <div class="drive-view-toggle"><button class="${view === 'grid' ? 'active' : ''}" data-doc-view="grid" title="网格">${icon('layers', 14)}</button><button class="${view === 'list' ? 'active' : ''}" data-doc-view="list" title="列表">${icon('menu', 14)}</button></div>
      </div>
      <div class="drive-summary"><span><b id="doc-visible">${fmtNumber(summary.total)}</b> 文档</span><span><b>${fmtNumber(summary.ready)}</b> 已编译</span><span><b>${fmtNumber(summary.processing)}</b> 处理中</span><span><b>${fmtNumber(summary.failed)}</b> 失败</span><span><b>${fmtNumber(summary.withoutKnowledge)}</b> 无知识点</span></div>
      <div class="file-grid ${view === 'list' ? 'view-list' : ''}" id="file-grid">${cards || emptyState('还没有文档', '导入第一份资料，系统会保留原文并编译出知识点。', '<a class="btn btn-primary" href="#/upload">导入文档</a>')}</div>
    </section>
    <aside class="file-inspector" id="file-inspector"><div class="inspector-empty">${icon('file', 24)}<b>选择一个文件</b><span>查看文件信息、原文预览和它关联的知识点。</span></div></aside>
  </div>`;
}

function bindFileInspector() {
  const grid = document.getElementById('file-grid');
  if (!grid) return;
  const select = async (card) => {
    grid.querySelectorAll('.file-card').forEach((item) => item.classList.toggle('selected', item === card));
    const inspector = document.getElementById('file-inspector');
    if (!inspector) return;
    inspector.innerHTML = `<div class="inspector-empty">${icon('clock', 20)}<b>正在读取文件…</b></div>`;
    try {
      const data = await api(`/api/sources/${encodeURIComponent(card.dataset.fileId)}`);
      const source = data.source;
      const pages = (source.compiledPages ?? []).filter((page) => page.status !== 'archived').filter((page, index, all) => all.findIndex((item) => item.title === page.title) === index);
      const pageRows = pages.slice(0, 8).map((page) => `<a class="inspector-page" href="#/page/${encodeURIComponent(page.id)}"><span class="dot" style="background:${libraryColor(page.classColor)}"></span><span>${esc(page.title)}</span></a>`).join('');
      inspector.innerHTML = `<div class="inspector-head"><span class="file-kind">${icon(source.kind === 'image' ? 'image' : 'file', 18)}<b>${esc(kindLabel(source))}</b></span><div><b>${esc(source.title)}</b><span>${esc(source.filename)}</span></div></div>
        <div class="inspector-section"><div class="inspector-label">文件</div><dl class="inspector-kv"><dt>部门</dt><dd>${esc(source.library?.name ?? '—')}</dd><dt>目录</dt><dd>${esc(source.node?.name ?? '未分类')}</dd><dt>大小</dt><dd>${fmtBytes(source.size)}</dd><dt>上传</dt><dd>${timeAgo(source.createdAt)}</dd></dl></div>
        <div class="inspector-section"><div class="inspector-label">关联知识点 · ${pages.length}</div><div class="inspector-pages">${pageRows || '<span class="faint small">尚未编译出知识点</span>'}</div>${pages.length > 8 ? `<a class="link small" href="#/library/${encodeURIComponent(source.library?.slug ?? '')}?tab=pages">查看全部 ${pages.length} 个 →</a>` : ''}</div>
        <div class="inspector-section"><div class="inspector-label">操作</div><div class="inspector-actions"><button class="btn btn-sm btn-primary" data-file-preview>${icon('eye', 12)} 预览</button><button class="btn btn-sm" data-file-open>${icon('external', 12)} 文档详情</button><a class="btn btn-sm btn-ghost" href="/api/sources/${encodeURIComponent(source.id)}/download" target="_blank">${icon('file', 12)} 下载</a></div></div>`;
      inspector.querySelector('[data-file-preview]')?.addEventListener('click', () => openFilePreview(source));
      inspector.querySelector('[data-file-open]')?.addEventListener('click', () => go(`#/source/${encodeURIComponent(source.id)}`));
    } catch (error) {
      inspector.innerHTML = `<div class="inspector-empty">${icon('x', 18)}<b>读取失败</b><span>${esc(error.message)}</span></div>`;
    }
  };
  grid.addEventListener('click', (event) => {
    const card = event.target.closest('.file-card');
    if (card && grid.contains(card)) select(card);
  });
  grid.addEventListener('keydown', (event) => {
    const card = event.target.closest('.file-card');
    if (card && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); select(card); }
  });
}

export function mountDocuments() {
  const grid = document.getElementById('file-grid');
  if (!grid) return;
  const cards = [...grid.querySelectorAll('.file-card')];
  const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
  const state = { library: params.get('library') ?? '', node: params.get('node') ?? '', status: params.get('status') ?? '', q: params.get('q') ?? '' };
  const base = location.hash.split('?')[0] || '#/';
  const syncUrl = () => {
    const next = new URLSearchParams();
    if (state.library) next.set('library', state.library);
    if (state.node) next.set('node', state.node);
    if (state.status) next.set('status', state.status);
    if (state.q) next.set('q', state.q);
    history.replaceState(null, '', `${base}${next.toString() ? `?${next.toString()}` : ''}`);
  };
  const apply = () => {
    let visible = 0;
    cards.forEach((card) => {
      let match = !state.library || card.dataset.library === state.library;
      if (match && state.node) match = card.dataset.node === state.node || (card.dataset.nodePath ?? '').split(',').includes(state.node);
      if (match && state.status) match = state.status === 'processing' ? ['processing', 'queued'].includes(card.dataset.status) : card.dataset.status === state.status;
      if (match && state.q) match = (card.dataset.search ?? '').includes(state.q.toLowerCase());
      card.style.display = match ? '' : 'none';
      if (match) visible += 1;
    });
    document.querySelectorAll('.tree-row').forEach((row) => row.classList.toggle('active', row.dataset.docLibrary === state.library && (row.dataset.docNode || '') === state.node));
    const current = document.querySelector(`.tree-row[data-doc-library="${CSS.escape(state.library)}"][data-doc-node="${CSS.escape(state.node)}"]`) || (state.library && !state.node ? document.querySelector(`.tree-row[data-doc-library="${CSS.escape(state.library)}"]`) : null);
    const label = current?.dataset.name || (state.library ? '知识库' : '全部文档');
    const currentEl = document.getElementById('doc-current');
    if (currentEl) currentEl.textContent = label;
    const visibleEl = document.getElementById('doc-visible');
    if (visibleEl) visibleEl.textContent = String(visible);
    const status = document.getElementById('doc-status');
    if (status) status.value = state.status;
    const search = document.querySelector('#doc-search input');
    if (search && search.value !== state.q) search.value = state.q;
    syncUrl();
  };
  apply();
  document.querySelector('.drive-folders .tree-row.active')?.scrollIntoView({ block: 'nearest' });
  document.querySelectorAll('[data-node-toggle]').forEach((button) => button.addEventListener('click', (event) => {
    event.stopPropagation();
    const children = document.querySelector(`[data-tree-children-node="${CSS.escape(button.dataset.nodeToggle)}"]`);
    if (!children) return;
    children.hidden = !children.hidden;
    button.classList.toggle('collapsed', children.hidden);
  }));
  document.getElementById('doc-tree-collapse')?.addEventListener('click', (event) => {
    event.stopPropagation();
    const collapse = ![...document.querySelectorAll('[data-tree-children]')].every((el) => el.hidden);
    document.querySelectorAll('[data-tree-children], [data-tree-children-node]').forEach((el) => { el.hidden = collapse; });
    document.querySelectorAll('[data-tree-toggle], [data-node-toggle]').forEach((el) => el.classList.toggle('collapsed', collapse));
  });
  document.getElementById('doc-tree-search')?.addEventListener('input', (event) => {
    const value = event.currentTarget.value.trim().toLowerCase();
    document.querySelectorAll('.drive-folders .tree-row').forEach((row) => { row.style.display = !value || (row.dataset.name ?? '').toLowerCase().includes(value) ? '' : 'none'; });
  });
  document.querySelectorAll('[data-tree-toggle]').forEach((button) => button.addEventListener('click', (event) => {
    event.stopPropagation();
    const children = document.querySelector(`[data-tree-children="${CSS.escape(button.dataset.treeToggle)}"]`);
    if (!children) return;
    children.hidden = !children.hidden;
    button.classList.toggle('collapsed', children.hidden);
  }));
  document.querySelectorAll('[data-doc-library]').forEach((button) => button.addEventListener('click', () => {
    state.library = button.dataset.docLibrary || '';
    state.node = button.dataset.docNode || '';
    if (state.library && !state.node) {
      const children = document.querySelector(`[data-tree-children="${CSS.escape(state.library)}"]`);
      const toggle = document.querySelector(`[data-tree-toggle="${CSS.escape(state.library)}"]`);
      if (children) children.hidden = false;
      toggle?.classList.remove('collapsed');
    }
    apply();
  }));
  document.getElementById('doc-status')?.addEventListener('change', (event) => { state.status = event.currentTarget.value; apply(); });
  document.querySelectorAll('[data-doc-view]').forEach((button) => button.addEventListener('click', () => {
    grid.classList.toggle('view-list', button.dataset.docView === 'list');
    document.querySelectorAll('[data-doc-view]').forEach((item) => item.classList.toggle('active', item === button));
  }));
  const input = document.querySelector('#doc-search input');
  if (input) input.addEventListener('input', () => { state.q = input.value.trim(); apply(); });
  document.getElementById('doc-search')?.addEventListener('submit', (event) => { event.preventDefault(); apply(); });
  bindFileInspector();
}

export async function renderSource(ref) {
  if (!state.bootstrap) await loadBootstrap();
  const data = await api(`/api/sources/${encodeURIComponent(ref)}`);
  const source = data.source;
  const pages = (source.compiledPages ?? []).filter((page) => page.status !== 'archived');
  const classes = [...new Set(pages.map((page) => page.className || page.classKey || '知识页'))];
  const groups = classes.map((name) => ({ name, pages: pages.filter((page) => (page.className || page.classKey || '知识页') === name) }));
  const log = (source.job?.log ?? []).slice(-20).map((line) => `<div class="timeline-item"><span class="pip"></span><div class="text mono">${esc(line)}</div></div>`).join('');
  const groupHtml = groups.map((group) => `<section class="source-group" data-source-group data-class="${esc(group.name)}"><div class="source-group-head"><span>${esc(group.name)}</span><span class="badge outline">${group.pages.length}</span></div>${group.pages.map((page) => `<a class="linked-page" href="#/page/${encodeURIComponent(page.id)}"><span class="linked-page-dot" style="background:${libraryColor(page.classColor)}"></span><span><b>${esc(page.title)}</b><small>${esc(page.summary || page.tldr || '')}</small></span><span class="badge outline">${esc(page.className ?? page.classKey)}</span>${icon('chevron', 13)}</a>`).join('')}</section>`).join('');

  return `
    <div class="doc-detail-head">
      <div class="doc-breadcrumb"><a href="#/documents">文档中心</a><span>/</span><a href="#/library/${encodeURIComponent(source.library?.slug ?? '')}?tab=documents">${esc(source.library?.name ?? '知识库')}</a></div>
      <div class="between wrap" style="align-items:flex-start;gap:16px">
        <div class="doc-heading"><span class="doc-icon doc-icon-lg">${icon(source.kind === 'image' ? 'image' : 'file', 24)}</span><div><div class="row wrap" style="gap:7px">${statusPill(source.status)}<span class="badge outline">${kindLabel(source)}</span>${source.node ? `<span class="badge outline">${esc(source.node.name)}</span>` : ''}</div><h1>${esc(source.title)}</h1><p>${esc(source.filename)} · ${fmtBytes(source.size)} · ${fmtNumber(source.wordCount)} 字 · 上传于 ${timeAgo(source.createdAt)}${source.uploadedByName ? ` · ${esc(source.uploadedByName)}` : ''}</p></div></div>
        <div class="btn-row"><button class="btn btn-primary" id="source-preview">${icon('eye', 14)} 预览</button><a class="btn" href="/api/sources/${encodeURIComponent(source.id)}/download" target="_blank">${icon('external', 14)} 原始文件</a>${data.canEdit ? `<button class="btn" id="source-edit">${icon('edit', 14)} 编辑信息</button><button class="btn" id="source-reprocess">${icon('refresh', 14)} 重新编译</button>` : ''}<a class="btn btn-primary" href="#/library/${encodeURIComponent(source.library?.slug ?? '')}?tab=pages">查看知识库 ${icon('arrow', 14)}</a></div>
      </div>
    </div>

    <div class="doc-detail-grid">
      <div class="doc-detail-main">
        <div class="panel">
          <div class="panel-head"><div><h3>编译出的知识</h3><div class="small faint">每一条知识页都保留回本文档的来源链路</div></div><span class="badge jade">${pages.length} 个知识页</span></div>
          <div class="panel-body">${pages.length ? `<div class="fragment-chips source-type-filter"><button class="filter-chip active" data-source-class="">全部 <span>${pages.length}</span></button>${groups.map((group) => `<button class="filter-chip" data-source-class="${esc(group.name)}">${esc(group.name)} <span>${group.pages.length}</span></button>`).join('')}</div><div class="source-groups">${groupHtml}</div>` : `<div class="callout">${icon('clock', 16)} 尚未编译出知识页。${source.status === 'ready' ? '可能原文没有可抽取章节，或编译失败；可重新编译。' : '文档仍在处理队列中。'}</div>`}</div>
        </div>
        <div class="panel">
          <div class="panel-head"><h3>文档摘要</h3></div>
          <div class="panel-body"><p class="doc-excerpt">${esc(source.excerpt || '暂无摘要')}</p></div>
        </div>
        ${source.metadata?.regex ? `<div class="panel"><div class="panel-head"><div><h3>正则预抽取</h3><div class="small faint">在 DSH 之前由规则代码命中，DSH 会优先采用这些结构</div></div><span class="badge jade">${Number(source.metadata.regex.total ?? 0)} 个</span></div><div class="panel-body"><div class="row wrap" style="gap:6px;margin-bottom:10px">${Object.entries(source.metadata.regex.byCategory ?? {}).map(([name, count]) => `<span class="badge outline">${esc(name)} ${Number(count)}</span>`).join('')}</div><div class="regex-samples">${(source.metadata.regex.samples ?? []).slice(0, 12).map((match) => `<div class="regex-sample"><span>${esc(match.name)}</span><code>${esc(match.value)}</code></div>`).join('') || '<span class="faint small">暂无样例</span>'}</div></div></div>` : ''}
        ${log ? `<div class="panel"><div class="panel-head"><h3>处理日志</h3><span class="small faint">最近 ${Math.min(20, source.job?.log?.length ?? 0)} 条</span></div><div class="panel-body"><div class="timeline">${log}</div></div></div>` : ''}
      </div>
      <aside class="doc-detail-side">
        <div class="panel"><div class="panel-head"><h3>文档信息</h3></div><div class="panel-body"><div class="kv"><dt>所属部门</dt><dd>${esc(source.library?.name ?? '—')}</dd><dt>目录</dt><dd>${esc(source.node?.name ?? '未分类')}</dd><dt>格式</dt><dd>${kindLabel(source)}</dd><dt>大小</dt><dd>${fmtBytes(source.size)}</dd><dt>字数</dt><dd>${fmtNumber(source.wordCount)}</dd><dt>SHA-256</dt><dd class="mono">${esc(source.sha256?.slice(0, 16) ?? '—')}…</dd></div></div></div>
        <div class="panel"><div class="panel-head"><h3>关联</h3></div><div class="panel-body"><a class="rail-item" href="#/library/${encodeURIComponent(source.library?.slug ?? '')}?tab=pages"><span class="dot" style="background:var(--jade)"></span><span>知识库知识页 <span class="faint">${pages.length}</span></span></a><a class="rail-item" href="#/search?library=${encodeURIComponent(source.library?.slug ?? '')}"><span class="dot" style="background:var(--teal)"></span><span>在知识库中检索</span></a></div></div>
        ${source.canManageAccess ? `<div class="panel"><div class="panel-head"><h3>访问控制</h3><span class="badge outline">${esc(source.visibility)}</span></div><div class="panel-body"><p class="small muted">文档访问策略在知识库设置中管理；受限文档只对所有者与显式共享者开放。</p><a class="btn btn-sm" href="#/library/${encodeURIComponent(source.library?.slug ?? '')}?tab=settings">${icon('lock', 13)} 打开库设置</a></div></div>` : ''}
      </aside>
    </div>`;
}

export function mountSource(ref) {
  document.getElementById('source-preview')?.addEventListener('click', async () => {
    try {
      const data = await api(`/api/sources/${encodeURIComponent(ref)}`);
      openFilePreview(data.source);
    } catch (error) { toast(error.message, 'error'); }
  });
  document.getElementById('source-edit')?.addEventListener('click', async () => {
    try {
      const data = await api(`/api/sources/${encodeURIComponent(ref)}`);
      const source = data.source;
      const library = await api(`/api/libraries/${encodeURIComponent(source.library.id)}`);
      const nodes = [];
      const walk = (items, depth = 0) => items.forEach((item) => { nodes.push({ ...item, depth }); walk(item.children ?? [], depth + 1); });
      walk(library.nodes ?? []);
      openModal({
        title: '编辑文档信息',
        body: `<div class="field"><label>文档标题</label><input class="input" id="source-title-input" value="${esc(source.title)}"></div><div class="field" style="margin-top:10px"><label>归入目录</label><select class="select" id="source-node-input"><option value="">未分类</option>${nodes.map((node) => `<option value="${esc(node.id)}" ${source.nodeId === node.id ? 'selected' : ''}>${'— '.repeat(node.depth)}${esc(node.name)}</option>`).join('')}</select></div>`,
        footer: `<button class="btn" data-close-modal>取消</button><button class="btn btn-primary" id="save-source-meta">保存</button>`,
        onMount: (modal) => modal.querySelector('#save-source-meta')?.addEventListener('click', async () => {
          try {
            await api(`/api/sources/${encodeURIComponent(source.id)}`, { method: 'PATCH', body: { title: modal.querySelector('#source-title-input')?.value ?? '', nodeId: modal.querySelector('#source-node-input')?.value || null } });
            closeModal();
            toast('文档信息已更新', 'success');
            window.dispatchEvent(new HashChangeEvent('hashchange'));
          } catch (error) { toast(error.message, 'error'); }
        }),
      });
    } catch (error) { toast(error.message, 'error'); }
  });
  document.querySelectorAll('[data-source-class]').forEach((button) => button.addEventListener('click', () => {
    document.querySelectorAll('[data-source-class]').forEach((item) => item.classList.toggle('active', item === button));
    const value = button.dataset.sourceClass ?? '';
    document.querySelectorAll('[data-source-group]').forEach((group) => { group.style.display = !value || group.dataset.class === value ? '' : 'none'; });
  }));
  document.getElementById('source-reprocess')?.addEventListener('click', async () => {
    try {
      await api(`/api/sources/${encodeURIComponent(ref)}/reprocess`, { method: 'POST' });
      toast('已重新加入编译队列', 'success');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } catch (error) { toast(error.message, 'error'); }
  });
}
