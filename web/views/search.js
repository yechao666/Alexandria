import {
  api,
  state,
  icon,
  escapeHtml as esc,
  fmtNumber,
  timeAgo,
  roleBadge,
  classBadge,
  confidence,
  openModal,
  toast,
  go,
  libraryColor,
  formatAnswer,
  emptyState,
} from '../assets/core.js';
import { avatar } from '../assets/core.js';

export async function renderSearch(params) {
  const q = params.get('q')?.trim() ?? '';
  const libraryRef = params.get('library') ?? '';
  const classKey = params.get('class') ?? '';
  const library = state.libraries.find((item) => item.slug === libraryRef || item.id === libraryRef);
  let hits = [];
  let answer = null;
  let took = 0;
  let strategy = '';
  if (q) {
    const query = new URLSearchParams({ q, limit: '30' });
    if (library) query.set('library', library.id);
    if (classKey) query.set('class', classKey);
    const searchPromise = api(`/api/search?${query.toString()}`);
    const answerPromise = api('/api/query', {
      method: 'POST',
      body: { q, libraryIds: library ? [library.id] : undefined, limit: 6 },
    }).catch(() => null);
    const [searchResult, answerResult] = await Promise.all([searchPromise, answerPromise]);
    hits = searchResult.hits ?? [];
    took = searchResult.tookMs ?? 0;
    strategy = searchResult.strategy ?? '';
    answer = answerResult;
  }

  const classOptions = state.bootstrap?.classes
    ? [...new Map(state.bootstrap.classes.map((item) => [item.key, item])).values()]
    : [];
  const libraryOptions = [{ value: '', label: '全部可见知识库' }, ...state.libraries.map((item) => ({ value: item.slug, label: item.name }))];

  const answerHtml = answer
    ? `<div class="answer-card">
        <div class="answer-head">${icon('spark', 18)}<h3 style="font-size:16px">知识合成</h3><span class="badge ${answer.mode === 'llm' ? 'plum' : 'jade'}">${answer.mode === 'llm' ? 'LLM 合成' : answer.mode === 'compiled' ? '编译知识' : '无结果'}</span><span class="small faint" style="margin-left:auto">${answer.tookMs ?? 0} ms · ${answer.citations?.length ?? 0} 条引用</span></div>
        <div class="answer-body">${formatAnswer(answer.answer)}</div>
        ${answer.gaps?.length ? `<div class="gaps">${answer.gaps.map((gap) => `<div class="gap-item">${icon('clock', 13)}<span>${esc(gap)}</span></div>`).join('')}</div>` : ''}
      </div>`
    : '';

  const results = hits
    .map((hit) => {
      const href = hit.kind === 'source' ? `#/library/${encodeURIComponent(hit.librarySlug)}` : `#/page/${encodeURIComponent(hit.id)}`;
      return `<a class="result" href="${href}">
        <div class="top">${hit.kind === 'source' ? '<span class="badge ochre">文献</span>' : `<span class="badge ${hit.page?.classColor ?? 'jade'}">${esc(hit.className)}</span>`}<span>${esc(hit.libraryName)}</span><span>·</span><span>${timeAgo(hit.updatedAt)}</span><span class="score">${Number(hit.score ?? 0).toFixed(1)}</span></div>
        <h3>${esc(hit.title)}</h3>
        <div class="snippet">${esc(plain(hit.snippet || hit.summary))}</div>
        <div class="signals">
          ${signalBar('词法', hit.signals?.lexical, 20)}
          ${signalBar('标题', hit.signals?.title, 1)}
          ${signalBar('覆盖', hit.signals?.coverage, 1)}
          ${hit.signals?.graph ? signalBar('图谱', hit.signals.graph, 1) : ''}
          ${signalBar('置信', hit.signals?.confidence, 1)}
          ${(hit.tags ?? []).slice(0, 3).map((tag) => `<span class="tag">${esc(tag)}</span>`).join('')}
        </div>
      </a>`;
    })
    .join('');

  const suggestions = [...new Map((state.bootstrap?.classes ?? []).map((item) => [item.key, item])).values()]
    .slice(0, 8)
    .map((item) => `<a class="btn btn-sm" href="#/search?q=${encodeURIComponent(item.name)}">${esc(item.name)}</a>`)
    .join('');
  const recent = (state.bootstrap?.recentPages ?? [])
    .slice(0, 5)
    .map((page) => `<a class="rail-item" href="#/page/${encodeURIComponent(page.id)}"><span class="dot" style="background:${libraryColor('jade')}"></span><span>${esc(page.title)}</span></a>`)
    .join('');

  return `
    <section class="search-hero">
      <div class="eyebrow">FTS5 · TYPED GRAPH · COMPILED PAGES</div>
      <h1>沿着知识路径找答案。</h1>
      <form class="search-box" id="search-form">
        <input name="q" value="${esc(q)}" placeholder="问一个问题，或输入一个概念 / 文献名 / 标签…" autofocus>
        <button class="btn btn-primary" type="submit">${icon('search', 16)} 检索</button>
      </form>
      <div class="row wrap" style="margin-top:12px;gap:8px">
        <span class="small faint">试试：</span>
        ${suggestions || '<a class="btn btn-sm" href="#/search?q=知识编译">知识编译</a>'}
      </div>
    </section>
    ${q ? `<div class="between" style="margin:4px 0 14px"><span class="small muted">命中 ${hits.length} 条 · ${took} ms</span><span class="small faint">${esc(strategy)}</span></div>` : ''}
    <div class="search-layout">
      <div>
        ${answerHtml}
        <div class="result-list" style="margin-top:${answerHtml ? '18px' : '0'}">
          ${q ? results || emptyState('没有命中的知识', '尝试减少限定词，或先上传相关资料。', '<a class="btn btn-sm" href="#/upload">上传资料</a>') : ''}
          ${!q ? `<div class="panel panel-pad"><h3>从一个文獻或概念开始</h3><p class="muted">检索会先用 FTS5 做词法召回，再沿预编译的关联图扩展一跳，最后按标题覆盖、置信度、时效与 read_when 重排。没有查询时向量化。</p><div class="rail-list" style="margin-top:14px">${recent}</div></div>` : ''}
        </div>
      </div>
      <aside>
        <div class="panel side-card">
          <div class="panel-head"><h3 style="font-size:13px">检索范围</h3></div>
          <div class="panel-body">
            <div class="field"><label>知识库</label><select class="select" id="search-library">${libraryOptions.map((option) => `<option value="${esc(option.value)}" ${option.value === libraryRef ? 'selected' : ''}>${esc(option.label)}</option>`).join('')}</select></div>
            <div class="field" style="margin-top:10px"><label>本体类型</label><select class="select" id="search-class"><option value="">全部类型</option>${classOptions.map((item) => `<option value="${esc(item.key)}" ${item.key === classKey ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</select></div>
          </div>
        </div>
        ${answer ? `<div class="panel side-card" style="margin-top:14px">
          <div class="panel-head"><h3 style="font-size:13px">检索信号</h3></div>
          <div class="panel-body">
            <div class="stat-row"><span>候选知识页</span><b>${answer.pages?.length ?? 0}</b></div>
            <div class="stat-row"><span>直接引用</span><b>${answer.citations?.length ?? 0}</b></div>
            <div class="stat-row"><span>图谱扩展命中</span><b>${answer.signals?.graphHits ?? 0}</b></div>
            <div class="stat-row"><span>最高分</span><b>${Number(answer.signals?.topScore ?? 0).toFixed(1)}</b></div>
            <div class="strategy-note">${esc(strategy || '')}</div>
            <div class="hairline"></div>
            <div class="small faint">这一答案来自已编译知识页；原文仅作为可回溯证据，不在查询时重新切片。</div>
          </div>
        </div>` : ''}
        ${answer?.citations?.length ? `<div class="panel side-card" style="margin-top:14px"><div class="panel-head"><h3 style="font-size:13px">引用来源</h3></div><div class="panel-body rail-list">${answer.citations.map((citation) => `<a class="rail-item" href="#/page/${encodeURIComponent(citation.pageId)}"><span class="dot" style="background:var(--clay)"></span><span>${esc(citation.title)}<br><span class="faint">${esc(citation.libraryName)} · ${Math.round(citation.confidence * 100)}%</span></span></a>`).join('')}</div></div>` : ''}
      </aside>
    </div>`;
}

export function mountSearch() {
  document.getElementById('search-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const q = new FormData(event.currentTarget).get('q')?.toString().trim() ?? '';
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    const library = document.getElementById('search-library')?.value;
    const klass = document.getElementById('search-class')?.value;
    if (library) params.set('library', library);
    if (klass) params.set('class', klass);
    go(`#/search?${params.toString()}`);
  });
  const applyFilter = () => {
    const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
    const q = params.get('q') ?? '';
    if (!q) return;
    const library = document.getElementById('search-library')?.value;
    const klass = document.getElementById('search-class')?.value;
    const next = new URLSearchParams({ q });
    if (library) next.set('library', library);
    if (klass) next.set('class', klass);
    go(`#/search?${next.toString()}`);
  };
  document.getElementById('search-library')?.addEventListener('change', applyFilter);
  document.getElementById('search-class')?.addEventListener('change', applyFilter);
}

function plain(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, label) => label || target)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function signalBar(label, value, max) {
  if (value === undefined) return '';
  const pct = Math.max(4, Math.min(100, Math.round((Number(value) / max) * 100)));
  return `<span class="signal">${esc(label)}<span class="bar"><i style="width:${pct}%"></i></span></span>`;
}
