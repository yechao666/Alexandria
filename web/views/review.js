import {
  api,
  state,
  icon,
  escapeHtml as esc,
  timeAgo,
  classBadge,
  reviewBadge,
  statusBadge,
  confidence,
  toast,
  go,
  emptyState,
} from '../assets/core.js';

const FILTERS = [
  { key: 'all', label: '全部待校对' },
  { key: 'unreviewed', label: '待首次校对' },
  { key: 'changes_requested', label: '已退回' },
];

export async function renderReview(params) {
  const libraryRef = params.get('library') ?? '';
  const status = params.get('status') ?? 'all';
  const library = state.libraries.find((item) => item.slug === libraryRef || item.id === libraryRef);
  const query = new URLSearchParams();
  if (library) query.set('library', library.id);
  if (status !== 'all') query.set('status', status);
  const data = await api(`/api/review${query.toString() ? `?${query.toString()}` : ''}`);
  const items = data.items ?? [];
  const summary = data.summary ?? {};
  const filtered = status === 'all' ? items : items.filter((item) => item.reviewStatus === status);

  const cards = filtered
    .map((item) => reviewCard(item))
    .join('');

  return `
    <div class="eyebrow">CURATION · REVIEW · CONFLICT RESOLUTION</div>
    <h1 style="font-size:42px;letter-spacing:-.03em;margin:8px 0 6px">校对台</h1>
    <p class="muted" style="max-width:760px;margin-bottom:20px">自动编译出的概念页默认是草稿；在成为高置信知识之前，需要人工确认定义、来源与矛盾。批准会将页面标记为已校对，并要求后续变更重新进入队列。</p>
    <div class="stat-strip" style="margin:0 0 22px">
      <div class="stat-cell"><div class="label">待校对</div><div class="value">${summary.unreviewed ?? 0}</div><div class="sub">尚未人工确认</div></div>
      <div class="stat-cell"><div class="label">已退回</div><div class="value">${summary.changesRequested ?? 0}</div><div class="sub">需要补充或修改</div></div>
      <div class="stat-cell"><div class="label">矛盾主张</div><div class="value">${summary.conflicts ?? 0}</div><div class="sub">等待裁决</div></div>
      <div class="stat-cell"><div class="label">队列总量</div><div class="value">${summary.pending ?? 0}</div><div class="sub">草稿 ${summary.drafts ?? 0} 页</div></div>
    </div>
    <div class="list-toolbar">
      <div class="row wrap"><label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="select-all-reviews"> 全选</label><button class="btn btn-sm btn-primary" id="bulk-approve">批量批准</button><button class="btn btn-sm" id="bulk-return">批量退回</button>${FILTERS.map((filter) => `<button class="btn btn-sm ${status === filter.key ? 'btn-primary' : ''}" data-review-status="${filter.key}">${filter.label}</button>`).join('')}</div>
      <select class="select" id="review-library" style="margin-left:auto;width:auto"><option value="">全部知识库</option>${state.libraries.map((item) => `<option value="${esc(item.slug)}" ${library && item.id === library.id ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</select>
    </div>
    <div class="review-list">${cards || emptyState('队列已清空', '没有等待校对的知识页。新的编译结果会自动进入这里。', '<a class="btn btn-sm" href="#/">回到总览</a>')}</div>`;
}

function reviewCard(item) {
  const page = item.page;
  return `<div class="review-card">
    <div class="review-main">
      <div class="row wrap" style="align-items:center;gap:7px"><input type="checkbox" data-review-select="${esc(page.id)}" aria-label="选择页面">${classBadge(page)}${reviewBadge(item.reviewStatus)}${statusBadge(page.status)}<span class="small faint">${esc(item.library.name)}</span></div>
      <a href="#/page/${encodeURIComponent(page.id)}" class="review-title">${esc(page.title)}</a>
      <div class="review-summary">${esc(page.summary || page.tldr || '暂无摘要')}</div>
      <div class="row wrap" style="gap:6px;margin-top:8px">${item.reasons.map((reason) => `<span class="badge outline">${esc(reason)}</span>`).join('')}${page.reviewNote ? `<span class="badge ochre">${esc(page.reviewNote)}</span>` : ''}</div>
    </div>
    <div class="review-side">
      <div class="review-metric"><b>${Math.round(Number(page.confidence) * 100)}%</b><span>置信度</span></div>
      <div class="review-metric"><b>${item.sources}</b><span>来源</span></div>
      <div class="review-metric"><b>${item.conflicts}</b><span>矛盾</span></div>
      <div class="small faint">${timeAgo(page.updatedAt)}</div>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn btn-sm btn-ghost" data-open-review="${esc(page.id)}">打开</button>
        ${item.reviewStatus !== 'approved' ? `<button class="btn btn-sm btn-clay" data-approve-review="${esc(page.id)}">批准</button><button class="btn btn-sm" data-changes-review="${esc(page.id)}">退回</button>` : ''}
      </div>
    </div>
  </div>`;
}

export function mountReview() {
  document.getElementById('select-all-reviews')?.addEventListener('change', (event) => {
    document.querySelectorAll('[data-review-select]').forEach((input) => { input.checked = event.target.checked; });
  });
  const selected = () => [...document.querySelectorAll('[data-review-select]:checked')].map((input) => input.dataset.reviewSelect);
  const bulk = async (action) => {
    const ids = selected();
    if (!ids.length) return toast('请先选择页面', 'error');
    const note = action === 'request_changes' ? prompt('说明需要修改什么（必填）：') : '';
    if (action === 'request_changes' && !note?.trim()) return;
    try {
      const result = await api('/api/review/bulk', { method: 'POST', body: JSON.stringify({ ids, action, note: note?.trim() ?? '' }) });
      toast(`已处理 ${result.approved} 页${result.skipped ? `，跳过 ${result.skipped} 页` : ''}`, 'success');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } catch (error) { toast(error.message, 'error'); }
  };
  document.getElementById('bulk-approve')?.addEventListener('click', () => bulk('approve'));
  document.getElementById('bulk-return')?.addEventListener('click', () => bulk('request_changes'));
  document.querySelectorAll('[data-review-status]').forEach((button) => {
    button.addEventListener('click', () => {
      const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
      const key = button.dataset.reviewStatus;
      if (key === 'all') params.delete('status');
      else params.set('status', key);
      go(`#/review${params.toString() ? `?${params.toString()}` : ''}`);
    });
  });
  document.getElementById('review-library')?.addEventListener('change', (event) => {
    const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
    if (event.currentTarget.value) params.set('library', event.currentTarget.value);
    else params.delete('library');
    go(`#/review${params.toString() ? `?${params.toString()}` : ''}`);
  });
  document.querySelectorAll('[data-open-review]').forEach((button) => {
    button.addEventListener('click', () => go(`#/page/${encodeURIComponent(button.dataset.openReview)}`));
  });
  const review = async (pageId, action, note = '') => {
    try {
      await api(`/api/pages/${encodeURIComponent(pageId)}/review`, { method: 'POST', body: { action, note } });
      toast(action === 'approve' ? '已批准' : '已退回修改', 'success');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } catch (error) {
      toast(error.message, 'error');
    }
  };
  document.querySelectorAll('[data-approve-review]').forEach((button) => {
    button.addEventListener('click', () => review(button.dataset.approveReview, 'approve'));
  });
  document.querySelectorAll('[data-changes-review]').forEach((button) => {
    button.addEventListener('click', () => {
      const note = prompt('说明需要修改什么（必填）：');
      if (note?.trim()) review(button.dataset.changesReview, 'request_changes', note.trim());
    });
  });
}
