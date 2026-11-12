import type { ExtractedSection } from '../types.ts';
import { cleanText } from './text-util.ts';

export function splitPdfText(text: string): ExtractedSection[] {
  const value = cleanText(text);
  if (!value) return [];
  const chunks = value.split(/\n{2,}/).filter((chunk) => chunk.trim().length > 20);
  const sections: ExtractedSection[] = [];
  let current = { level: 1, title: '正文', text: '' };
  for (const chunk of chunks) {
    if (chunk.length < 60 && /^[\d\s.、一二三四五六七八九十]+$/.test(chunk)) continue;
    if (current.text.length + chunk.length > 2400 && current.text) {
      sections.push({ ...current, text: cleanText(current.text) });
      current = { level: 1, title: `续（${sections.length + 1}）`, text: '' };
    }
    current.text += `${chunk}\n\n`;
  }
  if (current.text.trim()) sections.push({ ...current, text: cleanText(current.text) });
  return sections;
}
