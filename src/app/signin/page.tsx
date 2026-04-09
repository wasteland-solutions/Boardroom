import { enabledProviders, signIn } from '@/lib/auth';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <div className="signin-panel">
      <h1>Boardroom</h1>
      <p>A DM with Claude Code.</p>

      {error && <div className="signin-error">Sign-in failed. Check your credentials and try again.</div>}

      <div className="signin-forms">
        {enabledProviders.credentials && (
          <form
            className="signin-form"
            action={async (formData) => {
              'use server';
              await signIn('credentials', {
                username: formData.get('username'),
                password: formData.get('password'),
                redirectTo: '/',
              });
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
              await signIn('oidc', { redirectTo: '/' });
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
