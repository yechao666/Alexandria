import type { ExtractResult, ExtractedSection } from '../types.ts';
import { cleanText } from './text-util.ts';
import { readZip, readZipText } from './zip.ts';
import { decodeEntities } from './xml.ts';

function sharedStrings(entries: Map<string, ReturnType<typeof readZip> extends Map<string, infer E> ? E : never>): string[] {
  const xml = readZipText(entries, 'xl/sharedStrings.xml');
  if (!xml) return [];
  const values: string[] = [];
  for (const match of xml.matchAll(/<si\b[\s\S]*?<\/si>/g)) {
    const parts: string[] = [];
    for (const textMatch of match[0].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) {
      parts.push(decodeEntities(textMatch[1] ?? ''));
    }
    values.push(parts.join(''));
  }
  return values;
}

function cellValue(cellXml: string, strings: string[]): string {
  const type = cellXml.match(/\bt="([^"]+)"/)?.[1] ?? '';
  const inline = cellXml.match(/<is\b[\s\S]*?<\/is>/)?.[0];
  if (inline) {
    const parts = [...inline.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decodeEntities(m[1] ?? ''));
    return parts.join('');
  }
  const value = cellXml.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/)?.[1] ?? '';
  if (type === 's') return strings[Number(value)] ?? '';
  if (type === 'b') return value === '1' ? 'TRUE' : 'FALSE';
  return decodeEntities(value);
}

function columnIndex(ref: string): number {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? 'A';
  let index = 0;
  for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

export function extractXlsx(buffer: Buffer): ExtractResult {
  const entries = readZip(buffer);
  const strings = sharedStrings(entries);
  const sheets = [...entries.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/sheet(\d+)/)?.[1] ?? 0) - Number(b.match(/sheet(\d+)/)?.[1] ?? 0));
  if (!sheets.length) throw new Error('XLSX 中未找到工作表');

  const sections: ExtractedSection[] = [];
  sheets.forEach((name, sheetIndex) => {
    const xml = readZipText(entries, name);
    const rows: string[][] = [];
    for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const cellMatch of rowMatch[1]!.matchAll(/<c\b[^>]*>([\s\S]*?)<\/c>/g)) {
        const tag = cellMatch[0]!.slice(0, cellMatch[0]!.indexOf('>') + 1);
        const ref = tag.match(/\br="([A-Z]+\d+)"/)?.[1] ?? 'A1';
        const index = columnIndex(ref);
        while (cells.length < index) cells.push('');
        cells[index] = cellValue(cellMatch[0]!, strings);
      }
      if (cells.some((cell) => cell.trim())) rows.push(cells);
      if (rows.length >= 500) break;
    }
    if (!rows.length) return;
    const width = Math.max(...rows.map((row) => row.length));
    const normalized = rows.map((row) => [...row, ...Array(width - row.length).fill('')]);
    const table = [
      `| ${normalized[0]!.map((cell) => cell.replace(/\|/g, '\\|') || ' ').join(' | ')} |`,
      `| ${normalized[0]!.map(() => '---').join(' | ')} |`,
      ...normalized.slice(1).map((row) => `| ${row.map((cell) => cell.replace(/\|/g, '\\|') || ' ').join(' | ')} |`),
    ].join('\n');
    sections.push({
      level: 1,
      title: `工作表 ${sheetIndex + 1}`,
      text: cleanText(`${table}\n\n共 ${rows.length} 行`),
      page: sheetIndex + 1,
    });
  });

  const text = cleanText(sections.map((section) => `${section.title}\n${section.text}`).join('\n\n'));
  return {
    kind: 'xlsx',
    text,
    sections,
    assets: [],
    metadata: { sheets: sheets.length, rows: sections.length },
    pageCount: sheets.length,
    warnings: [],
  };
}
