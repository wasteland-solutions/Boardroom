import { signIn } from '@/lib/auth';

export default function SignInPage() {
  return (
    <div className="signin-panel">
      <h1>Boardroom</h1>
      <p>A DM with Claude Code.</p>
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
    </div>
  );
}
