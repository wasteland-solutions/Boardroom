import { NextResponse } from 'next/server';
import NextAuth from 'next-auth';
import { authConfig } from '@/lib/auth.config';
import { isRateLimited } from '@/lib/rate-limit';

// Edge-runtime middleware. Uses the edge-safe auth config — the full Auth.js
// instance (which imports node:crypto via the Credentials provider) is only
// loaded by route handlers and server components, not here.
const { auth } = NextAuth(authConfig);

export default auth((req) => {
  const { pathname } = req.nextUrl;

  // Rate-limit login attempts BEFORE Auth.js processes them. This catches
  // both form-based server action submissions and direct POSTs to the
  // Auth.js callback endpoint. Returns 429 so pen testers and attackers
  // see a clear throttling signal.
  if (
    req.method === 'POST' &&
    (pathname === '/api/auth/callback/credentials' || pathname === '/signin')
  ) {
    if (isRateLimited('auth:login', 3, 60_000)) {
      return new NextResponse(
        JSON.stringify({ error: 'Too many login attempts. Try again later.' }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': '60',
          },
        },
      );
    }
  }

  // Block Next.js dev-only endpoints in production. These only exist when
  // running `next dev`, but explicitly 404-ing them hardens against
  // accidental exposure if a dev build leaks to production.
  if (process.env.NODE_ENV === 'production') {
    if (
      pathname === '/_next/static/development/_devMiddlewareManifest.json' ||
      pathname.startsWith('/__nextjs')
    ) {
      return new NextResponse(null, { status: 404 });
    }
  }

  // Auth.js handles the rest — returns 401/redirect for unauthenticated.
  return undefined;
});

export const config = {
  matcher: [
    // Skip Next internals and static files.
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
