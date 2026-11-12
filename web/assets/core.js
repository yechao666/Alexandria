import { icon } from './icons.js';
import { escapeHtml, fmtNumber, timeAgo, fmtDate, fmtBytes, initials, roleLabel, classColor, parseHash } from './util.js';

export { icon, escapeHtml, fmtNumber, timeAgo, fmtDate, fmtBytes, initials, roleLabel, classColor, parseHash };

export const state = {
  me: null,
  bootstrap: null,
  libraries: [],
  people: [],
  teams: [],
  features: {},
  stats: {},
  currentLibrary: null,
  cache: new Map(),
  modal: null,
};

export function setContent(html) {
  const content = document.getElementById('content');
  if (content) content.innerHTML = html;
}

export async function api(path, options = {}) {
  const { method = 'GET', body, headers = {}, rawBody } = options;
  const init = { method, credentials: 'include', headers: { ...headers } };
  if (rawBody !== undefined) {
    init.body = rawBody;
  } else if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(path, init);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: { message: text || '响应解析失败' } };
  }
  if (!response.ok) {
    const error = new Error(data?.error?.message || `请求失败（${response.status}）`);
    error.status = response.status;
    error.code = data?.error?.code;
    error.details = data?.error?.details;
    if (response.status === 401) {
      state.me = null;
      document.dispatchEvent(new CustomEvent('alex:unauthorized'));
    }
    throw error;
  }
  return data;
}

export async function loadBootstrap() {
  const data = await api('/api/bootstrap');
  state.me = data.me;
  state.bootstrap = data;
  state.libraries = data.libraries ?? [];
  state.people = data.people ?? [];
  state.teams = data.teams ?? [];
  state.features = data.features ?? {};
  state.stats = data.stats ?? {};
  return data;
}

export function toast(message, kind = 'info') {
  let wrap = document.querySelector('.toast-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'toast-wrap';
    document.body.appendChild(wrap);
  }
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  wrap.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    node.style.transition = 'all .25s';
    setTimeout(() => node.remove(), 260);
  }, kind === 'error' ? 5200 : 3200);
}

export function openModal({ title, body, footer, wide = false, onMount }) {
  closeModal();
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h3>${escapeHtml(title)}</h3>
        <button class="icon-btn" data-close-modal aria-label="关闭">${icon('x', 18)}</button>
      </div>
      <div class="modal-body">${body}</div>
      ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
    </div>`;
  document.body.appendChild(backdrop);
  state.modal = backdrop;
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) closeModal();
    if (event.target.closest('[data-close-modal]')) closeModal();
  });
  const onKey = (event) => {
    if (event.key === 'Escape') {
      closeModal();
      document.removeEventListener('keydown', onKey);
    }
  };
  document.addEventListener('keydown', onKey);
  if (onMount) onMount(backdrop.querySelector('.modal'));
  return backdrop;
}

export function closeModal() {
  if (state.modal) {
    state.modal.remove();
    state.modal = null;
  }
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到剪贴板', 'success');
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
    toast('已复制到剪贴板', 'success');
  }
}

export function go(hash) {
  if (location.hash === hash) {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    location.hash = hash;
  }
}

export function roleBadge(role) {
  return `<span class="badge ${role === 'owner' ? 'clay' : role === 'editor' ? 'jade' : 'outline'}">${roleLabel(role)}</span>`;
}

export function classBadge(page) {
  return `<span class="badge ${page.classColor ?? 'jade'}">${escapeHtml(page.className ?? page.classKey)}</span>`;
}

export function reviewBadge(status) {
  const labels = { unreviewed: '待校对', changes_requested: '已退回', approved: '已校对' };
  const tone = status === 'approved' ? 'jade' : status === 'changes_requested' ? 'clay' : 'ochre';
  return `<span class="badge ${tone}">${labels[status] ?? status}</span>`;
}

export function statusBadge(status) {
  const labels = { active: '有效', draft: '草稿', stale: '陈旧', archived: '归档', ready: '已就绪', processing: '处理中', queued: '排队中', failed: '失败' };
  return `<span class="badge status-${status}">${labels[status] ?? status}</span>`;
}

export function confidence(value) {
  const pct = Math.round(Number(value ?? 0) * 100);
  return `<span class="confidence-bar" title="置信度 ${pct}%"><i style="width:${pct}%"></i></span>`;
}

export function avatar(person, size = '') {
  if (!person) return `<span class="avatar ${size}">?</span>`;
  return `<span class="avatar ${person.avatarColor ?? 'jade'} ${size}" title="${escapeHtml(person.name)}">${escapeHtml(initials(person.name))}</span>`;
}

export function emptyState(title, description, action = '') {
  return `<div class="empty"><div class="big">${escapeHtml(title)}</div><div>${escapeHtml(description)}</div>${action ? `<div style="margin-top:16px">${action}</div>` : ''}</div>`;
}

export function libraryColor(color) {
  const map = { jade: '#2f6a58', clay: '#9b3d2c', ochre: '#b8892f', plum: '#7b4f6b', indigo: '#4b5b8f', teal: '#2d7b7b', slate: '#6b6b6b' };
  return map[color] ?? '#2f6a58';
}

export function formatAnswer(text) {
  const lines = String(text ?? '').split('\n');
  const parts = [];
  let list = [];
  const flush = () => {
    if (list.length) {
      parts.push(`<ul>${list.map((item) => `<li>${inlineAnswer(item)}</li>`).join('')}</ul>`);
      list = [];
    }
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      continue;
    }
    if (/^[-•]\s+/.test(trimmed)) {
      list.push(trimmed.replace(/^[-•]\s+/, ''));
    } else {
      flush();
      parts.push(`<p>${inlineAnswer(trimmed)}</p>`);
    }
  }
  flush();
  return parts.join('');
}

function inlineAnswer(text) {
  return escapeHtml(text).replace(/\[(\d+)\]/g, '<span class="citation">[$1]</span>');
}

export function renderShell({ content, breadcrumb = [], active = '' }) {
  const libraries = state.libraries
    .map(
      (library) => `
      <a class="nav-link library-link ${active === `library:${library.id}` ? 'active' : ''}" href="#/library/${encodeURIComponent(library.slug)}">
        <span class="library-dot" style="background:${libraryColor(library.color)}"></span>
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(library.name)}</span>
        <span class="role">${state.me?.person?.isAdmin ? '管理' : roleLabel(library.role)}</span>
      </a>`,
    )
    .join('');
  const crumbs = breadcrumb
    .map((item, index) =>
      item.href
        ? `<a href="${item.href}">${escapeHtml(item.label)}</a>${index < breadcrumb.length - 1 ? '<span class="sep">/</span>' : ''}`
        : `<span class="current">${escapeHtml(item.label)}</span>`,
    )
    .join('');
  document.getElementById('app').innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <a class="brand" href="#/">
          <span class="brand-mark">A</span>
          <span class="brand-text"><span class="brand-name">ALEXANDRIA</span><span class="brand-sub">亚历山大知识库</span></span>
        </a>
        <div class="side-section">
          <a class="nav-link ${active === 'home' ? 'active' : ''}" href="#/">${icon('layers')}<span>总览</span></a>
          <a class="nav-link ${active === 'search' ? 'active' : ''}" href="#/search">${icon('search')}<span>全局检索</span></a>
          <a class="nav-link ${active === 'graph' ? 'active' : ''}" href="#/graph">${icon('graph')}<span>知识图谱</span></a>
          <a class="nav-link ${active === 'review' ? 'active' : ''}" href="#/review">${icon('check')}<span>校对台</span>${Number(state.bootstrap?.stats?.reviewPending ?? 0) > 0 ? `<span class="nav-count">${state.bootstrap.stats.reviewPending}</span>` : ''}</a>
          <a class="nav-link ${active === 'upload' ? 'active' : ''}" href="#/upload">${icon('upload')}<span>资料入库</span></a>
        </div>
        <div class="side-section">
          <div class="side-label">我的知识库</div>
          ${libraries || '<div class="side-label" style="padding-top:4px">暂无可见知识库</div>'}
        </div>
        <div class="side-section">
          <div class="side-label">工作台</div>
          <a class="nav-link ${active === 'admin' ? 'active' : ''}" href="#/admin">${icon('users')}<span>团队与权限</span></a>
          <a class="nav-link ${active === 'agent' ? 'active' : ''}" href="#/agent">${icon('spark')}<span>智能体接入</span></a>
        </div>
        <div class="side-spacer"></div>
        <div class="side-user">
          ${avatar(state.me?.person)}
          <div class="meta"><div class="name">${escapeHtml(state.me?.person?.name ?? '')}</div><div class="title">${escapeHtml(state.me?.person?.title ?? '')}</div></div>
          <button class="icon-btn" id="logout-btn" title="退出登录" aria-label="退出登录">${icon('logout', 16)}</button>
        </div>
      </aside>
      <div class="main">
        <header class="topbar">
          <button class="icon-btn mobile-toggle" id="nav-toggle" aria-label="菜单">${icon('menu')}</button>
          <div class="breadcrumb">${crumbs}</div>
          <form class="topbar-search" id="top-search">
            ${icon('search', 16)}
            <input name="q" placeholder="搜索知识、文献、概念…" autocomplete="off" aria-label="搜索">
            <kbd>⌘K</kbd>
          </form>
          <a class="icon-btn notif-btn hide-sm" href="#/notifications" title="通知" aria-label="通知">${icon('bell', 17)}${Number(state.bootstrap?.stats?.notificationsUnread ?? 0) > 0 ? `<span class="notif-dot">${state.bootstrap.stats.notificationsUnread}</span>` : ''}</a>
          <a class="btn btn-sm hide-sm" href="#/upload">${icon('upload', 14)} 上传</a>
        </header>
        <main class="content" id="content">${content ?? ''}</main>
      </div>
    </div>
    <div class="scrim" id="scrim"></div>`;

  document.getElementById('logout-btn')?.addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      /* ignore */
    }
    state.me = null;
    state.bootstrap = null;
    location.hash = '#/login';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  document.getElementById('nav-toggle')?.addEventListener('click', () => document.body.classList.toggle('nav-open'));
  document.getElementById('scrim')?.addEventListener('click', () => document.body.classList.remove('nav-open'));
  document.getElementById('top-search')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const q = new FormData(event.currentTarget).get('q')?.toString().trim() ?? '';
    if (q) go(`#/search?q=${encodeURIComponent(q)}`);
  });
  document.querySelectorAll('.sidebar .nav-link').forEach((link) => link.addEventListener('click', () => document.body.classList.remove('nav-open')));
}

export function textField({ label, name, value = '', placeholder = '', type = 'text', span = false }) {
  return `<div class="field ${span ? 'span-2' : ''}"><label for="f-${name}">${escapeHtml(label)}</label><input class="input" id="f-${name}" name="${name}" type="${type}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}"></div>`;
}

export function selectField({ label, name, options, value = '', span = false }) {
  const opts = options
    .map((option) => {
      const optionValue = typeof option === 'string' ? option : option.value;
      const optionLabel = typeof option === 'string' ? option : option.label;
      return `<option value="${escapeHtml(optionValue)}" ${String(optionValue) === String(value) ? 'selected' : ''}>${escapeHtml(optionLabel)}</option>`;
    })
    .join('');
  return `<div class="field ${span ? 'span-2' : ''}"><label for="f-${name}">${escapeHtml(label)}</label><select class="select" id="f-${name}" name="${name}">${opts}</select></div>`;
}

export function textArea({ label, name, value = '', placeholder = '', span = true, rows = 6 }) {
  return `<div class="field ${span ? 'span-2' : ''}"><label for="f-${name}">${escapeHtml(label)}</label><textarea class="textarea" id="f-${name}" name="${name}" rows="${rows}" placeholder="${escapeHtml(placeholder)}">${escapeHtml(value)}</textarea></div>`;
}

export function formValues(form) {
  return Object.fromEntries(new FormData(form).entries());
}
