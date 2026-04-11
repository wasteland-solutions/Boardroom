import { redirect } from 'next/navigation';
import { oidcConfigured } from '@/lib/auth';
import { isSetupComplete } from '@/lib/settings-store';
import { SignInForm } from './form';

export const dynamic = 'force-dynamic';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; callbackUrl?: string }>;
}) {
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
        <SignInForm callbackUrl={callbackUrl} oidcConfigured={oidcConfigured} />
      </div>
    </div>
  );
}
