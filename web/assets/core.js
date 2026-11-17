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
  const existingShell = document.querySelector('.app-shell');
  const navActive = {
    documents: ['documents', 'home', 'source'].includes(active),
    knowledge: active === 'knowledge' || active === 'page' || active === 'graph',
    libraries: active === 'libraries' || String(active).startsWith('library:'),
    search: active === 'search',
    admin: active === 'admin',
  };
  if (!existingShell) {
  document.getElementById('app').innerHTML = `
    <div class="app-shell">
      <header class="app-header">
        <a class="app-brand" href="#/">
          <span class="brand-mark">A</span>
          <span class="brand-copy"><b>ALEXANDRIA</b><small>企业文档知识库</small></span>
        </a>
        <nav class="app-nav" aria-label="主导航">
          <a class="app-nav-link ${['documents', 'home', 'source'].includes(active) ? 'active' : ''}" href="#/" data-nav="documents">${icon('folder', 15)}<span>文档</span></a>
          <a class="app-nav-link ${active === 'knowledge' || active === 'page' || active === 'graph' ? 'active' : ''}" href="#/knowledge" data-nav="knowledge">${icon('graph', 15)}<span>知识</span></a>
          <a class="app-nav-link ${active === 'libraries' || String(active).startsWith('library:') ? 'active' : ''}" href="#/libraries" data-nav="libraries">${icon('layers', 15)}<span>资料库</span></a>
          <a class="app-nav-link ${active === 'search' ? 'active' : ''}" href="#/search" data-nav="search">${icon('search', 15)}<span>搜索</span></a>
          ${state.me?.person?.isAdmin ? `<a class="app-nav-link ${active === 'admin' ? 'active' : ''}" href="#/admin" data-nav="admin">${icon('settings', 15)}<span>管理</span></a>` : ''}
        </nav>
        <form class="topbar-search" id="top-search">
          ${icon('search', 16)}
          <input name="q" placeholder="搜索文档、知识、人员…" autocomplete="off" aria-label="搜索">
          <kbd>⌘K</kbd>
        </form>
        <div class="app-actions">
          <a class="icon-btn notif-btn" href="#/notifications" title="通知" aria-label="通知">${icon('bell', 17)}${Number(state.bootstrap?.stats?.notificationsUnread ?? 0) > 0 ? `<span class="notif-dot">${state.bootstrap.stats.notificationsUnread}</span>` : ''}</a>
          <a class="btn btn-primary" href="#/upload">${icon('upload', 14)} 导入</a>
          <button class="icon-btn" id="security-btn" title="安全设置" aria-label="安全设置">${icon('lock', 16)}</button>
          <button class="icon-btn" id="logout-btn" title="退出登录" aria-label="退出登录">${icon('logout', 16)}</button>
          ${avatar(state.me?.person)}
        </div>
      </header>
      <div class="app-subbar"><div class="breadcrumb">${crumbs}</div><div class="subbar-meta">企业知识空间 · 组织级权限</div></div>
      <main class="content" id="content">${content ?? ''}</main>
    </div>`;
  }
  const root = document.querySelector('.app-shell');
  if (root && existingShell) {
    const contentEl = root.querySelector('#content');
    if (contentEl) contentEl.innerHTML = content ?? '';
    const crumbEl = root.querySelector('.breadcrumb');
    if (crumbEl) crumbEl.innerHTML = crumbs;
  }
  if (root) {
    root.querySelectorAll('[data-nav]').forEach((link) => link.classList.toggle('active', Boolean(navActive[link.dataset.nav])));
    const count = root.querySelector('#nav-review-count');
    if (count) {
      const pending = Number(state.bootstrap?.stats?.reviewPending ?? 0);
      count.textContent = pending > 0 ? String(pending) : '';
      count.style.display = pending > 0 ? '' : 'none';
    }
  }
  if (!existingShell) {
  document.getElementById('security-btn')?.addEventListener('click', async () => {
    const openSecurity = async () => {
      try {
        const [status, sessionData] = await Promise.all([api('/api/auth/2fa'), api('/api/auth/sessions').catch(() => ({ sessions: [] }))]);
        const sessions = (sessionData.sessions ?? []).map((session) => `<div class="between" style="padding:7px 0;border-bottom:1px solid var(--line)"><span class="small">${session.current ? '<span class="badge jade">当前</span> ' : ''}${escapeHtml(session.ip ?? '未知 IP')}<br><span class="faint" style="font-size:10px">${escapeHtml(session.userAgent ?? '')}</span></span><button class="btn btn-sm btn-ghost" data-revoke-session="${escapeHtml(session.id)}">撤销</button></div>`).join('');
        const twoFactor = status.enabled
          ? `<div class="between"><span>两步验证</span><span class="badge jade">已启用</span></div><div class="field" style="margin-top:12px"><label>输入当前验证码以停用</label><input class="input" id="disable-2fa-code" inputmode="numeric" placeholder="6 位验证码"></div><button class="btn btn-sm" id="disable-2fa">停用两步验证</button>`
          : `<div class="between"><span>两步验证</span><span class="badge outline">未启用</span></div><p class="small muted" style="margin-top:8px">启用后登录需要认证器动态码。</p><button class="btn btn-sm btn-primary" id="setup-2fa">${icon('key', 14)} 启用两步验证</button>`;
        openModal({
          title: '安全设置',
          body: `<div class="panel" style="box-shadow:none"><div class="panel-head"><h3>账户安全</h3></div><div class="panel-body">${twoFactor}</div></div><div class="panel" style="box-shadow:none;margin-top:12px"><div class="panel-head"><h3>修改密码</h3></div><div class="panel-body"><div class="field"><label>当前密码</label><input class="input" id="current-password" type="password"></div><div class="field" style="margin-top:8px"><label>新密码（至少 10 位，含大小写、数字与符号）</label><input class="input" id="new-password" type="password"></div><button class="btn btn-sm" id="change-password" style="margin-top:10px">更新密码</button></div></div><div class="panel" style="box-shadow:none;margin-top:12px"><div class="panel-head"><h3>登录会话</h3><button class="btn btn-sm" id="revoke-other-sessions">撤销其他会话</button></div><div class="panel-body">${sessions || '<div class="rail-empty">暂无会话</div>'}</div></div>`,
          footer: `<button class="btn" data-close-modal>关闭</button>`,
          onMount: (modal) => {
            modal.querySelector('#setup-2fa')?.addEventListener('click', async () => {
              try {
                const setup = await api('/api/auth/2fa/setup', { method: 'POST' });
                closeModal();
                openModal({
                  title: '启用两步验证',
                  body: `<p class="small muted">把下面的密钥加入认证器（Google Authenticator / 1Password 等），然后输入 6 位验证码。</p><div class="mono" style="font-size:13px;background:var(--paper-2);padding:10px;border-radius:8px;word-break:break-all;margin:12px 0">${escapeHtml(setup.secret)}</div><div class="small faint" style="word-break:break-all">${escapeHtml(setup.otpauth)}</div><div class="field" style="margin-top:12px"><label>验证码</label><input class="input" id="enable-2fa-code" inputmode="numeric" placeholder="6 位验证码"></div>`,
                  footer: `<button class="btn" data-close-modal>取消</button><button class="btn btn-primary" id="enable-2fa">确认启用</button>`,
                  onMount: (inner) => {
                    inner.querySelector('#enable-2fa')?.addEventListener('click', async () => {
                      try {
                        const enabled = await api('/api/auth/2fa/enable', { method: 'POST', body: JSON.stringify({ code: inner.querySelector('#enable-2fa-code')?.value ?? '' }) });
                        closeModal();
                        openModal({
                          title: '两步验证已启用',
                          body: `<p class="small muted">请立即保存以下恢复码，每个只能使用一次：</p><div class="mono" style="font-size:12px;background:var(--paper-2);padding:12px;border-radius:8px;line-height:1.9;margin-top:10px">${(enabled.recoveryCodes ?? []).map((code) => escapeHtml(code)).join('<br>')}</div>`,
                          footer: `<button class="btn btn-primary" data-close-modal>我已保存</button>`,
                        });
                        return;
                      } catch (error) { toast(error.message, 'error'); }
                    });
                  },
                });
              } catch (error) { toast(error.message, 'error'); }
            });
            modal.querySelector('#disable-2fa')?.addEventListener('click', async () => {
              try {
                await api('/api/auth/2fa/disable', { method: 'POST', body: JSON.stringify({ code: modal.querySelector('#disable-2fa-code')?.value ?? '' }) });
                toast('两步验证已停用', 'success');
                closeModal();
                openSecurity();
              } catch (error) { toast(error.message, 'error'); }
            });
            modal.querySelectorAll('[data-revoke-session]').forEach((button) => button.addEventListener('click', async () => {
              try { await api(`/api/auth/sessions/${encodeURIComponent(button.dataset.revokeSession)}`, { method: 'DELETE' }); toast('会话已撤销', 'success'); closeModal(); openSecurity(); } catch (error) { toast(error.message, 'error'); }
            }));
            modal.querySelector('#revoke-other-sessions')?.addEventListener('click', async () => {
              try { const result = await api('/api/auth/sessions/revoke-others', { method: 'POST' }); toast(`已撤销 ${result.revoked ?? 0} 个会话`, 'success'); closeModal(); openSecurity(); } catch (error) { toast(error.message, 'error'); }
            });
            modal.querySelector('#change-password')?.addEventListener('click', async () => {
              try {
                await api('/api/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword: modal.querySelector('#current-password')?.value ?? '', newPassword: modal.querySelector('#new-password')?.value ?? '' }) });
                toast('密码已更新', 'success');
                modal.querySelector('#current-password').value = '';
                modal.querySelector('#new-password').value = '';
              } catch (error) { toast(error.message, 'error'); }
            });
          },
        });
      } catch (error) { toast(error.message, 'error'); }
    };
    openSecurity();
  });

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
