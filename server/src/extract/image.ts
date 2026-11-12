import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtractResult } from '../types.ts';
import { cleanText } from './text-util.ts';

export interface OcrResult {
  text: string;
  languages: string;
  warning?: string;
}

function runTesseract(input: string | Buffer, languages: string): string {
  const args = ['stdin', 'stdout', '-l', languages, '--psm', '3'];
  return execFileSync('tesseract', args, {
    input,
    encoding: 'utf8',
    timeout: 90_000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
}

/** 图像 OCR：中英优先，失败时降级英文。 */
export function ocrImage(input: string | Buffer): OcrResult {
  try {
    const text = cleanText(runTesseract(input, 'chi_sim+eng'));
    return { text, languages: 'chi_sim+eng' };
  } catch (first) {
    try {
      const text = cleanText(runTesseract(input, 'eng'));
      return { text, languages: 'eng', warning: `中文 OCR 不可用，已降级英文：${(first as Error).message}` };
    } catch (second) {
      return { text: '', languages: 'none', warning: `OCR 不可用：${(second as Error).message}` };
    }
  }
}

function imageSize(filePath: string): { width?: number; height?: number } {
  try {
    const output = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', filePath], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    const width = Number(output.match(/pixelWidth:\s*(\d+)/)?.[1]);
    const height = Number(output.match(/pixelHeight:\s*(\d+)/)?.[1]);
    return { width: Number.isFinite(width) ? width : undefined, height: Number.isFinite(height) ? height : undefined };
  } catch {
    return {};
  }
}

export function extractImage(filePath: string, mime: string): ExtractResult {
  const ocr = ocrImage(filePath);
  const size = imageSize(filePath);
  const warnings: string[] = [];
  if (ocr.warning) warnings.push(ocr.warning);
  if (!ocr.text) warnings.push('图像中未识别到文字，已保留原图与缩略图');
  return {
    kind: 'image',
    text: ocr.text,
    sections: ocr.text ? [{ level: 1, title: '图像文字', text: ocr.text }] : [],
    assets: [],
    metadata: { mime, ...size, ocrLanguages: ocr.languages, ...(ocr.text ? { ocr: true } : {}) },
    pageCount: 0,
    warnings,
  };
}

/** 将任意图像 buffer 写入临时文件并 OCR（供 docx/pptx 内嵌图片使用）。 */
export function ocrBuffer(buffer: Buffer): OcrResult & { width?: number; height?: number } {
  const dir = mkdtempSync(join(tmpdir(), 'alex-ocr-'));
  const file = join(dir, 'image.bin');
  try {
    writeFileSync(file, buffer);
    const ocr = ocrImage(file);
    const size = imageSize(file);
    return { ...ocr, ...size };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function makeThumbnail(filePath: string, outputPath: string, maxSize = 720): boolean {
  try {
    execFileSync('sips', ['-Z', String(maxSize), filePath, '--out', outputPath], {
      timeout: 30_000,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}
