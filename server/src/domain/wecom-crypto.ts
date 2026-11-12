import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

function keyBuffer(encodingAesKey: string): Buffer {
  if (encodingAesKey.length !== 43) throw new Error('EncodingAESKey 必须是 43 位');
  return Buffer.from(`${encodingAesKey}=`, 'base64');
}

function pad(buffer: Buffer, blockSize = 32): Buffer {
  const remainder = buffer.length % blockSize;
  const size = remainder === 0 ? blockSize : blockSize - remainder;
  return Buffer.concat([buffer, Buffer.alloc(size, size)]);
}

function unpad(buffer: Buffer, blockSize = 32): Buffer {
  if (!buffer.length) throw new Error('空内容');
  const size = buffer[buffer.length - 1]!;
  if (size < 1 || size > blockSize) throw new Error('非法填充');
  return buffer.subarray(0, buffer.length - size);
}

export function encryptWeCom(message: string, encodingAesKey: string, corpId: string): string {
  const key = keyBuffer(encodingAesKey);
  const msg = Buffer.from(message, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(msg.length, 0);
  const content = Buffer.concat([randomBytes(16), length, msg, Buffer.from(corpId, 'utf8')]);
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(pad(content)), cipher.final()]).toString('base64');
}

export function decryptWeCom(encrypted: string, encodingAesKey: string, corpId: string): string {
  const key = keyBuffer(encodingAesKey);
  const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
  decipher.setAutoPadding(false);
  const decrypted = unpad(Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]));
  const length = decrypted.readUInt32BE(16);
  const message = decrypted.subarray(20, 20 + length).toString('utf8');
  const actual = decrypted.subarray(20 + length).toString('utf8');
  if (actual !== corpId) throw new Error('corpId 不匹配');
  return message;
}

export function wecomSignature(token: string, timestamp: string, nonce: string, encrypt: string): string {
  return createHash('sha1').update([token, timestamp, nonce, encrypt].sort().join('')).digest('hex');
}

export function verifyWecomSignature(token: string, timestamp: string, nonce: string, encrypt: string, signature: string): boolean {
  const expected = Buffer.from(wecomSignature(token, timestamp, nonce, encrypt), 'utf8');
  const actual = Buffer.from(String(signature ?? ''), 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function cdata(value: string): string {
  return `<![CDATA[${String(value).replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

export function parseWecomXml(xml: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of xml.matchAll(/<([A-Za-z0-9_]+)>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))\s*<\/\1>/g)) {
    result[match[1]!] = (match[2] ?? match[3] ?? '').trim();
  }
  return result;
}

export function buildWecomReplyXml({
  toUser,
  fromUser,
  content,
  createTime = Math.floor(Date.now() / 1000),
}: {
  toUser: string;
  fromUser: string;
  content: string;
  createTime?: number;
}): string {
  return `<xml><ToUserName>${cdata(toUser)}</ToUserName><FromUserName>${cdata(fromUser)}</FromUserName><CreateTime>${createTime}</CreateTime><MsgType>${cdata('text')}</MsgType><Content>${cdata(content)}</Content></xml>`;
}

export function buildWecomEncryptedReply({
  replyXml,
  token,
  encodingAesKey,
  corpId,
}: {
  replyXml: string;
  token: string;
  encodingAesKey: string;
  corpId: string;
}): string {
  const encrypted = encryptWeCom(replyXml, encodingAesKey, corpId);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(8).toString('hex');
  const signature = wecomSignature(token, timestamp, nonce, encrypted);
  return `<xml><Encrypt>${cdata(encrypted)}</Encrypt><MsgSignature>${cdata(signature)}</MsgSignature><TimeStamp>${timestamp}</TimeStamp><Nonce>${cdata(nonce)}</Nonce></xml>`;
}
