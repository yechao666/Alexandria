import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { closeServer, createTestContext, startTestServer } from './helpers.ts';
// @ts-ignore wecom-mock is a plain ESM fixture outside this package
import { createMockWeCom } from '../../wecom-mock/src/server.mjs';

const ctx = createTestContext();
const { server, base } = await startTestServer(ctx.app);
const mock = createMockWeCom({ port: 0, configPath: join(ctx.root, 'wecom-bot-config.json') });
await new Promise<void>((resolve) => mock.server.listen(0, '127.0.0.1', () => resolve()));
const address = mock.server.address();
const mockBase = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
ctx.env.wecom.baseUrl = mockBase;
ctx.env.wecom.authorizeBase = mockBase;
ctx.env.wecom.publicUrl = base;
ctx.env.wecom.mock = true;
mock.config.callbackUrl = `${base}/api/integrations/wecom/im`;
mock.config.callbackMode = 'json';

test.after(async () => {
  await mock.close();
  await closeServer(server);
  ctx.cleanup();
});

test('企微 IM 回调按 userid 映射成员并返回带引用的知识回答', async () => {
  const response = await fetch(`${base}/api/integrations/wecom/im`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ senderWecomId: 'LinWei', senderName: '林薇', text: '知识编译是什么？', chatId: 'chat_lin_bot' }),
  });
  const data = (await response.json()) as { reply: string; citations?: unknown[] };
  assert.equal(response.status, 200);
  assert.match(data.reply, /知识编译/);
  assert.match(data.reply, /引用/);
  assert.ok((data.citations?.length ?? 0) > 0);
});

test('未绑定企微账号会得到明确的绑定提示', async () => {
  const response = await fetch(`${base}/api/integrations/wecom/im`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ senderWecomId: 'Ghost', text: '你好' }),
  });
  const data = (await response.json()) as { reply: string };
  assert.match(data.reply, /尚未绑定/);
});

test('Mock 聊天消息可以端到端触发 Alexandria 机器人回答', async () => {
  const response = await fetch(`${mockBase}/api/mock/chats/chat_lin_bot/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ senderId: 'LinWei', text: '/search 本体论' }),
  });
  const data = (await response.json()) as { reply: string; mode?: string };
  assert.equal(response.status, 200);
  assert.match(data.reply, /Alexandria/);
  assert.match(data.reply, /本体论/);
});
