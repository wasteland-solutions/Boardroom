'use client';

import { useState } from 'react';
import type { Cwd } from '@/lib/schema';
import {
  DEFAULT_MODELS,
  type AppSettings,
  type AuthMode,
  type ModelId,
  type PermissionMode,
} from '@/lib/types';
import { DirectoryBrowser } from './DirectoryBrowser';

export function SettingsForm({
  initialSettings,
  initialCwds,
}: {
  initialSettings: AppSettings;
  initialCwds: Cwd[];
}) {
  const [settings, setSettings] = useState<AppSettings>(initialSettings);
  const [mcpText, setMcpText] = useState(JSON.stringify(initialSettings.mcpServers, null, 2));
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [cwdList, setCwdList] = useState<Cwd[]>(initialCwds);
  const [newHost, setNewHost] = useState('');
  const [newPath, setNewPath] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);

  const save = async () => {
    setSaving(true);
    setStatus(null);
    let parsedMcp: Record<string, unknown>;
    try {
      parsedMcp = JSON.parse(mcpText);
      setMcpError(null);
    } catch (err) {
      setMcpError('Invalid JSON: ' + (err as Error).message);
      setSaving(false);
      return;
    }
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          authMode: settings.authMode,
          anthropicApiKey: settings.anthropicApiKey,
          claudeCodeOauthToken: settings.claudeCodeOauthToken,
          defaultModel: settings.defaultModel,
          defaultPermissionMode: settings.defaultPermissionMode,
          mcpServers: parsedMcp,
          permissionTimeoutMs: settings.permissionTimeoutMs,
          oidcIssuerUrl: settings.oidcIssuerUrl,
          oidcClientId: settings.oidcClientId,
          oidcClientSecret: settings.oidcClientSecret,
          oidcAllowedEmail: settings.oidcAllowedEmail,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as { settings: AppSettings };
      setSettings(data.settings);
      setStatus('Saved.');
    } catch (err) {
      setStatus('Save failed: ' + (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const addCwd = async () => {
    if (!newPath.trim() || !newLabel.trim()) return;
    const res = await fetch('/api/cwds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: newHost.trim() || undefined,
        path: newPath.trim(),
        label: newLabel.trim(),
      }),
    });
    if (res.ok) {
      const { cwd } = (await res.json()) as { cwd: Cwd };
      setCwdList((prev) => {
        const without = prev.filter((c) => c.path !== cwd.path);
        return [...without, { ...cwd, createdAt: Date.now() }];
      });
      setNewHost('');
      setNewPath('');
      setNewLabel('');
    } else {
      const body = await res.json().catch(() => ({}));
      setStatus('Add workspace failed: ' + (body.error ?? res.statusText));
    }
  };

  const removeCwd = async (path: string) => {
    const res = await fetch(`/api/cwds?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
    if (res.ok) {
      setCwdList((prev) => prev.filter((c) => c.path !== path));
    }
  };

  return (
    <div className="panel">
      <h1>Settings</h1>

      <section>
        <h2>Claude credentials</h2>
        <label>
          <span>Auth mode</span>
          <select
            value={settings.authMode}
            onChange={(e) => setSettings({ ...settings, authMode: e.target.value as AuthMode })}
          >
            <option value="api_key">API key (Anthropic Console)</option>
            <option value="claude_code">OAuth token (Claude Pro/Max subscription)</option>
          </select>
        </label>

        {settings.authMode === 'api_key' ? (
          <label>
            <span>Anthropic API key</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="sk-ant-..."
              value={settings.anthropicApiKey}
              onChange={(e) => setSettings({ ...settings, anthropicApiKey: e.target.value })}
            />
            <span className="hint">
              From{' '}
              <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
                console.anthropic.com
              </a>. Stored encrypted.
            </span>
          </label>
        ) : (
          <label>
            <span>Claude Code OAuth token</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="sk-ant-oat01-..."
              value={settings.claudeCodeOauthToken}
              onChange={(e) => setSettings({ ...settings, claudeCodeOauthToken: e.target.value })}
            />
            <span className="hint">
              From <code>claude setup-token</code>. Stored encrypted.
            </span>
          </label>
        )}
      </section>

      <section>
        <h2>Defaults</h2>
        <label>
          <span>Model</span>
          <select
            value={settings.defaultModel}
            onChange={(e) => setSettings({ ...settings, defaultModel: e.target.value as ModelId })}
          >
            {DEFAULT_MODELS.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Permission mode</span>
          <select
            value={settings.defaultPermissionMode}
            onChange={(e) =>
              setSettings({ ...settings, defaultPermissionMode: e.target.value as PermissionMode })
            }
          >
            <option value="ask">ask</option>
            <option value="acceptEdits">acceptEdits</option>
            <option value="bypassPermissions">bypassPermissions</option>
          </select>
        </label>
        <label>
          <span>Permission timeout (ms, 0 = hold forever)</span>
          <input
            type="number"
            min={0}
            value={settings.permissionTimeoutMs}
            onChange={(e) =>
              setSettings({ ...settings, permissionTimeoutMs: Number(e.target.value) || 0 })
            }
          />
        </label>
      </section>

      <section>
        <h2>Working directories</h2>
        {cwdList.length === 0 && (
          <div style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 10 }}>
            Add at least one directory to start a conversation.
          </div>
        )}
        {cwdList.map((c) => (
          <div className="cwd-row" key={c.path}>
            <div className="info">
              <div className="label">{c.label}</div>
              <div className="path">{c.path}</div>
            </div>
            <button className="btn ghost" onClick={() => removeCwd(c.path)}>
              Remove
            </button>
          </div>
        ))}
        <div className="cwd-add-grid">
          <label>
            <span>Host (optional, blank = local)</span>
            <input
              placeholder="user@host or user@host:2222"
              value={newHost}
              onChange={(e) => setNewHost(e.target.value)}
              spellCheck={false}
            />
          </label>
          <label>
            <span>Path (absolute)</span>
            <div className="cwd-path-row">
              <input
                placeholder="/path/to/project"
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
                spellCheck={false}
              />
              <button
                type="button"
                className="btn ghost"
                onClick={() => setBrowserOpen(true)}
              >
                Browse
              </button>
            </div>
          </label>
          <label>
            <span>Label</span>
            <input
              placeholder="my-app"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
            />
          </label>
          <button className="btn" onClick={addCwd} disabled={!newPath.trim() || !newLabel.trim()}>
            Add workspace
          </button>
        </div>
      </section>

      {browserOpen && (
        <DirectoryBrowser
          host={newHost}
          initialPath={newPath || (newHost ? '/home' : '/')}
          onPick={(picked) => { setNewPath(picked); setBrowserOpen(false); }}
          onClose={() => setBrowserOpen(false)}
        />
      )}

      <section>
        <h2>SSO (OIDC)</h2>
        <span className="hint" style={{ display: 'block', marginBottom: 12 }}>
          Optional. Connect Google, Authentik, Keycloak, or any OIDC provider. Restart required after changing.
        </span>
        <label>
          <span>Issuer URL</span>
          <input
            type="url"
            placeholder="https://accounts.google.com"
            value={settings.oidcIssuerUrl}
            onChange={(e) => setSettings({ ...settings, oidcIssuerUrl: e.target.value })}
            spellCheck={false}
          />
        </label>
        <label>
          <span>Client ID</span>
          <input
            placeholder="xxxx.apps.googleusercontent.com"
            value={settings.oidcClientId}
            onChange={(e) => setSettings({ ...settings, oidcClientId: e.target.value })}
            spellCheck={false}
          />
        </label>
        <label>
          <span>Client secret</span>
          <input
            type="password"
            autoComplete="off"
            value={settings.oidcClientSecret}
            onChange={(e) => setSettings({ ...settings, oidcClientSecret: e.target.value })}
            spellCheck={false}
          />
        </label>
        <label>
          <span>Allowed email</span>
          <input
            type="email"
            placeholder="you@example.com"
            value={settings.oidcAllowedEmail}
            onChange={(e) => setSettings({ ...settings, oidcAllowedEmail: e.target.value })}
            spellCheck={false}
          />
          <span className="hint">Only this email can sign in via SSO.</span>
        </label>
      </section>

      <section>
        <h2>MCP servers</h2>
        <label>
          <span>JSON config passed to the Claude Agent SDK</span>
          <textarea value={mcpText} onChange={(e) => setMcpText(e.target.value)} spellCheck={false} />
        </label>
        {mcpError && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{mcpError}</div>}
      </section>

      <button className="btn" onClick={save} disabled={saving}>
        {saving ? 'Saving…' : 'Save settings'}
      </button>
      {status && (
        <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-dim)' }}>{status}</div>
      )}
    </div>
  );
}
