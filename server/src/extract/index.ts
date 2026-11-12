import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import type { ExtractResult } from '../types.ts';
import { extractDocx } from './docx.ts';
import { extractHtml } from './html.ts';
import { extractImage } from './image.ts';
import { extractOleText, sofficeToText, writeTempFile } from './ole.ts';
import { extractPdf } from './pdf.ts';
import { extractPptx } from './pptx.ts';
import { extractRtf } from './rtf.ts';
import { extractCsv, extractJson, extractMarkdown, extractText } from './text.ts';
import { sectionsFromPlainText } from './sections.ts';
import { cleanText, decodeTextBuffer } from './text-util.ts';
import { extractTex } from './tex.ts';
import { extractXlsx } from './xlsx.ts';
import { readZip, readZipText } from './zip.ts';

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'avif']);
const TEXT_EXT = new Set(['txt', 'log', 'md', 'markdown', 'csv', 'tsv', 'json', 'yaml', 'yml', 'xml', 'ini', 'conf', 'toml', 'sql', 'py', 'ts', 'js', 'tsx', 'jsx', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'sh', 'zsh']);

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  rtf: 'application/rtf',
  wps: 'application/vnd.ms-works',
  tex: 'application/x-tex',
  latex: 'application/x-tex',
  md: 'text/markdown',
  html: 'text/html',
  htm: 'text/html',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic',
  odt: 'application/vnd.oasis.opendocument.text',
  epub: 'application/epub+zip',
};

export function mimeFor(filename: string): string {
  return MIME[extOf(filename)] ?? 'application/octet-stream';
}

export function extOf(filename: string): string {
  return extname(filename).replace(/^\./, '').toLowerCase();
}

function isZip(buffer: Buffer): boolean {
  return buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && (buffer[2] === 3 || buffer[2] === 5 || buffer[2] === 7);
}

function isOle(buffer: Buffer): boolean {
  return buffer.length > 8 && buffer.readUInt32LE(0) === 0xe011cfd0;
}

function isImage(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return true;
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return true;
  if (buffer.subarray(0, 4).toString('latin1') === 'GIF8') return true;
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return true;
  if (buffer.subarray(0, 2).toString('latin1') === 'BM') return true;
  if (buffer.subarray(0, 4).toString('latin1') === 'II*\u0000' || buffer.subarray(0, 4).toString('latin1') === 'MM\u0000*') return true;
  return false;
}

function zipKind(buffer: Buffer): string | null {
  try {
    const entries = readZip(buffer);
    if (entries.has('word/document.xml')) return 'docx';
    if ([...entries.keys()].some((name) => name.startsWith('ppt/slides/slide'))) return 'pptx';
    if (entries.has('xl/workbook.xml')) return 'xlsx';
    if (entries.has('content.xml')) return 'odt';
    if (entries.has('mimetype')) {
      const mime = readZipText(entries, 'mimetype');
      if (mime.includes('opendocument.text')) return 'odt';
      if (mime.includes('epub')) return 'epub';
    }
    return null;
  } catch {
    return null;
  }
}

function extractOdt(buffer: Buffer): ExtractResult {
  const entries = readZip(buffer);
  const xml = readZipText(entries, 'content.xml');
  if (!xml) throw new Error('ODT 中未找到 content.xml');
  const sections: { level: number; title: string; text: string }[] = [];
  let current = { level: 1, title: '正文', text: '' };
  const flush = () => {
    const text = cleanText(current.text);
    if (text) sections.push({ ...current, text });
  };
  for (const match of xml.matchAll(/<text:(h|p)\b[^>]*>([\s\S]*?)<\/text:\1>/g)) {
    const isHeading = match[1] === 'h';
    const level = Number(match[0].match(/text:outline-level="(\d+)"/)?.[1] ?? 2);
    const text = cleanText(match[2]!.replace(/<text:tab\/>/g, '\t').replace(/<text:line-break\/>/g, '\n').replace(/<[^>]+>/g, ''));
    if (isHeading) {
      flush();
      current = { level, title: text || '未命名章节', text: '' };
    } else {
      current.text += `${text}\n`;
    }
  }
  flush();
  const text = cleanText(sections.map((section) => `${section.title}\n${section.text}`).join('\n\n'));
  return { kind: 'odt', text, sections, assets: [], metadata: {}, pageCount: 0, warnings: [] };
}

function extractEpub(buffer: Buffer): ExtractResult {
  const entries = readZip(buffer);
  const texts: string[] = [];
  for (const [name, entry] of entries) {
    if (!/\.(x?html?|htm)$/i.test(name) || entry.uncompressedSize > 4 * 1024 * 1024) continue;
    const html = entry.read().toString('utf8');
    texts.push(cleanText(html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')));
  }
  const parsed = sectionsFromPlainText(texts.join('\n\n'));
  return { kind: 'epub', text: parsed.text, sections: parsed.sections, assets: [], metadata: {}, pageCount: 0, warnings: [] };
}

export function extractFile(filePath: string, filename = filePath): ExtractResult {
  const buffer = readFileSync(filePath);
  return extractBuffer(buffer, filename, filePath);
}

export function extractBuffer(buffer: Buffer, filename: string, filePath?: string): ExtractResult {
  const ext = extOf(filename);
  let kind = ext;

  if (isImage(buffer) || IMAGE_EXT.has(ext)) {
    if (!filePath) {
      const temp = writeTempFile(buffer, filename);
      try {
        return extractImage(temp.path, mimeFor(filename));
      } finally {
        temp.cleanup();
      }
    }
    return extractImage(filePath, mimeFor(filename));
  }

  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-' || ext === 'pdf') {
    let path = filePath;
    let cleanup: (() => void) | undefined;
    if (!path) {
      const temp = writeTempFile(buffer, filename);
      path = temp.path;
      cleanup = temp.cleanup;
    }
    try {
      return extractPdf(path);
    } finally {
      cleanup?.();
    }
  }

  if (isZip(buffer)) {
    const detected = zipKind(buffer);
    kind = detected ?? ext;
    if (detected === 'docx' || ext === 'wps' && detected === 'docx') return extractDocx(buffer);
    if (detected === 'pptx') return extractPptx(buffer);
    if (detected === 'xlsx') return extractXlsx(buffer);
    if (detected === 'odt' || ext === 'odt') return extractOdt(buffer);
    if (detected === 'epub' || ext === 'epub') return extractEpub(buffer);
    throw new Error(`ZIP 容器未识别为受支持的文档：${filename}`);
  }

  if (buffer.subarray(0, 5).toString('latin1') === '{\\rtf' || ext === 'rtf') {
    let path = filePath;
    let cleanup: (() => void) | undefined;
    if (!path) {
      const temp = writeTempFile(buffer, filename);
      path = temp.path;
      cleanup = temp.cleanup;
    }
    try {
      return extractRtf(path, buffer);
    } finally {
      cleanup?.();
    }
  }

  if (isOle(buffer) || ['doc', 'wps', 'ppt', 'xls'].includes(ext)) {
    const temp = filePath ? null : writeTempFile(buffer, filename);
    const sourcePath = filePath ?? temp!.path;
    try {
      if (['doc', 'wps', 'ppt', 'xls', 'docx'].includes(ext)) {
        const converted = sofficeToText(sourcePath);
        if (converted) {
          const parsed = sectionsFromPlainText(converted);
          return {
            kind: ext,
            text: parsed.text,
            sections: parsed.sections,
            assets: [],
            metadata: { convertedBy: 'libreoffice' },
            pageCount: 0,
            warnings: [],
          };
        }
        if (ext === 'doc') {
          try {
            const convertedByTextutil = execFileSync('textutil', ['-convert', 'txt', '-stdout', sourcePath], {
              encoding: 'utf8',
              timeout: 60_000,
              maxBuffer: 64 * 1024 * 1024,
              stdio: ['ignore', 'pipe', 'ignore'],
            });
            if (convertedByTextutil.trim()) {
              const parsed = sectionsFromPlainText(convertedByTextutil);
              return {
                kind: 'doc',
                text: parsed.text,
                sections: parsed.sections,
                assets: [],
                metadata: { convertedBy: 'textutil' },
                pageCount: 0,
                warnings: [],
              };
            }
          } catch {
            /* fallback OLE */
          }
        }
      }
      const ole = extractOleText(buffer);
      const parsed = sectionsFromPlainText(ole.text);
      return {
        kind: ext || 'ole',
        text: parsed.text,
        sections: parsed.sections,
        assets: [],
        metadata: { convertedBy: 'ole-fallback' },
        pageCount: 0,
        warnings: [...ole.warnings, ...(parsed.text ? [] : ['未能从二进制文档中提取文本'])],
      };
    } finally {
      temp?.cleanup();
    }
  }

  switch (ext) {
    case 'md':
    case 'markdown':
      return extractMarkdown(buffer);
    case 'html':
    case 'htm':
      return extractHtml(buffer);
    case 'tex':
    case 'latex':
      if (!filePath) {
        const temp = writeTempFile(buffer, filename);
        try {
          return extractTex(temp.path);
        } finally {
          temp.cleanup();
        }
      }
      return extractTex(filePath);
    case 'csv':
      return extractCsv(buffer);
    case 'tsv':
      return extractCsv(buffer, '\t');
    case 'json':
      return extractJson(buffer);
    default:
      if (TEXT_EXT.has(ext) || ext === '') {
        const text = decodeTextBuffer(buffer);
        const parsed = sectionsFromPlainText(text);
        return {
          kind: ext || 'text',
          text: parsed.text,
          sections: parsed.sections,
          assets: [],
          metadata: { characters: parsed.text.length },
          pageCount: 0,
          warnings: [],
        };
      }
      throw new Error(`暂不支持的文件类型 .${ext}，请上传 PDF / Word / PPT / Excel / Markdown / TeX / RTF / WPS / 图片 / HTML / CSV 等`);
  }
}
