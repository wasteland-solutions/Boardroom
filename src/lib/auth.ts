import NextAuth, { type NextAuthConfig } from 'next-auth';

// Generic OIDC provider configured entirely from env. Auth.js v5 lets you
// define a provider inline without using a preset.
const oidcProvider = {
  id: 'oidc',
  name: 'OIDC',
  type: 'oidc' as const,
  issuer: process.env.OIDC_ISSUER_URL,
  clientId: process.env.OIDC_CLIENT_ID,
  clientSecret: process.env.OIDC_CLIENT_SECRET,
  authorization: { params: { scope: 'openid email profile' } },
  // `profile` gives us the claims we use for the single-user allowlist.
  profile(profile: { sub: string; email?: string; name?: string; picture?: string }) {
    return {
      id: profile.sub,
      email: profile.email,
      name: profile.name,
      image: profile.picture,
    };
  },
};

const authConfig: NextAuthConfig = {
  secret: process.env.AUTH_SECRET,
  session: { strategy: 'jwt' },
  providers: [oidcProvider],
  callbacks: {
    // Single-user gate — reject anyone who isn't the allowlisted subject/email.
    async signIn({ profile, user }) {
      const allowedSub = process.env.ALLOWED_OIDC_SUBJECT;
      const allowedEmail = process.env.ALLOWED_OIDC_EMAIL;
      if (!allowedSub && !allowedEmail) {
        console.warn('[auth] neither ALLOWED_OIDC_SUBJECT nor ALLOWED_OIDC_EMAIL set — rejecting all sign-ins.');
        return false;
      }
      const sub = (profile as { sub?: string })?.sub ?? user?.id;
      const email = (profile as { email?: string })?.email ?? user?.email;
      if (allowedSub && sub === allowedSub) return true;
      if (allowedEmail && email && email.toLowerCase() === allowedEmail.toLowerCase()) return true;
      return false;
    },
    async jwt({ token, profile }) {
      if (profile) {
        token.sub = (profile as { sub?: string }).sub ?? token.sub;
        token.email = (profile as { email?: string }).email ?? token.email;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as { id?: string }).id = token.sub;
        session.user.email = (token.email as string | null | undefined) ?? session.user.email;
      }
      return session;
    },
  },
  pages: {
    signIn: '/signin',
  },
};

export const { handlers, signIn, signOut, auth } = NextAuth(authConfig);
