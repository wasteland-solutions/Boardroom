import { redirect } from 'next/navigation';
import { isSetupComplete, createUser, updateSettings } from '@/lib/settings-store';
import type { AuthMode } from '@/lib/types';
import { SetupForm } from './form';

export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (isSetupComplete()) redirect('/signin');

  const { error } = await searchParams;
  const errorMessage = error === 'mismatch'
    ? 'Passwords do not match.'
    : error === 'short'
    ? 'Password must be at least 8 characters.'
    : error === 'empty'
    ? 'Username and password are required.'
    : error
    ? 'Something went wrong. Try again.'
    : null;

  async function handleSetup(formData: FormData) {
    'use server';
    if (isSetupComplete()) redirect('/signin');

    const username = (formData.get('username') as string)?.trim() ?? '';
    const password = (formData.get('password') as string) ?? '';
    const confirm = (formData.get('confirm') as string) ?? '';
    const authMode = (formData.get('authMode') as string) ?? 'api_key';
    const apiKey = (formData.get('apiKey') as string)?.trim() ?? '';
    const oauthToken = (formData.get('oauthToken') as string)?.trim() ?? '';

    if (!username || !password) redirect('/setup?error=empty');
    if (password.length < 8) redirect('/setup?error=short');
    if (password !== confirm) redirect('/setup?error=mismatch');

    createUser(username, password);
    updateSettings({
      authMode: authMode as AuthMode,
      ...(authMode === 'api_key' ? { anthropicApiKey: apiKey } : {}),
      ...(authMode === 'claude_code' ? { claudeCodeOauthToken: oauthToken } : {}),
    });

    redirect('/signin');
  }

  return (
    <div className="signin-panel">
      <div className="wordmark" aria-hidden="true" />
      <h1>Boardroom</h1>
      <p>Create your account to get started.</p>
      {errorMessage && <div className="signin-error">{errorMessage}</div>}
      <div className="signin-forms">
        <SetupForm action={handleSetup} />
      </div>
    </div>
  );
}
