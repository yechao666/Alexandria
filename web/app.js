import {
  api,
  state,
  loadBootstrap,
  renderShell,
  setContent,
  icon,
  escapeHtml as esc,
  toast,
  go,
  parseHash,
} from './assets/core.js';
import { renderHome, mountHome } from './views/home.js';
import { renderLibrary, mountLibrary } from './views/library.js';
import { renderPage, mountPage } from './views/page.js';
import { renderSearch, mountSearch } from './views/search.js';
import { renderUpload, mountUpload } from './views/upload.js';
import { renderGraph, mountGraphView } from './views/graph.js';
import { renderAdmin, mountAdmin } from './views/admin.js';
import { renderAgent, mountAgent } from './views/agent.js';
import { renderReview, mountReview } from './views/review.js';
import { renderNotifications, mountNotifications } from './views/notifications.js';
import { renderTasks, mountTasks } from './views/tasks.js';

const app = document.getElementById('app');
let routeSeq = 0;

const DEMO_USERS = [
  { email: 'lin@alex.dev', name: '林知远', role: '组织管理员' },
  { email: 'shen@alex.dev', name: '沈书言', role: '知识策展人' },
  { email: 'su@alex.dev', name: '苏禾', role: '产品经理' },
  { email: 'zhou@alex.dev', name: '周砚', role: '平台工程师' },
  { email: 'guest@alex.dev', name: '访客', role: '只读成员' },
];

function loading(label = '正在整理知识…') {
  return `<div class="loading"><div class="spinner"></div><div class="small muted">${esc(label)}</div></div>`;
}

function errorView(error) {
  return `<div class="empty" style="margin-top:60px"><div class="big">页面走丢了</div><div>${esc(error?.message ?? '未知错误')}</div><div style="margin-top:16px"><a class="btn" href="#/">回到总览</a></div></div>`;
}

async function boot() {
  try {
    const me = await api('/api/me');
    state.me = me;
    await loadBootstrap();
    if (!location.hash || location.hash === '#/login') location.hash = '#/';
    route();
  } catch {
    showLogin();
  }
}

function showLogin() {
  state.me = null;
  const { query } = parseHash();
  const errorCode = query.get('error') ?? '';
  const errorMessages = {
    wecom_unavailable: '企业微信登录未启用或尚未配置。',
    wecom_state: '企业微信登录状态已过期，请重新发起。',
    wecom_denied: '你取消了企业微信授权。',
    wecom_api: '企业微信接口不可用。本地联调请先启动 wecom-mock。',
    wecom_unmapped: '该企业微信账号尚未绑定本地成员，请联系管理员完成绑定。',
  };
  const loginError = errorMessages[errorCode] ?? '';
  app.innerHTML = `
    <div class="login-shell">
      <aside class="login-aside">
        <div class="brand" style="padding:0">
          <span class="brand-mark">A</span>
          <span class="brand-text"><span class="brand-name">ALEXANDRIA</span><span class="brand-sub">亚历山大知识库</span></span>
        </div>
        <div>
          <div class="eyebrow" style="margin-bottom:18px">KNOWLEDGE, COMPILED</div>
          <div class="login-quote">知识不是被检索的片段，<br>而是被<em>编译</em>的馆藏。</div>
          <p class="caption">在资料入库时阅读、拆页、抽取主张、维护本体关联；查询时沿着已经写好的路径导航。为团队与智能体共同维护的知识而设计。</p>
          <div class="login-meta"><span>分库与目录</span><span>本体类型</span><span>团队权限</span><span>文档 + OCR</span><span>DSH 智能体</span></div>
        </div>
        <div class="small faint">Alexandria · 0.1 · 本地优先，零外部服务依赖</div>
      </aside>
      <main class="login-main">
        <div class="login-card">
          <div class="eyebrow">SIGN IN</div>
          <h2 style="margin-top:8px">回到你的图书馆</h2>
          <p class="muted small">使用组织账号登录。演示环境密码统一为 <span class="mono">alex-demo</span>。</p>
          <form class="login-form" id="login-form">
            <div class="field"><label>邮箱</label><input class="input" name="email" type="email" value="lin@alex.dev" autocomplete="username" required></div>
            <div class="field"><label>密码</label><input class="input" name="password" type="password" value="alex-demo" autocomplete="current-password" required></div>
            <div class="login-error" id="login-error">${esc(loginError)}</div>
            <button class="btn btn-primary" type="submit" style="justify-content:center;padding:11px">${icon('arrow', 15)} 登录</button>
          </form>
          <div id="wecom-login-slot" style="margin-top:18px"></div>
          <div class="demo-users">
            <div class="title">演示账号</div>
            ${DEMO_USERS.map(
              (user) => `<div class="demo-row" data-email="${user.email}"><span class="avatar sm ${user.email.startsWith('lin') ? 'clay' : user.email.startsWith('shen') ? 'jade' : user.email.startsWith('su') ? 'ochre' : user.email.startsWith('zhou') ? 'indigo' : 'slate'}">${user.name.slice(-1)}</span><span>${user.name}</span><span class="faint" style="font-size:10px">${user.role}</span><span class="email">${user.email}</span></div>`,
            ).join('')}
          </div>
        </div>
      </main>
    </div>`;
  const form = document.getElementById('login-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form).entries());
    const errorNode = document.getElementById('login-error');
    errorNode.textContent = '';
    try {
      await api('/api/auth/login', { method: 'POST', body: values });
      await loadBootstrap();
      toast('欢迎回来，' + state.me.person.name, 'success');
      go('#/');
      route();
    } catch (error) {
      errorNode.textContent = error.message;
    }
  });
  fetch('/api/auth/providers')
    .then((response) => response.json())
    .then((providers) => {
      const slot = document.getElementById('wecom-login-slot');
      if (!slot || !providers?.wecom?.enabled) return;
      slot.innerHTML = `<div class="login-divider"><span>或</span></div><a class="btn" href="/api/auth/wecom/start?returnTo=%2F%23%2F" style="width:100%;justify-content:center;padding:10px">${icon('key', 15)} ${esc(providers.wecom.label)}</a><div class="small faint" style="margin-top:8px;text-align:center">Mock 身份将映射到已绑定的本地账号</div>`;
    })
    .catch(() => {});
  document.querySelectorAll('.demo-row').forEach((row) => {
    row.addEventListener('click', () => {
      form.email.value = row.dataset.email;
      form.password.value = 'alex-demo';
    });
  });
}

async function route() {
  const seq = ++routeSeq;
  const { path, query } = parseHash();
  if (!state.me) {
    showLogin();
    return;
  }
  document.body.classList.remove('nav-open');
  const parts = path.split('/').filter(Boolean);
  try {
    if (parts[0] === 'resolve' && parts.length >= 3) {
      const libraryId = decodeURIComponent(parts[1]);
      const ref = decodeURIComponent(parts.slice(2).join('/'));
      const result = await api(`/api/resolve?library=${encodeURIComponent(libraryId)}&ref=${encodeURIComponent(ref)}`);
      if (seq !== routeSeq) return;
      location.replace(`#/page/${encodeURIComponent(result.page.id)}`);
      return;
    }
    if (parts[0] === 'page') {
      setContent(loading());
      renderShell({ content: loading(), breadcrumb: [{ label: '总览', href: '#/' }, { label: '知识页' }], active: 'page' });
      const pageRef = decodeURIComponent(parts.slice(1).join('/'));
      const result = await renderPage(pageRef);
      if (seq !== routeSeq) return;
      renderShell({
        content: result.html,
        breadcrumb: [{ label: result.detail.library.name, href: `#/library/${encodeURIComponent(result.page.libraryId)}` }, { label: result.page.title }],
        active: `library:${result.page.libraryId}`,
      });
      document.title = `${result.page.title} · Alexandria`;
      await mountPage(pageRef);
      return;
    }
    if (parts[0] === 'library') {
      const ref = decodeURIComponent(parts[1]);
      setContent(loading());
      renderShell({ content: loading(), breadcrumb: [{ label: '总览', href: '#/' }, { label: '知识库' }], active: `library:${ref}` });
      const tab = query.get('tab') ?? 'catalog';
      const html = await renderLibrary(ref, tab);
      if (seq !== routeSeq) return;
      const library = state.currentLibrary?.library;
      renderShell({
        content: html,
        breadcrumb: [{ label: '总览', href: '#/' }, { label: library?.name ?? '知识库' }],
        active: `library:${library?.id ?? ref}`,
      });
      document.title = `${library?.name ?? '知识库'} · Alexandria`;
      await mountLibrary(ref, tab);
      return;
    }
    if (parts[0] === 'search') {
      setContent(loading('正在检索已编译的知识…'));
      renderShell({ content: loading('正在检索已编译的知识…'), breadcrumb: [{ label: '总览', href: '#/' }, { label: '全局检索' }], active: 'search' });
      const html = await renderSearch(query);
      if (seq !== routeSeq) return;
      renderShell({ content: html, breadcrumb: [{ label: '总览', href: '#/' }, { label: '全局检索' }], active: 'search' });
      document.title = `${query.get('q') ?? '检索'} · Alexandria`;
      mountSearch();
      return;
    }
    if (parts[0] === 'upload') {
      const html = await renderUpload(parts[1] ? decodeURIComponent(parts[1]) : '');
      if (seq !== routeSeq) return;
      renderShell({ content: html, breadcrumb: [{ label: '总览', href: '#/' }, { label: '资料入库' }], active: 'upload' });
      document.title = '资料入库 · Alexandria';
      mountUpload(parts[1] ? decodeURIComponent(parts[1]) : '');
      return;
    }
    if (parts[0] === 'tasks') {
      setContent(loading('正在读取任务…'));
      const html = await renderTasks();
      if (seq !== routeSeq) return;
      renderShell({ content: html, breadcrumb: [{ label: '总览', href: '#/' }, { label: '任务中心' }], active: 'tasks' });
      document.title = '任务中心 · Alexandria';
      mountTasks();
      return;
    }
    if (parts[0] === 'graph') {
      setContent(loading('正在绘制知识图谱…'));
      const html = await renderGraph(parts[1] ? decodeURIComponent(parts[1]) : '');
      if (seq !== routeSeq) return;
      renderShell({ content: html, breadcrumb: [{ label: '总览', href: '#/' }, { label: '知识图谱' }], active: 'graph' });
      document.title = '知识图谱 · Alexandria';
      mountGraphView();
      return;
    }
    if (parts[0] === 'admin') {
      const tab = query.get('tab') ?? 'teams';
      setContent(loading());
      const html = await renderAdmin(tab);
      if (seq !== routeSeq) return;
      renderShell({ content: html, breadcrumb: [{ label: '总览', href: '#/' }, { label: '团队与权限' }], active: 'admin' });
      document.title = '团队与权限 · Alexandria';
      mountAdmin(tab);
      return;
    }
    if (parts[0] === 'review') {
      setContent(loading());
      const html = await renderReview(query);
      if (seq !== routeSeq) return;
      renderShell({ content: html, breadcrumb: [{ label: '总览', href: '#/' }, { label: '校对台' }], active: 'review' });
      document.title = '校对台 · Alexandria';
      mountReview();
      return;
    }
    if (parts[0] === 'notifications') {
      setContent(loading());
      const html = await renderNotifications();
      if (seq !== routeSeq) return;
      renderShell({ content: html, breadcrumb: [{ label: '总览', href: '#/' }, { label: '通知' }], active: 'notifications' });
      document.title = '通知 · Alexandria';
      mountNotifications();
      return;
    }
    if (parts[0] === 'agent') {
      setContent(loading());
      const html = await renderAgent();
      if (seq !== routeSeq) return;
      renderShell({ content: html, breadcrumb: [{ label: '总览', href: '#/' }, { label: '智能体接入' }], active: 'agent' });
      document.title = '智能体接入 · Alexandria';
      mountAgent();
      return;
    }
    // home
    setContent(loading());
    renderShell({ content: loading(), breadcrumb: [{ label: '总览' }], active: 'home' });
    const html = await renderHome();
    if (seq !== routeSeq) return;
    renderShell({ content: html, breadcrumb: [{ label: '总览' }], active: 'home' });
    document.title = 'Alexandria · 亚历山大知识库';
    mountHome();
  } catch (error) {
    console.error(error);
    if (error.status === 401) {
      showLogin();
      return;
    }
    renderShell({ content: errorView(error), breadcrumb: [{ label: '总览', href: '#/' }, { label: '出错了' }], active: '' });
  }
}

window.addEventListener('hashchange', () => {
  if (!state.me) return;
  route();
});

document.addEventListener('alex:unauthorized', () => {
  showLogin();
});

document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    document.querySelector('.topbar-search input')?.focus();
  }
});

boot();
