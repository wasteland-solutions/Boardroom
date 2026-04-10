// Encrypt / decrypt sensitive settings values at rest in SQLite using
// AES-256-GCM. The encryption key is derived from AUTH_SECRET via SHA-256
// so we don't need a separate secret. This file is node-runtime-only —
// never import from middleware or edge code.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

function deriveKey(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error('AUTH_SECRET is required for encryption');
  return createHash('sha256').update(secret).digest();
}

/**
 * Encrypt a plaintext string. Returns a hex-encoded string of the form
 * `iv:ciphertext:tag` (all hex). Returns the input unchanged if it's
 * empty or already encrypted (starts with a hex IV pattern).
 */
export function encrypt(plaintext: string): string {
  if (!plaintext) return plaintext;
  // Don't double-encrypt.
  if (/^[0-9a-f]{24}:/.test(plaintext)) return plaintext;
  const key = deriveKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${encrypted.toString('hex')}:${tag.toString('hex')}`;
}

/**
 * Decrypt a value produced by encrypt(). Returns the input unchanged if
 * it doesn't match the encrypted format (backwards compat with plaintext
 * values already stored before encryption was added).
 */
export function decrypt(ciphertext: string): string {
  if (!ciphertext) return ciphertext;
  const parts = ciphertext.split(':');
  // Not in our encrypted format — return as-is (plaintext fallback).
  if (parts.length !== 3) return ciphertext;
  const [ivHex, encHex, tagHex] = parts;
  if (!ivHex || !encHex || !tagHex) return ciphertext;
  try {
    const key = deriveKey();
    const iv = Buffer.from(ivHex, 'hex');
    const encrypted = Buffer.from(encHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    // Decryption failed — might be a plaintext value that happens to
    // contain colons. Return as-is.
    return ciphertext;
  }
}
