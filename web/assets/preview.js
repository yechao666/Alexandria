import { api, openModal, escapeHtml as esc, fmtBytes, icon, timeAgo } from './core.js';

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);
const TEXT_EXT = new Set(['md', 'markdown', 'txt', 'csv', 'json', 'html', 'htm', 'tex', 'log', 'xml', 'yaml', 'yml']);
const OFFICE_EXT = new Set(['doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'odt', 'odp', 'ods']);

function extOf(source) {
  return String(source.ext ?? source.filename?.split('.').pop() ?? '').toLowerCase();
}

export async function openFilePreview(source) {
  const ext = extOf(source);
  const isImage = IMAGE_EXT.has(ext) || source.kind === 'image';
  const isPdf = ext === 'pdf' || source.mime === 'application/pdf';
  const isText = TEXT_EXT.has(ext);
  const isOffice = OFFICE_EXT.has(ext);
  const downloadUrl = `/api/sources/${encodeURIComponent(source.id)}/download`;
  const body = openModal({
    title: `预览 · ${source.title}`,
    wide: true,
    body: `<div class="preview-head"><span class="preview-kind">${esc(ext.toUpperCase() || '文件')}</span><span>${esc(source.filename ?? '')} · ${fmtBytes(source.size)}</span><span class="faint">${timeAgo(source.createdAt)}</span></div><div id="preview-body" class="preview-body"><div class="preview-loading">${icon('clock', 18)} 正在加载预览…</div></div>`,
    footer: `<a class="btn" href="${downloadUrl}" target="_blank">${icon('external', 13)} 下载原文</a><button class="btn btn-primary" data-close-modal>关闭</button>`,
  });
  const target = body.querySelector('#preview-body');
  if (!target) return;

  if (isImage) {
    target.innerHTML = `<div class="preview-image-wrap"><img class="preview-image" src="${downloadUrl}" alt="${esc(source.title)}"></div>`;
    return;
  }
  if (isPdf) {
    target.innerHTML = `<iframe class="preview-frame" src="${downloadUrl}#toolbar=1&navpanes=0" title="${esc(source.title)}"></iframe>`;
    return;
  }
  try {
    const data = await api(`/api/sources/${encodeURIComponent(source.id)}/text`);
    const text = String(data.text ?? '').trim();
    target.innerHTML = `<div class="preview-source-note">${isOffice ? 'Office 原排版无法在浏览器直接渲染，以下为入库时提取的文本。' : isText ? '文本预览（原文以文件为准）。' : '该格式不支持原生预览，以下为提取文本。'}</div><pre class="preview-text">${esc(text || '（未提取到文本）')}</pre>`;
  } catch (error) {
    target.innerHTML = `<div class="preview-error">${icon('x', 18)} 无法加载预览：${esc(error.message)}</div>`;
  }
}
