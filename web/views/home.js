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
  emptyState,
} from '../assets/core.js';

export async function renderHome() {
  const b = state.bootstrap ?? (await loadBootstrap());
  const libraries = state.libraries;
  const stats = state.stats ?? {};
  const sortedLibraries = [...libraries].sort((a, b) => String(a.ownerTeamName || '未绑定部门').localeCompare(String(b.ownerTeamName || '未绑定部门'), 'zh-CN') || String(a.name).localeCompare(String(b.name), 'zh-CN'));

  const renderLibrary = (library) => {
    const coverColor = libraryColor(library.color);
    const visibility = library.visibility === 'private' ? '私有' : library.visibility === 'public' ? '公开' : '组织内';
    const department = library.ownerTeamName || '未绑定部门';
    return `<a class="lib-card kb-card" href="#/library/${encodeURIComponent(library.slug)}">
      <div class="lib-card-head">
        <span class="lib-avatar" style="background:${coverColor}">${esc(library.name.slice(0, 1))}</span>
        <span class="lib-card-title"><b>${esc(library.name)}</b><span>${esc(library.description || '暂无描述')}</span></span>
        <span class="lib-chevron">${icon('chevron', 14)}</span>
      </div>
      <div class="lib-card-badges"><span class="badge outline">${esc(department)}</span><span class="badge ${library.visibility === 'private' ? 'ochre' : 'outline'}">${visibility}</span>${roleBadge(library.role)}</div>
      <div class="lib-card-stats">
        <span><b>${fmtNumber(library.counts?.sources)}</b><i>文档</i></span>
        <span><b>${fmtNumber(library.counts?.pages)}</b><i>知识页</i></span>
        <span><b>${fmtNumber(library.counts?.links ?? 0)}</b><i>关联</i></span>
      </div>
      <div class="kb-card-foot"><span>${(library.nodes ?? []).length} 个目录 · ${fmtNumber(library.counts?.links)} 条关联</span><span>进入知识库 ${icon('arrow', 12)}</span></div>
    </a>`;
  };

  return `
    <section class="page-head">
      <div><div class="eyebrow">KNOWLEDGE BASES · DOCUMENTS · PROVENANCE</div><h1>知识库</h1><p>按部门进入知识库。每个知识库同时管理原始文档、编译出的知识页与来源链路。</p></div>
      <div class="page-actions"><a class="btn" href="#/search">${icon('search', 14)} 全局检索</a><button class="btn btn-primary" id="new-library-btn">${icon('plus', 14)} 新建知识库</button></div>
    </section>

    <section class="kb-summary">
      <div><b>${fmtNumber(libraries.length)}</b><span>知识库</span></div>
      <div><b>${fmtNumber(stats.sources)}</b><span>文档</span></div>
      <div><b>${fmtNumber(stats.pages)}</b><span>知识页</span></div>
      <div><b>${fmtNumber(stats.links ?? 0)}</b><span>关联</span></div>
      <div><b>${fmtNumber(stats.conflicts ?? 0)}</b><span>矛盾</span></div>
    </section>

    <div class="lib-grid">${sortedLibraries.map(renderLibrary).join('') || emptyState('还没有知识库', '先创建一个部门知识库，再导入文档。', '<button class="btn btn-primary" id="new-library-empty">新建知识库</button>')}</div>`;
}

export function mountHome() {
  const open = () => openCreateLibrary();
  document.getElementById('new-library-btn')?.addEventListener('click', open);
  document.getElementById('new-library-empty')?.addEventListener('click', open);
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
