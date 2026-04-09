import NextAuth from 'next-auth';
import { authConfig } from '@/lib/auth.config';

// Edge-runtime middleware. Uses the edge-safe auth config — the full Auth.js
// instance (which imports node:crypto via the Credentials provider) is only
// loaded by route handlers and server components, not here.
export const { auth: middleware } = NextAuth(authConfig);

export default middleware;

export const config = {
  matcher: [
    // Skip Next internals and static files.
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
