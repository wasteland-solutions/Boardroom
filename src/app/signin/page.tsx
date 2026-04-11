import { AuthError } from 'next-auth';
import { redirect } from 'next/navigation';
import { signIn, oidcConfigured } from '@/lib/auth';
import { isSetupComplete } from '@/lib/settings-store';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; callbackUrl?: string }>;
}) {
  // If no user has registered yet, send them to setup.
  if (!isSetupComplete()) redirect('/setup');

  const { error, callbackUrl } = await searchParams;

  return (
    <div className="signin-panel">
      <div className="wordmark" aria-hidden="true" />
      <h1>Boardroom</h1>
      <p>A DM with Claude Code.</p>

      {error && (
        <div className="signin-error">
          {error === 'credentials' || error === 'CredentialsSignin'
            ? 'Wrong username or password.'
            : error === 'oidc'
            ? 'SSO sign-in failed. Check your provider configuration.'
            : error === 'ratelimit'
            ? 'Too many attempts. Wait a minute and try again.'
            : 'Sign-in failed. Please try again.'}
        </div>
      )}

      <div className="signin-forms">
        <form
          className="signin-form"
          action={async (formData) => {
            'use server';
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

        {oidcConfigured && (
          <>
            <div className="signin-divider">or</div>
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
          </>
        )}
      </div>
    </div>
  );
}
