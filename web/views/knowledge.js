import { api, state, icon, escapeHtml as esc, timeAgo, toast } from '../assets/core.js';
import { renderMarkdown } from '../assets/markdown.js';
import { mountGraph } from '../assets/graph.js';

let wikiState = null;

function resolveLibrary(query) {
  const slug = query.get('library');
  return state.libraries.find((item) => item.slug === slug || item.id === slug)
    ?? state.libraries.find((item) => item.slug === 'power-industry')
    ?? state.libraries[0]
    ?? null;
}

function typeBadge(klass) {
  return `<span class="wiki-type" style="--type-color:${klass.color || 'jade'}">${esc(klass.name || klass.key)}</span>`;
}

function empty(text) {
  return `<div class="wiki-empty">${esc(text)}</div>`;
}

export async function renderKnowledge(query = new URLSearchParams()) {
  const library = resolveLibrary(query);
  if (!library) return empty('还没有可用的知识库');
  const detail = await api(`/api/libraries/${encodeURIComponent(library.id)}`).catch(() => null);
  if (!detail) return empty('无法读取知识库');
  const classes = detail.classes ?? [];
  const counts = await Promise.all(classes.map(async (klass) => {
    const data = await api(`/api/libraries/${encodeURIComponent(library.id)}/pages?class=${encodeURIComponent(klass.key)}&status=visible&limit=1`).catch(() => ({ total: 0 }));
    return { ...klass, count: Number(data.total ?? 0) };
  }));
  const pagesData = await api(`/api/libraries/${encodeURIComponent(library.id)}/pages?status=visible&limit=500`).catch(() => ({ pages: [] }));
  const pages = (pagesData.pages ?? []).map((page) => ({
    id: page.id, title: page.title, summary: page.summary || page.tldr || '', classKey: page.classKey,
    className: page.className, classColor: page.classColor, tags: page.tags ?? [], updatedAt: page.updatedAt,
  }));
  const tagCounts = new Map();
  for (const page of pages) for (const tag of page.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  const tags = [...tagCounts.entries()].filter(([tag]) => !tag.includes('www.') && !/^[a-z0-9.-]+\.(com|cn|org|net)/i.test(tag)).sort((a, b) => b[1] - a[1]).slice(0, 18);
  wikiState = { library, detail, classes: counts, pages, tags, activeType: query.get('type') ?? '', activeTag: query.get('tag') ?? '', query: query.get('q') ?? '', current: null };
  const pageId = query.get('page') ?? '';
  return `
    <div class="wiki-workspace" data-library="${esc(library.id)}">
      <aside class="wiki-side">
        <div class="wiki-side-head">
          <div class="wiki-eyebrow">KNOWLEDGE GRAPH</div>
          <h2>知识工作台</h2>
          <p>按页面、类型与链接浏览知识。</p>
        </div>
        <label class="wiki-library-label">知识库
          <select id="wiki-library" class="select">${state.libraries.map((item) => `<option value="${esc(item.slug)}" ${item.id === library.id ? 'selected' : ''}>${esc(item.name)} · ${Number(item.counts?.pages ?? 0)} 页</option>`).join('')}</select>
        </label>
        <label class="wiki-search">${icon('search', 14)}<input id="wiki-search" placeholder="搜索页面、标签…" value="${esc(wikiState.query)}"></label>
        <div class="wiki-type-list">
          <button class="wiki-type-row ${!wikiState.activeType ? 'active' : ''}" data-wiki-type=""><span class="wiki-type-dot" style="background:#64748b"></span><span>全部</span><b>${pages.length}<small>/${detail.counts?.pages ?? pages.length}</small></b></button>
          ${counts.map((klass) => `<button class="wiki-type-row ${wikiState.activeType === klass.key ? 'active' : ''}" data-wiki-type="${esc(klass.key)}"><span class="wiki-type-dot" style="background:${klass.color || '#64748b'}"></span><span>${esc(klass.name)}</span><b>${klass.count}</b></button>`).join('')}
        </div>
        <div class="wiki-tags"><div class="wiki-rail-title">标签</div><div class="wiki-tag-cloud">${tags.map(([tag, count]) => `<button class="wiki-tag ${wikiState.activeTag === tag ? 'active' : ''}" data-wiki-tag="${esc(tag)}">${esc(tag)} <span>${count}</span></button>`).join('') || '<span class="wiki-muted">暂无标签</span>'}</div></div>
        <div class="wiki-side-foot">${icon('graph', 13)} <a href="#/graph?library=${encodeURIComponent(library.slug)}">打开全库图谱</a><span class="wiki-dev">DEV · 校对关闭</span></div>
      </aside>
      <main class="wiki-main">
        <div class="wiki-toolbar"><div id="wiki-list-meta" class="wiki-list-meta">最近 ${pages.length} / ${detail.counts?.pages ?? pages.length} 页</div><div class="wiki-toolbar-actions"><button class="btn btn-sm btn-ghost" id="wiki-toggle-list">${icon('layers', 13)} 页面列表</button></div></div>
        <section id="wiki-list" class="wiki-list collapsed" aria-label="页面列表"></section>
        <article id="wiki-article" class="wiki-article">
          <div class="wiki-loading">${icon('layers', 28)}<p>选择左侧页面，或从下方最近页面开始。</p></div>
        </article>
      </main>
      <aside class="wiki-right" id="wiki-right">
        <div class="wiki-rail-card"><div class="wiki-rail-title">知识类型</div><div class="wiki-type-summary">${counts.filter((klass) => klass.count > 0).map((klass) => `<button data-wiki-type="${esc(klass.key)}"><span class="wiki-type" style="--type-color:${klass.color}">${esc(klass.name)}</span><b>${klass.count}</b></button>`).join('')}</div></div>
        <div id="wiki-local-graph-card" class="wiki-rail-card hidden"><div class="wiki-rail-title">局部图谱</div><canvas id="wiki-local-graph" class="wiki-local-graph"></canvas></div>
      </aside>
    </div>`;
}

function renderList() {
  const list = document.getElementById('wiki-list');
  const meta = document.getElementById('wiki-list-meta');
  if (!list || !wikiState) return;
  const q = wikiState.query.trim().toLowerCase();
  const filtered = wikiState.pages.filter((page) => {
    if (wikiState.activeType && page.classKey !== wikiState.activeType) return false;
    if (wikiState.activeTag && !page.tags.includes(wikiState.activeTag)) return false;
    if (q && !(`${page.title} ${page.summary} ${page.tags.join(' ')}`.toLowerCase().includes(q))) return false;
    return true;
  });
  list.innerHTML = filtered.map((page) => `<button class="wiki-page-row ${wikiState.current === page.id ? 'active' : ''}" data-wiki-page="${esc(page.id)}"><span class="wiki-page-type" style="--type-color:${page.classColor || '#64748b'}"></span><div class="wiki-page-copy"><div class="wiki-page-title">${esc(page.title)}</div><div class="wiki-page-summary">${esc(page.summary || '暂无摘要')}</div><div class="wiki-page-meta">${esc(page.className || page.classKey)} · ${timeAgo(page.updatedAt)}</div></div><span class="wiki-page-arrow">↗</span></button>`).join('') || empty('没有匹配的页面');
  if (meta) meta.textContent = `${filtered.length} / ${wikiState.detail.counts?.pages ?? filtered.length} 页${wikiState.activeType ? ` · ${wikiState.classes.find((item) => item.key === wikiState.activeType)?.name ?? ''}` : ''}`;
}

function renderWelcome() {
  if (!wikiState) return '';
  const recent = (wikiState.pages.filter((page) => page.classKey !== 'source').slice(0, 8));
  return `<div class="wiki-welcome"><div class="wiki-eyebrow">A LINKED KNOWLEDGE BASE</div><h1>知识不是文件夹，<br><em>是页面之间的链接。</em></h1><p>从类型进入概念、实体、决策与方法；从页面进入来源、主张和相邻知识。左侧类型与标签是入口，右侧反向链接和图谱是路径。</p><div class="wiki-type-cards">${wikiState.classes.filter((klass) => ['concept','entity','decision','howto','comparison','note'].includes(klass.key)).map((klass) => `<button class="wiki-type-card" data-wiki-type="${esc(klass.key)}"><span class="wiki-type-icon" style="--type-color:${klass.color}">${icon(klass.key === 'decision' ? 'check' : klass.key === 'entity' ? 'users' : 'layers', 16)}</span><b>${klass.count}</b><span>${esc(klass.name)}</span></button>`).join('')}</div><div class="wiki-section-head"><h3>最近更新</h3><span>${wikiState.pages.length} 页（最多加载 500）</span></div><div class="wiki-recent">${recent.map((page) => `<button class="wiki-recent-row" data-wiki-page="${esc(page.id)}"><span>${esc(page.title)}</span><small>${esc(page.className)} · ${timeAgo(page.updatedAt)}</small></button>`).join('')}</div></div>`;
}

function renderArticle(detail) {
  const page = detail.page;
  const body = renderMarkdown(page.body, { libraryId: page.libraryId });
  const html = `<header class="wiki-article-head"><div class="wiki-article-types">${typeBadge({ name: page.className || page.classKey, color: page.classColor })}${page.tags.slice(0, 5).map((tag) => `<span class="wiki-tag-static">${esc(tag)}</span>`).join('')}</div><h1>${esc(page.title)}</h1>${page.summary ? `<p class="wiki-lede">${esc(page.summary)}</p>` : ''}<div class="wiki-article-meta"><span>${icon('edit', 13)} ${timeAgo(page.updatedAt)}</span><span>${(page.links?.outbound ?? detail.links?.outbound ?? []).length} 条出链</span><a href="#/page/${encodeURIComponent(page.id)}">完整页面 ↗</a></div></header><div class="article-body wiki-article-body">${body || '<p class="wiki-muted">暂无正文。</p>'}</div>`;
  const article = document.getElementById('wiki-article');
  if (article) article.innerHTML = html;
  renderRail(detail);
  article?.querySelectorAll('a.wikilink').forEach((link) => {
    link.addEventListener('click', async (event) => {
      const href = link.getAttribute('href') || '';
      const match = href.match(/#\/resolve\/([^/]+)\/([^?]+)/);
      if (!match) return;
      event.preventDefault();
      try {
        const resolved = await api(`/api/resolve?library=${match[1]}&ref=${decodeURIComponent(match[2])}`);
        loadPage(resolved.page.id);
      } catch (error) { toast(error.message, 'error'); }
    });
  });
}

function renderRail(detail) {
  const right = document.getElementById('wiki-right');
  if (!right) return;
  const page = detail.page;
  const inbound = (detail.links?.inbound ?? []).filter((item) => item.id !== page.id);
  const outbound = (detail.links?.outbound ?? []).filter((item) => item.id !== page.id);
  const properties = detail.properties ?? [];
  const hierarchy = detail.hierarchy ?? { parent: null, children: [] };
  right.innerHTML = `
    <div class="wiki-rail-card wiki-rail-summary"><div class="wiki-rail-title">页面信息</div><div class="wiki-meta-line"><span>类型</span><b>${typeBadge({ name: page.className || page.classKey, color: page.classColor })}</b></div><div class="wiki-meta-line"><span>来源</span><b>${detail.sources?.length ?? 0}</b></div><div class="wiki-meta-line"><span>主张</span><b>${detail.claims?.length ?? 0}</b></div><div class="wiki-meta-line"><span>版本</span><b>v${page.version ?? 1}</b></div></div>
    <div class="wiki-rail-card"><div class="wiki-rail-title">反向链接 <b>${inbound.length}</b></div><div class="wiki-backlinks">${inbound.slice(0, 12).map((item) => `<button class="wiki-backlink" data-wiki-page="${esc(item.id)}">${esc(item.title)}<small>${esc(item.relation)}</small></button>`).join('') || '<div class="wiki-muted">还没有页面链接到这里。</div>'}</div>${inbound.length ? `<a class="wiki-rail-link" href="#/page/${encodeURIComponent(page.id)}">查看全部链接 ↗</a>` : ''}</div>
    <div class="wiki-rail-card"><div class="wiki-rail-title">向上 / 向下</div><div class="wiki-backlinks">${hierarchy.parent ? `<button class="wiki-backlink" data-wiki-page="${esc(hierarchy.parent.id)}">↑ ${esc(hierarchy.parent.title)}</button>` : ''}${(hierarchy.children ?? []).slice(0, 6).map((item) => `<button class="wiki-backlink" data-wiki-page="${esc(item.id)}">↓ ${esc(item.title)}</button>`).join('')}${!hierarchy.parent && !(hierarchy.children ?? []).length ? '<div class="wiki-muted">还没有层级关联。</div>' : ''}</div></div>
    ${properties.length ? `<div class="wiki-rail-card"><div class="wiki-rail-title">本体属性</div><div class="wiki-properties">${properties.slice(0, 8).map((item) => `<div><span>${esc(item.name || item.key)}</span><b>${esc(Array.isArray(item.value) ? item.value.join('、') : item.value ?? '—')}</b></div>`).join('')}</div></div>` : ''}
    <div id="wiki-local-graph-card" class="wiki-rail-card"><div class="wiki-rail-title">局部图谱</div><canvas id="wiki-local-graph" class="wiki-local-graph"></canvas><div class="wiki-muted">${outbound.length + inbound.length} 条相邻边</div></div>
    <div class="wiki-rail-card wiki-rail-outbound"><div class="wiki-rail-title">出链 <b>${outbound.length}</b></div>${outbound.slice(0, 8).map((item) => `<button class="wiki-backlink" data-wiki-page="${esc(item.id)}">${esc(item.title)}<small>${esc(item.relation)}</small></button>`).join('') || '<div class="wiki-muted">没有出链。</div>'}</div>`;
  right.querySelectorAll('[data-wiki-page]').forEach((button) => button.addEventListener('click', () => loadPage(button.dataset.wikiPage)));
  const canvas = document.getElementById('wiki-local-graph');
  if (canvas) {
    const nodes = [{ id: page.id, title: page.title, classKey: page.classKey, className: page.className, color: page.classColor, degree: 4 }, ...[...inbound, ...outbound].map((item) => ({ id: item.id, title: item.title, classKey: item.classKey, className: item.className, color: 'jade', degree: 1 }))];
    const edges = [...inbound.map((item) => ({ source: item.id, target: page.id, relation: item.relation })), ...outbound.map((item) => ({ source: page.id, target: item.id, relation: item.relation }))];
    try { mountGraph(canvas, { nodes, edges }, { onSelect: (node) => loadPage(node.id) }); } catch { /* ignore */ }
  }
}

async function loadPage(id) {
  if (!wikiState) return;
  const article = document.getElementById('wiki-article');
  if (!article) return;
  article.innerHTML = `<div class="wiki-loading">${icon('layers', 24)}<p>正在读取页面…</p></div>`;
  try {
    const detail = await api(`/api/pages/${encodeURIComponent(id)}`);
    wikiState.current = id;
    renderArticle(detail);
    renderList();
    const query = new URLSearchParams({ library: wikiState.library.slug, page: id });
    if (wikiState.activeType) query.set('type', wikiState.activeType);
    if (wikiState.activeTag) query.set('tag', wikiState.activeTag);
    if (wikiState.query) query.set('q', wikiState.query);
    history.replaceState(null, '', `#/knowledge?${query.toString()}`);
  } catch (error) {
    article.innerHTML = empty(error.message);
  }
}

export function mountKnowledge(query = new URLSearchParams()) {
  if (!wikiState) return;
  renderList();
  const pageId = query.get('page');
  if (pageId) loadPage(pageId); else document.getElementById('wiki-article').innerHTML = renderWelcome();
  document.querySelectorAll('[data-wiki-type]').forEach((button) => button.addEventListener('click', () => { wikiState.activeType = button.dataset.wikiType || ''; document.querySelectorAll('[data-wiki-type]').forEach((item) => item.classList.toggle('active', (item.dataset.wikiType || '') === wikiState.activeType)); document.getElementById('wiki-list')?.classList.remove('collapsed'); renderList(); }));
  document.querySelectorAll('[data-wiki-tag]').forEach((button) => button.addEventListener('click', () => { wikiState.activeTag = wikiState.activeTag === button.dataset.wikiTag ? '' : button.dataset.wikiTag; document.querySelectorAll('[data-wiki-tag]').forEach((item) => item.classList.toggle('active', item.dataset.wikiTag === wikiState.activeTag)); document.getElementById('wiki-list')?.classList.remove('collapsed'); renderList(); }));
  const search = document.getElementById('wiki-search');
  search?.addEventListener('input', () => { wikiState.query = search.value; document.getElementById('wiki-list')?.classList.remove('collapsed'); renderList(); });
  document.getElementById('wiki-library')?.addEventListener('change', (event) => { const selected = state.libraries.find((item) => item.slug === event.target.value); if (selected) window.location.hash = `#/knowledge?library=${encodeURIComponent(selected.slug)}`; });
  document.getElementById('wiki-list')?.addEventListener('click', (event) => { const row = event.target.closest('[data-wiki-page]'); if (row) loadPage(row.dataset.wikiPage); });
  document.addEventListener('click', (event) => { const row = event.target.closest('.wiki-recent-row'); if (row?.dataset.wikiPage) loadPage(row.dataset.wikiPage); });
  document.getElementById('wiki-toggle-list')?.addEventListener('click', () => document.getElementById('wiki-list')?.classList.toggle('collapsed'));
}
