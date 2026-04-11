'use client';

import { useState } from 'react';
import type { AuthMode } from '@/lib/types';

export function SetupForm({ action }: { action: (formData: FormData) => Promise<void> }) {
  const [authMode, setAuthMode] = useState<AuthMode>('api_key');

  return (
    <form className="signin-form" action={action}>
      <h2 className="setup-section" style={{ marginTop: 0, paddingTop: 0, borderTop: 'none' }}>Account</h2>
      <label>
        <span>Username</span>
        <input name="username" type="text" autoComplete="username" required autoFocus />
      </label>
      <label>
        <span>Password</span>
        <input name="password" type="password" autoComplete="new-password" required minLength={8} />
      </label>
      <label>
        <span>Confirm password</span>
        <input name="confirm" type="password" autoComplete="new-password" required minLength={8} />
      </label>

      <h2 className="setup-section">Claude</h2>
      <label>
        <span>Auth mode</span>
        <select
          name="authMode"
          value={authMode}
          onChange={(e) => setAuthMode(e.target.value as AuthMode)}
        >
          <option value="api_key">API key (Anthropic Console)</option>
          <option value="claude_code">OAuth token (Claude Pro/Max subscription)</option>
        </select>
      </label>

      {authMode === 'api_key' && (
        <label>
          <span>Anthropic API key</span>
          <input name="apiKey" type="password" autoComplete="off" spellCheck={false} placeholder="sk-ant-..." />
          <span className="hint">
            From your{' '}
            <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
              Anthropic Console
            </a>. Stored encrypted.
          </span>
        </label>
      )}

      {authMode === 'claude_code' && (
        <label>
          <span>Claude Code OAuth token</span>
          <input name="oauthToken" type="password" autoComplete="off" spellCheck={false} placeholder="sk-ant-oat01-..." />
          <span className="hint">
            From <code>claude setup-token</code> on a machine with a Claude subscription. Stored encrypted.
          </span>
        </label>
      )}

      <button type="submit" className="btn" style={{ marginTop: 8 }}>
        Create account
      </button>
    </form>
  );
}
