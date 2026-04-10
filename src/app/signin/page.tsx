import { AuthError } from 'next-auth';
import { redirect } from 'next/navigation';
import { enabledProviders, signIn } from '@/lib/auth';
import { isRateLimited } from '@/lib/rate-limit';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; callbackUrl?: string }>;
}) {
  const { error, callbackUrl } = await searchParams;

  return (
    <div className="signin-panel">
      <div className="wordmark">B</div>
      <h1>Boardroom</h1>
      <p>A DM with Claude Code.</p>

      {error && (
        <div className="signin-error">
          {error === 'credentials'
            ? 'Wrong username or password.'
            : error === 'oidc'
            ? 'SSO sign-in failed. Check your provider configuration.'
            : error === 'ratelimit'
            ? 'Too many attempts. Wait a minute and try again.'
            : 'Sign-in failed. Please try again.'}
        </div>
      )}

      <div className="signin-forms">
        {enabledProviders.credentials && (
          <form
            className="signin-form"
            action={async (formData) => {
              'use server';
              // 5 attempts per 60 seconds.
              if (isRateLimited('auth:credentials', 5, 60_000)) {
                redirect(`/signin?error=ratelimit${callbackUrl ? `&callbackUrl=${encodeURIComponent(callbackUrl)}` : ''}`);
              }
              try {
                await signIn('credentials', {
                  username: formData.get('username'),
                  password: formData.get('password'),
                  redirectTo: callbackUrl || '/',
                });
              } catch (err) {
                if (err instanceof AuthError) {
                  redirect(`/signin?error=credentials${callbackUrl ? `&callbackUrl=${encodeURIComponent(callbackUrl)}` : ''}`);
                }
                throw err;
              }
            }}
          >
            <label>
              <span>Username</span>
              <input name="username" type="text" autoComplete="username" required autoFocus />
            </label>
            <label>
              <span>Password</span>
              <input name="password" type="password" autoComplete="current-password" required />
            </label>
            <button type="submit" className="btn">
              Sign in
            </button>
          </form>
        )}

        {enabledProviders.oidc && enabledProviders.credentials && (
          <div className="signin-divider">or</div>
        )}

        {enabledProviders.oidc && (
          <form
            action={async () => {
              'use server';
              try {
                await signIn('oidc', { redirectTo: callbackUrl || '/' });
              } catch (err) {
                if (err instanceof AuthError) {
                  redirect(`/signin?error=oidc${callbackUrl ? `&callbackUrl=${encodeURIComponent(callbackUrl)}` : ''}`);
                }
                throw err;
              }
            }}
          >
            <button type="submit" className="btn">
              Sign in with SSO
            </button>
          </form>
        )}

        {!enabledProviders.credentials && !enabledProviders.oidc && (
          <div className="signin-empty">
            No authentication providers are configured. Set either{' '}
            <code>BOARDROOM_USERNAME</code> + <code>BOARDROOM_PASSWORD</code>, or the{' '}
            <code>OIDC_*</code> env vars, in your <code>.env</code>, then restart the server.
          </div>
        )}
      </div>
    </div>
  );
}
