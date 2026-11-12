import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import type { ExtractResult, ExtractedSection } from '../types.ts';
import { cleanText } from './text-util.ts';
import { splitPdfText } from './pdf-util.ts';

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

  return {
    kind: 'pdf',
    text,
    sections,
    assets: [],
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
