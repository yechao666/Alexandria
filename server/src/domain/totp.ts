import { createHmac, randomBytes } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(input: string): Buffer {
  const normalized = input.toUpperCase().replace(/=+$/g, '').replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of normalized) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpCode(secret: string, time = Date.now()): string {
  const step = Math.floor(time / 30_000);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', base32Decode(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(binary % 1_000_000).padStart(6, '0');
}

export function verifyTotp(secret: string, code: string, time = Date.now()): boolean {
  const normalized = String(code ?? '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(normalized)) return false;
  for (const offset of [-1, 0, 1]) {
    if (totpCode(secret, time + offset * 30_000) === normalized) return true;
  }
  return false;
}

export function totpUri(secret: string, email: string): string {
  return `otpauth://totp/${encodeURIComponent(`Alexandria:${email}`)}?secret=${secret}&issuer=Alexandria&algorithm=SHA1&digits=6&period=30`;
}

export function passwordPolicyError(password: string): string | null {
  if (password.length < 10) return '密码至少 10 位';
  if (!/[a-z]/.test(password)) return '密码需包含小写字母';
  if (!/[A-Z]/.test(password)) return '密码需包含大写字母';
  if (!/\d/.test(password)) return '密码需包含数字';
  if (!/[^A-Za-z0-9]/.test(password)) return '密码需包含符号';
  return null;
}
