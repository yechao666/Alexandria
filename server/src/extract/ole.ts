import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanText } from './text-util.ts';

interface CfbEntry {
  name: string;
  type: number;
  start: number;
  size: number;
}

function parseCfb(buffer: Buffer): Map<string, Buffer> {
  if (buffer.length < 512 || buffer.readUInt32LE(0) !== 0xe011cfd0) return new Map();
  const sectorShift = buffer.readUInt16LE(30);
  const sectorSize = 1 << sectorShift;
  const numFat = buffer.readUInt32LE(44);
  const firstDir = buffer.readUInt32LE(48);
  const miniCutoff = buffer.readUInt32LE(56);
  const firstDifat = buffer.readUInt32LE(68);
  const numDifat = buffer.readUInt32LE(72);

  const sectorOffset = (sector: number) => (sector + 1) * sectorSize;
  const readSector = (sector: number) => buffer.subarray(sectorOffset(sector), sectorOffset(sector) + sectorSize);

  const fatSectors: number[] = [];
  for (let i = 0; i < 109; i += 1) {
    const value = buffer.readUInt32LE(76 + i * 4);
    if (value !== 0xffffffff) fatSectors.push(value);
  }
  let difat = firstDifat;
  for (let i = 0; i < numDifat && difat !== 0xfffffffe && difat !== 0xffffffff; i += 1) {
    const sector = readSector(difat);
    const perSector = sectorSize / 4 - 1;
    for (let j = 0; j < perSector; j += 1) {
      const value = sector.readUInt32LE(j * 4);
      if (value !== 0xffffffff) fatSectors.push(value);
    }
    difat = sector.readUInt32LE(sectorSize - 4);
  }

  const fat: number[] = [];
  for (const sector of fatSectors.slice(0, numFat)) {
    const data = readSector(sector);
    for (let i = 0; i < data.length; i += 4) fat.push(data.readUInt32LE(i));
  }

  const chain = (start: number, limit = 100_000): number[] => {
    const result: number[] = [];
    let current = start;
    while (current !== 0xfffffffe && current !== 0xffffffff && result.length < limit) {
      result.push(current);
      current = fat[current] ?? 0xfffffffe;
    }
    return result;
  };
  const readChain = (start: number, size: number): Buffer => {
    const sectors = chain(start);
    const data = Buffer.concat(sectors.map(readSector));
    return data.subarray(0, Math.min(size, data.length));
  };

  const dirData = readChain(firstDir, Number.MAX_SAFE_INTEGER);
  const entries: CfbEntry[] = [];
  for (let offset = 0; offset + 128 <= dirData.length; offset += 128) {
    const nameLength = dirData.readUInt16LE(offset + 64);
    if (!nameLength || nameLength > 64) continue;
    const name = dirData.subarray(offset, offset + nameLength - 2).toString('utf16le');
    entries.push({
      name,
      type: dirData[offset + 66]!,
      start: dirData.readUInt32LE(offset + 116),
      size: Number(dirData.readBigUInt64LE(offset + 120)),
    });
  }
  const root = entries.find((entry) => entry.type === 5);
  const miniStream = root ? readChain(root.start, root.size) : Buffer.alloc(0);
  void miniCutoff;
  void miniStream;

  const streams = new Map<string, Buffer>();
  for (const entry of entries) {
    if (entry.type !== 2 || entry.size === 0 || entry.size > 100 * 1024 * 1024) continue;
    if (entry.size < miniCutoff) continue; // 小流需 miniFAT，WordDocument 通常不在此列
    try {
      streams.set(entry.name, readChain(entry.start, entry.size));
    } catch {
      /* ignore */
    }
  }
  return streams;
}

function isReadableCode(code: number): boolean {
  if (code === 9 || code === 10 || code === 13) return true;
  if (code >= 32 && code <= 126) return true;
  if (code >= 0x4e00 && code <= 0x9fff) return true;
  if (code >= 0x3000 && code <= 0x303f) return true;
  if (code >= 0xff00 && code <= 0xffef) return true;
  return false;
}

function utf16Runs(buffer: Buffer): string[] {
  const runs: string[] = [];
  let current: number[] = [];
  for (let i = 0; i + 1 < buffer.length; i += 2) {
    const code = buffer.readUInt16LE(i);
    if (isReadableCode(code)) {
      current.push(code);
    } else {
      if (current.length >= 4) runs.push(String.fromCharCode(...current));
      current = [];
    }
  }
  if (current.length >= 4) runs.push(String.fromCharCode(...current));
  return runs;
}

function asciiRuns(buffer: Buffer): string[] {
  const runs: string[] = [];
  let current = '';
  for (const byte of buffer) {
    if ((byte >= 32 && byte <= 126) || byte === 9) {
      current += String.fromCharCode(byte);
    } else {
      if (current.length >= 8) runs.push(current);
      current = '';
    }
  }
  if (current.length >= 8) runs.push(current);
  return runs;
}

function likelyText(run: string): boolean {
  const compact = run.replace(/\s+/g, '');
  if (compact.length < 4) return false;
  const letters = (compact.match(/[\p{L}\p{N}]/gu) ?? []).length;
  return letters / compact.length > 0.5;
}

/** OLE/CFB（Word 97、旧版 WPS）文本兜底抽取。 */
export function extractOleText(buffer: Buffer): { text: string; warnings: string[] } {
  const warnings: string[] = [];
  let streams: Map<string, Buffer>;
  try {
    streams = parseCfb(buffer);
  } catch (error) {
    warnings.push(`OLE 结构解析失败：${(error as Error).message}`);
    streams = new Map();
  }
  const word = streams.get('WordDocument') ?? streams.get('worddocument');
  const chunks: string[] = [];
  if (word) {
    chunks.push(...utf16Runs(word).filter(likelyText));
    chunks.push(...asciiRuns(word).filter(likelyText));
  }
  if (!chunks.length) {
    chunks.push(...utf16Runs(buffer).filter(likelyText));
  }
  const seen = new Set<string>();
  const text = cleanText(
    chunks
      .filter((chunk) => {
        const key = chunk.slice(0, 40);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .join('\n'),
  );
  warnings.push('旧版二进制文档使用兜底文本抽取，格式与顺序可能不完整；建议安装 LibreOffice 以获得高质量转换');
  return { text, warnings };
}

/** 尝试 LibreOffice 转文本；不存在时返回 null。 */
export function sofficeToText(filePath: string): string | null {
  const dir = mkdtempSync(join(tmpdir(), 'alex-office-'));
  try {
    execFileSync('soffice', ['--headless', '--convert-to', 'txt:Text', '--outdir', dir, filePath], {
      timeout: 120_000,
      stdio: 'ignore',
    });
    const base = filePath.split('/').pop()!.replace(/\.[^.]+$/, '');
    const output = join(dir, `${base}.txt`);
    return readFileSync(output, 'utf8');
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function writeTempFile(buffer: Buffer, filename: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'alex-file-'));
  const path = join(dir, filename.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_'));
  writeFileSync(path, buffer);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
