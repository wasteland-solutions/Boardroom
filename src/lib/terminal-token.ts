import { createHmac, timingSafeEqual } from 'node:crypto';

// Shared HMAC-token format used by the Next.js route handler to mint a
// short-lived proof-of-authentication for the terminal WebSocket, and by
// the agent worker to verify it.
//
// Both sides read AUTH_SECRET from the same .env, so the HMAC round-trips.
//
// Token layout:
//   base64url(conversationId):base64url(expMs):hex(hmacSha256(payload, AUTH_SECRET))
//
// payload = `${conversationId}:${expMs}`
//
// This file is *only* safe to import from node-runtime code (route handlers,
// agent worker) — never from edge-runtime code like middleware.

const TTL_MS = 2 * 60 * 1000; // 2 minutes

function b64url(s: string): string {
  return Buffer.from(s).toString('base64url');
}

function unb64url(s: string): string {
  return Buffer.from(s, 'base64url').toString();
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function mintTerminalToken(conversationId: string): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error('AUTH_SECRET is not set');
  const exp = Date.now() + TTL_MS;
  const payload = `${conversationId}:${exp}`;
  const sig = sign(payload, secret);
  return `${b64url(conversationId)}.${b64url(String(exp))}.${sig}`;
}

export function verifyTerminalToken(token: string): { conversationId: string } | null {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [encConv, encExp, sig] = parts;
  let conversationId: string;
  let expStr: string;
  try {
    conversationId = unb64url(encConv);
    expStr = unb64url(encExp);
  } catch {
    return null;
  }
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() > exp) return null;
  const payload = `${conversationId}:${exp}`;
  const expected = sign(payload, secret);
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;
  return { conversationId };
}
