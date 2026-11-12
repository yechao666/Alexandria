const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/gu;
const LATIN_WORD = /[A-Za-z][A-Za-z0-9_.+#-]{1,40}/g;
const NUMBER = /\d+(?:\.\d+)?%?/g;

export const STOPWORDS = new Set(
  `的 了 和 与 及 或 在 是 为 对 从 到 把 被 将 让 给 由 于 中 上 下 内 外 这 那 这些 那些 一个 一种 一些 我们 你们 他们 它 其 之 而 也 都 就 还 又 很 更 最 可以 能够 需要 应该 通过 进行 以及 这个 那个 如果 因为 所以 但是 不过 并且 然后 其中 之后 之前 目前 已经 没有 不是 不能 可能 主要 相关 方面 问题 情况 内容 方式 方法 过程 时候 同时 对于 关于 根据 由于 以便 并不 不会 这种 这类 这样 那么 什么 如何 为什么 是否 哪些 某个 每个 各种 一种 一下 一点 一些 这里 那里
  the a an and or of to in on for with by from as at is are was were be been being this that these those it its we you they i he she not no can could should would may might will just also than then there here what which who whom whose when where why how all any both each few more most other some such only own same so too very s t don now`.split(
    /\s+/,
  ),
);

export function isCjk(char: string): boolean {
  return CJK.test(char);
}

/** FTS 分词：CJK 输出单字与双字，拉丁输出词与数字。 */
export function tokenize(text: string): string[] {
  const input = String(text ?? '');
  const tokens: string[] = [];
  for (const match of input.matchAll(CJK_RUN)) {
    const run = match[0]!;
    for (const char of run) tokens.push(char);
    for (let i = 0; i < run.length - 1; i += 1) tokens.push(run.slice(i, i + 2));
    if (run.length <= 6) tokens.push(run);
  }
  for (const match of input.matchAll(LATIN_WORD)) {
    const word = match[0]!.toLowerCase();
    if (!STOPWORDS.has(word)) tokens.push(word);
  }
  for (const match of input.matchAll(NUMBER)) tokens.push(match[0]!);
  return tokens;
}

export function termsString(text: string): string {
  return Array.from(new Set(tokenize(text))).join(' ');
}

/** 查询分词：保留有意义的长 token，同时保留拉丁词。 */
export function queryTokens(query: string): string[] {
  const raw = String(query ?? '').trim();
  if (!raw) return [];
  const tokens = tokenize(raw).filter((token) => {
    if (/^[a-z]/.test(token)) return token.length >= 2 && !STOPWORDS.has(token);
    if (/^\d/.test(token)) return true;
    return token.length >= 1 && !STOPWORDS.has(token);
  });
  const unique = Array.from(new Set(tokens));
  // 去掉被更长 token 覆盖的 CJK 单字，降低噪声；双字仍保留以提升召回。
  const longCjk = unique.filter((t) => CJK.test(t) && t.length >= 2);
  return unique.filter((t) => {
    if (!CJK.test(t)) return true;
    if (t.length >= 2) return true;
    return !longCjk.some((long) => long.includes(t));
  });
}

export function splitSentences(text: string): string[] {
  return String(text ?? '')
    .replace(/\r/g, '')
    .split(/(?<=[。！？!?；;])\s*|\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 4);
}

const KEYPHRASE_STOP = new Set(
  `可以 需要 应该 通过 进行 以及 这个 那个 这些 那些 我们 你们 他们 其中 之后 之前 目前 已经 没有 不是 不能 可能 主要 相关 方面 问题 情况 内容 方式 方法 过程 时候 同时 对于 关于 根据 由于 一个 一种 一些 这样 那么 什么 如何 为什么 是否 哪些 每个 各种 这里 那里 因为 所以 但是 不过 并且 然后 而且 如果 虽然 即使 无论 只是 还是 就是 也是 都是`.split(
    /\s+/,
  ),
);

/** 轻量关键短语抽取：CJK 2-5 gram 与拉丁词，按频次、长度和标题加权。 */
export function keyphrases(text: string, limit = 20, boost: string[] = []): string[] {
  const input = String(text ?? '');
  const counts = new Map<string, { score: number; freq: number }>();
  const boosted = new Set<string>();
  const add = (term: string, weight = 1) => {
    const clean = term.trim();
    if (!clean || KEYPHRASE_STOP.has(clean)) return;
    if (CJK.test(clean)) {
      if (clean.length < 2 || clean.length > 5) return;
      if (/^[的了和与及或在是为对从把被将让给由于中上下内外这那其之而也都就还又很更最]/.test(clean)) return;
      if (/[的了和与及或在是为对从把被将让给由于之而都就还又很更最]$/.test(clean)) return;
    } else if (clean.length < 3) {
      return;
    }
    const current = counts.get(clean) ?? { score: 0, freq: 0 };
    current.score += weight;
    current.freq += 1;
    counts.set(clean, current);
  };

  for (const run of input.matchAll(CJK_RUN)) {
    const value = run[0]!;
    for (let size = 2; size <= 5; size += 1) {
      for (let i = 0; i + size <= value.length; i += 1) {
        const gram = value.slice(i, i + size);
        if (KEYPHRASE_STOP.has(gram)) continue;
        add(gram, size / 4);
      }
    }
  }
  for (const match of input.matchAll(LATIN_WORD)) {
    const word = match[0]!;
    if (word.length >= 3 && !STOPWORDS.has(word.toLowerCase())) add(word, 1.5);
  }
  for (const phrase of boost) {
    for (const part of phrase.split(/[\s/、，,·]+/)) {
      boosted.add(part);
      add(part, 6);
    }
  }

  const scored = [...counts.entries()].map(([term, stats]) => ({
    term,
    freq: stats.freq,
    score: stats.score * Math.min(2.2, 1 + term.length / 8),
  }));
  scored.sort((a, b) => b.score - a.score || b.term.length - a.term.length);
  const picked: string[] = [];
  for (const item of scored) {
    if (picked.length >= limit) break;
    if (picked.some((p) => p.includes(item.term) || item.term.includes(p))) continue;
    const isBoosted = boosted.has(item.term);
    if (!isBoosted) {
      if (CJK.test(item.term) && item.freq < 2) continue;
      if (!CJK.test(item.term) && item.term.length < 3) continue;
      if (item.score < 1.6) continue;
    }
    picked.push(item.term);
  }
  return picked;
}

export function normalizeTitle(value: string): string {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s_\-·:：,，.。()（）[\]【】"“”'’/\\]+/g, '')
    .trim();
}

export function snippet(text: string, tokens: string[], length = 160): string {
  const source = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!source) return '';
  const lower = source.toLowerCase();
  let index = -1;
  for (const token of [...tokens].sort((a, b) => b.length - a.length)) {
    const found = lower.indexOf(token.toLowerCase());
    if (found >= 0) {
      index = found;
      break;
    }
  }
  if (index < 0) return source.length <= length ? source : `${source.slice(0, length - 1)}…`;
  const start = Math.max(0, index - Math.floor(length / 3));
  const end = Math.min(source.length, start + length);
  return `${start > 0 ? '…' : ''}${source.slice(start, end)}${end < source.length ? '…' : ''}`;
}

export function wordCount(text: string): number {
  const latin = (text.match(/[A-Za-z0-9]+/g) ?? []).length;
  const cjk = (text.match(CJK_RUN) ?? []).reduce((sum, run) => sum + run.length, 0);
  return latin + cjk;
}
