import type { ExtractedSection } from '../types.ts';
import { cleanText } from './text-util.ts';

export interface SectionedText {
  text: string;
  sections: ExtractedSection[];
}

/** 从 Markdown / 纯文本中按标题层级构建 section。 */
export function sectionsFromMarkdown(markdown: string): SectionedText {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const sections: ExtractedSection[] = [];
  let current: ExtractedSection = { level: 0, title: '正文', text: '' };
  const preamble: string[] = [];
  let inCode = false;
  let seenHeading = false;

  const flush = () => {
    const text = cleanText(current.text);
    if (text) sections.push({ ...current, text });
  };

  for (const line of lines) {
    if (/^```/.test(line.trim())) inCode = !inCode;
    const heading = !inCode ? line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/) : null;
    if (heading) {
      flush();
      seenHeading = true;
      current = { level: heading[1]!.length, title: heading[2]!.trim(), text: '' };
    } else {
      if (!seenHeading) preamble.push(line);
      current.text += `${line}\n`;
    }
  }
  flush();
  if (!sections.length) {
    const text = cleanText(markdown);
    return { text, sections: text ? [{ level: 1, title: '正文', text }] : [] };
  }
  const text = cleanText([...preamble, ...sections.map((s) => s.text)].join('\n\n'));
  return { text, sections };
}

/** 纯文本：按空行或编号标题切 section，避免只有一大块。 */
export function sectionsFromPlainText(text: string): SectionedText {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) return { text: '', sections: [] };
  const lines = normalized.split('\n');
  const sections: ExtractedSection[] = [];
  let current: ExtractedSection = { level: 1, title: '正文', text: '' };
  const isHeading = (line: string) =>
    /^\s*(?:第[一二三四五六七八九十百]+[章节]|[一二三四五六七八九十]+、|\d+(?:\.\d+)*[.、\s])\s*\S/.test(line) &&
    line.trim().length <= 40;

  for (const line of lines) {
    if (isHeading(line) && current.text.trim()) {
      const limit = current.text.trim().slice(0, 2000);
      sections.push({ ...current, text: cleanText(limit) });
      current = { level: 2, title: line.trim().replace(/^[\d一二三四五六七八九十.、\s]+/, ''), text: '' };
    } else if (isHeading(line) && !current.text.trim()) {
      current = { level: 2, title: line.trim().replace(/^[\d一二三四五六七八九十.、\s]+/, ''), text: '' };
    } else {
      current.text += `${line}\n`;
    }
  }
  if (current.text.trim()) sections.push({ ...current, text: cleanText(current.text) });
  if (!sections.length) sections.push({ level: 1, title: '正文', text: cleanText(normalized) });
  return { text: cleanText(normalized), sections };
}
