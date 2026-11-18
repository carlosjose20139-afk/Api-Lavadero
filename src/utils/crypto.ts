import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';

export function newUuid(): string {
  return crypto.randomUUID();
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, env.BCRYPT_ROUNDS);
}

// Hash precalculado válido para mantener tiempo constante cuando el usuario no existe
const DUMMY_BCRYPT_HASH =
  '$2b$10$abcdefghijklmnopqrstuu5v5x8y9z0a1b2c3d4e5f6g7h8i9j0kL';

export async function verifyPassword(plain: string, hash: string | null): Promise<boolean> {
  if (!hash) {
    await bcrypt.compare(plain, DUMMY_BCRYPT_HASH);
    return false;
  }
  return bcrypt.compare(plain, hash);
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function generateOpaqueToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function generateTemporaryPassword(length = 12): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
}
