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
  params.set('limit', '500');
  const data = await api(`/api/sources?${params.toString()}`).catch(() => ({ sources: [], summary: {}, facets: {} }));
  const sources = data.sources ?? [];
  const summary = data.summary ?? {};
  const libraries = data.facets?.libraries ?? [];
  const selectedLibrary = params.get('library') ?? '';
  const selectedStatus = params.get('status') ?? '';
  const q = params.get('q') ?? '';

  const rows = sources.map((source) => `<tr class="doc-row" data-href="#/source/${encodeURIComponent(source.id)}" tabindex="0">
    <td><div class="doc-title-cell"><span class="doc-icon">${icon(source.kind === 'image' ? 'image' : 'file', 17)}</span><div><b>${esc(source.title)}</b><span>${esc(source.filename)} · ${kindLabel(source)} · ${fmtBytes(source.size)}</span></div></div></td>
    <td><div class="doc-dept"><b>${esc(source.departmentName || '未绑定部门')}</b><span>${esc(source.libraryName)}</span></div></td>
    <td><span class="badge outline">${kindLabel(source)}</span></td>
    <td class="num-cell"><a class="doc-pages-link" href="#/library/${encodeURIComponent(source.librarySlug)}?tab=pages">${fmtNumber(source.compiledPages)} 页知识</a></td>
    <td>${statusPill(source.status)}</td>
    <td class="small faint">${esc(source.uploadedByName || '—')}<br>${timeAgo(source.createdAt)}</td>
    <td><span class="icon-btn">${icon('chevron', 14)}</span></td>
  </tr>`).join('');

  return `
    <section class="page-head">
      <div><div class="eyebrow">DOCUMENT REGISTRY · DEPARTMENTS · PROVENANCE</div><h1>文档中心</h1><p>按部门与知识库管理原始资料；每份文档保留原文、处理状态、编译出的知识页与来源链路。</p></div>
      <div class="page-actions"><a class="btn btn-primary" href="#/upload">${icon('upload', 14)} 导入文档</a></div>
    </section>

    <section class="kpi-grid kpi-grid-4">
      <div class="kpi-card kpi-violet"><div><div class="label">文档总数</div><div class="value">${fmtNumber(summary.total)}</div><div class="hint">可见范围内的原始资料</div></div><span class="kpi-icon">${icon('file', 18)}</span></div>
      <div class="kpi-card kpi-green"><div><div class="label">已编译</div><div class="value">${fmtNumber(summary.ready)}</div><div class="hint">已产生知识页</div></div><span class="kpi-icon">${icon('check', 18)}</span></div>
      <div class="kpi-card kpi-amber"><div><div class="label">处理中</div><div class="value">${fmtNumber(summary.processing)}</div><div class="hint">解析 / 编译队列</div></div><span class="kpi-icon">${icon('clock', 18)}</span></div>
      <div class="kpi-card kpi-red"><div><div class="label">失败 / 空编译</div><div class="value">${fmtNumber((summary.failed ?? 0) + (summary.withoutKnowledge ?? 0))}</div><div class="hint">${fmtNumber(summary.failed)} 失败 · ${fmtNumber(summary.withoutKnowledge)} 无知识页</div></div><span class="kpi-icon">${icon('shield', 18)}</span></div>
    </section>

    <div class="panel doc-panel">
      <div class="doc-toolbar">
        <form class="doc-search" id="doc-search"><input class="input" name="q" value="${esc(q)}" placeholder="搜索文档标题、文件名、摘要…" aria-label="搜索文档"><button class="btn btn-sm" type="submit">${icon('search', 13)} 搜索</button></form>
        <select class="select" id="doc-library"><option value="">全部部门 / 知识库</option>${libraries.map((library) => `<option value="${esc(library.id)}" ${selectedLibrary === library.id ? 'selected' : ''}>${esc(library.name)} · ${library.count}</option>`).join('')}</select>
        <select class="select" id="doc-status"><option value="">全部状态</option>${['ready', 'processing', 'failed'].map((status) => `<option value="${status}" ${selectedStatus === status ? 'selected' : ''}>${STATUS_LABEL[status]}</option>`).join('')}</select>
        <span class="small faint" style="margin-left:auto">${sources.length} 份文档</span>
      </div>
      <div style="overflow:auto">
        <table class="data-table doc-table">
          <thead><tr><th>文档</th><th>部门 / 知识库</th><th>类型</th><th>编译知识</th><th>状态</th><th>上传者</th><th></th></tr></thead>
          <tbody>${rows || `<tr><td colspan="7">${emptyState('还没有文档', '导入第一份资料，系统会保留原文并编译出知识页。', '<a class="btn btn-primary" href="#/upload">导入文档</a>')}</td></tr>`}</tbody>
        </table>
      </div>
    </div>`;
}

export function mountDocuments() {
  const navigate = (updates) => {
    const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
    for (const [key, value] of Object.entries(updates)) {
      if (value) params.set(key, value); else params.delete(key);
    }
    go(`#/documents${params.toString() ? `?${params.toString()}` : ''}`);
  };
  document.getElementById('doc-search')?.addEventListener('submit', (event) => {
    event.preventDefault();
    navigate({ q: new FormData(event.currentTarget).get('q') ?? '' });
  });
  document.getElementById('doc-library')?.addEventListener('change', (event) => navigate({ library: event.currentTarget.value }));
  document.getElementById('doc-status')?.addEventListener('change', (event) => navigate({ status: event.currentTarget.value }));
  document.querySelectorAll('.doc-row').forEach((row) => {
    row.addEventListener('click', (event) => {
      if (event.target.closest('a')) return;
      go(row.dataset.href);
    });
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); go(row.dataset.href); }
    });
  });
}

export async function renderSource(ref) {
  if (!state.bootstrap) await loadBootstrap();
  const data = await api(`/api/sources/${encodeURIComponent(ref)}`);
  const source = data.source;
  const pages = source.compiledPages ?? [];
  const classes = [...new Set(pages.map((page) => page.className || page.classKey || '知识页'))];
  const groups = classes.map((name) => ({ name, pages: pages.filter((page) => (page.className || page.classKey || '知识页') === name) }));
  const log = (source.job?.log ?? []).slice(-20).map((line) => `<div class="timeline-item"><span class="pip"></span><div class="text mono">${esc(line)}</div></div>`).join('');
  const groupHtml = groups.map((group) => `<section class="source-group" data-source-group data-class="${esc(group.name)}"><div class="source-group-head"><span>${esc(group.name)}</span><span class="badge outline">${group.pages.length}</span></div>${group.pages.map((page) => `<a class="linked-page" href="#/page/${encodeURIComponent(page.id)}"><span class="linked-page-dot" style="background:${libraryColor(page.classColor)}"></span><span><b>${esc(page.title)}</b><small>${esc(page.summary || page.tldr || '')}</small></span><span class="badge ${page.reviewStatus === 'approved' ? 'jade' : 'outline'}">${page.reviewStatus === 'approved' ? '已校对' : '草稿'}</span>${icon('chevron', 13)}</a>`).join('')}</section>`).join('');

  return `
    <div class="doc-detail-head">
      <div class="doc-breadcrumb"><a href="#/documents">文档中心</a><span>/</span><a href="#/library/${encodeURIComponent(source.library?.slug ?? '')}?tab=documents">${esc(source.library?.name ?? '知识库')}</a></div>
      <div class="between wrap" style="align-items:flex-start;gap:16px">
        <div class="doc-heading"><span class="doc-icon doc-icon-lg">${icon(source.kind === 'image' ? 'image' : 'file', 24)}</span><div><div class="row wrap" style="gap:7px">${statusPill(source.status)}<span class="badge outline">${kindLabel(source)}</span>${source.node ? `<span class="badge outline">${esc(source.node.name)}</span>` : ''}</div><h1>${esc(source.title)}</h1><p>${esc(source.filename)} · ${fmtBytes(source.size)} · ${fmtNumber(source.wordCount)} 字 · 上传于 ${timeAgo(source.createdAt)}${source.uploadedByName ? ` · ${esc(source.uploadedByName)}` : ''}</p></div></div>
        <div class="btn-row"><a class="btn" href="/api/sources/${encodeURIComponent(source.id)}/download" target="_blank">${icon('external', 14)} 原始文件</a>${data.canEdit ? `<button class="btn" id="source-edit">${icon('edit', 14)} 编辑信息</button><button class="btn" id="source-reprocess">${icon('refresh', 14)} 重新编译</button>` : ''}<a class="btn btn-primary" href="#/library/${encodeURIComponent(source.library?.slug ?? '')}?tab=pages">查看知识库 ${icon('arrow', 14)}</a></div>
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
