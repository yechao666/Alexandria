import {
  api,
  state,
  icon,
  escapeHtml as esc,
  timeAgo,
  roleBadge,
  classBadge,
  statusBadge,
  confidence,
  reviewBadge,
  toast,
  go,
  libraryColor,
  fmtDate,
  emptyState,
} from '../assets/core.js';
import { renderMarkdown, headingList } from '../assets/markdown.js';
import { mountGraph } from '../assets/graph.js';
import { openPageEditor, openSource } from './library.js';

const RELATION_LABELS = {
  references: '引用',
  'derived-from': '源自',
  'depends-on': '依赖',
  'related-to': '相关',
  mentions: '提及',
  contradicts: '矛盾',
  supersedes: '取代',
};

function relationLabel(relation) {
  return RELATION_LABELS[relation] ?? relation;
}

export async function renderPage(ref) {
  const detail = await api(`/api/pages/${encodeURIComponent(ref)}`);
  const page = detail.page;
  const libraryDetail = await api(`/api/libraries/${encodeURIComponent(page.libraryId)}`).catch(() => null);
  const body = renderMarkdown(page.body, { libraryId: page.libraryId });
  const headings = headingList(page.body).filter((heading) => heading.level >= 2 && heading.level <= 3);
  const sources = (detail.sources ?? [])
    .map(
      (source) => `<div class="rail-item" data-source="${esc(source.id)}" style="cursor:pointer"><span class="dot" style="background:var(--ochre)"></span><span>${esc(source.title)}<br><span class="faint">${esc(relationLabel(source.relation))}${source.locator ? ` · ${esc(source.locator)}` : ''}</span></span></div>`,
    )
    .join('');
  const claims = (detail.claims ?? [])
    .map(
      (claim) => `<div class="claim ${claim.status === 'conflicted' ? 'conflicted' : ''}">${esc(claim.text)}<div class="claim-meta"><span>${esc(claim.predicate)}</span><span>${Math.round(Number(claim.confidence) * 100)}%</span>${claim.status === 'conflicted' ? '<span class="badge clay">待裁决</span>' : ''}</div>${claim.status === 'conflicted' && detail.canEdit ? `<div class="btn-row" style="margin-top:6px"><button class="btn btn-sm" data-claim-resolution="keep" data-claim-id="${esc(claim.id)}">采用此说法</button><button class="btn btn-sm btn-ghost" data-claim-resolution="dismiss" data-claim-id="${esc(claim.id)}">驳回</button></div>` : ''}</div>`,
    )
    .join('');
  const outbound = (detail.links?.outbound ?? [])
    .map((item) => `<a class="rail-item" href="#/page/${encodeURIComponent(item.id)}"><span class="dot" style="background:var(--jade)"></span><span>${esc(item.title)} <span class="faint">${esc(relationLabel(item.relation))}</span></span></a>`)
    .join('');
  const inbound = (detail.links?.inbound ?? [])
    .map((item) => `<a class="rail-item" href="#/page/${encodeURIComponent(item.id)}"><span class="dot" style="background:var(--indigo)"></span><span>${esc(item.title)} <span class="faint">${esc(relationLabel(item.relation))}</span></span></a>`)
    .join('');
  const toc = headings.map((heading) => `<a class="lvl-${heading.level}" href="#h-${esc(heading.title.replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 40))}">${esc(heading.title)}</a>`).join('');
  const tagChips = (page.tags ?? []).map((tag) => `<span class="tag">${esc(tag)}</span>`).join('');
  const readWhen = (page.readWhen ?? []).map((item) => `<div class="rail-item"><span class="dot" style="background:var(--ochre)"></span><span>${esc(item)}</span></div>`).join('');
  const sourcesAttached = detail.sources ?? [];

  return {
    html: `
      <div class="article-layout">
        <article>
          <div class="small muted" style="margin-bottom:14px"><a href="#/library/${encodeURIComponent(page.libraryId)}">${esc(detail.library.name)}</a><span> / </span><span>${esc(page.className)}</span></div>
          <header class="article-head">
            <div class="row wrap">${classBadge(page)}${statusBadge(page.status)}${reviewBadge(page.reviewStatus)}${page.tags?.slice(0, 3).map((tag) => `<span class="tag">${esc(tag)}</span>`).join('') ?? ''}</div>
            <h1>${esc(page.title)}</h1>
            <div class="summary">${esc(page.summary)}</div>
            <div class="article-meta">
              <span>${icon('clock', 13)} 更新于 ${timeAgo(page.updatedAt)}</span>
              <span>${icon('layers', 13)} 版本 v${page.version}</span>
              <span>${confidence(page.confidence)} 置信度 ${Math.round(Number(page.confidence) * 100)}%</span>
              ${page.creatorName ? `<span>创建者 ${esc(page.creatorName)}</span>` : ''}
              <span class="mono">${esc(page.slug)}</span>
            </div>
            ${detail.canEdit ? `<div class="btn-row" style="margin-top:16px"><button class="btn btn-sm" id="edit-page">${icon('edit', 14)} 编辑</button>${page.reviewStatus === 'approved' ? `<button class="btn btn-sm btn-ghost" id="review-reopen">${icon('refresh', 14)} 撤回校对</button>` : `<button class="btn btn-sm btn-clay" id="review-approve">${icon('check', 14)} 批准此页</button><button class="btn btn-sm" id="review-changes">${icon('edit', 14)} 要求修改</button>`}<button class="btn btn-sm btn-ghost btn-danger" id="delete-page">${icon('trash', 14)} 删除</button></div>` : ''}
          </header>
          <div class="article-body" id="article-body">${body || '<p class="muted">暂无正文。</p>'}</div>
        </article>
        <aside class="rail">
          <div class="rail-card"><div class="title">校对状态 <span>${reviewBadge(page.reviewStatus)}</span></div><div class="small muted">${page.reviewedAt ? `最近审核：${timeAgo(page.reviewedAt)}${page.reviewerName ? ` · ${esc(page.reviewerName)}` : ''}` : '尚未经过人工校对'}</div>${page.reviewNote ? `<div class="review-note">${esc(page.reviewNote)}</div>` : ''}</div>
          ${toc ? `<div class="rail-card"><div class="title">本页目录</div><div class="toc">${toc}</div></div>` : ''}
          <div class="rail-card"><div class="title">来源 <span>${sourcesAttached.length}</span></div><div class="rail-list">${sources || '<div class="rail-empty">该页尚未关联文献</div>'}</div></div>
          <div class="rail-card"><div class="title">结构化主张 <span>${detail.claims?.length ?? 0}</span></div><div>${claims || '<div class="rail-empty">暂无主张</div>'}</div></div>
          <div class="rail-card"><div class="title">关联 <span>${(detail.links?.outbound?.length ?? 0) + (detail.links?.inbound?.length ?? 0)}</span></div><div class="rail-list">${outbound}${inbound}${!outbound && !inbound ? '<div class="rail-empty">尚未建立关联</div>' : ''}</div></div>
          ${readWhen ? `<div class="rail-card"><div class="title">何时读这一页</div><div class="rail-list">${readWhen}</div></div>` : ''}
          <div class="rail-card"><div class="title">邻域图谱</div><canvas class="mini-graph" id="page-graph"></canvas></div>
        </aside>
      </div>`,
    page,
    detail,
    libraryDetail,
    sourcesAttached,
  };
}

export async function mountPage(ref) {
  const detail = await api(`/api/pages/${encodeURIComponent(ref)}`);
  const page = detail.page;
  const libraryDetail = await api(`/api/libraries/${encodeURIComponent(page.libraryId)}`).catch(() => null);

  document.querySelectorAll('[data-source]').forEach((node) => {
    node.addEventListener('click', () => openSource(node.dataset.source));
  });
  document.getElementById('edit-page')?.addEventListener('click', () => {
    openPageEditor({ id: page.libraryId, name: detail.library.name, slug: detail.library.slug }, libraryDetail, page);
  });
  document.getElementById('delete-page')?.addEventListener('click', async () => {
    if (!confirm(`确认删除《${page.title}》？历史版本也会保留在审计中，但页面会从知识库移除。`)) return;
    try {
      await api(`/api/pages/${encodeURIComponent(page.id)}`, { method: 'DELETE' });
      toast('页面已删除', 'success');
      go(`#/library/${encodeURIComponent(detail.library.slug)}`);
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  const review = async (action, note = '') => {
    try {
      await api(`/api/pages/${encodeURIComponent(page.id)}/review`, { method: 'POST', body: { action, note } });
      toast(action === 'approve' ? '已批准' : action === 'request_changes' ? '已退回修改' : '已撤回校对', 'success');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } catch (error) {
      toast(error.message, 'error');
    }
  };
  document.getElementById('review-approve')?.addEventListener('click', () => review('approve'));
  document.getElementById('review-changes')?.addEventListener('click', () => {
    const note = prompt('说明需要修改什么（必填）：');
    if (note?.trim()) review('request_changes', note.trim());
  });
  document.getElementById('review-reopen')?.addEventListener('click', () => review('reopen'));
  document.querySelectorAll('[data-claim-resolution]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await api(`/api/claims/${encodeURIComponent(button.dataset.claimId)}/resolve`, {
          method: 'POST',
          body: { resolution: button.dataset.claimResolution },
        });
        toast(button.dataset.claimResolution === 'keep' ? '已采用该说法' : '已驳回该说法', 'success');
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  });
  document.getElementById('page-graph');
  try {
    const neighbors = await api(`/api/pages/${encodeURIComponent(page.id)}/neighbors`);
    const nodes = [
      { id: page.id, title: page.title, classKey: page.classKey, className: page.className, color: page.classColor, degree: 4, status: page.status },
      ...neighbors.neighbors.map((item) => ({ id: item.id, title: item.title, classKey: item.classKey, className: item.className, color: 'jade', degree: 1, status: 'active' })),
    ];
    const edges = neighbors.neighbors.map((item) => ({ source: item.direction === 'out' ? page.id : item.id, target: item.direction === 'out' ? item.id : page.id, relation: item.relation }));
    const canvas = document.getElementById('page-graph');
    if (canvas) mountGraph(canvas, { nodes, edges }, { onSelect: (node) => go(`#/page/${encodeURIComponent(node.id)}`) });
  } catch {
    /* 忽略图谱失败 */
  }
}
