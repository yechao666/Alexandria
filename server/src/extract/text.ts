import type { ExtractResult } from '../types.ts';
import { cleanText, decodeTextBuffer } from './text-util.ts';
import { sectionsFromMarkdown, sectionsFromPlainText } from './sections.ts';

export function extractMarkdown(buffer: Buffer): ExtractResult {
  const markdown = decodeTextBuffer(buffer);
  const parsed = sectionsFromMarkdown(stripFrontmatter(markdown));
  return {
    kind: 'markdown',
    text: parsed.text,
    sections: parsed.sections,
    assets: [],
    metadata: { headings: parsed.sections.length },
    pageCount: 0,
    warnings: parsed.text ? [] : ['Markdown 内容为空'],
  };
}

export function extractText(buffer: Buffer, kind = 'text'): ExtractResult {
  const text = cleanText(decodeTextBuffer(buffer));
  const parsed = sectionsFromPlainText(text);
  return {
    kind,
    text: parsed.text,
    sections: parsed.sections,
    assets: [],
    metadata: { characters: text.length },
    pageCount: 0,
    warnings: [],
  };
}

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\n[\s\S]*?\n---\n?/, '');
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const input = text.replace(/\r\n?/g, '\n');
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  row.push(field);
  if (row.some((cell) => cell.trim())) rows.push(row);
  return rows;
}

export function extractCsv(buffer: Buffer, separator = ','): ExtractResult {
  const text = decodeTextBuffer(buffer);
  const rows = parseCsv(separator === '\t' ? text.replace(/\t/g, ',') : text);
  const width = Math.max(0, ...rows.map((row) => row.length));
  const normalized = rows.map((row) => [...row, ...Array(width - row.length).fill('')]);
  const table = normalized.length
    ? [
        `| ${normalized[0]!.map((cell) => cell.replace(/\|/g, '\\|') || ' ').join(' | ')} |`,
        `| ${normalized[0]!.map(() => '---').join(' | ')} |`,
        ...normalized.slice(1, 501).map((row) => `| ${row.map((cell) => cell.replace(/\|/g, '\\|') || ' ').join(' | ')} |`),
      ].join('\n')
    : '';
  const body = cleanText(`${table}\n\n共 ${rows.length} 行 × ${width} 列`);
  return {
    kind: 'csv',
    text: body,
    sections: [{ level: 1, title: '数据表', text: body }],
    assets: [],
    metadata: { rows: rows.length, columns: width },
    pageCount: 0,
    warnings: rows.length > 500 ? ['仅索引前 500 行数据'] : [],
  };
}

export function extractJson(buffer: Buffer): ExtractResult {
  const raw = decodeTextBuffer(buffer);
  try {
    const value = JSON.parse(raw);
    let text: string;
    if (Array.isArray(value) && value.length && typeof value[0] === 'object' && value[0] !== null) {
      const keys = [...new Set(value.flatMap((item) => Object.keys(item as object)))].slice(0, 20);
      const rows = value.slice(0, 200).map((item) => keys.map((key) => String((item as Record<string, unknown>)[key] ?? '')));
      text = [
        `| ${keys.join(' | ')} |`,
        `| ${keys.map(() => '---').join(' | ')} |`,
        ...rows.map((row) => `| ${row.map((cell) => cell.replace(/\|/g, '\\|')).join(' | ')} |`),
      ].join('\n');
    } else {
      text = JSON.stringify(value, null, 2);
    }
    return {
      kind: 'json',
      text: cleanText(text),
      sections: [{ level: 1, title: 'JSON 数据', text: cleanText(text) }],
      assets: [],
      metadata: { keys: Array.isArray(value) ? value.length : Object.keys(value as object).length },
      pageCount: 0,
      warnings: [],
    };
  } catch {
    return extractText(buffer, 'json');
  }
}
