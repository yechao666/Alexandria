import type { ExtractResult, ExtractedSection } from '../types.ts';
import { cleanText, decodeTextBuffer } from './text-util.ts';
import { decodeEntities } from './xml.ts';
import { sectionsFromPlainText } from './sections.ts';

export function extractHtml(buffer: Buffer): ExtractResult {
  let html = decodeTextBuffer(buffer)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  const title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
  const sections: ExtractedSection[] = [];
  let current: ExtractedSection = { level: 1, title: title || '正文', text: '' };
  const flush = () => {
    const text = cleanText(current.text);
    if (text) sections.push({ ...current, text });
  };

  const tokens = html.split(/(<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>)/i);
  for (const token of tokens) {
    const heading = token.match(/^<h([1-6])[^>]*>([\s\S]*?)<\/h[1-6]>$/i);
    if (heading) {
      flush();
      current = { level: Number(heading[1]), title: blockText(heading[2]!) || '未命名章节', text: '' };
      continue;
    }
    current.text += `${blockText(token)}\n`;
  }
  flush();

  if (!sections.length) {
    const plain = blockText(html);
    if (plain) return { ...sectionsFromPlainText(plain), kind: 'html', assets: [], metadata: { title }, pageCount: 0, warnings: [] };
  }
  const text = cleanText(sections.map((section) => `${section.title}\n${section.text}`).join('\n\n'));
  return {
    kind: 'html',
    text,
    sections,
    assets: [],
    metadata: { title },
    pageCount: 0,
    warnings: [],
  };
}

function blockText(html: string): string {
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|section|article|header|footer|blockquote|pre|table|ul|ol)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<td[^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, '');
  return cleanText(decodeEntities(text));
}
