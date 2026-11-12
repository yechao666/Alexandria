import type { ExtractResult, ExtractedAsset, ExtractedSection } from '../types.ts';
import { cleanText } from './text-util.ts';
import { readZip, readZipText } from './zip.ts';
import { decodeEntities } from './xml.ts';

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff', 'tif', 'emf', 'wmf']);
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  tif: 'image/tiff',
  emf: 'image/emf',
  wmf: 'image/wmf',
};

function wordText(xml: string): string {
  let value = xml
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:br\b[^>]*\/>/g, '\n')
    .replace(/<w:cr\b[^>]*\/>/g, '\n');
  const parts: string[] = [];
  for (const match of value.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)) {
    parts.push(decodeEntities(match[1] ?? ''));
  }
  return cleanText(parts.join('').replace(/[ \t]+\n/g, '\n'));
}

function headingLevel(paragraph: string): number {
  const styleMatch = paragraph.match(/<w:pStyle\s+w:val="([^"]+)"/);
  const style = styleMatch?.[1] ?? '';
  const normalized = style.toLowerCase().replace(/\s+/g, '');
  const heading = normalized.match(/^(?:heading|标题)(\d)$/);
  if (heading) return Math.max(1, Math.min(6, Number(heading[1])));
  if (/^(title|标题)$/.test(normalized)) return 1;
  const outline = paragraph.match(/<w:outlineLvl\s+w:val="(\d+)"/);
  if (outline) return Math.max(1, Math.min(6, Number(outline[1]) + 1));
  return 0;
}

function tableText(tableXml: string): string {
  const rows: string[] = [];
  for (const rowMatch of tableXml.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)) {
    const cells: string[] = [];
    for (const cellMatch of rowMatch[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)) {
      const text = wordText(cellMatch[0]).replace(/\n+/g, ' ');
      cells.push(text);
    }
    if (cells.some(Boolean)) rows.push(`| ${cells.join(' | ')} |`);
  }
  return rows.join('\n');
}

export function extractDocx(buffer: Buffer): ExtractResult {
  const entries = readZip(buffer);
  const document = readZipText(entries, 'word/document.xml');
  if (!document) throw new Error('DOCX 中未找到 word/document.xml');
  const sections: ExtractedSection[] = [];
  let current: ExtractedSection = { level: 1, title: '正文', text: '' };
  const flush = () => {
    const text = cleanText(current.text);
    if (text) sections.push({ ...current, text });
  };

  const body = document.match(/<w:body[^>]*>([\s\S]*?)<\/w:body>/)?.[1] ?? document;
  const blocks = body.match(/<w:p\b[\s\S]*?<\/w:p>|<w:tbl\b[\s\S]*?<\/w:tbl>/g) ?? [];
  for (const block of blocks) {
    if (block.startsWith('<w:tbl')) {
      const table = tableText(block);
      if (table) current.text += `${table}\n\n`;
      continue;
    }
    const level = headingLevel(block);
    const text = wordText(block);
    if (level > 0) {
      flush();
      current = { level, title: text || '未命名章节', text: '' };
    } else if (text) {
      current.text += `${text}\n`;
    }
  }
  flush();

  const core = readZipText(entries, 'docProps/core.xml');
  const metadata: Record<string, unknown> = {};
  if (core) {
    metadata.title = decodeEntities(core.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/)?.[1] ?? '');
    metadata.creator = decodeEntities(core.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/)?.[1] ?? '');
    metadata.created = core.match(/<dcterms:created[^>]*>([\s\S]*?)<\/dcterms:created>/)?.[1] ?? '';
  }

  const assets: ExtractedAsset[] = [];
  for (const [name, entry] of entries) {
    if (!name.startsWith('word/media/')) continue;
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    if (!IMAGE_EXT.has(ext) || entry.uncompressedSize > 8 * 1024 * 1024) continue;
    assets.push({
      filename: name.split('/').pop() ?? name,
      mime: IMAGE_MIME[ext] ?? 'application/octet-stream',
      kind: 'image',
      data: entry.read(),
    });
    if (assets.length >= 8) break;
  }

  const text = cleanText(sections.map((section) => `${section.title}\n${section.text}`).join('\n\n'));
  return {
    kind: 'docx',
    text,
    sections,
    assets,
    metadata,
    pageCount: 0,
    warnings: blocks.length === 0 ? ['DOCX 中未解析到段落'] : [],
  };
}
