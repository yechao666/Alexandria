import type { Env } from '../env.ts';
import type { KnowledgeAnswer } from './search.ts';

export interface LlmSynthesis {
  answer: string;
  citations: string[];
}

/**
 * 可选的 LLM 合成层。知识库本身不依赖向量检索：
 * 先由编译器把知识写成页面，这里只负责把已选中的知识页组织成自然语言答案。
 * 未配置 LLM 时完全离线可用。
 */
export async function synthesizeWithLlm(
  env: Env,
  query: string,
  compiled: KnowledgeAnswer,
): Promise<LlmSynthesis | null> {
  const config = env.llm;
  if (!config || !compiled.citations.length) return null;
  const context = compiled.citations
    .map(
      (citation, index) =>
        `[${index + 1}] 页面：${citation.title}\n知识库：${citation.libraryName}\n内容：${citation.excerpt}`,
    )
    .join('\n\n');
  const prompt = `你是一名严谨的企业知识编辑。只能依据下面给出的“已编译知识页”回答问题；不要使用外部知识，不要编造。
如果资料不足，明确指出缺口。回答使用中文，先给结论，再用 3-5 个要点展开，并在每段末尾用 [编号] 标注引用来源。不要输出 Markdown 表格。

问题：${query}

知识页：
${context}`;

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: '你只依据给定知识页回答，任何结论都必须有引用。' },
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const answer = data.choices?.[0]?.message?.content?.trim();
    if (!answer) return null;
    return { answer, citations: compiled.citations.map((citation) => citation.pageId) };
  } catch {
    return null;
  }
}
