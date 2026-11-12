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

  const libraryCards = libraries
    .map((library) => {
      const coverColor = libraryColor(library.color);
      return `<a class="library-card" href="#/library/${encodeURIComponent(library.slug)}" style="--lib-color:${coverColor}">
        <span class="library-spine"></span>
        <span class="library-cover">
          <span class="top"><span class="badge ${library.visibility === 'private' ? 'clay' : 'outline'}">${library.visibility === 'private' ? '私有馆藏' : library.visibility === 'public' ? '公开' : '组织内'}</span>${roleBadge(library.role)}</span>
          <span class="name">${esc(library.name)}</span>
          <span class="desc">${esc(library.description)}</span>
          <span class="library-shelf">${(library.nodes ?? []).slice(0, 3).map((node) => `<span class="shelf-chip">${esc(node.name)}</span>`).join('')}</span>
          <span class="foot"><span><b>${fmtNumber(library.counts?.pages)}</b> 知识页</span><span><b>${fmtNumber(library.counts?.sources)}</b> 文献</span><span><b>${fmtNumber(library.counts?.links)}</b> 关联</span><span class="arrow">${icon('arrow', 15)}</span></span>
        </span>
      </a>`;
    })
    .join('');

  const recent = (b.recentPages ?? [])
    .slice(0, 6)
    .map(
      (page) => `<a class="activity-row" href="#/page/${encodeURIComponent(page.id)}">
        <span class="activity-icon">${icon(page.classKey === 'source' ? 'file' : 'file', 15)}</span>
        <span class="text"><b>${esc(page.title)}</b><br><span class="muted">${esc(page.libraryName)} · ${esc(page.summary ?? '').slice(0, 70)}</span></span>
        <span class="time">${timeAgo(page.updatedAt)}</span>
      </a>`,
    )
    .join('');

  const teamTree = renderTeamTree(b.teams ?? []);

  return `
    <section class="hero">
      <div>
        <div class="eyebrow">LLM WIKI · ONTOLOGY · TEAM KNOWLEDGE</div>
        <h1><span class="line">把资料，</span><span class="line"><em>编译</em>成知识。</span></h1>
        <p class="lede">不是把文件切块、等提问时再猜。Alexandria 在入库时阅读、拆页、抽取主张、建立本体关联；检索时沿着已经写好的知识路径走。</p>
        <div class="hero-actions">
          ${featured ? `<a class="btn btn-primary" href="#/library/${encodeURIComponent(featured.slug)}">进入${esc(featured.name)} ${icon('arrow', 15)}</a>` : ''}
          <a class="btn" href="#/upload">${icon('upload', 15)} 上传资料</a>
          <a class="btn btn-ghost" href="#/search">${icon('search', 15)} 试试检索</a>
        </div>
        <div class="hero-foot">
          <span><b>${fmtNumber(stats.pages)}</b>知识页</span>
          <span><b>${fmtNumber(stats.sources)}</b>馆藏文献</span>
          <span><b>${fmtNumber(stats.links)}</b>类型化关联</span>
          <span><b>${fmtNumber(stats.members)}</b>组织成员</span>
        </div>
      </div>
      <div class="panel pipeline-card">
        <div class="between" style="margin-bottom:8px"><h3 style="font-size:16px">一条资料的旅程</h3><span class="badge jade">入库时编译</span></div>
        <div class="pipeline-step"><span class="num">01</span><span class="body"><span class="name">解析与识别</span><span class="desc">PDF / Word / PPT / Excel / TeX / RTF / WPS / 图片 OCR，统一成文本、章节与资产。</span></span></div>
        <div class="pipeline-step"><span class="num">02</span><span class="body"><span class="name">概念与主张抽取</span><span class="desc">识别概念、定义、关系与数字事实，生成带来源锚点的 claim。</span></span></div>
        <div class="pipeline-step"><span class="num">03</span><span class="body"><span class="name">合并与矛盾标记</span><span class="desc">更新已有原子知识页，保留双方说法，把冲突留给人类裁决。</span></span></div>
        <div class="pipeline-step"><span class="num">04</span><span class="body"><span class="name">本体化与索引</span><span class="desc">按类型归档，写入词法索引与类型化图谱，供检索与智能体导航。</span></span></div>
        <div class="pipeline-foot"><span>${fmtNumber(stats.claims)} 条结构化主张</span><span>${fmtNumber(stats.conflicts)} 处待裁决矛盾</span></div>
      </div>
    </section>

    <section class="stat-strip">
      <div class="stat-cell"><div class="label">知识页</div><div class="value">${fmtNumber(stats.pages)}</div><div class="sub">原子化、可引用</div></div>
      <div class="stat-cell"><div class="label">馆藏文献</div><div class="value">${fmtNumber(stats.sources)}</div><div class="sub">原始文件可回溯</div></div>
      <div class="stat-cell"><div class="label">知识关联</div><div class="value">${fmtNumber(stats.links)}</div><div class="sub">wikilink + 类型化边</div></div>
      <div class="stat-cell"><div class="label">知识库</div><div class="value">${fmtNumber(stats.libraries ?? libraries.length)}</div><div class="sub">${fmtNumber(stats.members)} 位成员可见</div></div>
    </section>

    <div class="section-head">
      <div><h2>馆藏</h2><div class="sub">按团队与领域划分的知识库；权限在库、团队、个人三层授予。</div></div>
      <button class="btn btn-sm" id="new-library-btn">${icon('plus', 14)} 新建知识库</button>
    </div>
    <div class="library-grid">
      ${libraryCards || ''}
      <button class="library-add" id="new-library-card">${icon('plus', 22)}<div style="margin-top:8px">建立一个新的知识库</div><div class="small muted">绑定团队、设定可见性，再选择本体</div></button>
    </div>

    <div class="home-lower">
      <div class="panel">
        <div class="panel-head"><h3>最近编译</h3><a class="link small" href="#/search">查看全部 ${icon('arrow', 13)}</a></div>
        <div class="panel-body activity-list">${recent || '<div class="rail-empty">还没有知识页，先上传一份资料。</div>'}</div>
      </div>
      <div class="panel">
        <div class="panel-head"><h3>知识构成</h3><span class="small muted">按本体类型</span></div>
        <div class="panel-body type-bars">
          ${classes
            .slice(0, 8)
            .map(
              (item) => `<div class="type-bar"><span>${esc(item.name)}</span><span class="track"><i class="fill" style="width:${Math.round((item.count / maxClass) * 100)}%;background:${libraryColor(item.color)}"></i></span><span>${item.count}</span></div>`,
            )
            .join('') || '<div class="rail-empty">暂无数据</div>'}
        </div>
        <div class="panel-head" style="border-top:1px solid var(--line)"><h3>组织架构</h3><a class="link small" href="#/admin">管理 ${icon('arrow', 13)}</a></div>
        <div class="panel-body org-tree">${teamTree}</div>
      </div>
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
