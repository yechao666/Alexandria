import {
  api,
  state,
  icon,
  escapeHtml as esc,
  fmtNumber,
  timeAgo,
  libraryColor,
  roleBadge,
  classBadge,
  statusBadge,
  confidence,
  openModal,
  closeModal,
  toast,
  go,
  emptyState,
  textField,
  selectField,
  textArea,
  formValues,
  avatar,
  loadBootstrap,
} from '../assets/core.js';
import { mountGraph } from '../assets/graph.js';

const TABS = [
  { key: 'documents', label: '文档' },
  { key: 'pages', label: '知识页' },
  { key: 'catalog', label: '目录' },
  { key: 'graph', label: '图谱' },
  { key: 'settings', label: '设置' },
];

export async function renderLibrary(ref, tab = 'documents') {
  const [detail, pagesData, sourcesData] = await Promise.all([
    api(`/api/libraries/${encodeURIComponent(ref)}`),
    api(`/api/libraries/${encodeURIComponent(ref)}/pages?limit=400`).catch(() => ({ pages: [], total: 0 })),
    api(`/api/libraries/${encodeURIComponent(ref)}/sources?limit=300`).catch(() => ({ sources: [], total: 0 })),
  ]);
  const library = detail.library;
  state.currentLibrary = detail;
  const pages = pagesData.pages ?? [];
  const sources = sourcesData.sources ?? [];
  const nodes = flattenNodes(detail.nodes ?? []);
  const selected = new URLSearchParams(location.hash.split('?')[1] ?? '').get('node') ?? '';
  const visiblePages = pages.filter((page) => !selected || page.nodeId === selected);
  const visibleSources = sources.filter((source) => !selected || source.nodeId === selected);
  const color = libraryColor(library.color);

  const pageCards = visiblePages
    .map((page) => pageCard(page))
    .join('');
  const sourceRows = visibleSources.map((source) => sourceRow(source)).join('');
  const classCounts = detail.classes.map((klass) => ({ ...klass, count: pages.filter((page) => page.classKey === klass.key).length }));
  const classChips = `<button class="filter-chip active" data-class-filter="">全部 <span>${pages.length}</span></button>${classCounts.map((klass) => `<button class="filter-chip" data-class-filter="${esc(klass.key)}">${esc(klass.name)} <span>${klass.count}</span></button>`).join('')}`;
  const tabsHtml = TABS.map(
    (item) => `<button class="tab ${tab === item.key ? 'active' : ''}" data-tab="${item.key}">${item.label}${item.key === 'pages' ? ` <span class="faint">${pages.length}</span>` : item.key === 'documents' ? ` <span class="faint">${sources.length}</span>` : ''}</button>`,
  ).join('');

  const bodyByTab = {
    catalog: `
      <div class="library-layout">
        ${catalogTree(nodes, detail.nodes, selected)}
        <div class="content-pad">
          <div class="list-toolbar">
            <div class="section-head" style="margin:0;flex:1"><div><h2 style="font-size:22px">${selected ? esc(nodes.find((node) => node.id === selected)?.name ?? '目录') : '全部知识页'}</h2><div class="sub">知识页 ${visiblePages.length} · 文档 ${visibleSources.length}</div></div></div>
            <input class="input" id="library-filter" placeholder="筛选标题…" style="width:180px">
            ${detail.canEdit ? `<button class="btn btn-sm" id="new-page">${icon('plus', 14)} 新建页</button>` : ''}
          </div>
          <div class="page-grid" id="page-grid">${pageCards || emptyState('这里还没有知识页', '上传一份资料，Alexandria 会在入库时编译出概念页与文献页。', detail.canEdit ? `<a class="btn btn-clay" href="#/upload/${encodeURIComponent(library.slug)}">${icon('upload', 15)} 上传资料</a>` : '')}</div>
          <div class="section-head" style="margin-top:28px"><div><h2 style="font-size:20px">文献</h2><div class="sub">原始文件保留，可随时回溯与重编译</div></div>${detail.canEdit ? `<a class="link small" href="#/upload/${encodeURIComponent(library.slug)}">上传 ${icon('plus', 13)}</a>` : ''}</div>
          <div class="source-list">${sourceRows || '<div class="rail-empty">还没有文献。</div>'}</div>
        </div>
      </div>`,
    pages: `
      <div class="fragment-toolbar">
        <div class="fragment-chips">${classChips}</div>
        <input class="input" id="library-filter" placeholder="筛选知识页…" style="width:220px">
        ${detail.canEdit ? `<button class="btn btn-sm" id="new-page">${icon('plus', 14)} 新建页</button>` : ''}
      </div>
      <div class="page-grid" id="page-grid">${pageCards || emptyState('没有匹配的知识页', '换个类型或关键词试试。')}</div>`,
    documents: `
      <div class="doc-coverage">
        <div><b>${sources.length}</b><span>文档总数</span></div>
        <div><b>${sources.filter((source) => source.status === 'ready').length}</b><span>已编译</span></div>
        <div><b>${sources.filter((source) => source.status === 'processing' || source.status === 'queued').length}</b><span>处理中</span></div>
        <div><b>${sources.filter((source) => source.status === 'failed').length}</b><span>失败</span></div>
        <div><b>${sources.filter((source) => source.status === 'ready' && !Number(source.compiledPages)).length}</b><span>无知识页</span></div>
      </div>
      <div class="list-toolbar">
        <input class="input" id="library-filter" placeholder="筛选文档…" style="width:260px">
        <span class="small faint">按部门知识库归档 · ${sources.length} 份文档</span>
        ${detail.canEdit ? `<a class="btn btn-sm btn-clay" href="#/upload/${encodeURIComponent(library.slug)}" style="margin-left:auto">${icon('upload', 14)} 上传文档</a>` : ''}
      </div>
      <div class="source-list" id="source-list">${sourceRows || emptyState('还没有文档', '支持 PDF、Word、PPT、Excel、TeX、RTF、WPS、图片与 Markdown 等格式。')}</div>`,
    graph: `
      <div class="between" style="margin-bottom:14px"><div><h2 style="font-size:22px">类型化图谱</h2><div class="sub">节点大小约等于连接度；颜色代表本体类型；点击进入知识页。</div></div><button class="btn btn-sm" id="graph-fit">${icon('refresh', 14)} 重置视图</button></div>
      <div class="graph-shell"><canvas class="graph-canvas" id="library-graph"></canvas><div class="graph-legend" id="graph-legend"></div></div>`,
    settings: settingsTab(detail, library, color),
  };

  return `
    <div class="library-hero">
      <div>
        <div class="library-title-row">
          <span class="library-emblem" style="--lib-color:${color}">${icon(library.icon === 'terminal' ? 'terminal' : library.icon === 'flask' ? 'flask' : library.icon === 'lock' ? 'lock' : library.icon === 'compass' ? 'compass' : 'book', 27)}</span>
          <div>
            <div class="row" style="gap:8px"><h1>${esc(library.name)}</h1>${roleBadge(detail.role)}${library.visibility === 'private' ? '<span class="badge clay">私有</span>' : ''}</div>
            <div class="desc">${esc(library.description)}</div>
            <div class="library-stats">
              <div><b>${fmtNumber(detail.counts.pages)}</b>知识页</div>
              <div><b>${fmtNumber(detail.counts.sources)}</b>文档</div>
              <div><b>${fmtNumber(detail.counts.links)}</b>关联</div>
              <div><b>${fmtNumber(detail.counts.claims)}</b>主张</div>
              <div><b>${fmtNumber(detail.counts.conflicts)}</b>待裁决</div>
            </div>
          </div>
        </div>
      </div>
      <div class="btn-row">
        ${detail.canEdit ? `<a class="btn btn-primary" href="#/upload/${encodeURIComponent(library.slug)}">${icon('upload', 15)} 上传资料</a>` : ''}
        <a class="btn" href="#/search?library=${encodeURIComponent(library.slug)}">${icon('search', 15)} 检索</a>
        <a class="btn" href="#/review?library=${encodeURIComponent(library.slug)}">${icon('check', 15)} 校对 ${detail.counts.reviewPending ?? 0}</a>
      </div>
    </div>
    <div class="tabs">${tabsHtml}</div>
    ${bodyByTab[tab] ?? bodyByTab.catalog}`;
}

export async function mountLibrary(ref, tab = 'documents') {
  document.querySelectorAll('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => go(`#/library/${encodeURIComponent(ref)}?tab=${button.dataset.tab}`));
  });
  const detail = state.currentLibrary;
  if (!detail) return;
  const library = detail.library;

  if (tab === 'graph') {
    const canvas = document.getElementById('library-graph');
    if (canvas) {
      try {
        const graph = await api(`/api/libraries/${encodeURIComponent(library.id)}/graph?limit=300`);
        drawGraph(canvas, graph);
      } catch (error) {
        toast(error.message, 'error');
      }
    }
    document.getElementById('graph-fit')?.addEventListener('click', () => location.reload());
    return;
  }

  document.getElementById('new-page')?.addEventListener('click', () => openPageEditor(library, detail));
  document.getElementById('new-node')?.addEventListener('click', () => openNodeEditor(library, detail));
  document.getElementById('add-grant')?.addEventListener('click', () => openGrantEditor(library, detail));
  document.getElementById('new-class')?.addEventListener('click', () => openClassEditor(library));
  document.getElementById('new-property')?.addEventListener('click', () => openPropertyEditor(library, detail));
  document.querySelectorAll('[data-delete-property]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!confirm('确认删除该本体属性？已有页面值会保留但不再展示定义。')) return;
      try {
        await api(`/api/properties/${encodeURIComponent(button.dataset.deleteProperty)}`, { method: 'DELETE' });
        toast('属性已删除', 'success');
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  });
  bindCatalogTree(ref, tab);
  bindFilter();
  bindSourceRows();
  bindLibrarySettings(library, detail);
}

function flattenNodes(nodes, depth = 0, out = []) {
  for (const node of nodes ?? []) {
    out.push({ id: node.id, name: node.name, depth, pageCount: node.pageCount, sourceCount: node.sourceCount, code: node.code, kind: node.kind });
    flattenNodes(node.children ?? [], depth + 1, out);
  }
  return out;
}

function catalogTree(flat, tree, selected) {
  const all = `<div class="catalog-item ${!selected ? 'active' : ''}" data-node=""><span class="code">ALL</span><span>全部</span><span class="count">${flat.reduce((sum, node) => sum + node.pageCount, 0)}</span></div>`;
  return `<aside class="catalog"><div class="catalog-head">目录</div>${all}${flat
    .map(
      (node) => `<div class="catalog-item ${selected === node.id ? 'active' : ''}" data-node="${esc(node.id)}" style="padding-left:${9 + node.depth * 14}px"><span class="code">${esc(node.code || '·')}</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(node.name)}</span><span class="count">${node.pageCount}</span></div>`,
    )
    .join('')}${tree?.length === 0 ? '<div class="rail-empty">暂无目录</div>' : ''}</aside>`;
}

function bindCatalogTree(ref, tab) {
  document.querySelectorAll('[data-node]').forEach((item) => {
    item.addEventListener('click', () => {
      const node = item.dataset.node;
      go(`#/library/${encodeURIComponent(ref)}?tab=${tab}${node ? `&node=${encodeURIComponent(node)}` : ''}`);
    });
  });
}

function applyClassFilter(value) {
  document.querySelectorAll('#page-grid .page-card').forEach((card) => {
    card.style.display = !value || card.dataset.class === value ? '' : 'none';
  });
}

function bindFilter() {
  const input = document.getElementById('library-filter');
  if (!input) return;
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    document.querySelectorAll('#page-grid .page-card, #source-list .source-row').forEach((card) => {
      card.style.display = (card.dataset.search ?? card.textContent.toLowerCase()).includes(q) ? '' : 'none';
    });
  });
  const classFilter = document.getElementById('class-filter');
  if (classFilter) {
    classFilter.addEventListener('change', () => applyClassFilter(classFilter.value));
  }
  document.querySelectorAll('[data-class-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('[data-class-filter]').forEach((item) => item.classList.toggle('active', item === button));
      applyClassFilter(button.dataset.classFilter ?? '');
    });
  });
}

function pageCard(page) {
  return `<a class="page-card" href="#/page/${encodeURIComponent(page.id)}" data-class="${esc(page.classKey)}" data-search="${esc(`${page.title} ${page.summary} ${(page.tags ?? []).join(' ')}`.toLowerCase())}">
    <div class="top">${classBadge(page)}${page.status !== 'active' ? statusBadge(page.status) : ''}<span class="score" style="margin-left:auto">v${page.version}</span></div>
    <h3>${esc(page.title)}</h3>
    <div class="summary">${esc(page.summary || page.tldr || '')}</div>
    <div class="foot"><span class="tags">${(page.tags ?? []).slice(0, 3).map((tag) => `<span class="tag">${esc(tag)}</span>`).join('')}</span><span style="margin-left:auto">${confidence(page.confidence)}</span><span>${timeAgo(page.updatedAt)}</span></div>
  </a>`;
}

function sourceRow(source) {
  const status = source.status === 'ready' ? 'jade' : source.status === 'failed' ? 'clay' : 'ochre';
  return `<a class="source-row" href="#/source/${encodeURIComponent(source.id)}" data-search="${esc(`${source.title} ${source.filename}`.toLowerCase())}">
    <span class="file-icon">${icon(source.kind === 'image' ? 'image' : 'file', 18)}</span>
    <span class="info"><span class="name">${esc(source.title)}</span><span class="meta">${esc(source.filename)} · ${esc(source.kind)} · ${fmtNumber(source.wordCount)} 字</span></span>
    <span class="source-linkage"><b>${fmtNumber(source.compiledPages)}</b> 知识页</span>
    <span class="badge ${status}">${source.status === 'ready' ? '已编译' : source.status === 'failed' ? '失败' : '处理中'}</span>
    <span class="faint small">${timeAgo(source.createdAt)}</span>
    <span class="icon-btn">${icon('chevron', 15)}</span>
  </a>`;
}

function bindSourceRows() {
  // 文档行现在是链接，直接进入文档详情页。
}

export async function openSource(sourceId) {
  try {
    const data = await api(`/api/sources/${encodeURIComponent(sourceId)}`);
    const source = data.source;
    const pages = (source.compiledPages ?? []).map(
      (page) => `<a class="rail-item" href="#/page/${encodeURIComponent(page.id)}" style="padding:6px 0"><span class="dot" style="background:${libraryColor(page.classColor)}"></span><span>${esc(page.title)} <span class="faint">· ${esc(page.className)}</span></span></a>`,
    ).join('');
    const assets = (source.assets ?? [])
      .map(
        (asset) => `<a class="rail-item" href="${asset.url}" target="_blank" rel="noopener"><span class="dot" style="background:var(--ochre)"></span><span>${esc(asset.filename)}</span></a>`,
      )
      .join('');
    const log = (source.job?.log ?? []).slice(-14).map((line) => `<div class="timeline-item"><span class="pip"></span><div class="text mono" style="font-size:10.5px">${esc(line)}</div></div>`).join('');
    openModal({
      title: source.title,
      wide: true,
      body: `
        <div class="grid grid-2">
          <div>
            <div class="chip-row" style="margin-bottom:12px">${statusBadge(source.status)}<span class="badge outline">${esc(source.kind)}</span><span class="badge">${fmtNumber(source.wordCount)} 字</span>${source.pageCount ? `<span class="badge">${source.pageCount} 页</span>` : ''}</div>
            <div class="kv">
              <dt>原始文件</dt><dd>${esc(source.filename)}</dd>
              <dt>大小</dt><dd>${fmtNumber(source.size)} B</dd>
              <dt>状态</dt><dd>${esc(source.status)}${source.error ? ` · ${esc(source.error)}` : ''}</dd>
              <dt>入库时间</dt><dd>${esc(new Date(source.createdAt).toLocaleString('zh-CN'))}</dd>
              <dt>SHA-256</dt><dd class="mono" style="font-size:9.5px;word-break:break-all">${esc(source.sha256)}</dd>
            </div>
            <div class="answer-card" style="margin-top:16px;padding:14px"><div class="small muted">摘要</div><div style="margin-top:4px;font-size:13px;line-height:1.7">${esc(source.excerpt || '—')}</div></div>
            ${assets ? `<div style="margin-top:16px"><div class="small faint" style="margin-bottom:6px">附件与图片</div>${assets}</div>` : ''}
          </div>
          <div>
            <div class="small faint" style="margin-bottom:6px">编译出的知识页</div>
            <div class="rail-list">${pages || '<div class="rail-empty">尚未编译</div>'}</div>
            ${log ? `<div class="small faint" style="margin:16px 0 6px">处理日志</div><div class="timeline">${log}</div>` : ''}
          </div>
        </div>`,
      footer: `<a class="btn" href="/api/sources/${encodeURIComponent(source.id)}/download" target="_blank">${icon('external', 14)} 原始文件</a>${data.canEdit ? `<button class="btn" id="reprocess-source">${icon('refresh', 14)} 重新编译</button>` : ''}${source.canManageAccess ? `<button class="btn" id="source-access">${icon('lock', 14)} 访问策略</button>` : ''}<button class="btn btn-primary" data-close-modal>关闭</button>`,
      onMount: (modal) => {
        modal.querySelector('#source-access')?.addEventListener('click', async () => {
          try {
            const access = await api(`/api/sources/${encodeURIComponent(source.id)}/access`);
            const subjects = [
              ...(state.people ?? []).map((person) => ({ type: 'person', id: person.id, name: person.name, sub: person.title ?? '成员' })),
              ...(state.teams ?? []).map((team) => ({ type: 'team', id: team.id, name: team.name, sub: '团队' })),
            ];
            const grants = new Map((access.grants ?? []).map((grant) => [`${grant.subjectType}:${grant.subjectId}`, grant.role]));
            const rows = subjects.map((subject) => {
              const key = `${subject.type}:${subject.id}`;
              const checked = grants.has(key);
              const role = grants.get(key) ?? 'viewer';
              return `<label class="rail-item" style="display:flex;gap:8px;align-items:center;padding:7px 0"><input type="checkbox" data-source-subject="${subject.type}:${subject.id}" ${checked ? 'checked' : ''}><span style="flex:1">${esc(subject.name)} <span class="faint">· ${esc(subject.sub)}</span></span><select class="select" data-source-role="${subject.type}:${subject.id}" style="width:92px"><option value="viewer" ${role === 'viewer' ? 'selected' : ''}>只读</option><option value="editor" ${role === 'editor' ? 'selected' : ''}>可编辑</option></select></label>`;
            }).join('');
            openModal({
              title: '文献访问控制',
              body: `<div class="field"><label>可见性</label><select class="select" id="source-visibility"><option value="inherit" ${access.visibility === 'inherit' ? 'selected' : ''}>继承知识库权限</option><option value="restricted" ${access.visibility === 'restricted' ? 'selected' : ''}>受限：仅所有者与共享对象</option><option value="private" ${access.visibility === 'private' ? 'selected' : ''}>私有：仅文献所有者与共享对象</option></select></div><div class="small faint" style="margin:12px 0 4px">共享给</div><div style="max-height:340px;overflow:auto">${rows}</div>`,
              footer: `<button class="btn" data-close-modal>取消</button><button class="btn btn-primary" id="save-source-access">保存访问策略</button>`,
              onMount: (inner) => {
                inner.querySelector('#save-source-access')?.addEventListener('click', async () => {
                  const visibility = inner.querySelector('#source-visibility')?.value ?? 'inherit';
                  const grantsToSave = [];
                  inner.querySelectorAll('[data-source-subject]').forEach((input) => {
                    if (!input.checked) return;
                    const [subjectType, ...rest] = input.dataset.sourceSubject.split(':');
                    const role = inner.querySelector(`[data-source-role="${input.dataset.sourceSubject}"]`)?.value ?? 'viewer';
                    grantsToSave.push({ subjectType, subjectId: rest.join(':'), role });
                  });
                  try {
                    await api(`/api/sources/${encodeURIComponent(source.id)}/access`, { method: 'PATCH', body: JSON.stringify({ visibility, grants: grantsToSave }) });
                    closeModal();
                    toast('文献访问策略已更新', 'success');
                    window.dispatchEvent(new HashChangeEvent('hashchange'));
                  } catch (error) { toast(error.message, 'error'); }
                });
              },
            });
          } catch (error) { toast(error.message, 'error'); }
        });
        modal.querySelector('#reprocess-source')?.addEventListener('click', async () => {
          try {
            await api(`/api/sources/${encodeURIComponent(source.id)}/reprocess`, { method: 'POST' });
            toast('已加入编译队列', 'success');
            closeModal();
          } catch (error) {
            toast(error.message, 'error');
          }
        });
      },
    });
  } catch (error) {
    toast(error.message, 'error');
  }
}

function settingsTab(detail, library, color) {
  if (!detail.canEdit) {
    return `<div class="panel panel-pad"><h3>无权修改</h3><p class="muted">你对该知识库只有只读权限。可以联系所有者申请编辑权限。</p></div>`;
  }
  const grants = (detail.grants ?? [])
    .map(
      (grant) => `<tr><td><span class="badge outline">${grant.subject_type === 'person' ? '个人' : grant.subject_type === 'team' ? '团队' : '组织'}</span></td><td>${esc(grant.subjectName)}</td><td>${roleBadge(grant.role)}</td><td class="faint">${timeAgo(grant.created_at)}</td><td><button class="btn btn-sm btn-ghost" data-revoke="${esc(grant.id)}">移除</button></td></tr>`,
    )
    .join('');
  const classes = (detail.classes ?? [])
    .map(
      (klass) => `<tr><td><span class="badge ${klass.color}">${esc(klass.name)}</span></td><td class="mono">${esc(klass.key)}</td><td class="muted">${esc(klass.description)}</td><td>${klass.builtin ? '<span class="badge outline">内置</span>' : ''}</td></tr>`,
    )
    .join('');
  const propertyRows = (detail.properties ?? [])
    .map((property) => `<tr><td class="mono">${esc(property.class_key ?? '全部')}</td><td>${esc(property.name)}</td><td class="mono">${esc(property.key)}</td><td><span class="badge outline">${esc(property.type)}</span></td><td>${property.required ? '是' : '—'}</td><td><button class="btn btn-sm btn-ghost" data-delete-property="${esc(property.id)}">删除</button></td></tr>`)
    .join('');
  return `
    <div class="grid grid-2">
      <div class="panel">
        <div class="panel-head"><h3>基本信息</h3>${roleBadge(detail.role)}</div>
        <div class="panel-body">
          <form id="library-settings-form" class="form-grid">
            ${textField({ label: '名称', name: 'name', value: library.name })}
            ${selectField({ label: '可见性', name: 'visibility', value: library.visibility, options: [
              { value: 'internal', label: '组织内' }, { value: 'private', label: '私有' }, { value: 'public', label: '公开' },
            ] })}
            ${textArea({ label: '简介', name: 'description', value: library.description, rows: 3 })}
            ${selectField({ label: '主色', name: 'color', value: library.color, options: [
              { value: 'jade', label: '玉' }, { value: 'clay', label: '陶' }, { value: 'ochre', label: '赭' },
              { value: 'plum', label: '梅' }, { value: 'indigo', label: '靛' }, { value: 'teal', label: '青' },
            ] })}
          </form>
          <div class="btn-row" style="margin-top:14px"><button class="btn btn-primary" id="save-library">保存设置</button><button class="btn" id="new-node">${icon('plus', 14)} 新建目录</button><a class="btn" href="/api/libraries/${encodeURIComponent(library.id)}/export.md" target="_blank">${icon('file', 14)} 导出 Markdown</a>${detail.canEdit ? `<button class="btn" id="library-audit">${icon('clock', 14)} 审计日志</button><button class="btn" id="library-trash">${icon('trash', 14)} 回收站</button><button class="btn" id="merge-suggestions">${icon('layers', 14)} 扫描重复页</button><button class="btn" id="merge-proposals">${icon('check', 14)} 合并审批</button>` : ''}</div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><h3>访问授权</h3>${detail.role === 'owner' ? `<button class="btn btn-sm" id="add-grant">${icon('plus', 14)} 授权</button>` : ''}</div>
        <div class="panel-body" style="padding:0"><table class="org-table"><thead><tr><th>类型</th><th>对象</th><th>角色</th><th>授予时间</th><th></th></tr></thead><tbody>${grants || '<tr><td colspan="5" class="muted" style="padding:18px">暂无额外授权；团队归属会自动授权。</td></tr>'}</tbody></table></div>
      </div>
      <div class="panel">
        <div class="panel-head"><h3>本体类型</h3><div class="row"><span class="small muted">${detail.classes.length} 个类型</span>${detail.canEdit ? `<button class="btn btn-sm" id="new-class">${icon('plus', 14)} 新建类型</button>` : ''}</div></div>
        <div class="panel-body" style="padding:0"><table class="org-table"><thead><tr><th>类型</th><th>Key</th><th>说明</th><th></th></tr></thead><tbody>${classes}</tbody></table></div>
      </div>
      <div class="panel">
        <div class="panel-head"><h3>本体属性</h3><div class="row"><span class="small muted">${(detail.properties ?? []).length} 个属性</span>${detail.canEdit ? `<button class="btn btn-sm" id="new-property">${icon('plus', 14)} 新建属性</button>` : ''}</div></div>
        <div class="panel-body" style="padding:0"><table class="org-table"><thead><tr><th>类型</th><th>名称</th><th>Key</th><th>字段</th><th>必填</th><th></th></tr></thead><tbody>${propertyRows || '<tr><td colspan="6" class="muted" style="padding:18px">暂无属性</td></tr>'}</tbody></table></div>
      </div>
      <div class="panel">
        <div class="panel-head"><h3>危险区</h3></div>
        <div class="panel-body">
          <p class="muted small">删除知识库会同时删除知识页、文献、索引与授权。原始文件目录也会被移除，且不可恢复。</p>
          <button class="btn btn-danger btn-sm" id="delete-library">删除知识库</button>
          <div class="hairline"></div>
          <div class="small faint">库 ID：<span class="mono">${esc(library.id)}</span><br>创建者：${esc(detail.library.created_by ?? '—')}<br>创建时间：${esc(new Date(library.created_at).toLocaleString('zh-CN'))}</div>
        </div>
      </div>
    </div>`;
}

function bindLibrarySettings(library, detail) {
  document.getElementById('merge-proposals')?.addEventListener('click', async () => {
    const openProposals = async () => {
      try {
        const data = await api(`/api/libraries/${encodeURIComponent(library.id)}/merge-proposals`);
        const proposals = (data.proposals ?? []).filter((item) => item.status === 'pending');
        const rows = proposals.map((item) => `<div style="padding:10px 0;border-bottom:1px solid var(--line)"><div class="between"><span><b>${esc(item.source_title)}</b> → <b>${esc(item.target_title)}</b></span><span class="badge ${item.score >= 0.85 ? 'clay' : 'ochre'}">${Math.round(item.score * 100)}%</span></div><div class="small muted" style="margin:4px 0">${esc((item.reasons ?? []).join(' · '))}</div><div class="btn-row"><button class="btn btn-sm btn-primary" data-approve-proposal="${esc(item.id)}">批准合并</button><button class="btn btn-sm btn-ghost" data-reject-proposal="${esc(item.id)}">驳回</button></div></div>`).join('');
        openModal({
          title: '合并审批',
          wide: true,
          body: `<div class="between" style="margin-bottom:10px"><span class="small muted">待审批 ${proposals.length} 条</span><button class="btn btn-sm" id="scan-proposals">扫描新建议</button></div><div style="max-height:480px;overflow:auto">${rows || '<div class="rail-empty" style="padding:20px">没有待审批的合并建议。</div>'}</div>`,
          footer: `<button class="btn" data-close-modal>关闭</button>`,
          onMount: (modal) => {
            modal.querySelector('#scan-proposals')?.addEventListener('click', async () => {
              try { const result = await api(`/api/libraries/${encodeURIComponent(library.id)}/merge-proposals/scan`, { method: 'POST' }); toast(`新生成 ${result.created} 条建议`, 'success'); closeModal(); openProposals(); } catch (error) { toast(error.message, 'error'); }
            });
            modal.querySelectorAll('[data-approve-proposal]').forEach((button) => button.addEventListener('click', async () => {
              try { await api(`/api/merge-proposals/${encodeURIComponent(button.dataset.approveProposal)}/approve`, { method: 'POST' }); toast('已批准合并', 'success'); closeModal(); openProposals(); window.dispatchEvent(new HashChangeEvent('hashchange')); } catch (error) { toast(error.message, 'error'); }
            }));
            modal.querySelectorAll('[data-reject-proposal]').forEach((button) => button.addEventListener('click', async () => {
              try { await api(`/api/merge-proposals/${encodeURIComponent(button.dataset.rejectProposal)}/reject`, { method: 'POST' }); toast('已驳回', 'success'); closeModal(); openProposals(); } catch (error) { toast(error.message, 'error'); }
            }));
          },
        });
      } catch (error) { toast(error.message, 'error'); }
    };
    openProposals();
  });

  document.getElementById('merge-suggestions')?.addEventListener('click', async () => {
    try {
      const data = await api(`/api/libraries/${encodeURIComponent(library.id)}/merge-suggestions`);
      const suggestions = data.suggestions ?? [];
      const rows = suggestions.map((item, index) => `<div class="suggestion-row" style="padding:10px 0;border-bottom:1px solid var(--line)"><div class="between"><span><b>${esc(item.source.title)}</b> → <b>${esc(item.target.title)}</b></span><span class="badge ${item.score >= 0.85 ? 'clay' : 'ochre'}">${Math.round(item.score * 100)}%</span></div><div class="small muted" style="margin:4px 0">${esc(item.reasons.join(' · '))}</div><button class="btn btn-sm" data-merge-suggestion="${index}">合并源页到目标</button></div>`).join('');
      openModal({
        title: '重复页合并建议',
        wide: true,
        body: `<p class="small muted">按标题、别名与摘要相似度排序；合并会迁移来源/主张/链接/属性并保留源页归档。</p><div style="max-height:460px;overflow:auto">${rows || '<div class="rail-empty" style="padding:20px">没有发现高置信度重复页。</div>'}</div>`,
        footer: `<button class="btn" data-close-modal>关闭</button>`,
        onMount: (modal) => {
          modal.querySelectorAll('[data-merge-suggestion]').forEach((button) => {
            button.addEventListener('click', async () => {
              const item = suggestions[Number(button.dataset.mergeSuggestion)];
              if (!item || !confirm(`确认把「${item.source.title}」合并到「${item.target.title}」？`)) return;
              try {
                await api(`/api/pages/${encodeURIComponent(item.source.id)}/merge`, { method: 'POST', body: JSON.stringify({ targetId: item.target.id }) });
                closeModal();
                toast('页面已合并', 'success');
                window.dispatchEvent(new HashChangeEvent('hashchange'));
              } catch (error) { toast(error.message, 'error'); }
            });
          });
        },
      });
    } catch (error) { toast(error.message, 'error'); }
  });

  document.getElementById('library-trash')?.addEventListener('click', async () => {
    const openTrash = async () => {
      try {
        const data = await api(`/api/libraries/${encodeURIComponent(library.id)}/trash`);
        const items = data.items ?? [];
        const rows = items.map((item) => `<div class="between" style="padding:10px 0;border-bottom:1px solid var(--line)"><span><b>${esc(item.title)}</b><br><span class="faint small">${esc(new Date(item.deletedAt).toLocaleString('zh-CN'))} · ${esc(item.deletedByName ?? '系统')}</span></span><span class="btn-row"><button class="btn btn-sm" data-restore-trash="${esc(item.id)}">恢复</button><button class="btn btn-sm btn-ghost" data-purge-trash="${esc(item.id)}">彻底删除</button></span></div>`).join('');
        openModal({
          title: '回收站',
          wide: true,
          body: `<p class="small muted">删除的页面会保留快照；恢复后重建页面、来源、主张、属性与关联。</p><div style="max-height:480px;overflow:auto;margin-top:10px">${rows || '<div class="rail-empty" style="padding:20px">回收站为空</div>'}</div>`,
          footer: `<button class="btn" data-close-modal>关闭</button>`,
          onMount: (modal) => {
            modal.querySelectorAll('[data-restore-trash]').forEach((button) => button.addEventListener('click', async () => {
              try { await api(`/api/trash/${encodeURIComponent(button.dataset.restoreTrash)}/restore`, { method: 'POST' }); toast('页面已恢复', 'success'); closeModal(); window.dispatchEvent(new HashChangeEvent('hashchange')); } catch (error) { toast(error.message, 'error'); }
            }));
            modal.querySelectorAll('[data-purge-trash]').forEach((button) => button.addEventListener('click', async () => {
              if (!confirm('彻底删除后不可恢复，确认？')) return;
              try { await api(`/api/trash/${encodeURIComponent(button.dataset.purgeTrash)}`, { method: 'DELETE' }); toast('已彻底删除', 'success'); closeModal(); openTrash(); } catch (error) { toast(error.message, 'error'); }
            }));
          },
        });
      } catch (error) { toast(error.message, 'error'); }
    };
    openTrash();
  });

  document.getElementById('library-audit')?.addEventListener('click', async () => {
    try {
      const data = await api(`/api/libraries/${encodeURIComponent(library.id)}/audit`);
      const rows = (data.events ?? []).slice(0, 60).map((event) => `<tr><td class="mono" style="font-size:10px">${esc(new Date(event.created_at).toLocaleString('zh-CN'))}</td><td>${esc(event.actor_name ?? '系统')}</td><td><code>${esc(event.action)}</code></td><td class="small muted">${esc(JSON.stringify(event.detail ?? {}).slice(0, 120))}</td></tr>`).join('');
      openModal({ title: '审计日志', wide: true, body: `<div class="panel" style="box-shadow:none"><div class="panel-body" style="padding:0;max-height:480px;overflow:auto"><table class="org-table"><thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>详情</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="muted" style="padding:18px">暂无审计记录</td></tr>'}</tbody></table></div></div>` });
    } catch (error) { toast(error.message, 'error'); }
  });
  document.getElementById('save-library')?.addEventListener('click', async () => {
    const form = document.getElementById('library-settings-form');
    if (!form) return;
    try {
      await api(`/api/libraries/${encodeURIComponent(library.id)}`, { method: 'PATCH', body: formValues(form) });
      toast('设置已保存', 'success');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  document.querySelectorAll('[data-revoke]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!confirm('确认移除这条授权？')) return;
      try {
        await api(`/api/grants/${encodeURIComponent(button.dataset.revoke)}`, { method: 'DELETE' });
        toast('授权已移除', 'success');
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  });
  document.getElementById('delete-library')?.addEventListener('click', async () => {
    const name = prompt(`输入知识库名称「${library.name}」以确认删除：`);
    if (name !== library.name) return;
    try {
      await api(`/api/libraries/${encodeURIComponent(library.id)}`, { method: 'DELETE' });
      toast('知识库已删除', 'success');
      await loadBootstrap();
      go('#/');
    } catch (error) {
      toast(error.message, 'error');
    }
  });
}

function drawGraph(canvas, graph) {
  const legend = document.getElementById('graph-legend');
  const typeMap = new Map();
  for (const node of graph.nodes) {
    typeMap.set(node.classKey, { name: node.className, color: node.color });
  }
  if (legend) {
    legend.innerHTML = [...typeMap.entries()]
      .map(([key, item]) => `<span class="item"><span class="swatch" style="background:${libraryColor(item.color)}"></span>${esc(item.name)}</span>`)
      .join('') + `<span class="item"><span class="swatch" style="background:var(--ochre)"></span>草稿</span>`;
  }
  mountGraph(canvas, graph, {
    onSelect: (node) => go(`#/page/${encodeURIComponent(node.id)}`),
  });
}

export function openPageEditor(library, detail, page = null, pageProperties = []) {
  const classOptions = (detail.classes ?? []).map((klass) => ({ value: klass.key, label: klass.name }));
  const definitions = detail.properties ?? [];
  const currentValues = new Map((pageProperties ?? []).map((item) => [item.key, item.value]));
  const propertyFields = (classKey) => {
    const fields = definitions.filter((definition) => !definition.class_key || definition.class_key === classKey);
    if (!fields.length) return '<div class="rail-empty">该类型暂无自定义属性</div>';
    return fields
      .map((definition) => {
        const value = currentValues.get(definition.key) ?? '';
        const label = `${definition.name ?? definition.key}${definition.required ? ' *' : ''}`;
        if (definition.type === 'enum') {
          const options = (definition.options ?? []).map((option) => `<option value="${esc(option)}" ${String(value) === String(option) ? 'selected' : ''}>${esc(option)}</option>`).join('');
          return `<div class="field"><label>${esc(label)}</label><select class="select" data-property-key="${esc(definition.key)}"><option value="">未设置</option>${options}</select></div>`;
        }
        if (definition.type === 'boolean') {
          return `<div class="field"><label>${esc(label)}</label><select class="select" data-property-key="${esc(definition.key)}"><option value="">未设置</option><option value="true" ${value === true ? 'selected' : ''}>是</option><option value="false" ${value === false ? 'selected' : ''}>否</option></select></div>`;
        }
        if (definition.type === 'text') {
          return `<div class="field span-2"><label>${esc(label)}</label><textarea class="textarea" rows="2" data-property-key="${esc(definition.key)}">${esc(value)}</textarea></div>`;
        }
        const inputType = definition.type === 'number' ? 'number' : definition.type === 'date' ? 'date' : definition.type === 'url' ? 'url' : 'text';
        return `<div class="field"><label>${esc(label)}</label><input class="input" type="${inputType}" data-property-key="${esc(definition.key)}" value="${esc(value)}"></div>`;
      })
      .join('');
  };
  const initialClass = page?.classKey ?? 'concept';
  openModal({
    title: page ? '编辑知识页' : '新建知识页',
    wide: true,
    body: `<form id="page-form" class="form-grid">
      ${textField({ label: '标题', name: 'title', value: page?.title ?? '', placeholder: '一个概念、一个决策、一份方法' })}
      ${selectField({ label: '本体类型', name: 'classKey', options: classOptions, value: initialClass })}
      ${textField({ label: '摘要', name: 'summary', value: page?.summary ?? '', span: true, placeholder: '一句话说明这个页面讲什么' })}
      ${textField({ label: '一句话结论', name: 'tldr', value: page?.tldr ?? '', span: true })}
      ${textField({ label: '标签（逗号分隔）', name: 'tags', value: (page?.tags ?? []).join(', ') })}
      ${textField({ label: '别名（逗号分隔）', name: 'aliases', value: (page?.aliases ?? []).join(', ') })}
      ${selectField({ label: '状态', name: 'status', value: page?.status ?? 'draft', options: [
        { value: 'draft', label: '草稿' }, { value: 'active', label: '有效' }, { value: 'stale', label: '陈旧' }, { value: 'archived', label: '归档' },
      ] })}
      ${textField({ label: '置信度 0–1', name: 'confidence', value: page?.confidence ?? 0.6, type: 'number' })}
      <div class="span-2"><div class="small faint" style="margin:6px 0 4px">本体属性</div><div class="form-grid" id="property-fields">${propertyFields(initialClass)}</div></div>
      ${textArea({ label: '正文（Markdown，可用 [[slug]] 链接）', name: 'body', value: page?.body ?? '', rows: 14 })}
    </form>`,
    footer: `<button class="btn" data-close-modal>取消</button><button class="btn btn-primary" id="save-page">${page ? '保存修改' : '创建页面'}</button>`,
    onMount: (modal) => {
      modal.querySelector('[name="classKey"]')?.addEventListener('change', (event) => {
        const container = modal.querySelector('#property-fields');
        if (container) container.innerHTML = propertyFields(event.currentTarget.value);
      });
      modal.querySelector('#save-page')?.addEventListener('click', async () => {
        const values = formValues(modal.querySelector('#page-form'));
        const properties = {};
        modal.querySelectorAll('[data-property-key]').forEach((input) => {
          if (input.value !== '') properties[input.dataset.propertyKey] = input.value;
        });
        const payload = {
          ...values,
          tags: values.tags.split(/[,，]/).map((item) => item.trim()).filter(Boolean),
          aliases: values.aliases.split(/[,，]/).map((item) => item.trim()).filter(Boolean),
          confidence: Number(values.confidence),
          properties,
        };
        try {
          if (page) await api(`/api/pages/${encodeURIComponent(page.id)}`, { method: 'PATCH', body: payload });
          else await api(`/api/libraries/${encodeURIComponent(library.id)}/pages`, { method: 'POST', body: payload });
          toast(page ? '页面已更新' : '页面已创建', 'success');
          closeModal();
          window.dispatchEvent(new HashChangeEvent('hashchange'));
        } catch (error) {
          toast(error.message, 'error');
        }
      });
    },
  });
}

function openNodeEditor(library, detail) {
  openModal({
    title: '新建目录',
    body: `<form id="node-form" class="form-grid">
      ${textField({ label: '名称', name: 'name', placeholder: '例如：客户案例' })}
      ${selectField({ label: '父级', name: 'parentId', options: [{ value: '', label: '顶层' }, ...flattenNodes(detail.nodes).map((node) => ({ value: node.id, label: `${'— '.repeat(node.depth)}${node.name}` }))] })}
      ${selectField({ label: '类型', name: 'kind', options: [{ value: 'section', label: '分类' }, { value: 'shelf', label: '书架' }, { value: 'category', label: '主题' }] })}
      ${textField({ label: '分类号', name: 'code', placeholder: '例如 A.3' })}
      ${textField({ label: '说明', name: 'description', span: true })}
    </form>`,
    footer: `<button class="btn" data-close-modal>取消</button><button class="btn btn-primary" id="save-node">创建目录</button>`,
    onMount: (modal) => {
      modal.querySelector('#save-node')?.addEventListener('click', async () => {
        const values = formValues(modal.querySelector('#node-form'));
        try {
          await api(`/api/libraries/${encodeURIComponent(library.id)}/nodes`, { method: 'POST', body: values });
          toast('目录已创建', 'success');
          closeModal();
          window.dispatchEvent(new HashChangeEvent('hashchange'));
        } catch (error) {
          toast(error.message, 'error');
        }
      });
    },
  });
}

function openGrantEditor(library, detail) {
  const people = state.people.map((person) => ({ value: `person:${person.id}`, label: `个人 · ${person.name}` }));
  const teams = state.teams.flatMap((team) => flattenTeamOptions(team));
  openModal({
    title: '新增访问授权',
    body: `<form id="grant-form" class="form-grid">
      ${selectField({ label: '授权对象', name: 'subject', options: [...people, ...teams, { value: 'org:org', label: '组织 · 全体成员' }], span: true })}
      ${selectField({ label: '角色', name: 'role', options: [{ value: 'viewer', label: '只读' }, { value: 'editor', label: '编辑' }, { value: 'owner', label: '所有者' }] })}
    </form>`,
    footer: `<button class="btn" data-close-modal>取消</button><button class="btn btn-primary" id="save-grant">授予权限</button>`,
    onMount: (modal) => {
      modal.querySelector('#save-grant')?.addEventListener('click', async () => {
        const values = formValues(modal.querySelector('#grant-form'));
        const [subjectType, subjectId] = String(values.subject).split(':');
        try {
          await api(`/api/libraries/${encodeURIComponent(library.id)}/grants`, {
            method: 'POST',
            body: { subjectType, subjectId, role: values.role },
          });
          toast('权限已授予', 'success');
          closeModal();
          window.dispatchEvent(new HashChangeEvent('hashchange'));
        } catch (error) {
          toast(error.message, 'error');
        }
      });
    },
  });
}

function flattenTeamOptions(team, depth = 0, out = []) {
  out.push({ value: `team:${team.id}`, label: `${'— '.repeat(depth)}团队 · ${team.name}` });
  for (const child of team.children ?? []) flattenTeamOptions(child, depth + 1, out);
  return out;
}

function openClassEditor(library) {
  openModal({
    title: '新建本体类型',
    body: `<form id="class-form" class="form-grid">
      ${textField({ label: '显示名称', name: 'name', placeholder: '例如：客户案例' })}
      ${textField({ label: 'Key（小写字母/数字/-）', name: 'key', placeholder: 'case-study' })}
      ${selectField({ label: '主色', name: 'color', options: [
        { value: 'jade', label: '玉' }, { value: 'clay', label: '陶' }, { value: 'ochre', label: '赭' },
        { value: 'indigo', label: '靛' }, { value: 'teal', label: '青' }, { value: 'plum', label: '梅' },
      ] })}
      ${textField({ label: '说明', name: 'description', span: true })}
    </form>`,
    footer: `<button class="btn" data-close-modal>取消</button><button class="btn btn-primary" id="save-class">创建类型</button>`,
    onMount: (modal) => {
      modal.querySelector('#save-class')?.addEventListener('click', async () => {
        try {
          await api(`/api/libraries/${encodeURIComponent(library.id)}/classes`, {
            method: 'POST',
            body: { ...formValues(modal.querySelector('#class-form')), schema: { fields: [] } },
          });
          toast('本体类型已创建', 'success');
          closeModal();
          window.dispatchEvent(new HashChangeEvent('hashchange'));
        } catch (error) {
          toast(error.message, 'error');
        }
      });
    },
  });
}

function openPropertyEditor(library, detail) {
  const classOptions = [{ value: '', label: '全部类型' }, ...(detail.classes ?? []).map((klass) => ({ value: klass.key, label: klass.name }))];
  openModal({
    title: '新建本体属性',
    body: `<form id="property-form" class="form-grid">
      ${selectField({ label: '所属类型', name: 'classKey', options: classOptions })}
      ${textField({ label: '属性名称', name: 'name', placeholder: '例如：领域' })}
      ${textField({ label: 'Key', name: 'key', placeholder: 'domain' })}
      ${selectField({ label: '字段类型', name: 'type', options: [
        { value: 'string', label: '短文本' }, { value: 'text', label: '长文本' }, { value: 'number', label: '数字' },
        { value: 'date', label: '日期' }, { value: 'url', label: '链接' }, { value: 'boolean', label: '布尔' }, { value: 'enum', label: '枚举' },
      ] })}
      ${textField({ label: '枚举选项（逗号分隔，仅 enum）', name: 'options', span: true, placeholder: '组织,人物,产品' })}
      ${textField({ label: '说明', name: 'description', span: true })}
    </form>`,
    footer: `<button class="btn" data-close-modal>取消</button><button class="btn btn-primary" id="save-property">创建属性</button>`,
    onMount: (modal) => {
      modal.querySelector('#save-property')?.addEventListener('click', async () => {
        const values = formValues(modal.querySelector('#property-form'));
        try {
          await api(`/api/libraries/${encodeURIComponent(library.id)}/properties`, {
            method: 'POST',
            body: {
              classKey: values.classKey || null,
              key: values.key,
              name: values.name,
              type: values.type,
              description: values.description,
              options: values.options ? values.options.split(/[,，]/).map((item) => item.trim()).filter(Boolean) : [],
            },
          });
          toast('本体属性已创建', 'success');
          closeModal();
          window.dispatchEvent(new HashChangeEvent('hashchange'));
        } catch (error) {
          toast(error.message, 'error');
        }
      });
    },
  });
}
