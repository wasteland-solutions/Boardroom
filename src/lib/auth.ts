import NextAuth, { type NextAuthConfig } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { authConfig as baseAuthConfig } from './auth.config';
import { isRateLimited } from './rate-limit';

// Pure-JS constant-time string compare. Avoids depending on `node:crypto`
// so this module can be statically analysed by Next's webpack without
// triggering "UnhandledSchemeError: node:crypto" when it shows up in an
// edge-adjacent bundle trace. The xor-or loop still runs over the full
// length regardless of where the first mismatch is.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// --- Provider: generic OIDC (optional) ---
//
// Only registered when all four OIDC_* env vars are present. Lets you sign
// in through Google, Authentik, Keycloak, etc. The ALLOWED_OIDC_SUBJECT /
// ALLOWED_OIDC_EMAIL env vars gate which identity is allowed through.
const oidcEnabled =
  !!process.env.OIDC_ISSUER_URL &&
  !!process.env.OIDC_CLIENT_ID &&
  !!process.env.OIDC_CLIENT_SECRET;

const oidcProvider = {
  id: 'oidc',
  name: 'OIDC',
  type: 'oidc' as const,
  issuer: process.env.OIDC_ISSUER_URL,
  clientId: process.env.OIDC_CLIENT_ID,
  clientSecret: process.env.OIDC_CLIENT_SECRET,
  authorization: { params: { scope: 'openid email profile' } },
  profile(profile: { sub: string; email?: string; name?: string; picture?: string }) {
    return {
      id: profile.sub,
      email: profile.email,
      name: profile.name,
      image: profile.picture,
    };
  },
};

// --- Provider: username + password (optional) ---
//
// Only registered when BOARDROOM_USERNAME + BOARDROOM_PASSWORD are set in
// the environment. This is the simpler self-host option — no OIDC provider
// required. The password lives in .env (already trusted); compared in
// constant time. Exactly one credential pair is valid at a time.
const credsEnabled = !!process.env.BOARDROOM_USERNAME && !!process.env.BOARDROOM_PASSWORD;

const credentialsProvider = Credentials({
  id: 'credentials',
  name: 'Password',
  credentials: {
    username: { label: 'Username', type: 'text' },
    password: { label: 'Password', type: 'password' },
  },
  async authorize(raw) {
    // Rate-limit at the provider level — this fires regardless of whether the
    // request came through the server action form or directly via the Auth.js
    // callback endpoint (/api/auth/callback/credentials).
    if (isRateLimited('auth:credentials', 3, 60_000)) {
      // Returning null tells Auth.js "invalid credentials" which redirects to
      // the sign-in page with ?error=CredentialsSignin. The UI maps that to a
      // generic error message so we don't leak that rate-limiting kicked in vs
      // wrong password.
      return null;
    }
    const username = typeof raw?.username === 'string' ? raw.username : '';
    const password = typeof raw?.password === 'string' ? raw.password : '';
    const expectedUser = process.env.BOARDROOM_USERNAME ?? '';
    const expectedPass = process.env.BOARDROOM_PASSWORD ?? '';
    if (!expectedUser || !expectedPass) return null;
    if (!safeEqual(username, expectedUser)) return null;
    if (!safeEqual(password, expectedPass)) return null;
    return { id: `local:${expectedUser}`, name: expectedUser };
  },
});

const providers = [
  ...(oidcEnabled ? [oidcProvider] : []),
  ...(credsEnabled ? [credentialsProvider] : []),
];

if (providers.length === 0) {
  console.warn(
    '[auth] No sign-in providers configured. Set OIDC_* env vars and/or ' +
      'BOARDROOM_USERNAME + BOARDROOM_PASSWORD in .env. The sign-in page will ' +
      'render but nobody will be able to sign in.',
  );
}

// Which auth methods are available, for the sign-in UI.
export const enabledProviders = {
  oidc: oidcEnabled,
  credentials: credsEnabled,
};

const authConfig: NextAuthConfig = {
  ...baseAuthConfig,
  secret: process.env.AUTH_SECRET,
  // In production behind TLS (or when NEXTAUTH_URL starts with https://),
  // Auth.js auto-sets Secure on cookies. We also force HttpOnly + SameSite.
  useSecureCookies: process.env.NEXTAUTH_URL?.startsWith('https://') || process.env.NODE_ENV === 'production',
  providers,
  callbacks: {
    ...baseAuthConfig.callbacks,
    // Single-user gate. For OIDC, enforce the subject/email allowlist. The
    // credentials provider is already single-user by construction (there's
    // exactly one valid username/password in env).
    async signIn({ account, profile, user }) {
      if (account?.provider === 'credentials') return true;
      if (account?.provider === 'oidc') {
        const allowedSub = process.env.ALLOWED_OIDC_SUBJECT;
        const allowedEmail = process.env.ALLOWED_OIDC_EMAIL;
        if (!allowedSub && !allowedEmail) {
          console.warn(
            '[auth] OIDC sign-in attempted but neither ALLOWED_OIDC_SUBJECT ' +
              'nor ALLOWED_OIDC_EMAIL is set — rejecting.',
          );
          return false;
        }
        const sub = (profile as { sub?: string })?.sub ?? user?.id;
        const email = (profile as { email?: string })?.email ?? user?.email;
        if (allowedSub && sub === allowedSub) return true;
        if (allowedEmail && email && email.toLowerCase() === allowedEmail.toLowerCase()) return true;
        return false;
      }
      return false;
    },
    async jwt({ token, profile, user }) {
      if (profile) {
        token.sub = (profile as { sub?: string }).sub ?? token.sub;
        token.email = (profile as { email?: string }).email ?? token.email;
      }
      if (user) {
        token.sub = user.id ?? token.sub;
        token.name = user.name ?? token.name;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as { id?: string }).id = token.sub;
        session.user.email = (token.email as string | null | undefined) ?? session.user.email;
        session.user.name = (token.name as string | null | undefined) ?? session.user.name;
      }
      return session;
    },
  },
  pages: {
    signIn: '/signin',
  },
};

export const { handlers, signIn, signOut, auth } = NextAuth(authConfig);
