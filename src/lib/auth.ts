import NextAuth, { type NextAuthConfig } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { authConfig as baseAuthConfig } from './auth.config';
import { isRateLimited } from './rate-limit';
import { getUser, verifyPassword, getSettings } from './settings-store';

// --- Provider: generic OIDC (optional) ---
//
// Reads OIDC config from SQLite settings (configured in the Settings drawer).
// Falls back to env vars for backwards compatibility. Requires a server
// restart after changing — NextAuth providers are configured at boot.
let oidcIssuer = '';
let oidcClientId = '';
let oidcClientSecret = '';
let oidcAllowedEmail = '';
try {
  const s = getSettings();
  oidcIssuer = s.oidcIssuerUrl || process.env.OIDC_ISSUER_URL || '';
  oidcClientId = s.oidcClientId || process.env.OIDC_CLIENT_ID || '';
  oidcClientSecret = s.oidcClientSecret || process.env.OIDC_CLIENT_SECRET || '';
  oidcAllowedEmail = s.oidcAllowedEmail || process.env.ALLOWED_OIDC_EMAIL || '';
} catch {
  // DB not ready yet (first boot before migrations) — fall back to env vars.
  oidcIssuer = process.env.OIDC_ISSUER_URL || '';
  oidcClientId = process.env.OIDC_CLIENT_ID || '';
  oidcClientSecret = process.env.OIDC_CLIENT_SECRET || '';
  oidcAllowedEmail = process.env.ALLOWED_OIDC_EMAIL || '';
}

const oidcEnabled = !!oidcIssuer && !!oidcClientId && !!oidcClientSecret;

const oidcProvider = {
  id: 'oidc',
  name: 'OIDC',
  type: 'oidc' as const,
  issuer: oidcIssuer,
  clientId: oidcClientId,
  clientSecret: oidcClientSecret,
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

// --- Provider: username + password ---
//
// Credentials are stored in SQLite (created via the /setup registration page).
// The password hash is verified at login time. If no user has been registered
// yet, authorize() returns null and the sign-in page redirects to /setup.
const credentialsProvider = Credentials({
  id: 'credentials',
  name: 'Password',
  credentials: {
    username: { label: 'Username', type: 'text' },
    password: { label: 'Password', type: 'password' },
  },
  async authorize(raw) {
    if (isRateLimited('auth:credentials', 3, 60_000)) {
      return null;
    }
    const username = typeof raw?.username === 'string' ? raw.username : '';
    const password = typeof raw?.password === 'string' ? raw.password : '';
    if (!username || !password) return null;

    const user = getUser();
    if (!user) return null;
    if (username !== user.username) return null;
    if (!verifyPassword(password, user.passwordHash)) return null;

    return { id: `local:${user.username}`, name: user.username };
  },
});

const providers = [
  ...(oidcEnabled ? [oidcProvider] : []),
  credentialsProvider,
];

export const oidcConfigured = oidcEnabled;

const authConfig: NextAuthConfig = {
  ...baseAuthConfig,
  secret: process.env.AUTH_SECRET,
  useSecureCookies: process.env.NEXTAUTH_URL?.startsWith('https://') || process.env.NODE_ENV === 'production',
  providers,
  callbacks: {
    ...baseAuthConfig.callbacks,
    async signIn({ account, profile, user }) {
      if (account?.provider === 'credentials') return true;
      if (account?.provider === 'oidc') {
        const allowedSub = process.env.ALLOWED_OIDC_SUBJECT;
        const allowedEmail = oidcAllowedEmail || process.env.ALLOWED_OIDC_EMAIL;
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
