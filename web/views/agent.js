import { api, state, icon, escapeHtml as esc, toast, openModal, closeModal, copyText, loadBootstrap } from '../assets/core.js';

export async function renderAgent() {
  const [manifest, overview] = await Promise.all([
    api('/api/agent/manifest'),
    api('/api/agent/overview').catch(() => null),
  ]);
  const endpoints = manifest.tools
    .map(
      (tool) => `<div class="endpoint"><span class="method">${tool.method}</span><code>${esc(tool.path)}</code><span class="desc">${esc(tool.description)}</span></div>`,
    )
    .join('');
  const libraries = (overview?.libraries ?? [])
    .map(
      (library) => `<div class="rail-item"><span class="dot" style="background:var(--jade)"></span><span>${esc(library.name)} <span class="faint">· ${library.pages} 页 / ${library.sources} 文献</span></span></div>`,
    )
    .join('');
  const curl = `curl -s http://127.0.0.1:4520/api/agent/search \\
  -H "Authorization: Bearer $ALEX_API_KEY" \\
  -H "content-type: application/json" \\
  -d '{"query":"知识编译","limit":5}'`;
  let skill = null;
  try {
    const skillResponse = await fetch('/api/agent/skill', { credentials: 'include' });
    if (skillResponse.ok) skill = await skillResponse.text();
  } catch {
    skill = null;
  }
  return `
    <div class="agent-hero">
      <div>
        <div class="eyebrow">DSH · AGENT API · SKILLS</div>
        <h1 style="font-size:42px;letter-spacing:-.03em;margin:8px 0 8px">让智能体维护知识，而不是消费片段。</h1>
        <p class="muted" style="max-width:680px">后台默认用本机 DSH headless 做语义编译、检索重排与知识合成；DSH 不可用时自动回退到规则编译器与本地检索。外部智能体通过 API Key 维护知识。</p>
        <div class="btn-row" style="margin-top:18px">
          <button class="btn btn-primary" id="agent-new-key">${icon('key', 15)} 创建 API 密钥</button>
          <a class="btn" href="/api/agent/skill" target="_blank">${icon('file', 15)} 下载 SKILL.md</a>
          <a class="btn btn-ghost" href="/api/agent/manifest" target="_blank">${icon('external', 15)} manifest.json</a>
        </div>
        <div class="panel" style="margin-top:22px">
          <div class="panel-head"><h3>快速开始</h3><button class="btn btn-sm btn-ghost" id="copy-curl">${icon('copy', 14)} 复制</button></div>
          <div class="panel-body" style="padding:0"><pre class="code-block" style="margin:0;border-radius:0 0 14px 14px">${esc(curl)}</pre></div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><h3>智能体工作循环</h3><span class="badge jade">${esc(manifest.version)}</span></div>
        <div class="panel-body">
          <div class="timeline">
            ${manifest.principles.map((principle, index) => `<div class="timeline-item"><span class="pip"></span><div class="text">${esc(principle)}</div></div>`).join('')}
          </div>
          <div class="hairline"></div>
          <div class="small faint" style="margin-bottom:6px">可用知识库</div>
          <div class="rail-list">${libraries || '<div class="rail-empty">暂无</div>'}</div>
        </div>
      </div>
    </div>
    <div class="grid grid-2" style="margin-top:26px">
      <div class="panel">
        <div class="panel-head"><h3>工具</h3><span class="small muted">${manifest.tools.length} 个端点</span></div>
        <div class="panel-body">${endpoints}</div>
      </div>
      <div class="panel">
        <div class="panel-head"><h3>技能契约</h3><span class="badge outline">SKILL.md</span></div>
        <div class="panel-body">
          <p class="small muted">技能文件告诉 DSH 何时检索、如何写入、哪些字段必须保留。引擎本身不内置提示词。</p>
          <div class="code-block" style="max-height:300px;overflow:auto;white-space:pre-wrap">${esc((skill ?? '# skill unavailable').slice(0, 2200))}</div>
        </div>
      </div>
    </div>
    <div class="panel" style="margin-top:20px">
      <div class="panel-head"><h3>设计边界</h3></div>
      <div class="panel-body grid grid-3">
        <div><h4 style="margin-bottom:6px">本机 DSH 语义层</h4><p class="small muted">解析、索引、图、权限由确定性代码完成；语义编译/重排/合成调用本机 DSH，失败时回退。</p></div>
        <div><h4 style="margin-bottom:6px">知识先于检索</h4><p class="small muted">页面是事实源，FTS 与图是派生索引；检索不做查询期向量切块。</p></div>
        <div><h4 style="margin-bottom:6px">权限先于结果</h4><p class="small muted">所有查询先做库级权限过滤，再进入检索；私有库对无权限成员返回 404。</p></div>
      </div>
    </div>`;
}

export function mountAgent() {
  document.getElementById('copy-curl')?.addEventListener('click', () => {
    copyText(`curl -s http://127.0.0.1:4520/api/agent/search \\\n  -H "Authorization: Bearer $ALEX_API_KEY" \\\n  -H "content-type: application/json" \\\n  -d '{"query":"知识编译","limit":5}'`);
  });
  document.getElementById('agent-new-key')?.addEventListener('click', () => {
    openModal({
      title: '创建智能体密钥',
      body: `<form id="agent-key-form" class="form-grid">
        <div class="field span-2"><label>名称</label><input class="input" name="name" value="DSH 编译智能体" placeholder="例如：DSH 知识编译"></div>
        <div class="field"><label>范围</label><select class="select" name="scope"><option value="write">读写：编译与写入</option><option value="read">只读：检索与读取</option></select></div>
      </form>`,
      footer: `<button class="btn" data-close-modal>取消</button><button class="btn btn-primary" id="agent-key-submit">创建密钥</button>`,
      onMount: (modal) => {
        modal.querySelector('#agent-key-submit')?.addEventListener('click', async () => {
          try {
            const form = modal.querySelector('#agent-key-form');
            const values = Object.fromEntries(new FormData(form).entries());
            const result = await api('/api/api-keys', { method: 'POST', body: values });
            modal.querySelector('.modal-body').innerHTML = `<div class="error-box" style="background:var(--jade-soft);color:var(--jade);border-color:transparent">密钥只显示一次，请立即复制并写入 DSH 的安全存储。</div><div class="code-block" style="margin-top:12px;white-space:pre-wrap;word-break:break-all">${esc(result.token)}</div>`;
            modal.querySelector('.modal-foot').innerHTML = `<button class="btn btn-primary" id="agent-key-done">我已保存</button>`;
            modal.querySelector('#agent-key-done')?.addEventListener('click', async () => {
              closeModal();
              await loadBootstrap();
            });
          } catch (error) {
            toast(error.message, 'error');
          }
        });
      },
    });
  });
}
