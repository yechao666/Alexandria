export function cleanText(input: string): string {
  return String(input ?? '')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u00ad\u200b-\u200d\ufeff]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function decodeTextBuffer(buffer: Buffer): string {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8');
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buffer.subarray(2));
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buffer.subarray(2));
  }
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  const nulls = sample.filter((byte) => byte === 0).length;
  if (nulls > sample.length * 0.15) {
    // 可能是无 BOM 的 UTF-16LE（中文 Office 文档常见）。
    try {
      const text = new TextDecoder('utf-16le').decode(buffer);
      if ((text.match(/\u0000/g) ?? []).length < text.length * 0.1) return text.replace(/\u0000/g, '');
    } catch {
      /* ignore */
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  } catch {
    return buffer.toString('latin1');
  }
}

const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff', 'tif', 'heic', 'pdf', 'docx', 'pptx', 'xlsx', 'zip', 'wps', 'doc', 'ppt', 'xls', 'rtf',
]);

export function looksBinary(path: string, buffer: Buffer): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (BINARY_EXT.has(ext)) return true;
  const sample = buffer.subarray(0, 1024);
  return sample.includes(0);
}
