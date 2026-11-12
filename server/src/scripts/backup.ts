import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../env.ts';
import { createBackup } from '../maintenance/backup.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const env = loadEnv(root);
const result = createBackup(env);
console.log(`[backup] 已创建 ${result.target}`);
console.log(`[backup] 校验 ${JSON.stringify(result.verification)}`);
