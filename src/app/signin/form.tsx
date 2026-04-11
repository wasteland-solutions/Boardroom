'use client';

import { useState, useEffect } from 'react';

export function SignInForm({
  callbackUrl,
  oidcConfigured,
}: {
  callbackUrl?: string;
  oidcConfigured: boolean;
}) {
  const [csrfToken, setCsrfToken] = useState('');

  useEffect(() => {
    fetch('/api/auth/csrf')
      .then((r) => r.json())
      .then((d) => setCsrfToken(d.csrfToken))
      .catch(() => {});
  }, []);

  return (
    <>
      <form
        className="signin-form"
        method="post"
        action="/api/auth/callback/credentials"
      >
        <input type="hidden" name="csrfToken" value={csrfToken} />
        <input type="hidden" name="callbackUrl" value={callbackUrl || '/'} />
        <label>
          <span>Username</span>
          <input name="username" type="text" autoComplete="username" required autoFocus />
        </label>
        <label>
          <span>Password</span>
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        <button type="submit" className="btn" disabled={!csrfToken}>
          Sign in
        </button>
      </form>

      {oidcConfigured && (
        <>
          <div className="signin-divider">or</div>
          <form method="post" action="/api/auth/signin/oidc">
            <input type="hidden" name="csrfToken" value={csrfToken} />
            <input type="hidden" name="callbackUrl" value={callbackUrl || '/'} />
            <button type="submit" className="btn" style={{ width: '100%' }} disabled={!csrfToken}>
              Sign in with SSO
            </button>
          </form>
        </>
      )}
    </>
  );
}
