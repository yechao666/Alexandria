import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../env.ts';
import { createBackup } from '../maintenance/backup.ts';
import { uploadBackupToS3, s3Configured } from '../maintenance/s3.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const env = loadEnv(root);
const result = createBackup(env);
console.log(`[backup] 已创建 ${result.target}`);
console.log(`[backup] 校验 ${JSON.stringify(result.verification)}`);

if (s3Configured(env)) {
  try {
    const uploaded = await uploadBackupToS3(env, result.target);
    console.log(`[backup] 已上传 ${uploaded.uploaded} 个文件到 S3`);
  } catch (error) {
    console.warn('[backup] S3 上传失败', (error as Error).message);
  }
}
