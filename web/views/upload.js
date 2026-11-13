import {
  api,
  state,
  icon,
  escapeHtml as esc,
  fmtBytes,
  toast,
  go,
  emptyState,
} from '../assets/core.js';

const FORMATS = [
  ['PDF', '文本层 / 扫描件降级', 'pdf'],
  ['DOCX', '标题、表格、内嵌图片', 'docx'],
  ['DOC', 'LibreOffice / textutil', 'doc'],
  ['PPTX', '逐页文本', 'pptx'],
  ['XLSX', '多工作表转表格', 'xlsx'],
  ['TeX', '章节与摘要', 'tex'],
  ['RTF', 'textutil + 内置解析', 'rtf'],
  ['WPS', 'OOXML / OLE 兜底', 'wps'],
  ['图片', '中英 OCR + 缩略图', 'image'],
  ['MD/HTML', '标题、正文与链接', 'md'],
  ['CSV/JSON', '表格化', 'csv'],
  ['ODT/EPUB', '开放文档', 'odt'],
];

export async function renderUpload(libraryRef) {
  const libraries = state.libraries;
  const selected = libraries.find((library) => library.slug === libraryRef || library.id === libraryRef) ?? libraries[0];
  let detail = null;
  if (selected) detail = await api(`/api/libraries/${encodeURIComponent(selected.id)}`).catch(() => null);
  const libraryOptions = libraries
    .filter((library) => library.role !== 'viewer')
    .map((library) => ({ value: library.slug, label: library.name }));
  const nodeOptions = flattenNodes(detail?.nodes ?? []).map((node) => ({ value: node.id, label: `${'— '.repeat(node.depth)}${node.name}` }));

  return `
    <div class="eyebrow">INGESTION · OCR · COMPILE</div>
    <h1 style="font-size:28px;letter-spacing:-.02em;margin:6px 0 6px">导入资料</h1>
    <p class="muted" style="max-width:680px">上传后先解析、再做知识编译。文本、章节、图片与 OCR 文本会合并成可检索的知识；原始文件保留，可随时回溯或重新编译。</p>
    <div class="upload-layout" style="margin-top:22px">
      <div>
        <div class="panel panel-pad">
          <div class="form-grid">
            <div class="field"><label>目标知识库</label><select class="select" id="upload-library">${libraryOptions.map((option) => `<option value="${esc(option.value)}" ${selected && option.value === selected.slug ? 'selected' : ''}>${esc(option.label)}</option>`).join('')}</select></div>
            <div class="field"><label>归入目录</label><select class="select" id="upload-node"><option value="">未分类</option>${nodeOptions.map((option) => `<option value="${esc(option.value)}">${esc(option.label)}</option>`).join('')}</select></div>
            <div class="field span-2"><label>标题（可选，单文件时使用）</label><input class="input" id="upload-title" placeholder="留空则使用文件名"></div>
          </div>
          <div class="dropzone" id="dropzone" style="margin-top:16px">
            <div>
              <div class="big-icon">${icon('upload', 28)}</div>
              <h3>把文件拖到这里</h3>
              <p>或点击选择文件 · 单个文件上限 ${Math.round((state.features?.maxUploadMB ?? 80))} MB</p>
              <div class="btn-row" style="justify-content:center;margin-top:16px"><button class="btn btn-primary" id="choose-files">${icon('file', 15)} 选择文件</button></div>
              <input type="file" id="file-input" multiple hidden>
            </div>
          </div>
          <div class="upload-queue" id="upload-queue"></div>
        </div>
        <div class="panel" style="margin-top:16px">
          <div class="panel-head"><h3>编译流水线</h3><span class="small muted">异步执行，可离开页面</span></div>
          <div class="panel-body">
            <div class="timeline">
              <div class="timeline-item"><span class="pip"></span><div class="text"><b>解析</b><br><span class="muted">识别格式，抽取文本、章节、表格、图片与 OCR 文本。</span></div></div>
              <div class="timeline-item"><span class="pip"></span><div class="text"><b>索引</b><br><span class="muted">文献全文写入 FTS5，原始文件与资产落盘。</span></div></div>
              <div class="timeline-item"><span class="pip"></span><div class="text"><b>编译</b><br><span class="muted">生成文献页、概念页、结构化主张与类型化关联。</span></div></div>
              <div class="timeline-item"><span class="pip"></span><div class="text"><b>可检索</b><br><span class="muted">新页面立即进入检索与图谱；矛盾会被标记待裁决。</span></div></div>
            </div>
          </div>
        </div>
      </div>
      <aside>
        <div class="panel">
          <div class="panel-head"><h3>支持的格式</h3><span class="small muted">12 类</span></div>
          <div class="panel-body format-grid">
            ${FORMATS.map(([name, desc]) => `<div class="format-chip"><b>${esc(name)}</b><span>${esc(desc)}</span></div>`).join('')}
          </div>
        </div>
        <div class="panel" style="margin-top:14px">
          <div class="panel-head"><h3>处理约定</h3></div>
          <div class="panel-body small muted" style="line-height:1.8">
            <p>· 同一知识库内相同 SHA-256 的文件会自动去重。</p>
            <p>· 图片优先用 Tesseract 中英 OCR；扫描版 PDF 缺文本层时记录提示，不静默丢失。</p>
            <p>· 旧版 DOC / WPS 若安装了 LibreOffice 会优先转换，否则使用兜底抽取并标记质量提示。</p>
            <p>· 编译失败不会删除原始文件，可在文献详情里重新编译。</p>
          </div>
        </div>
      </aside>
    </div>`;
}

export function mountUpload(libraryRef) {
  const dropzone = document.getElementById('dropzone');
  const input = document.getElementById('file-input');
  const choose = document.getElementById('choose-files');
  const queue = document.getElementById('upload-queue');
  const librarySelect = document.getElementById('upload-library');
  if (!dropzone) return;

  const refreshNodes = async () => {
    const library = state.libraries.find((item) => item.slug === librarySelect.value || item.id === librarySelect.value);
    if (!library) return;
    const detail = await api(`/api/libraries/${encodeURIComponent(library.id)}`).catch(() => null);
    const nodeSelect = document.getElementById('upload-node');
    if (!nodeSelect || !detail) return;
    nodeSelect.innerHTML = `<option value="">未分类</option>${flattenNodes(detail.nodes ?? [])
      .map((node) => `<option value="${esc(node.id)}">${esc(`${'— '.repeat(node.depth)}${node.name}`)}</option>`)
      .join('')}`;
  };
  librarySelect?.addEventListener('change', refreshNodes);

  const pick = () => input?.click();
  choose?.addEventListener('click', pick);
  dropzone.addEventListener('click', (event) => {
    if (!event.target.closest('button')) pick();
  });
  dropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropzone.classList.add('drag');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropzone.classList.remove('drag');
    uploadFiles([...event.dataTransfer.files]);
  });
  input?.addEventListener('change', () => {
    uploadFiles([...input.files]);
    input.value = '';
  });

  async function uploadFiles(files) {
    if (!files.length) return;
    const library = state.libraries.find((item) => item.slug === librarySelect.value || item.id === librarySelect.value) ?? state.libraries[0];
    if (!library) {
      toast('没有可写入的知识库', 'error');
      return;
    }
    const nodeId = document.getElementById('upload-node')?.value ?? '';
    const title = document.getElementById('upload-title')?.value.trim() ?? '';
    for (const file of files) {
      const item = document.createElement('div');
      item.className = 'upload-item';
      item.innerHTML = `<span class="file-icon" style="width:30px;height:30px">${icon('file', 15)}</span><span style="min-width:0;flex:1"><span style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(file.name)}</span><span class="faint" style="font-size:10px">${fmtBytes(file.size)}</span></span><span class="progress"><i style="width:2%"></i></span><span class="status">等待</span>`;
      queue.appendChild(item);
      const fill = item.querySelector('.progress i');
      const status = item.querySelector('.status');

      const xhr = new XMLHttpRequest();
      const done = new Promise((resolve) => {
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) fill.style.width = `${Math.max(4, Math.round((event.loaded / event.total) * 70))}%`;
        };
        xhr.onload = () => {
          let data = {};
          try {
            data = JSON.parse(xhr.responseText || '{}');
          } catch {
            data = {};
          }
          resolve({ status: xhr.status, data });
        };
        xhr.onerror = () => resolve({ status: 0, data: { error: { message: '网络错误' } } });
      });
      xhr.open('POST', `/api/libraries/${encodeURIComponent(library.id)}/sources`);
      xhr.setRequestHeader('x-filename', encodeURIComponent(file.name));
      if (title && files.length === 1) xhr.setRequestHeader('x-title', encodeURIComponent(title));
      if (nodeId) xhr.setRequestHeader('x-node-id', nodeId);
      xhr.setRequestHeader('content-type', 'application/octet-stream');
      xhr.send(file);

      const result = await done;
      if (result.status >= 400) {
        fill.style.width = '100%';
        fill.style.background = 'var(--clay)';
        status.textContent = result.data?.error?.message ?? '上传失败';
        status.style.color = 'var(--clay)';
        continue;
      }
      const data = result.data;
      if (data.duplicate) {
        fill.style.width = '100%';
        status.textContent = '已存在（去重）· 查看文档';
        item.style.cursor = 'pointer';
        item.addEventListener('click', () => go(`#/source/${encodeURIComponent(data.source?.id ?? '')}`));
        continue;
      }
      fill.style.width = '72%';
      status.textContent = '解析中…';
      await pollJob(data.jobId, {
        onProgress: (job) => {
          const pct = 72 + Math.round((job.progress ?? 0) * 0.26);
          fill.style.width = `${Math.min(99, pct)}%`;
          status.textContent = stageLabel(job.stage);
        },
      }).then((job) => {
        if (job?.status === 'succeeded') {
          fill.style.width = '100%';
          fill.style.background = 'var(--jade)';
          status.textContent = `已编译 · ${job.pages_created ?? 0} 新页 · 查看文档`;
          status.style.color = 'var(--jade)';
          item.style.cursor = 'pointer';
          item.addEventListener('click', () => go(`#/source/${encodeURIComponent(data.source?.id ?? '')}`));
        } else {
          fill.style.width = '100%';
          fill.style.background = 'var(--clay)';
          status.textContent = job?.error ? '编译失败' : '处理超时';
          status.style.color = 'var(--clay)';
        }
      });
    }
    toast('文件已进入处理队列', 'success');
  }
}

async function pollJob(jobId, { onProgress, timeoutMs = 180000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 900));
    try {
      const { job } = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
      onProgress?.(job);
      if (['succeeded', 'failed'].includes(job.status)) return job;
    } catch {
      return null;
    }
  }
  return null;
}

function stageLabel(stage) {
  return {
    queued: '排队中…',
    extract: '解析文档…',
    normalize: '规范化…',
    compile: '编译知识…',
    done: '完成',
    failed: '失败',
  }[stage] ?? stage;
}

function flattenNodes(nodes, depth = 0, out = []) {
  for (const node of nodes ?? []) {
    out.push({ id: node.id, name: node.name, depth });
    flattenNodes(node.children ?? [], depth + 1, out);
  }
  return out;
}
