import type { NextAuthConfig } from 'next-auth';

// Edge-safe Auth.js config. This file MUST NOT import anything that depends
// on `node:*` modules because it's consumed by `src/middleware.ts`, which
// runs in the Edge runtime.
//
// The full config (with Credentials + OIDC providers + signIn callback) lives
// in `auth.ts` and is used by route handlers and server components. Both
// configs spread this base, so the session cookie is compatible between them.
export const authConfig = {
  pages: {
    signIn: '/signin',
    error: '/signin',
  },
  session: { strategy: 'jwt' },
  secret: process.env.AUTH_SECRET,
  providers: [],
  callbacks: {
    authorized({ auth, request }) {
      const { pathname } = request.nextUrl;
      // Allow auth endpoints, sign-in, and setup without a session.
      if (pathname.startsWith('/api/auth') || pathname === '/signin') return true;
      if (pathname.startsWith('/setup') || pathname.startsWith('/api/setup')) return true;
      return !!auth;
    },
    redirect({ url, baseUrl }) {
      if (url.startsWith('/')) return url;
      try {
        const target = new URL(url);
        const base = new URL(baseUrl);
        if (target.origin === base.origin) return url;
      } catch {
        // Invalid URL — fall through to default.
      }
      return baseUrl;
    },
  },
} satisfies NextAuthConfig;
