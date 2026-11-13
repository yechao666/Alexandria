import { api, icon, escapeHtml as esc, timeAgo, statusBadge, openModal, closeModal, toast } from '../assets/core.js';

const STEP_LABELS = {
  queued: '排队',
  extract: '解析原文',
  assets: '图片与 OCR',
  index: '全文索引',
  compile: '知识编译',
  done: '完成',
  failed: '失败',
};
const STATUS_LABELS = { queued: '排队中', running: '执行中', succeeded: '已完成', failed: '失败', cancelled: '已取消' };

function duration(ms) {
  if (!ms && ms !== 0) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function taskRow(task) {
  const tone = task.status === 'succeeded' ? 'jade' : task.status === 'failed' ? 'clay' : task.status === 'running' ? 'ochre' : 'outline';
  return `<div class="source-row task-row" data-task="${esc(task.id)}" style="cursor:pointer;align-items:center">
    <span class="file-icon">${icon(task.compiler === 'dsh' ? 'spark' : 'refresh', 18)}</span>
    <span class="info" style="display:flex;flex-direction:column;gap:2px"><span class="name">${esc(task.source_title || task.source_filename || '未命名资料')}</span><span class="meta">${esc(task.library_name || '')} · ${esc(task.compiler || 'rule')} · ${esc(timeAgo(task.created_at))}</span></span>
    <span class="badge ${tone}">${esc(STATUS_LABELS[task.status] ?? task.status)}</span>
    <span class="faint small" style="width:56px;text-align:right">${task.progress ?? 0}%</span>
    <span class="icon-btn">${icon('chevron', 15)}</span>
  </div>`;
}

export async function renderTasks() {
  const data = await api('/api/tasks?limit=80').catch(() => ({ tasks: [] }));
  const tasks = data.tasks ?? [];
  const queue = data.queue ?? { active: 0, pending: 0 };
  const counts = {
    total: tasks.length,
    running: tasks.filter((task) => task.status === 'running' || task.status === 'queued').length,
    failed: tasks.filter((task) => task.status === 'failed').length,
    succeeded: tasks.filter((task) => task.status === 'succeeded').length,
  };
  return `
    <div class="eyebrow">PIPELINE · DSH · OBSERVABILITY</div>
    <div class="between" style="margin:8px 0 18px"><div><h1 style="font-size:28px;letter-spacing:-.02em;margin:0">处理任务</h1><div class="sub muted">资料处理被拆成可观察的步骤：解析、OCR、索引、DSH 编译。Worker 队列 ${queue.active} 执行 / ${queue.pending} 排队；失败可重试，排队任务可取消。</div></div><a class="btn btn-primary" href="#/upload">${icon('upload', 15)} 上传资料</a></div>
    <div class="grid grid-4" style="margin-bottom:16px">
      <div class="panel panel-pad"><div class="small faint">任务总数</div><div style="font-size:30px;font-weight:650">${counts.total}</div></div>
      <div class="panel panel-pad"><div class="small faint">执行中</div><div style="font-size:30px;font-weight:650;color:var(--ochre)">${counts.running}</div></div>
      <div class="panel panel-pad"><div class="small faint">已完成</div><div style="font-size:30px;font-weight:650;color:var(--jade)">${counts.succeeded}</div></div>
      <div class="panel panel-pad"><div class="small faint">失败</div><div style="font-size:30px;font-weight:650;color:var(--clay)">${counts.failed}</div></div>
    </div>
    <div class="panel"><div class="panel-head"><h3>处理任务</h3><span class="small muted">点击查看步骤与日志</span></div>
      <div class="panel-body" style="padding:0">${tasks.length ? tasks.map(taskRow).join('') : '<div class="empty">还没有处理任务；上传一份资料开始。</div>'}</div>
    </div>`;
}

function taskModal(task) {
  const events = task.events ?? [];
  const current = events.at(-1);
  const eventRows = events.map((event) => {
    const tone = event.status === 'failed' ? 'clay' : event.status === 'succeeded' ? 'jade' : event.status === 'running' ? 'ochre' : 'outline';
    return `<div class="timeline-item"><span class="pip" style="background:${event.status === 'failed' ? 'var(--clay)' : event.status === 'succeeded' ? 'var(--jade)' : 'var(--ochre)'}"></span><div class="text"><div class="between"><b>${esc(STEP_LABELS[event.step] ?? event.step)}</b><span class="badge ${tone}">${esc(event.status)}</span></div><div class="small muted" style="margin-top:2px">${esc(event.message || '')}</div><div class="faint" style="font-size:10px;margin-top:2px">${task.progress ?? 0}% 任务进度 · ${duration(event.duration_ms)}</div></div></div>`;
  }).join('');
  const logs = (task.log ?? []).slice(-14).map((line) => `<div class="mono small faint" style="padding:2px 0">${esc(line)}</div>`).join('');
  openModal({
    title: `任务 ${task.id}`,
    wide: true,
    body: `<div class="chip-row" style="margin-bottom:14px"><span class="badge ${task.status === 'succeeded' ? 'jade' : task.status === 'failed' ? 'clay' : 'ochre'}">${esc(STATUS_LABELS[task.status] ?? task.status)}</span><span class="badge outline">${esc(task.compiler)}</span><span class="badge">${task.progress ?? 0}%</span></div>
      <div class="grid grid-2"><div><div class="small faint" style="margin-bottom:8px">步骤时间线</div><div class="timeline">${eventRows || '<div class="rail-empty">暂无事件</div>'}</div></div><div><div class="small faint" style="margin-bottom:8px">运行日志</div><div style="max-height:360px;overflow:auto;background:var(--paper-2);padding:10px;border-radius:8px">${logs || '<div class="rail-empty">暂无日志</div>'}</div><div class="kv" style="margin-top:14px"><dt>资料</dt><dd>${esc(task.source_title || '—')}</dd><dt>知识库</dt><dd>${esc(task.library_name || '—')}</dd><dt>创建</dt><dd>${esc(new Date(task.created_at).toLocaleString('zh-CN'))}</dd></div></div></div>`,
    footer: `${task.status === 'failed' ? `<button class="btn" id="retry-task">${icon('refresh', 14)} 重试</button>` : ''}${task.status === 'queued' ? `<button class="btn btn-ghost" id="cancel-task">取消任务</button>` : ''}<button class="btn btn-primary" data-close-modal>关闭</button>`,
    onMount: (modal) => {
      modal.querySelector('#retry-task')?.addEventListener('click', async () => {
        try {
          await api(`/api/jobs/${encodeURIComponent(task.id)}/run`, { method: 'POST' });
          toast('已重新进入处理队列', 'success');
          closeModal();
          window.dispatchEvent(new HashChangeEvent('hashchange'));
        } catch (error) { toast(error.message, 'error'); }
      });
      modal.querySelector('#cancel-task')?.addEventListener('click', async () => {
        try {
          await api(`/api/jobs/${encodeURIComponent(task.id)}/cancel`, { method: 'POST' });
          toast('任务已取消', 'success');
          closeModal();
          window.dispatchEvent(new HashChangeEvent('hashchange'));
        } catch (error) { toast(error.message, 'error'); }
      });
    },
  });
}

export function mountTasks() {
  document.querySelectorAll('[data-task]').forEach((row) => {
    row.addEventListener('click', async () => {
      try {
        const { job } = await api(`/api/jobs/${encodeURIComponent(row.dataset.task)}`);
        taskModal(job);
      } catch (error) { toast(error.message, 'error'); }
    });
  });
}
