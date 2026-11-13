import { api, openModal, escapeHtml as esc, fmtBytes, icon, timeAgo } from './core.js';

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);
const TEXT_EXT = new Set(['md', 'markdown', 'txt', 'csv', 'json', 'html', 'htm', 'tex', 'log', 'xml', 'yaml', 'yml']);
const OFFICE_EXT = new Set(['doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'odt', 'odp', 'ods']);
const DOCX_EXT = new Set(['docx', 'doc']);
const PPTX_EXT = new Set(['pptx', 'ppt']);
const XLSX_EXT = new Set(['xlsx', 'xls']);

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
  if (DOCX_EXT.has(ext) && window.docx) {
    try {
      target.innerHTML = `<div class="preview-source-note">DOCX 文档预览 · 使用 docx-preview 在浏览器内渲染。</div><div class="docx-preview" id="docx-preview"></div>`;
      const buffer = await fetchBuffer(source);
      await window.docx.renderAsync(buffer, target.querySelector('#docx-preview'), null, {
        inWrapper: true, ignoreWidth: false, ignoreHeight: false, breakPages: true,
        ignoreLastRenderedPageBreak: false, useBase64URL: true, renderHeaders: true,
        renderFooters: true, renderFootnotes: true, renderEndnotes: true,
      });
      return;
    } catch (error) {
      target.innerHTML = `<div class="preview-error">${icon('x', 18)} DOCX 预览失败：${esc(error.message)}</div>`;
      return;
    }
  }
  if (PPTX_EXT.has(ext) && window.pptxPreview) {
    try {
      target.innerHTML = `<div class="preview-source-note">PPTX 幻灯片预览 · 使用 pptx-preview 在浏览器内渲染。</div><div class="pptx-preview" id="pptx-preview"></div>`;
      const buffer = await fetchBuffer(source);
      const previewer = window.pptxPreview.init(target.querySelector('#pptx-preview'), { width: 960, height: 540 });
      await previewer.preview(buffer);
      return;
    } catch (error) {
      target.innerHTML = `<div class="preview-error">${icon('x', 18)} PPTX 预览失败：${esc(error.message)}</div>`;
      return;
    }
  }
  if (XLSX_EXT.has(ext) && window.XLSX) {
    try {
      target.innerHTML = `<div class="preview-source-note">工作簿预览 · 使用 SheetJS 渲染前 3 个工作表。</div><div class="sheet-preview" id="sheet-preview"></div>`;
      const buffer = await fetchBuffer(source);
      const workbook = window.XLSX.read(new Uint8Array(buffer), { type: 'array' });
      target.querySelector('#sheet-preview').innerHTML = workbook.SheetNames.slice(0, 3).map((name) => `<section class="sheet-block"><div class="sheet-name">${esc(name)}</div>${window.XLSX.utils.sheet_to_html(workbook.Sheets[name], { header: '', footer: '' })}</section>`).join('');
      return;
    } catch (error) {
      target.innerHTML = `<div class="preview-error">${icon('x', 18)} 表格预览失败：${esc(error.message)}</div>`;
      return;
    }
  }
  try {
    const data = await api(`/api/sources/${encodeURIComponent(source.id)}/text`);
    const text = String(data.text ?? '').trim();
    target.innerHTML = `<div class="preview-source-note">${isOffice ? '该 Office 格式暂无浏览器渲染器，以下为入库时提取的文本。' : isText ? '文本预览（原文以文件为准）。' : '该格式不支持原生预览，以下为提取文本。'}</div><pre class="preview-text">${esc(text || '（未提取到文本）')}</pre>`;
  } catch (error) {
    target.innerHTML = `<div class="preview-error">${icon('x', 18)} 无法加载预览：${esc(error.message)}</div>`;
  }
}

async function fetchBuffer(source) {
  const response = await fetch(`/api/sources/${encodeURIComponent(source.id)}/download`, { credentials: 'include' });
  if (!response.ok) throw new Error(`下载失败（${response.status}）`);
  return response.arrayBuffer();
}
