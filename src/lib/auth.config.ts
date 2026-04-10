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
    // Override the default Auth.js error page (which leaks library
    // identity and version info) with a redirect to signin + error
    // query param.
    error: '/signin',
  },
  session: { strategy: 'jwt' },
  secret: process.env.AUTH_SECRET,
  providers: [],
  callbacks: {
    // Middleware authorization check. Runs on every protected request.
    authorized({ auth, request }) {
      const { pathname } = request.nextUrl;
      if (pathname.startsWith('/api/auth') || pathname === '/signin') return true;
      return !!auth;
    },
    // Restrict post-auth redirects to same-origin paths. Prevents
    // open-redirect via callbackUrl=http://evil.com.
    redirect({ url, baseUrl }) {
      // Allow relative paths.
      if (url.startsWith('/')) return url;
      // Allow same-origin absolute URLs.
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
