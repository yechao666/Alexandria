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
  openModal,
  closeModal,
} from '../assets/core.js';

const FILTERS = [
  { key: 'all', label: '全部待校对' },
  { key: 'unreviewed', label: '待首次校对' },
  { key: 'changes_requested', label: '已退回' },
];

export async function renderReview(params) {
  const libraryRef = params.get('library') ?? '';
  const status = params.get('status') ?? 'all';
  const conflictsOnly = params.get('conflicts') === '1';
  const confidenceMax = params.get('confidenceMax') ?? '';
  const mine = params.get('assignee') === 'me';
  const library = state.libraries.find((item) => item.slug === libraryRef || item.id === libraryRef);
  const query = new URLSearchParams();
  if (library) query.set('library', library.id);
  if (status !== 'all') query.set('status', status);
  if (conflictsOnly) query.set('conflicts', '1');
  if (confidenceMax) query.set('confidenceMax', confidenceMax);
  if (mine) query.set('assignee', 'me');
  const data = await api(`/api/review${query.toString() ? `?${query.toString()}` : ''}`);
  const items = data.items ?? [];
  const summary = data.summary ?? {};
  const filtered = status === 'all' ? items : items.filter((item) => item.reviewStatus === status);

  const cards = filtered
    .map((item) => reviewCard(item))
    .join('');

  return `
    <div class="eyebrow">CURATION · REVIEW · CONFLICT RESOLUTION</div>
    <h1 style="font-size:28px;letter-spacing:-.02em;margin:6px 0 4px">知识校对</h1>
    <p class="muted" style="max-width:760px;margin-bottom:20px">自动编译出的概念页默认是草稿；在成为高置信知识之前，需要人工确认定义、来源与矛盾。批准会将页面标记为已校对，并要求后续变更重新进入队列。</p>
    <div class="stat-strip" style="margin:0 0 22px">
      <div class="stat-cell"><div class="label">待校对</div><div class="value">${summary.unreviewed ?? 0}</div><div class="sub">尚未人工确认</div></div>
      <div class="stat-cell"><div class="label">已退回</div><div class="value">${summary.changesRequested ?? 0}</div><div class="sub">需要补充或修改</div></div>
      <div class="stat-cell"><div class="label">矛盾主张</div><div class="value">${summary.conflicts ?? 0}</div><div class="sub">等待裁决</div></div>
      <div class="stat-cell"><div class="label">队列总量</div><div class="value">${summary.pending ?? 0}</div><div class="sub">草稿 ${summary.drafts ?? 0} 页</div></div>
    </div>
    <div class="list-toolbar">
      <div class="row wrap"><label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="select-all-reviews"> 全选</label><button class="btn btn-sm btn-primary" id="bulk-approve">批量批准</button><button class="btn btn-sm" id="bulk-return">批量退回</button><button class="btn btn-sm btn-clay" id="conflict-center">冲突中心</button>${FILTERS.map((filter) => `<button class="btn btn-sm ${status === filter.key ? 'btn-primary' : ''}" data-review-status="${filter.key}">${filter.label}</button>`).join('')}</div>
      <select class="select" id="review-confidence" style="width:auto"><option value="">全部置信度</option><option value="0.55" ${confidenceMax === '0.55' ? 'selected' : ''}>≤ 55%</option><option value="0.7" ${confidenceMax === '0.7' ? 'selected' : ''}>≤ 70%</option></select><label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="review-conflicts" ${conflictsOnly ? 'checked' : ''}> 仅看矛盾</label><label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="review-mine" ${mine ? 'checked' : ''}> 我的指派</label><select class="select" id="review-library" style="margin-left:auto;width:auto"><option value="">全部知识库</option>${state.libraries.map((item) => `<option value="${esc(item.slug)}" ${library && item.id === library.id ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</select>
    </div>
    <div class="review-list">${cards || emptyState('队列已清空', '没有等待校对的知识页。新的编译结果会自动进入这里。', '<a class="btn btn-sm" href="#/">回到总览</a>')}</div>`;
}

function reviewCard(item) {
  const page = item.page;
  return `<div class="review-card" data-assigned="${item.assigneeName ? '1' : '0'}">
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
      ${item.assigneeName ? `<div class="badge outline">校对：${esc(item.assigneeName)}</div>` : ''}
      <div class="small faint">${timeAgo(page.updatedAt)}</div>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn btn-sm btn-ghost" data-open-review="${esc(page.id)}">打开</button>${item.conflicts ? `<button class="btn btn-sm btn-clay" data-conflicts-review="${esc(page.id)}">冲突 ${item.conflicts}</button>` : ''}<button class="btn btn-sm btn-ghost" data-assign-review="${esc(page.id)}">${item.assigneeName ? '取消指派' : '分配给我'}</button>
        ${item.reviewStatus !== 'approved' ? `<button class="btn btn-sm btn-clay" data-approve-review="${esc(page.id)}">批准</button><button class="btn btn-sm" data-changes-review="${esc(page.id)}">退回</button>` : ''}
      </div>
    </div>
  </div>`;
}

export function mountReview() {
  document.getElementById('conflict-center')?.addEventListener('click', async () => {
    const openConflicts = async () => {
      try {
        const data = await api('/api/review/conflicts');
        const rows = (data.conflicts ?? []).map((conflict) => `<div class="review-note" style="margin-bottom:10px"><div class="between"><span><input type="checkbox" data-conflict-select="${esc(conflict.claimId)}" aria-label="选择冲突"> <a href="#/page/${encodeURIComponent(conflict.pageId)}"><b>${esc(conflict.pageTitle)}</b></a></span><span class="badge clay">${esc(conflict.predicate)}</span></div><div style="margin-top:5px">${esc(conflict.text)}</div><div class="small faint" style="margin-top:4px">${esc(conflict.libraryName)} · ${esc(conflict.subject)} · ${esc(conflict.severity ?? 'medium')}${conflict.effectiveDate ? ` · 生效 ${esc(conflict.effectiveDate)}` : ''}</div><div class="btn-row" style="margin-top:8px"><button class="btn btn-sm" data-claim-resolution="keep" data-claim-id="${esc(conflict.claimId)}">采用此说法</button><button class="btn btn-sm btn-ghost" data-claim-resolution="dismiss" data-claim-id="${esc(conflict.claimId)}">驳回</button></div></div>`).join('');
        openModal({
          title: '冲突中心',
          wide: true,
          body: `<p class="small muted">所有当前可见知识库中的矛盾主张；裁决会解除同主语/谓语下的冲突状态。</p><div class="row wrap" style="margin-top:10px"><label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="select-all-conflicts"> 全选</label><button class="btn btn-sm btn-clay" id="bulk-conflict-keep">批量采用</button><button class="btn btn-sm" id="bulk-conflict-dismiss">批量驳回</button></div><div style="max-height:480px;overflow:auto;margin-top:10px">${rows || '<div class="rail-empty">没有待裁决矛盾</div>'}</div>`,
          footer: `<button class="btn" data-close-modal>关闭</button>`,
          onMount: (modal) => {
            modal.querySelector('#select-all-conflicts')?.addEventListener('change', (event) => { modal.querySelectorAll('[data-conflict-select]').forEach((input) => { input.checked = event.target.checked; }); });
            const bulkConflicts = async (resolution) => {
              const ids = [...modal.querySelectorAll('[data-conflict-select]:checked')].map((input) => input.dataset.conflictSelect);
              if (!ids.length) return toast('请先选择冲突', 'error');
              try {
                const result = await api('/api/review/conflicts/bulk', { method: 'POST', body: JSON.stringify({ ids, resolution }) });
                toast(`已裁决 ${result.resolved} 条${result.skipped ? `，跳过 ${result.skipped} 条` : ''}`, 'success');
                closeModal();
                openConflicts();
              } catch (error) { toast(error.message, 'error'); }
            };
            modal.querySelector('#bulk-conflict-keep')?.addEventListener('click', () => bulkConflicts('keep'));
            modal.querySelector('#bulk-conflict-dismiss')?.addEventListener('click', () => bulkConflicts('dismiss'));
            modal.querySelectorAll('[data-claim-resolution]').forEach((button) => button.addEventListener('click', async () => {
              try {
                await api(`/api/claims/${encodeURIComponent(button.dataset.claimId)}/resolve`, { method: 'POST', body: { resolution: button.dataset.claimResolution } });
                toast(button.dataset.claimResolution === 'keep' ? '已采用' : '已驳回', 'success');
                closeModal();
                openConflicts();
              } catch (error) { toast(error.message, 'error'); }
            }));
          },
        });
      } catch (error) { toast(error.message, 'error'); }
    };
    openConflicts();
  });

  document.querySelectorAll('[data-conflicts-review]').forEach((button) => button.addEventListener('click', async () => {
    try {
      const detail = await api(`/api/pages/${encodeURIComponent(button.dataset.conflictsReview)}`);
      const conflicts = (detail.claims ?? []).filter((claim) => claim.status === 'conflicted');
      const rows = conflicts.map((claim) => `<div class="review-note" style="margin-bottom:10px"><div>${esc(claim.text)}</div><div class="small faint" style="margin-top:4px">${esc(claim.subject)} · ${esc(claim.predicate)} · ${Math.round(Number(claim.confidence) * 100)}%</div><div class="btn-row" style="margin-top:8px"><button class="btn btn-sm" data-claim-resolution="keep" data-claim-id="${esc(claim.id)}">采用此说法</button><button class="btn btn-sm btn-ghost" data-claim-resolution="dismiss" data-claim-id="${esc(claim.id)}">驳回</button></div></div>`).join('');
      openModal({
        title: `冲突裁决 · ${detail.page.title}`,
        wide: true,
        body: `<p class="small muted">矛盾不会自动覆盖；请逐条采纳或驳回，裁决后再回到校对台批准页面。</p><div style="margin-top:12px">${rows || '<div class="rail-empty">当前没有矛盾主张</div>'}</div>`,
        footer: `<button class="btn" data-close-modal>关闭</button>`,
        onMount: (modal) => {
          modal.querySelectorAll('[data-claim-resolution]').forEach((action) => action.addEventListener('click', async () => {
            try {
              await api(`/api/claims/${encodeURIComponent(action.dataset.claimId)}/resolve`, { method: 'POST', body: { resolution: action.dataset.claimResolution } });
              toast(action.dataset.claimResolution === 'keep' ? '已采用' : '已驳回', 'success');
              closeModal();
              window.dispatchEvent(new HashChangeEvent('hashchange'));
            } catch (error) { toast(error.message, 'error'); }
          }));
        },
      });
    } catch (error) { toast(error.message, 'error'); }
  }));
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
  const updateFilter = (key, value) => {
    const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
    if (value === '' || value === false) params.delete(key); else params.set(key, String(value));
    go(`#/review${params.toString() ? `?${params.toString()}` : ''}`);
  };
  document.getElementById('review-confidence')?.addEventListener('change', (event) => updateFilter('confidenceMax', event.currentTarget.value));
  document.getElementById('review-conflicts')?.addEventListener('change', (event) => updateFilter('conflicts', event.currentTarget.checked ? '1' : ''));
  document.getElementById('review-mine')?.addEventListener('change', (event) => updateFilter('assignee', event.currentTarget.checked ? 'me' : ''));
  document.querySelectorAll('[data-assign-review]').forEach((button) => button.addEventListener('click', async () => {
    try {
      const card = button.closest('.review-card');
      const already = card?.dataset.assigned === '1';
      await api(`/api/pages/${encodeURIComponent(button.dataset.assignReview)}/review-assignee`, { method: 'PATCH', body: { personId: already ? null : state.me?.person?.id } });
      toast(already ? '已取消指派' : '已分配给你', 'success');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } catch (error) { toast(error.message, 'error'); }
  }));
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
