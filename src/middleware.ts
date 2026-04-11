import { NextResponse } from 'next/server';
import NextAuth from 'next-auth';
import { authConfig } from '@/lib/auth.config';
import { isRateLimited } from '@/lib/rate-limit';

const { auth } = NextAuth(authConfig);

// Cache the setup status so we don't hit the API on every request.
// Re-checked when null (startup) or false (not yet registered).
// Once true, never re-checked — single-user registration is permanent.
let setupComplete: boolean | null = null;

export default auth(async (req) => {
  const { pathname } = req.nextUrl;

  // Rate-limit login attempts.
  if (
    req.method === 'POST' &&
    (pathname === '/api/auth/callback/credentials' || pathname === '/signin')
  ) {
    if (isRateLimited('auth:login', 3, 60_000)) {
      return new NextResponse(
        JSON.stringify({ error: 'Too many login attempts. Try again later.' }),
        {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
        },
      );
    }
  }

  // Block dev-only endpoints in production.
  if (process.env.NODE_ENV === 'production') {
    if (
      pathname === '/_next/static/development/_devMiddlewareManifest.json' ||
      pathname.startsWith('/__nextjs')
    ) {
      return new NextResponse(null, { status: 404 });
    }
  }

  // Skip setup check for setup routes, auth routes, and static assets.
  if (
    pathname.startsWith('/setup') ||
    pathname.startsWith('/api/setup') ||
    pathname.startsWith('/api/auth') ||
    pathname.startsWith('/_next')
  ) {
    return undefined;
  }

  // Check if a user has been registered. If not, redirect to /setup.
  // Re-check every time until registration completes (setupComplete becomes true).
  if (!setupComplete) {
    try {
      const base = req.nextUrl.origin;
      const res = await fetch(`${base}/api/setup/status`);
      if (res.ok) {
        const data = (await res.json()) as { registered: boolean };
        setupComplete = data.registered;
      }
    } catch {
      // Can't reach the API yet (startup race) — let the request through.
    }
  }

  if (setupComplete === false) {
    const setupUrl = req.nextUrl.clone();
    setupUrl.pathname = '/setup';
    return NextResponse.redirect(setupUrl);
  }

  // Auth.js handles the rest.
  return undefined;
});

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
