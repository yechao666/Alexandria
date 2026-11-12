import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { ExtractResult } from '../types.ts';
import { decodeTextBuffer } from './text-util.ts';
import { sectionsFromPlainText } from './sections.ts';

function textutil(filePath: string): string | null {
  try {
    return execFileSync('textutil', ['-convert', 'txt', '-stdout', filePath], {
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function decodeRtf(buffer: Buffer): string {
  let raw = decodeTextBuffer(buffer);
  // 移除字体表、样式表、图片等目标组，保留正文。
  for (let i = 0; i < 8; i += 1) {
    raw = raw.replace(/\{\\\*[^{}]*\}/g, ' ').replace(/\{\\(?:fonttbl|colortbl|stylesheet|info|pict)[\s\S]*?\}/g, ' ');
  }
  const bytes: number[] = [];
  let index = 0;
  while (index < raw.length) {
    const char = raw[index]!;
    if (char === '\\') {
      const next = raw[index + 1];
      if (next === "'") {
        bytes.push(parseInt(raw.slice(index + 2, index + 4), 16));
        index += 4;
        continue;
      }
      if (next === 'u') {
        const match = raw.slice(index).match(/^\\u(-?\d+)\??/);
        if (match) {
          let code = Number(match[1]);
          if (code < 0) code += 65536;
          bytes.push(...Buffer.from(String.fromCharCode(code), 'utf8'));
          index += match[0].length;
          continue;
        }
      }
      if (next === '\\' || next === '{' || next === '}') {
        bytes.push(next.charCodeAt(0));
        index += 2;
        continue;
      }
      const word = raw.slice(index + 1).match(/^([a-z]+)(-?\d+)? ?/i);
      if (word) {
        const name = word[1]!.toLowerCase();
        if (name === 'par' || name === 'line') bytes.push(10);
        else if (name === 'tab') bytes.push(9);
        index += 1 + word[0].length;
        continue;
      }
      index += 1;
      continue;
    }
    if (char === '{' || char === '}') {
      index += 1;
      continue;
    }
    bytes.push(...Buffer.from(char, 'utf8'));
    index += 1;
  }
  return Buffer.from(bytes).toString('utf8');
}

export function extractRtf(filePath: string, buffer: Buffer): ExtractResult {
  const converted = textutil(filePath);
  const text = (converted ?? decodeRtf(buffer)).replace(/\r/g, '').trim();
  const parsed = sectionsFromPlainText(text);
  return {
    kind: 'rtf',
    text: parsed.text,
    sections: parsed.sections,
    assets: [],
    metadata: { convertedBy: converted ? 'textutil' : 'builtin-rtf' },
    pageCount: 0,
    warnings: converted ? [] : ['使用内置 RTF 解析器，复杂格式可能丢失'],
  };
}

export function readRtfBuffer(buffer: Buffer): string {
  return decodeRtf(buffer);
}

export function readFileText(filePath: string): string {
  return decodeTextBuffer(readFileSync(filePath));
}
