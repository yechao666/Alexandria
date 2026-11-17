export interface PageBlock {
  id: string;
  heading: string;
  level: number;
  markdown: string;
}

export function parsePageBlocks(body: string): PageBlock[] {
  const lines = String(body ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks: PageBlock[] = [];
  let start = 0;
  let heading = '';
  let level = 0;
  const push = (end: number) => {
    const markdown = lines.slice(start, end).join('\n').trim();
    if (!markdown) return;
    const id = `b${blocks.length + 1}`;
    blocks.push({ id, heading: heading || '开头', level, markdown });
  };
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(#{1,4})\s+(.+)$/);
    if (!match) continue;
    push(index);
    start = index;
    level = match[1].length;
    heading = match[2].trim();
  }
  push(lines.length);
  return blocks;
}

export function replacePageBlock(body: string, blockId: string, markdown: string): string | null {
  const blocks = parsePageBlocks(body);
  const target = blocks.find((block) => block.id === blockId);
  if (!target) return null;
  return blocks.map((block) => (block.id === target.id ? markdown.trim() : block.markdown)).join('\n\n').trim() + '\n';
}
