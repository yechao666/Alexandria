import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  read(): Buffer;
}

/**
 * 最小 ZIP 读取器（docx/pptx/xlsx 都是 ZIP）。
 * 仅支持 store/deflate，拒绝 ZIP64；足以覆盖 Office Open XML。
 */
export function readZip(buffer: Buffer): Map<string, ZipEntry> {
  const entries = new Map<string, ZipEntry>();
  let eocd = -1;
  const min = Math.max(0, buffer.length - 66_000);
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件（找不到 EOCD）');
  const total = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (total === 0xffff || offset === 0xffffffff) throw new Error('暂不支持 ZIP64 文件');

  for (let index = 0; index < total; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('ZIP 中央目录损坏');
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const nameBytes = buffer.subarray(offset + 46, offset + 46 + nameLength);
    const name = nameBytes.toString(flags & 0x800 ? 'utf8' : 'latin1').replace(/\\/g, '/');

    entries.set(name, {
      name,
      method,
      compressedSize,
      uncompressedSize,
      read: () => {
        if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`ZIP 本地头损坏：${name}`);
        const localNameLength = buffer.readUInt16LE(localOffset + 26);
        const localExtraLength = buffer.readUInt16LE(localOffset + 28);
        const start = localOffset + 30 + localNameLength + localExtraLength;
        const compressed = buffer.subarray(start, start + compressedSize);
        if (method === 0) return Buffer.from(compressed);
        if (method === 8) return inflateRawSync(compressed);
        throw new Error(`不支持的 ZIP 压缩方式 ${method}：${name}`);
      },
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export function readZipText(entries: Map<string, ZipEntry>, name: string): string {
  const entry = entries.get(name);
  if (!entry) return '';
  return entry.read().toString('utf8');
}
