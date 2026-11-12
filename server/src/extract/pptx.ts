import type { ExtractResult, ExtractedAsset, ExtractedSection } from '../types.ts';
import { cleanText } from './text-util.ts';
import { readZip, readZipText } from './zip.ts';
import { decodeEntities } from './xml.ts';

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff', 'tif']);
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  tif: 'image/tiff',
};

function slideNumber(name: string): number {
  return Number(name.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
}

export function extractPptx(buffer: Buffer): ExtractResult {
  const entries = readZip(buffer);
  const slides = [...entries.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b));
  if (!slides.length) throw new Error('PPTX 中未找到幻灯片');

  const sections: ExtractedSection[] = [];
  slides.forEach((name, index) => {
    const xml = readZipText(entries, name);
    const paragraphs: string[] = [];
    for (const match of xml.matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)) {
      const parts: string[] = [];
      for (const textMatch of match[0].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)) {
        parts.push(decodeEntities(textMatch[1] ?? ''));
      }
      const text = cleanText(parts.join(''));
      if (text) paragraphs.push(text);
    }
    if (!paragraphs.length) return;
    const title = paragraphs[0]!.slice(0, 80);
    sections.push({
      level: 1,
      title: title || `第 ${index + 1} 页`,
      text: paragraphs.slice(1).join('\n') || paragraphs[0]!,
      page: index + 1,
    });
  });

  const assets: ExtractedAsset[] = [];
  for (const [name, entry] of entries) {
    if (!name.startsWith('ppt/media/')) continue;
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    if (!IMAGE_EXT.has(ext) || entry.uncompressedSize > 8 * 1024 * 1024) continue;
    assets.push({
      filename: name.split('/').pop() ?? name,
      mime: IMAGE_MIME[ext] ?? 'application/octet-stream',
      kind: 'image',
      data: entry.read(),
    });
    if (assets.length >= 10) break;
  }

  const text = cleanText(sections.map((section) => `${section.title}\n${section.text}`).join('\n\n'));
  return {
    kind: 'pptx',
    text,
    sections,
    assets,
    metadata: { slides: slides.length },
    pageCount: slides.length,
    warnings: [],
  };
}
