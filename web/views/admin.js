import {
  api,
  state,
  icon,
  escapeHtml as esc,
  timeAgo,
  avatar,
  roleBadge,
  toast,
  openModal,
  closeModal,
  go,
  textField,
  selectField,
  formValues,
  loadBootstrap,
} from '../assets/core.js';

const TABS = [
  { key: 'teams', label: '团队与成员' },
  { key: 'people', label: '成员目录' },
  { key: 'wecom', label: '企业微信' },
  { key: 'keys', label: 'API 密钥' },
  { key: 'security', label: '安全审计' },
  { key: 'observability', label: '运行状态' },
  { key: 'access-matrix', label: '权限矩阵' },
  { key: 'review-analytics', label: '校对报表' },
];

export async function renderAdmin(tab = 'teams') {
  const isAdmin = Boolean(state.me?.person?.isAdmin);
  const [teamsData, peopleData, wecom, keysData, syncRunsData, securityData, observability, matrixData, analyticsData] = await Promise.all([
    api('/api/teams'),
    api('/api/people'),
    api('/api/integrations/wecom').catch(() => null),
    api('/api/api-keys').catch(() => ({ keys: [] })),
    api('/api/integrations/wecom/sync-runs').catch(() => ({ runs: [] })),
    api('/api/admin/security?limit=80').catch(() => ({ events: [], counts: [] })),
    api('/api/admin/observability').catch(() => null),
    api('/api/admin/access-matrix').catch(() => ({ libraries: [], persons: [] })),
    api('/api/review/analytics?days=30').catch(() => null),
  ]);
  const teams = teamsData.teams ?? [];
  const people = peopleData.people ?? [];
  const teamCards = flattenTeams(teams).map((team) => teamCard(team, isAdmin)).join('');
  const peopleRows = people
    .map(
      (person) => `<tr><td><div class="row">${avatar(person, 'sm')}<span>${esc(person.name)}</span></div></td><td class="mono" style="font-size:11px">${esc(person.email)}</td><td>${esc(person.title)}</td><td class="mono">${esc(person.wecomUserid ?? '—')}</td><td>${person.isAdmin ? '<span class="badge clay">管理员</span>' : '<span class="badge outline">成员</span>'}</td><td>${isAdmin ? `<button class="btn btn-sm btn-ghost" data-bind-wecom="${esc(person.id)}" data-person-name="${esc(person.name)}">绑定企微</button>` : ''}</td></tr>`,
    )
    .join('');
  const keyRows = (keysData.keys ?? [])
    .map(
      (key) => `<tr><td><b>${esc(key.name)}</b></td><td class="mono">${esc(key.prefix)}…</td><td><span class="badge ${key.scope === 'read' ? 'outline' : 'jade'}">${key.scope}</span></td><td class="faint">${key.last_used_at ? timeAgo(key.last_used_at) : '从未使用'}</td><td>${key.revoked_at ? '<span class="badge clay">已吊销</span>' : `<button class="btn btn-sm btn-ghost" data-revoke-key="${esc(key.id)}">吊销</button>`}</td></tr>`,
    )
    .join('');

  const syncRuns = syncRunsData.runs ?? [];
  const syncRunRows = syncRuns
    .slice(0, 5)
    .map((run) => `<tr><td>${timeAgo(run.created_at)}</td><td>${run.dry_run ? '预览' : '执行'}</td><td>${run.departments} / ${run.users}</td><td>${run.applied_departments} / ${run.applied_users} / ${run.deactivated}</td></tr>`)
    .join('');
  const matrixLibraries = matrixData.libraries ?? [];
  const matrixRows = (matrixData.persons ?? []).map((row) => `<tr><td><b>${esc(row.person.name)}</b><br><span class="faint small">${esc(row.person.email)}</span></td>${matrixLibraries.map((library) => `<td>${row.person.isAdmin ? '<span class="badge clay">admin</span>' : row.roles?.[library.id] ? `<span class="badge ${row.roles[library.id] === 'owner' ? 'clay' : row.roles[library.id] === 'editor' ? 'jade' : 'outline'}">${row.roles[library.id]}</span>` : '<span class="faint">—</span>'}</td>`).join('')}</tr>`).join('');
  const analytics = analyticsData;
  const securityEvents = securityData.events ?? [];
  const securityRows = securityEvents.map((event) => {
    const tone = event.severity === 'critical' ? 'clay' : event.severity === 'warning' ? 'ochre' : 'outline';
    return `<tr><td class="mono" style="font-size:10px">${esc(new Date(event.created_at).toLocaleString('zh-CN'))}</td><td><span class="badge ${tone}">${esc(event.severity)}</span></td><td><code>${esc(event.kind)}</code></td><td>${esc(event.actor_name ?? '—')}</td><td>${esc(event.subject ?? '—')}</td><td class="mono" style="font-size:10px">${esc(event.ip ?? '—')}</td></tr>`;
  }).join('');
  const wecomBody = wecom
    ? `<div class="grid grid-2">
        <div class="panel wecom-card">
          <div class="panel-head"><h3>企业微信接入</h3><span class="badge ${wecom.configured ? 'jade' : 'ochre'}">${wecom.configured ? '已配置' : '待配置'}</span><span class="badge ${wecom.mode === 'mock' ? 'outline' : 'plum'}">${wecom.mode === 'mock' ? 'Mock 模式' : '生产模式'}</span></div>
          <div class="panel-body">
            <p class="muted small">账号体系按“组织统一身份优先”设计：生产环境用企业微信 OAuth 登录，本地开发可接 wecom-mock。人员与团队通过 wecom_userid / wecom_dept_id 绑定。</p>
            <div class="kv" style="margin-top:12px">
              <dt>CorpID</dt><dd>${esc(wecom.corpId ?? '未配置')}</dd>
              <dt>AgentID</dt><dd>${esc(wecom.agentId ?? '未配置')}</dd>
              <dt>OAuth 回调</dt><dd class="mono" style="font-size:10px;word-break:break-all">${esc(wecom.callbackUrl ?? '—')}</dd>
              <dt>机器人回调</dt><dd class="mono" style="font-size:10px;word-break:break-all">${esc(wecom.imCallbackUrl ?? '—')}</dd>
              <dt>加密回调</dt><dd class="mono" style="font-size:10px;word-break:break-all">${esc(wecom.encryptedCallbackUrl ?? '—')}</dd>
              <dt>能力</dt><dd>${wecom.capabilities.map((item) => `<span class="badge outline">${esc(item)}</span>`).join(' ')}</dd>
            </div>
            ${isAdmin ? `<form id="wecom-form" class="form-grid" style="margin-top:14px">
              ${textField({ label: 'CorpID', name: 'corpId', value: wecom.corpId ?? '' })}
              ${textField({ label: 'AgentID', name: 'agentId', value: wecom.agentId ?? '' })}
              ${textField({ label: 'Secret', name: 'secret', type: 'password', span: true, placeholder: '仅写入 meta，不回显' })}
              ${textField({ label: 'API Base URL', name: 'baseUrl', value: wecom.baseUrl ?? '' })}
              ${textField({ label: 'Authorize Base URL', name: 'authorizeBase', value: wecom.authorizeBase ?? '' })}
              ${textField({ label: 'Public URL', name: 'publicUrl', value: wecom.publicUrl ?? '' })}
              ${selectField({ label: '模式', name: 'mode', value: wecom.mode ?? 'mock', options: [{ value: 'mock', label: 'Mock（本地联调）' }, { value: 'wecom', label: '生产（企业微信）' }] })}
              ${textField({ label: '回调 Token', name: 'callbackToken', type: 'password', placeholder: wecom.callbackTokenConfigured ? '已配置，留空不修改' : '仅写入 meta，不回显' })}
              ${textField({ label: 'EncodingAESKey', name: 'encodingAesKey', type: 'password', placeholder: wecom.aesKeyConfigured ? '已配置，留空不修改' : '43 位，仅写入 meta' })}
            </form>
            <div class="btn-row" style="margin-top:12px"><button class="btn btn-primary btn-sm" id="save-wecom">保存配置</button><button class="btn btn-sm" id="sync-wecom">生成同步计划</button></div>` : ''}
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><h3>组织映射</h3><span class="small muted">${wecom.teams.length} 个团队 · ${wecom.persons.length} 位成员</span></div>
          <div class="panel-body" style="padding:0;max-height:360px;overflow:auto"><table class="org-table"><thead><tr><th>团队 / 成员</th><th>企业微信 ID</th><th>状态</th></tr></thead><tbody>
            ${wecom.teams.map((team) => `<tr><td>${esc(team.name)}</td><td class="mono">${esc(team.wecom_dept_id ?? '—')}</td><td>${team.wecom_dept_id ? '<span class="badge jade">已映射</span>' : '<span class="badge ochre">待建</span>'}</td></tr>`).join('')}
            ${wecom.persons.slice(0, 20).map((person) => `<tr><td>${esc(person.name)}</td><td class="mono">${esc(person.wecom_userid ?? '—')}</td><td>${person.wecom_userid ? '<span class="badge jade">已绑定</span>' : '<span class="badge outline">未绑定</span>'}</td></tr>`).join('')}
          </tbody></table></div>
        </div>
      </div>
      <div class="panel" style="margin-top:14px">
        <div class="panel-head"><h3>同步历史</h3><span class="small muted">最近 5 次</span></div>
        <div class="panel-body" style="padding:0"><table class="org-table"><thead><tr><th>时间</th><th>类型</th><th>发现部门/成员</th><th>写入 / 停用</th></tr></thead><tbody>${syncRunRows || '<tr><td colspan="4" class="muted" style="padding:18px">还没有同步记录</td></tr>'}</tbody></table></div>
      </div>`
    : '<div class="empty">企业微信集成信息不可用</div>';

  const bodies = {
    teams: `<div class="between" style="margin-bottom:14px"><div><h2 style="font-size:24px">团队与组织架构</h2><div class="sub muted">知识库绑定团队后，团队负责人自动成为库所有者，成员获得编辑权限。</div></div>${isAdmin ? '<button class="btn btn-primary btn-sm" id="new-team">+ 新建团队</button>' : ''}</div><div class="callout small" style="margin-bottom:14px">组织层级策略：上级负责人可只读下级团队知识库；下级成员默认看不到上级团队内容，需显式共享。</div><div class="grid grid-2">${teamCards || '<div class="empty">暂无团队</div>'}</div>`,
    people: `<div class="between" style="margin-bottom:14px"><div><h2 style="font-size:24px">成员目录</h2><div class="sub muted">账号由管理员开通，认证源优先绑定企业微信 / OIDC。</div></div>${isAdmin ? '<button class="btn btn-primary btn-sm" id="new-person">+ 邀请成员</button>' : ''}</div>
      <div class="panel"><div class="panel-body" style="padding:0"><table class="org-table"><thead><tr><th>姓名</th><th>邮箱</th><th>职位</th><th>企微 ID</th><th>角色</th><th></th></tr></thead><tbody>${peopleRows}</tbody></table></div></div>`,
    wecom: `<div class="between" style="margin-bottom:14px"><div><h2 style="font-size:24px">企业微信</h2><div class="sub muted">OAuth 登录、部门/成员同步与机器人通知；本地默认连接 wecom-mock。</div></div><span class="badge ${wecom?.configured ? 'jade' : 'outline'}">${wecom?.mode === 'mock' ? 'Mock 联调' : '生产接入'}</span></div>${wecomBody}`,
    observability: `<div class="between" style="margin-bottom:14px"><div><h2 style="font-size:24px">运行状态</h2><div class="sub muted">进程、队列、存储、任务与安全事件；用于日常巡检与容量观察。</div></div><span class="row"><button class="btn btn-sm" id="integrity-check">数据体检</button><span class="badge ${observability ? 'jade' : 'clay'}">${observability ? '采集中' : '不可用'}</span></span></div>${observability ? `<div class="grid grid-3"><div class="panel panel-pad"><div class="small faint">任务队列</div><div style="font-size:28px;font-weight:650">${observability.queue.active} <span style="font-size:13px;color:var(--muted)">执行</span> / ${observability.queue.pending} <span style="font-size:13px;color:var(--muted)">排队</span></div><div class="small muted" style="margin-top:8px">任务：${(observability.jobs ?? []).map((item) => `${esc(item.key)} ${item.c}`).join(' · ') || '暂无'}</div></div><div class="panel panel-pad"><div class="small faint">内容规模</div><div style="font-size:28px;font-weight:650">${observability.counts.pages} <span style="font-size:13px;color:var(--muted)">知识页</span></div><div class="small muted" style="margin-top:8px">${observability.counts.sources} 文献 · ${observability.counts.claims} 主张 · ${observability.counts.links} 关联</div></div><div class="panel panel-pad"><div class="small faint">安全事件（24h）</div><div style="font-size:28px;font-weight:650">${(observability.security ?? []).reduce((sum, item) => sum + Number(item.c), 0)}</div><div class="small muted" style="margin-top:8px">${(observability.security ?? []).map((item) => `${esc(item.key)} ${item.c}`).join(' · ') || '无'}</div></div></div><div class="grid grid-2" style="margin-top:14px"><div class="panel"><div class="panel-head"><h3>存储与备份</h3></div><div class="panel-body"><div class="kv"><dt>SQLite</dt><dd>${Math.round((observability.storage.databaseBytes ?? 0) / 1024 / 1024 * 10) / 10} MB</dd><dt>WAL</dt><dd>${Math.round((observability.storage.walBytes ?? 0) / 1024 / 1024 * 10) / 10} MB</dd><dt>备份</dt><dd>${(observability.storage.backups ?? []).length} 份</dd></div></div></div><div class="panel"><div class="panel-head"><h3>进程</h3></div><div class="panel-body"><div class="kv"><dt>Node</dt><dd class="mono">${esc(observability.process.node)}</dd><dt>平台</dt><dd>${esc(observability.process.platform)}</dd><dt>运行</dt><dd>${Math.round(observability.process.uptimeSeconds / 60)} 分钟</dd><dt>内存</dt><dd>${Math.round((observability.process.memory.rss ?? 0) / 1024 / 1024)} MB RSS</dd></div></div></div></div>` : '<div class="empty">无法读取运行状态</div>'}`,
    'review-analytics': `<div class="between" style="margin-bottom:14px"><div><h2 style="font-size:24px">校对报表</h2><div class="sub muted">最近 30 天：待校对、批准、矛盾、置信度与负责人分布。</div></div><span class="badge jade">${analytics ? '已生成' : '暂无数据'}</span></div>${analytics ? `<div class="grid grid-4"><div class="panel panel-pad"><div class="small faint">总页面</div><div style="font-size:28px;font-weight:650">${analytics.total}</div></div><div class="panel panel-pad"><div class="small faint">待校对</div><div style="font-size:28px;font-weight:650;color:var(--ochre)">${analytics.pending}</div></div><div class="panel panel-pad"><div class="small faint">30 天批准</div><div style="font-size:28px;font-weight:650;color:var(--jade)">${analytics.approvedInPeriod}</div></div><div class="panel panel-pad"><div class="small faint">低置信度</div><div style="font-size:28px;font-weight:650;color:var(--clay)">${analytics.confidence.low}</div></div></div><div class="grid grid-2" style="margin-top:14px"><div class="panel"><div class="panel-head"><h3>按知识库</h3></div><div class="panel-body" style="padding:0"><table class="org-table"><thead><tr><th>知识库</th><th>待校对</th><th>批准</th><th>矛盾</th></tr></thead><tbody>${analytics.byLibrary.map((item) => `<tr><td>${esc(item.name)}</td><td>${item.pending}</td><td>${item.approved}</td><td>${item.conflicts}</td></tr>`).join('') || '<tr><td colspan="4" class="muted" style="padding:16px">暂无</td></tr>'}</tbody></table></div></div><div class="panel"><div class="panel-head"><h3>负责人</h3></div><div class="panel-body" style="padding:0"><table class="org-table"><thead><tr><th>成员</th><th>待校对页</th></tr></thead><tbody>${analytics.byAssignee.map((item) => `<tr><td>${esc(item.name)}</td><td>${item.count}</td></tr>`).join('') || '<tr><td colspan="2" class="muted" style="padding:16px">暂无指派</td></tr>'}</tbody></table></div></div></div>` : '<div class="empty">暂无校对报表</div>'}`,
    'access-matrix': `<div class="between" style="margin-bottom:14px"><div><h2 style="font-size:24px">权限矩阵</h2><div class="sub muted">按人/库展示 effectiveRole（含团队归属、组织层级与显式授权）；仅组织管理员可见。</div></div><span class="badge jade">${matrixRows ? '已计算' : '暂无数据'}</span></div><div class="panel"><div class="panel-body" style="padding:0;overflow:auto"><table class="org-table"><thead><tr><th>成员</th>${matrixLibraries.map((library) => `<th>${esc(library.name)}</th>`).join('')}</tr></thead><tbody>${matrixRows || '<tr><td colspan="5" class="muted" style="padding:18px">暂无成员</td></tr>'}</tbody></table></div></div>`,
    security: `<div class="between" style="margin-bottom:14px"><div><h2 style="font-size:24px">安全审计</h2><div class="sub muted">登录、API Key、授权/访问策略变更与限流事件；仅组织管理员可见。</div></div><span class="row"><a class="btn btn-sm" href="/api/admin/security/export?days=30">导出安全 CSV</a><a class="btn btn-sm" href="/api/admin/audit/export?days=30">导出审计 CSV</a><span class="badge ${securityData?.counts?.some((item) => item.severity === 'critical') ? 'clay' : 'jade'}">最近 7 天</span></span></div><div class="panel"><div class="panel-body" style="padding:0"><table class="org-table"><thead><tr><th>时间</th><th>级别</th><th>事件</th><th>操作者</th><th>对象</th><th>IP</th></tr></thead><tbody>${securityRows || '<tr><td colspan="6" class="muted" style="padding:18px">暂无安全事件</td></tr>'}</tbody></table></div></div>`,
    keys: `<div class="between" style="margin-bottom:14px"><div><h2 style="font-size:24px">API 密钥</h2><div class="sub muted">供 DSH 智能体或外部系统读写知识；只读密钥不能调用写接口。</div></div><button class="btn btn-primary btn-sm" id="new-key">+ 创建密钥</button></div>
      <div class="panel"><div class="panel-body" style="padding:0"><table class="org-table"><thead><tr><th>名称</th><th>前缀</th><th>范围</th><th>最近使用</th><th></th></tr></thead><tbody>${keyRows || '<tr><td colspan="5" class="muted" style="padding:18px">还没有 API 密钥</td></tr>'}</tbody></table></div></div>
      <div class="panel" style="margin-top:16px"><div class="panel-head"><h3>智能体接入</h3><a class="link small" href="#/agent">查看接入指南 ${icon('arrow', 13)}</a></div><div class="panel-body"><div class="endpoint"><span class="method">POST</span><code>/api/agent/search</code><span class="desc">检索知识页与文献</span></div><div class="endpoint"><span class="method">POST</span><code>/api/agent/ask</code><span class="desc">带引用的知识合成</span></div><div class="endpoint"><span class="method">POST</span><code>/api/agent/page</code><span class="desc">创建或更新知识页</span></div></div></div>`,
  };

  return `
    <div class="eyebrow">ORGANIZATION · RBAC · INTEGRATIONS</div>
    <h1 style="font-size:42px;letter-spacing:-.03em;margin:8px 0 4px">团队与权限</h1>
    <p class="muted" style="max-width:720px">知识库属于团队，权限按组织、团队、个人三层授予；成员离开团队后自动失去对应访问。所有写入都会进入审计。</p>
    <div class="admin-layout" style="margin-top:22px">
      <nav class="admin-nav">${TABS.map((item) => `<button class="${tab === item.key ? 'active' : ''}" data-admin-tab="${item.key}">${item.label}</button>`).join('')}</nav>
      <div>${bodies[tab] ?? bodies.teams}</div>
    </div>`;
}

export function mountAdmin(tab = 'teams') {
  const isAdmin = Boolean(state.me?.person?.isAdmin);
  document.getElementById('integrity-check')?.addEventListener('click', async () => {
    try {
      const result = await api('/api/admin/integrity');
      const rows = (result.issues ?? []).map((issue) => `<tr><td><code>${esc(issue.kind)}</code></td><td>${esc(issue.title || issue.id)}</td><td class="small muted">${esc(issue.detail)}</td></tr>`).join('');
      openModal({ title: '数据体检', wide: true, body: `<div class="small muted" style="margin-bottom:10px">SQLite：${esc((result.sqlite ?? []).join(', '))} · 页面 ${result.counts.pages} · 文献 ${result.counts.sources} · 链接 ${result.counts.links}</div><div class="panel" style="box-shadow:none"><div class="panel-body" style="padding:0"><table class="org-table"><thead><tr><th>类型</th><th>对象</th><th>详情</th></tr></thead><tbody>${rows || '<tr><td colspan="3" class="muted" style="padding:18px">未发现结构性问题</td></tr>'}</tbody></table></div></div>` });
    } catch (error) { toast(error.message, 'error'); }
  });
  document.querySelectorAll('[data-admin-tab]').forEach((button) => {
    button.addEventListener('click', () => go(`#/admin?tab=${button.dataset.adminTab}`));
  });
  document.querySelectorAll('[data-member-team]').forEach((button) => {
    button.addEventListener('click', () => openMemberEditor(button.dataset.memberTeam));
  });
  document.querySelectorAll('[data-revoke-key]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!confirm('确认吊销该密钥？')) return;
      try {
        await api(`/api/api-keys/${encodeURIComponent(button.dataset.revokeKey)}`, { method: 'DELETE' });
        toast('密钥已吊销', 'success');
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  });
  document.querySelectorAll('[data-bind-wecom]').forEach((button) => {
    button.addEventListener('click', () => openWecomBind(button.dataset.bindWecom, button.dataset.personName));
  });
  document.getElementById('new-team')?.addEventListener('click', openTeamEditor);
  document.getElementById('new-person')?.addEventListener('click', openPersonEditor);
  document.getElementById('new-key')?.addEventListener('click', openKeyEditor);
  document.getElementById('save-wecom')?.addEventListener('click', async () => {
    const form = document.getElementById('wecom-form');
    if (!form) return;
    try {
      await api('/api/integrations/wecom/config', { method: 'POST', body: formValues(form) });
      toast('配置已保存', 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  document.getElementById('sync-wecom')?.addEventListener('click', async () => {
    try {
      const result = await api('/api/integrations/wecom/sync', { method: 'POST' });
      openModal({
        title: '企业微信同步计划（dry run）',
        wide: true,
        body: `<div class="small muted" style="margin-bottom:12px">${esc(result.note)}</div><label class="small" style="display:flex;gap:8px;align-items:center;margin-bottom:10px"><input type="checkbox" id="deactivate-missing"> 停用不在通讯录中的已绑定成员（管理员账号会跳过）</label><div class="json" style="font-family:var(--mono);font-size:11px;white-space:pre-wrap;background:var(--paper-2);padding:14px;border-radius:9px;max-height:360px;overflow:auto">${esc(JSON.stringify(result.plan, null, 2))}</div>`,
        footer: `<button class="btn" data-close-modal>取消</button><button class="btn btn-primary" id="apply-wecom-sync">应用计划</button>`,
        onMount: (modal) => {
          modal.querySelector('#apply-wecom-sync')?.addEventListener('click', async () => {
            const deactivateMissing = Boolean(modal.querySelector('#deactivate-missing')?.checked);
            if (deactivateMissing && !confirm('将停用通讯录中不存在的已绑定成员，确认执行？')) return;
            try {
              const applied = await api('/api/integrations/wecom/sync', { method: 'POST', body: JSON.stringify({ apply: true, deactivateMissing }) });
              toast(`已同步：团队 ${applied.applied?.departments ?? 0}，成员 ${applied.applied?.users ?? 0}，停用 ${applied.applied?.deactivated ?? 0}`, 'success');
              closeModal();
              await loadBootstrap();
              window.dispatchEvent(new HashChangeEvent('hashchange'));
            } catch (error) {
              toast(error.message, 'error');
            }
          });
        },
      });
    } catch (error) {
      toast(error.message, 'error');
    }
  });
}

function teamCard(team, isAdmin) {
  return `<div class="team-card" style="margin-left:${Math.min(3, Number(team.depth ?? 0)) * 18}px">
    <div class="head">
      <span class="avatar jade">${esc(team.name.slice(0, 2))}</span>
      <div style="min-width:0"><div class="name">${esc(team.name)} ${team.depth ? '<span class="badge outline">下级</span>' : '<span class="badge jade">顶级</span>'}</div><div class="desc">${esc(team.description || '—')}</div></div>
      <div style="margin-left:auto" class="row">${team.wecomDeptId ? `<span class="badge outline">企微 ${esc(team.wecomDeptId)}</span>` : ''}${isAdmin ? `<button class="btn btn-sm btn-ghost" data-member-team="${esc(team.id)}">成员</button>` : ''}</div>
    </div>
    <div style="padding:0 16px 14px"><div class="member-chips">${team.members.map((member) => `<span class="member-chip">${avatar(member, 'sm')}${esc(member.name)}<span class="role">${member.role === 'lead' ? '负责人' : '成员'}</span></span>`).join('') || '<span class="faint small">暂无成员</span>'}</div></div>
  </div>`;
}

function flattenTeams(teams, depth = 0, out = []) {
  for (const team of teams ?? []) {
    out.push({ ...team, depth });
    flattenTeams(team.children ?? [], depth + 1, out);
  }
  return out;
}

function openTeamEditor() {
  const teams = flattenTeams(state.teams).map((team) => ({ value: team.id, label: `${'— '.repeat(team.depth)}${team.name}` }));
  openModal({
    title: '新建团队',
    body: `<form id="team-form" class="form-grid">
      ${textField({ label: '团队名称', name: 'name' })}
      ${selectField({ label: '上级团队', name: 'parentId', options: [{ value: '', label: '顶层' }, ...teams] })}
      ${textField({ label: '说明', name: 'description', span: true })}
      ${textField({ label: '企业微信部门 ID', name: 'wecomDeptId' })}
    </form>`,
    footer: `<button class="btn" data-close-modal>取消</button><button class="btn btn-primary" id="save-team">创建团队</button>`,
    onMount: (modal) => {
      modal.querySelector('#save-team')?.addEventListener('click', async () => {
        try {
          await api('/api/teams', { method: 'POST', body: formValues(modal.querySelector('#team-form')) });
          toast('团队已创建', 'success');
          closeModal();
          await loadBootstrap();
          window.dispatchEvent(new HashChangeEvent('hashchange'));
        } catch (error) {
          toast(error.message, 'error');
        }
      });
    },
  });
}

function openPersonEditor() {
  openModal({
    title: '邀请成员',
    body: `<form id="person-form" class="form-grid">
      ${textField({ label: '姓名', name: 'name' })}
      ${textField({ label: '邮箱', name: 'email', type: 'email' })}
      ${textField({ label: '职位', name: 'title' })}
      ${textField({ label: '初始密码（至少 8 位）', name: 'password', type: 'password' })}
      ${selectField({ label: '角色', name: 'role', options: [{ value: 'member', label: '普通成员' }, { value: 'admin', label: '组织管理员' }] })}
    </form>`,
    footer: `<button class="btn" data-close-modal>取消</button><button class="btn btn-primary" id="save-person">创建账号</button>`,
    onMount: (modal) => {
      modal.querySelector('#save-person')?.addEventListener('click', async () => {
        const values = formValues(modal.querySelector('#person-form'));
        try {
          await api('/api/people', { method: 'POST', body: { ...values, isAdmin: values.role === 'admin' } });
          toast('成员已创建', 'success');
          closeModal();
          await loadBootstrap();
          window.dispatchEvent(new HashChangeEvent('hashchange'));
        } catch (error) {
          toast(error.message, 'error');
        }
      });
    },
  });
}

function openMemberEditor(teamId) {
  const team = flattenTeams(state.teams).find((item) => item.id === teamId);
  const existing = new Set((team?.members ?? []).map((member) => member.id));
  const options = state.people.filter((person) => !existing.has(person.id)).map((person) => ({ value: person.id, label: `${person.name} · ${person.email}` }));
  openModal({
    title: `管理成员 · ${team?.name ?? ''}`,
    body: `<form id="member-form" class="form-grid">
      ${selectField({ label: '添加成员', name: 'personId', options: [{ value: '', label: '选择成员' }, ...options], span: true })}
      ${selectField({ label: '团队角色', name: 'role', options: [{ value: 'member', label: '成员' }, { value: 'lead', label: '负责人' }] })}
    </form>
    <div class="hairline"></div>
    <div class="small faint" style="margin-bottom:8px">当前成员</div>
    <div class="member-chips">${(team?.members ?? []).map((member) => `<span class="member-chip">${avatar(member, 'sm')}${esc(member.name)}<span class="role">${member.role}</span></span>`).join('') || '<span class="faint">暂无</span>'}</div>`,
    footer: `<button class="btn" data-close-modal>关闭</button><button class="btn btn-primary" id="save-member">添加</button>`,
    onMount: (modal) => {
      modal.querySelector('#save-member')?.addEventListener('click', async () => {
        const values = formValues(modal.querySelector('#member-form'));
        if (!values.personId) return;
        try {
          await api(`/api/teams/${encodeURIComponent(teamId)}/members`, { method: 'POST', body: values });
          toast('成员已加入团队', 'success');
          closeModal();
          await loadBootstrap();
          window.dispatchEvent(new HashChangeEvent('hashchange'));
        } catch (error) {
          toast(error.message, 'error');
        }
      });
    },
  });
}

function openKeyEditor() {
  openModal({
    title: '创建 API 密钥',
    body: `<form id="key-form" class="form-grid">
      ${textField({ label: '名称', name: 'name', placeholder: '例如：DSH 编译智能体', span: true })}
      ${selectField({ label: '范围', name: 'scope', options: [{ value: 'read', label: '只读：检索与读取' }, { value: 'write', label: '读写：检索、编译、写入' }] })}
    </form>`,
    footer: `<button class="btn" data-close-modal>取消</button><button class="btn btn-primary" id="save-key">创建</button>`,
    onMount: (modal) => {
      modal.querySelector('#save-key')?.addEventListener('click', async () => {
        try {
          const result = await api('/api/api-keys', { method: 'POST', body: formValues(modal.querySelector('#key-form')) });
          modal.querySelector('.modal-body').innerHTML = `<div class="error-box" style="background:var(--jade-soft);color:var(--jade);border-color:transparent">密钥只显示一次，请立即复制保存。</div><div class="code-block" style="margin-top:12px;white-space:pre-wrap;word-break:break-all">${esc(result.token)}</div><div class="btn-row" style="margin-top:12px"><button class="btn btn-sm" id="copy-token">复制密钥</button></div>`;
          modal.querySelector('#copy-token')?.addEventListener('click', async () => {
            await navigator.clipboard.writeText(result.token).catch(() => {});
            toast('已复制', 'success');
          });
          modal.querySelector('.modal-foot').innerHTML = '<button class="btn btn-primary" id="done-key">我已保存</button>';
          modal.querySelector('#done-key')?.addEventListener('click', async () => {
            closeModal();
            await loadBootstrap();
            window.dispatchEvent(new HashChangeEvent('hashchange'));
          });
        } catch (error) {
          toast(error.message, 'error');
        }
      });
    },
  });
}

function openWecomBind(personId, personName) {
  openModal({
    title: `绑定企业微信 · ${personName ?? ''}`,
    body: `<form id="wecom-bind-form" class="form-grid">
      <div class="field span-2"><label>企业微信 userid</label><input class="input" name="wecomUserid" placeholder="例如 LinWei；留空可解绑"></div>
      <div class="small faint span-2">绑定后，该员工从企业微信登录时会映射到此本地账号。</div>
    </form>`,
    footer: `<button class="btn" data-close-modal>取消</button><button class="btn btn-primary" id="save-wecom-bind">保存绑定</button>`,
    onMount: (modal) => {
      modal.querySelector('#save-wecom-bind')?.addEventListener('click', async () => {
        const values = formValues(modal.querySelector('#wecom-bind-form'));
        try {
          await api(`/api/people/${encodeURIComponent(personId)}`, {
            method: 'PATCH',
            body: { wecomUserid: values.wecomUserid ?? '' },
          });
          toast('企业微信绑定已更新', 'success');
          closeModal();
          await loadBootstrap();
          window.dispatchEvent(new HashChangeEvent('hashchange'));
        } catch (error) {
          toast(error.message, 'error');
        }
      });
    },
  });
}
