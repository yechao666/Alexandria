import { escapeHtml } from './util.js';

/** 轻量 Markdown 渲染：标题、表格、列表、引用、代码、wikilink。 */
export function renderMarkdown(source, options = {}) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let index = 0;
  let paragraph = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${inline(paragraph.join(' '), options)}</p>`);
    paragraph = [];
  };

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      flushParagraph();
      index += 1;
      continue;
    }
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      flushParagraph();
      const language = fence[1] || '';
      const code = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1;
      html.push(`<pre class="code-block" data-lang="${escapeHtml(language)}"><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      const id = `h-${heading[2].replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 40)}`;
      html.push(`<h${level} id="${escapeHtml(id)}">${inline(heading[2], options)}</h${level}>`);
      index += 1;
      continue;
    }
    if (/^\s*---+\s*$/.test(line) || /^\s*\*\*\*+\s*$/.test(line)) {
      flushParagraph();
      html.push('<hr>');
      index += 1;
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      flushParagraph();
      const quote = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      html.push(`<blockquote>${inline(quote.join(' '), options)}</blockquote>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[index + 1] ?? '')) {
      flushParagraph();
      const header = splitRow(line);
      const rows = [];
      index += 2;
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
        rows.push(splitRow(lines[index]));
        index += 1;
      }
      html.push(
        `<div class="table-wrap"><table><thead><tr>${header.map((cell) => `<th>${inline(cell, options)}</th>`).join('')}</tr></thead><tbody>${rows
          .map((row) => `<tr>${header.map((_, i) => `<td>${inline(row[i] ?? '', options)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`,
      );
      continue;
    }
    const unordered = line.match(/^\s*[-*+]\s+(.*)$/);
    if (unordered) {
      flushParagraph();
      const items = [];
      while (index < lines.length) {
        const match = lines[index].match(/^\s*[-*+]\s+(.*)$/);
        if (!match) break;
        items.push(match[1]);
        index += 1;
      }
      html.push(`<ul>${items.map((item) => `<li>${inline(item, options)}</li>`).join('')}</ul>`);
      continue;
    }
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ordered) {
      flushParagraph();
      const items = [];
      while (index < lines.length) {
        const match = lines[index].match(/^\s*\d+[.)]\s+(.*)$/);
        if (!match) break;
        items.push(match[1]);
        index += 1;
      }
      html.push(`<ol>${items.map((item) => `<li>${inline(item, options)}</li>`).join('')}</ol>`);
      continue;
    }
    if (/^\s*<[^>]+>/.test(line)) {
      // 原始 HTML 不直出，按文本处理，避免注入。
      paragraph.push(line);
      index += 1;
      continue;
    }
    paragraph.push(line);
    index += 1;
  }
  flushParagraph();
  return html.join('\n');
}

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function inline(text, options) {
  let value = escapeHtml(String(text ?? ''));
  const codeTokens = [];
  value = value.replace(/`([^`]+)`/g, (_, code) => {
    codeTokens.push(`<code>${code}</code>`);
    return `\u0000CODE${codeTokens.length - 1}\u0000`;
  });
  value = value.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, label) => {
    const slug = target.trim();
    const text = (label ?? target).trim();
    const library = options.libraryId ? encodeURIComponent(options.libraryId) : '';
    return `<a class="wikilink" href="#/resolve/${library}/${encodeURIComponent(slug)}">${text}</a>`;
  });
  value = value.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/g, (_, label, href) => {
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  value = value.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  value = value.replace(/(^|[^\*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
  value = value.replace(/\u0000CODE(\d+)\u0000/g, (_, index) => codeTokens[Number(index)] ?? '');
  return value.replace(/\n/g, '<br>');
}

export function headingList(source) {
  const headings = [];
  for (const line of String(source ?? '').split('\n')) {
    const match = line.match(/^(#{1,4})\s+(.+)$/);
    if (match) headings.push({ level: match[1].length, title: match[2] });
  }
  return headings;
}
