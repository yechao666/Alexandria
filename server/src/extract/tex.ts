import { readFileSync } from 'node:fs';
import type { ExtractResult, ExtractedSection } from '../types.ts';
import { cleanText } from './text-util.ts';
import { sectionsFromPlainText } from './sections.ts';

function stripComments(source: string): string {
  return source.replace(/(^|[^\\])%.*$/gm, '$1');
}

function commandArg(source: string, command: string): string[] {
  const pattern = new RegExp(`\\\\${command}\\*?\\s*(?:\\[[^\\]]*\\])?\\{`, 'g');
  const values: string[] = [];
  for (const match of source.matchAll(pattern)) {
    const start = match.index! + match[0].length;
    let depth = 1;
    let index = start;
    while (index < source.length && depth > 0) {
      if (source[index] === '{') depth += 1;
      else if (source[index] === '}') depth -= 1;
      index += 1;
    }
    values.push(source.slice(start, index - 1));
  }
  return values;
}

const SECTION_LEVELS: Record<string, number> = {
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
};

export function extractTex(filePath: string): ExtractResult {
  const raw = stripComments(readFileSync(filePath, 'utf8'));
  const bodyMatch = raw.match(/\\begin\{document\}([\s\S]*?)\\end\{document\}/);
  const body = bodyMatch?.[1] ?? raw;
  const sections: ExtractedSection[] = [];
  const headingPattern = /\\(chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\{/g;
  let lastTitle = '正文';
  let lastIndex = 0;
  let lastLevel = 2;
  const flush = (end: number) => {
    const chunk = body.slice(lastIndex, end);
    const text = plainTex(chunk);
    if (text) sections.push({ level: lastLevel, title: lastTitle, text });
  };
  for (const match of body.matchAll(headingPattern)) {
    const start = match.index!;
    const braceStart = start + match[0].length;
    let depth = 1;
    let index = braceStart;
    while (index < body.length && depth > 0) {
      if (body[index] === '{') depth += 1;
      else if (body[index] === '}') depth -= 1;
      index += 1;
    }
    flush(start);
    lastTitle = plainTex(body.slice(braceStart, index - 1)) || '未命名章节';
    lastLevel = SECTION_LEVELS[match[1]!] ?? 2;
    lastIndex = index;
  }
  flush(body.length);

  const abstract = commandArg(body, 'abstract')[0];
  if (abstract) {
    const text = plainTex(abstract);
    if (text) sections.unshift({ level: 1, title: '摘要', text });
  }
  if (!sections.length) return { ...sectionsFromPlainText(plainTex(body)), kind: 'tex', assets: [], metadata: {}, pageCount: 0, warnings: [] };

  const text = cleanText(sections.map((section) => `${section.title}\n${section.text}`).join('\n\n'));
  return {
    kind: 'tex',
    text,
    sections,
    assets: [],
    metadata: { commands: [...new Set([...raw.matchAll(/\\\\([a-zA-Z]+)/g)].map((m) => m[1]))].slice(0, 40) },
    pageCount: 0,
    warnings: [],
  };
}

function plainTex(source: string): string {
  let text = source
    .replace(/\\begin\{(?:equation|align|eqnarray|figure|table|tabular|verbatim|lstlisting)\*?\}[\s\S]*?\\end\{(?:equation|align|eqnarray|figure|table|tabular|verbatim|lstlisting)\*?\}/g, ' ')
    .replace(/\\(?:cite|ref|label|footnote|index|bibliography|bibliographystyle)\*?(?:\[[^\]]*\])?\{[^}]*\}/g, ' ')
    .replace(/\\(?:begin|end)\{[^}]*\}/g, ' ')
    .replace(/\\(?:textbf|textit|emph|underline|text|mathrm|mathbf|operatorname)\{([^{}]*)\}/g, '$1')
    .replace(/\\\[([\s\S]*?)\\\]/g, '$1')
    .replace(/\$\$?([\s\S]*?)\$\$?/g, '$1')
    .replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?/g, ' ')
    .replace(/\\[\\{}%$&#_^~]/g, ' ')
    .replace(/[{}]/g, ' ');
  text = text.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n');
  return cleanText(text);
}
