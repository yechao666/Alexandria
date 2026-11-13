import {
  api,
  state,
  icon,
  escapeHtml as esc,
  fmtNumber,
  timeAgo,
  libraryColor,
  roleBadge,
  openModal,
  closeModal,
  toast,
  loadBootstrap,
  go,
  textField,
  selectField,
  textArea,
  formValues,
} from '../assets/core.js';

export async function renderHome() {
  const b = state.bootstrap ?? (await loadBootstrap());
  const libraries = state.libraries;
  const stats = state.stats ?? {};
  const classes = aggregateClasses(b.classes ?? []);
  const maxClass = Math.max(1, ...classes.map((item) => item.count));
  const featured = libraries[0];

  const libraryRows = libraries
    .map((library) => {
      const coverColor = libraryColor(library.color);
      const visibility = library.visibility === 'private' ? '私有' : library.visibility === 'public' ? '公开' : '组织内';
      return `<tr>
        <td><a class="library-row" href="#/library/${encodeURIComponent(library.slug)}">
          <span class="library-avatar" style="background:${coverColor}">${esc(library.name.slice(0, 1))}</span>
          <span style="min-width:0"><span class="name">${esc(library.name)}</span><span class="desc">${esc(library.description || '暂无描述')}</span></span>
        </a></td>
        <td><span class="badge ${library.visibility === 'private' ? 'ochre' : 'outline'}">${visibility}</span></td>
        <td>${roleBadge(library.role)}</td>
        <td class="num-cell"><b>${fmtNumber(library.counts?.pages)}</b></td>
        <td class="num-cell">${fmtNumber(library.counts?.sources)}</td>
        <td class="num-cell">${fmtNumber(library.counts?.links)}</td>
        <td><a class="icon-btn" href="#/library/${encodeURIComponent(library.slug)}" title="打开知识库" aria-label="打开知识库">${icon('arrow', 14)}</a></td>
      </tr>`;
    })
    .join('');

  const recentRows = (b.recentPages ?? [])
    .slice(0, 6)
    .map(
      (page) => `<tr><td><a class="library-row" href="#/page/${encodeURIComponent(page.id)}"><span class="activity-icon">${icon('file', 14)}</span><span style="min-width:0"><span class="name">${esc(page.title)}</span><span class="desc">${esc(page.libraryName)}</span></span></a></td><td><span class="badge outline">${esc(page.classKey ?? 'page')}</span></td><td class="faint small">${timeAgo(page.updatedAt)}</td></tr>`,
    )
    .join('');

  const teamTree = renderTeamTree(b.teams ?? []);
  const pending = Number(stats.reviewPending ?? 0);
  const conflicts = Number(stats.conflicts ?? 0);
  const composition = classes
    .slice(0, 7)
    .map(
      (item) => `<div class="type-bar"><span>${esc(item.name)}</span><span class="track"><i class="fill" style="width:${Math.round((item.count / Math.max(1, ...classes.map((entry) => entry.count))) * 100)}%;background:${libraryColor(item.color)}"></i></span><span>${item.count}</span></div>`,
    )
    .join('');

  return `
    <section class="page-head">
      <div>
        <div class="eyebrow">KNOWLEDGE OPERATIONS · ENTERPRISE</div>
        <h1>知识库总览</h1>
        <p>统一管理组织知识资产、资料处理、权限与校对队列；所有内容按团队和可见性范围受控。</p>
      </div>
      <div class="page-actions">
        <a class="btn" href="#/search">${icon('search', 14)} 检索</a>
        <button class="btn" id="new-library-btn">${icon('plus', 14)} 新建知识库</button>
        <a class="btn btn-primary" href="#/upload">${icon('upload', 14)} 导入资料</a>
      </div>
    </section>

    <section class="kpi-grid">
      <div class="kpi-card"><span class="kpi-icon">${icon('layers', 17)}</span><div><div class="label">知识资产</div><div class="value">${fmtNumber(stats.pages)}</div><div class="hint">原子化知识页</div></div></div>
      <div class="kpi-card"><span class="kpi-icon green">${icon('file', 17)}</span><div><div class="label">原始资料</div><div class="value">${fmtNumber(stats.sources)}</div><div class="hint">可回溯的文献与附件</div></div></div>
      <div class="kpi-card"><span class="kpi-icon amber">${icon('check', 17)}</span><div><div class="label">待校对</div><div class="value">${fmtNumber(pending)}</div><div class="hint">${conflicts} 条矛盾待裁决</div></div></div>
      <div class="kpi-card"><span class="kpi-icon ${conflicts ? 'red' : 'green'}">${icon('users', 17)}</span><div><div class="label">组织成员</div><div class="value">${fmtNumber(stats.members)}</div><div class="hint">${fmtNumber(stats.libraries ?? libraries.length)} 个知识库</div></div></div>
    </section>

    <div class="dashboard-grid">
      <div class="dashboard-main">
        <div class="panel">
          <div class="panel-head"><div><h3>知识库</h3><div class="small faint">按团队授权，库内再按目录、页面与文献细化</div></div><span class="badge jade">${libraries.length} 个可见</span></div>
          <div style="overflow:auto">
            <table class="data-table">
              <thead><tr><th>知识库</th><th>可见性</th><th>我的角色</th><th>知识页</th><th>文献</th><th>关联</th><th></th></tr></thead>
              <tbody>${libraryRows || '<tr><td colspan="7" class="muted" style="padding:18px">暂无可见知识库</td></tr>'}</tbody>
            </table>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head"><div><h3>最近更新</h3><div class="small faint">编译、校对或编辑后的知识页</div></div><a class="link small" href="#/search">查看全部 ${icon('arrow', 12)}</a></div>
          <div style="overflow:auto">
            <table class="data-table">
              <thead><tr><th>页面</th><th>类型</th><th>更新时间</th></tr></thead>
              <tbody>${recentRows || '<tr><td colspan="3" class="muted" style="padding:18px">还没有知识页，先导入一份资料。</td></tr>'}</tbody>
            </table>
          </div>
        </div>
      </div>

      <aside class="dashboard-side">
        <div class="panel">
          <div class="panel-head"><h3>待办事项</h3><span class="badge ochre">${pending + conflicts}</span></div>
          <div class="panel-body">
            <div class="todo-list">
              <a class="todo-item" href="#/review"><span class="todo-icon">${icon('check', 14)}</span><span class="todo-text"><b>待校对知识页</b><span>草稿需人工确认</span></span><span class="todo-count">${pending}</span></a>
              <a class="todo-item" href="#/review?conflicts=1"><span class="todo-icon">${icon('shield', 14)}</span><span class="todo-text"><b>矛盾主张</b><span>需裁决后发布</span></span><span class="todo-count">${conflicts}</span></a>
              <a class="todo-item" href="#/tasks"><span class="todo-icon">${icon('clock', 14)}</span><span class="todo-text"><b>处理任务</b><span>查看队列与失败项</span></span><span class="todo-count">›</span></a>
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head"><h3>知识构成</h3><span class="small faint">按本体类型</span></div>
          <div class="panel-body type-bars">${composition || '<div class="rail-empty">暂无数据</div>'}</div>
        </div>

        <div class="panel">
          <div class="panel-head"><h3>组织架构</h3><a class="link small" href="#/admin">管理 ${icon('arrow', 12)}</a></div>
          <div class="panel-body org-tree">${teamTree}</div>
        </div>
      </aside>
    </div>`;

  // bind after insertion by app: return markup only; events handled in mountHome
}

export function mountHome() {
  const open = () => openCreateLibrary();
  document.getElementById('new-library-btn')?.addEventListener('click', open);
  document.getElementById('new-library-card')?.addEventListener('click', open);
}

function aggregateClasses(classes) {
  const map = new Map();
  for (const item of classes) {
    if (!item?.key) continue;
    const current = map.get(item.key) ?? { key: item.key, name: item.name, color: item.color, count: 0 };
    current.count += Number(item.count ?? 0);
    map.set(item.key, current);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

function renderTeamTree(teams) {
  if (!teams?.length) return '<div class="rail-empty">暂无团队</div>';
  const render = (team, depth = 0) => `
    <div class="org-node" style="${depth > 0 ? 'margin-left:10px' : ''}">
      <div class="between"><span class="team-name">${esc(team.name)}</span><span class="faint small">${team.members?.length ?? 0} 人</span></div>
      <div class="members">${(team.members ?? [])
        .slice(0, 6)
        .map((member) => `<span class="avatar sm ${member.avatarColor}" title="${esc(member.name)}">${esc(member.name.slice(-1))}</span>`)
        .join('')}</div>
      ${(team.children ?? []).map((child) => render(child, depth + 1)).join('')}
    </div>`;
  return teams.map((team) => render(team)).join('');
}

function openCreateLibrary() {
  const teamOptions = flattenTeams(state.teams).map((team) => ({ value: team.id, label: `${'— '.repeat(team.depth)}${team.name}` }));
  openModal({
    title: '新建知识库',
    body: `<form id="library-form" class="form-grid">
      ${textField({ label: '名称', name: 'name', placeholder: '例如：客户成功手册' })}
      ${selectField({ label: '归属团队', name: 'ownerTeamId', options: [{ value: '', label: '不绑定团队' }, ...teamOptions] })}
      ${textArea({ label: '简介', name: 'description', placeholder: '这个知识库收纳什么、为谁服务', rows: 3 })}
      ${selectField({ label: '可见性', name: 'visibility', options: [
        { value: 'internal', label: '组织内可见' },
        { value: 'private', label: '私有（仅授权成员）' },
        { value: 'public', label: '公开（所有登录成员）' },
      ] })}
      ${selectField({ label: '主色', name: 'color', options: [
        { value: 'jade', label: '玉' }, { value: 'clay', label: '陶' }, { value: 'ochre', label: '赭' },
        { value: 'plum', label: '梅' }, { value: 'indigo', label: '靛' }, { value: 'teal', label: '青' },
      ] })}
    </form>`,
    footer: `<button class="btn" data-close-modal>取消</button><button class="btn btn-primary" id="create-library-submit">创建知识库</button>`,
    onMount: (modal) => {
      modal.querySelector('#create-library-submit').addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          const form = modal.querySelector('#library-form');
          const values = formValues(form);
          if (!values.ownerTeamId) delete values.ownerTeamId;
          const data = await api('/api/libraries', { method: 'POST', body: values });
          toast('知识库已创建', 'success');
          closeModal();
          await loadBootstrap();
          go(`#/library/${encodeURIComponent(data.library.slug)}`);
        } catch (error) {
          toast(error.message, 'error');
          button.disabled = false;
        }
      });
    },
  });
}

function flattenTeams(teams, depth = 0, out = []) {
  for (const team of teams ?? []) {
    out.push({ id: team.id, name: team.name, depth });
    flattenTeams(team.children ?? [], depth + 1, out);
  }
  return out;
}
