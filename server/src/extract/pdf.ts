import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import type { ExtractResult, ExtractedSection } from '../types.ts';
import { cleanText } from './text-util.ts';
import { splitPdfText } from './pdf-util.ts';
import { ocrImage } from './image.ts';

const PY_SCRIPT = `
import sys, json
try:
    from pypdf import PdfReader
except Exception as e:
    print(json.dumps({"error": "pypdf unavailable: %s" % e}))
    sys.exit(0)
path = sys.argv[1]
try:
    reader = PdfReader(path)
    pages = []
    for i, page in enumerate(reader.pages):
        try:
            text = page.extract_text() or ""
        except Exception:
            text = ""
        pages.append({"page": i + 1, "text": text})
    meta = {}
    try:
        info = reader.metadata or {}
        for key in ("/Title", "/Author", "/Subject", "/Creator", "/Producer"):
            value = info.get(key)
            if value:
                meta[key.lstrip("/").lower()] = str(value)
    except Exception:
        pass
    print(json.dumps({"pages": pages, "metadata": meta}, ensure_ascii=False))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`;

const PY_IMAGES = `
import base64, json, sys
try:
    from pypdf import PdfReader
except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(0)
try:
    reader = PdfReader(sys.argv[1])
    out = []
    for i, page in enumerate(reader.pages):
        text = ""
        try:
            text = page.extract_text() or ""
        except Exception:
            text = ""
        if len(text.strip()) > 24:
            continue
        try:
            images = list(page.images)
        except Exception:
            images = []
        if not images:
            continue
        image = max(images, key=lambda item: len(item.data))
        name = image.name or ("page-%d" % (i + 1))
        mime = "image/jpeg"
        lower = name.lower()
        if lower.endswith(".png"):
            mime = "image/png"
        elif lower.endswith(".tif") or lower.endswith(".tiff"):
            mime = "image/tiff"
        out.append({"page": i + 1, "name": name, "mime": mime, "data": base64.b64encode(image.data).decode("ascii")})
    print(json.dumps(out, ensure_ascii=False))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`;

interface PdfImage {
  page: number;
  name: string;
  mime: string;
  data: Buffer;
}

function extractPageImages(filePath: string): { images: PdfImage[]; warnings: string[] } {
  try {
    const raw = execFileSync('python3', ['-c', PY_IMAGES, filePath], {
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed = JSON.parse(raw.trim() || '[]') as
      | (Omit<PdfImage, 'data'> & { data: string })[]
      | { error: string };
    if (!Array.isArray(parsed)) return { images: [], warnings: [`PDF 页面图片抽取失败：${parsed.error}`] };
    return {
      images: parsed.slice(0, 24).map((item) => ({ ...item, data: Buffer.from(item.data, 'base64') })),
      warnings: [],
    };
  } catch (error) {
    return { images: [], warnings: [`PDF 页面图片抽取不可用：${(error as Error).message}`] };
  }
}

export function extractPdf(filePath: string): ExtractResult {
  let pages: { page: number; text: string }[] = [];
  const metadata: Record<string, unknown> = {};
  const warnings: string[] = [];

  try {
    const raw = execFileSync('python3', ['-c', PY_SCRIPT, filePath], {
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 128 * 1024 * 1024,
    });
    const parsed = JSON.parse(raw.trim() || '{}') as {
      pages?: { page: number; text: string }[];
      metadata?: Record<string, unknown>;
      error?: string;
    };
    if (parsed.error) warnings.push(`pypdf 解析失败：${parsed.error}`);
    pages = parsed.pages ?? [];
    Object.assign(metadata, parsed.metadata ?? {});
  } catch (error) {
    warnings.push(`PDF 解析器不可用：${(error as Error).message}`);
  }

  let text = cleanText(pages.map((page) => page.text).join('\n\n'));
  if (!text) {
    text = basicPdfText(filePath);
    if (text) warnings.push('已使用基础 PDF 文本抽取，复杂字体可能显示为乱码');
  }

  const sections: ExtractedSection[] = pages
    .filter((page) => cleanText(page.text))
    .map((page) => ({
      level: 1,
      title: `第 ${page.page} 页`,
      text: cleanText(page.text),
      page: page.page,
    }));
  if (!sections.length && text) sections.push(...splitPdfText(text));

  // 扫描版 PDF：没有文本层时，抽取页面内嵌图片做 OCR。
  const assets: ExtractResult['assets'] = [];
  if (text.length < 48) {
    const pageImages = extractPageImages(filePath);
    warnings.push(...pageImages.warnings);
    for (const image of pageImages.images) {
      const ocr = ocrImage(image.data);
      if (ocr.warning) warnings.push(ocr.warning);
      if (!ocr.text) continue;
      const sectionText = cleanText(ocr.text);
      sections.push({ level: 1, title: `第 ${image.page} 页（OCR）`, text: sectionText, page: image.page });
      assets.push({ filename: image.name, mime: image.mime, kind: 'image', data: image.data, ocrText: sectionText });
      text = cleanText(`${text}\n\n${sectionText}`);
    }
    if (assets.length) {
      metadata.ocrPages = assets.length;
      warnings.push(`检测到扫描版 PDF，已对 ${assets.length} 页内嵌图片做 OCR`);
    } else if (!text) {
      warnings.push('该 PDF 没有文本层，也未抽取到可 OCR 的页面图片');
    }
  }

  return {
    kind: 'pdf',
    text,
    sections,
    assets,
    metadata: { ...metadata, pages: pages.length || sections.length },
    pageCount: pages.length || sections.length,
    warnings,
  };
}

/** 兜底：扫描 Flate 流，提取 Tj/TJ 字符串；只作为 pypdf 不可用时的降级。 */
function basicPdfText(filePath: string): string {
  const buffer = readFileSync(filePath);
  const chunks: string[] = [];
  const streamPattern = /stream\r?\n([\s\S]*?)endstream/g;
  for (const match of buffer.toString('latin1').matchAll(streamPattern)) {
    let content = Buffer.from(match[1]!, 'latin1');
    try {
      content = inflateSync(content);
    } catch {
      /* 非 Flate 流直接尝试 */
    }
    const raw = content.toString('latin1');
    if (!/\bTj\b|\bTJ\b/.test(raw)) continue;
    for (const textMatch of raw.matchAll(/\((?:\\.|[^\\()])*\)\s*Tj/g)) {
      chunks.push(decodePdfString(textMatch[0].slice(1, textMatch[0].lastIndexOf(')'))));
    }
    for (const arrayMatch of raw.matchAll(/\[([\s\S]*?)\]\s*TJ/g)) {
      const parts = [...arrayMatch[1]!.matchAll(/\((?:\\.|[^\\()])*\)/g)].map((m) =>
        decodePdfString(m[0].slice(1, -1)),
      );
      if (parts.length) chunks.push(parts.join(''));
    }
    chunks.push('\n');
  }
  return cleanText(chunks.join(''));
}

function decodePdfString(value: string): string {
  return value
    .replace(/\\([nrtbf])/g, (_, char: string) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' })[char] ?? char)
    .replace(/\\([0-7]{1,3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)))
    .replace(/\\(.)/g, '$1');
}
