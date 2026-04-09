import { auth } from '@/lib/auth';
import { NextResponse } from 'next/server';

export default auth((req) => {
  const { pathname } = req.nextUrl;
  // Public paths: auth routes and the sign-in page itself.
  if (pathname.startsWith('/api/auth') || pathname === '/signin') {
    return NextResponse.next();
  }
  if (!req.auth) {
    const signInUrl = new URL('/signin', req.nextUrl.origin);
    return NextResponse.redirect(signInUrl);
  }
  return NextResponse.next();
});

export const config = {
  matcher: [
    // Match everything except Next internals and static files.
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
