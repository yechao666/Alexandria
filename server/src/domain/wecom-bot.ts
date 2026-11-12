import type { Db } from '../db/index.ts';
import type { Env } from '../env.ts';
import { actorFor } from './access.ts';
import { audit } from './audit.ts';
import { answerKnowledge, searchKnowledge } from '../knowledge/search.ts';

export interface WecomAnswer {
  reply: string;
  mode: 'ask' | 'search' | 'help' | 'unbound';
  citations: unknown[];
  hits: number;
  matched: boolean;
}

const HELP = '【Alexandria】可用指令：\n/ask 知识编译是什么？\n/search 本体论\n也可以直接提问；回答来自已编译知识页并带引用。';

/** 企微 JSON / 加密 XML 回调共用的问答逻辑。 */
export function answerWecomText(db: Db, env: Env, input: { senderWecomId: string; text: string; chatId?: string }): WecomAnswer {
  const senderId = String(input.senderWecomId ?? '').trim();
  const raw = String(input.text ?? '').trim();
  const personRow = db
    .prepare("SELECT * FROM persons WHERE lower(wecom_userid) = lower(?) AND status = 'active'")
    .get(senderId) as unknown as Record<string, unknown> | undefined;
  if (!personRow) {
    return {
      reply: `企业微信账号 ${senderId || '(未知)'} 尚未绑定 Alexandria 成员，请联系管理员在「团队与权限 → 成员目录」完成绑定。`,
      mode: 'unbound',
      citations: [],
      hits: 0,
      matched: false,
    };
  }
  const person = {
    id: String(personRow.id),
    email: String(personRow.email),
    name: String(personRow.name),
    title: String(personRow.title ?? ''),
    avatarColor: String(personRow.avatar_color ?? 'clay'),
    isAdmin: Boolean(personRow.is_admin),
  };
  const actor = actorFor(db, person);
  let command: 'ask' | 'search' | 'help' = 'ask';
  let query = raw;
  if (/^\/(search|s)\s+/i.test(raw)) {
    command = 'search';
    query = raw.replace(/^\/(search|s)\s+/i, '').trim();
  } else if (/^\/ask\s+/i.test(raw)) {
    query = raw.replace(/^\/ask\s+/i, '').trim();
  } else if (/^\/(help|帮助)\s*$/i.test(raw) || !raw) {
    return { reply: HELP, mode: 'help', citations: [], hits: 0, matched: true };
  }
  if (!query) return { reply: '【Alexandria】请输入问题，或发送 /help 查看指令。', mode: 'help', citations: [], hits: 0, matched: true };

  if (command === 'search') {
    const hits = searchKnowledge(db, actor, query, { limit: 5 });
    const lines = hits.length
      ? hits.map((hit, index) => `${index + 1}. ${hit.title}〔${hit.libraryName}〕\n   ${hit.snippet.slice(0, 90)}`).join('\n')
      : '没有命中的知识页。';
    audit(db, { actor, action: 'wecom.im.search', targetType: 'search', detail: { query, hits: hits.length, senderId, chatId: input.chatId ?? null } });
    return {
      reply: `【Alexandria】检索「${query}」：\n${lines}`,
      mode: 'search',
      citations: [],
      hits: hits.length,
      matched: hits.length > 0,
    };
  }

  const answer = answerKnowledge(db, actor, query, { limit: 5 });
  const citations = answer.citations.map((citation, index) => `[${index + 1}] ${citation.title} · ${citation.libraryName}`).join('\n');
  const reply = answer.citations.length
    ? `【Alexandria】${answer.answer.replace(/\n\n以上结论.*$/s, '').slice(0, 1200)}\n\n引用：\n${citations}`
    : '【Alexandria】知识库中暂未找到与此问题直接相关的已编译知识。可以上传资料或换一种问法。';
  audit(db, {
    actor,
    action: 'wecom.im.ask',
    targetType: 'search',
    detail: { query, citations: answer.citations.length, senderId, chatId: input.chatId ?? null },
  });
  return {
    reply,
    mode: 'ask',
    citations: answer.citations,
    hits: answer.citations.length,
    matched: answer.citations.length > 0,
  };
}
