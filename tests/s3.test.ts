import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createTestContext } from './helpers.ts';
import { s3Put } from '../server/src/maintenance/s3.ts';

const ctx = createTestContext();
let lastAuth = '';
const server = createServer((req, res) => {
  lastAuth = String(req.headers.authorization ?? '');
  req.resume();
  req.on('end', () => {
    res.statusCode = 200;
    res.end();
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
const address = server.address();
const port = typeof address === 'object' && address ? address.port : 0;
ctx.env.s3 = {
  endpoint: `http://127.0.0.1:${port}`,
  bucket: 'alex-test',
  region: 'us-east-1',
  accessKey: 'AKIATEST',
  secretKey: 'SECRETTEST',
  prefix: 'alexandria',
};

test.after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  ctx.cleanup();
});

test('S3 兼容备份上传使用 SigV4 签名', async () => {
  await s3Put(ctx.env, 'backups/test/manifest.json', Buffer.from('{"ok":true}'), 'application/json');
  assert.match(lastAuth, /^AWS4-HMAC-SHA256 Credential=AKIATEST\//);
  assert.match(lastAuth, /SignedHeaders=host;x-amz-content-sha256;x-amz-date/);
});
