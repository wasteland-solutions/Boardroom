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
  const [newPath, setNewPath] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

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
      body: JSON.stringify({ path: newPath.trim(), label: newLabel.trim() }),
    });
    if (res.ok) {
      const { cwd } = (await res.json()) as { cwd: Cwd };
      setCwdList((prev) => {
        const without = prev.filter((c) => c.path !== cwd.path);
        return [...without, { ...cwd, createdAt: Date.now() }];
      });
      setNewPath('');
      setNewLabel('');
    } else {
      const text = await res.text();
      setStatus('Add cwd failed: ' + text);
    }
  };

  const removeCwd = async (path: string) => {
    const res = await fetch(`/api/cwds?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
    if (res.ok) {
      setCwdList((prev) => prev.filter((c) => c.path !== path));
    }
  };

  return (
    <div className="settings-panel">
      <h1>Settings</h1>

      <section>
        <h2>Credentials</h2>

        <label>
          <span>How should Claude Code authenticate?</span>
          <select
            value={settings.authMode}
            onChange={(e) => setSettings({ ...settings, authMode: e.target.value as AuthMode })}
          >
            <option value="api_key">Anthropic API key — billed to your Anthropic Console account</option>
            <option value="claude_code">Claude Code subscription — billed to your Max / Pro plan</option>
          </select>
        </label>

        {settings.authMode === 'api_key' ? (
          <label>
            <span>Anthropic API key</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="sk-ant-api03-..."
              value={settings.anthropicApiKey}
              onChange={(e) => setSettings({ ...settings, anthropicApiKey: e.target.value })}
            />
            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
              Get one from <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">console.anthropic.com</a>.
              Stored in SQLite on the Boardroom data volume. Overrides the <code>ANTHROPIC_API_KEY</code>
              environment variable if both are set. Leave blank to fall back to the env var.
            </div>
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
            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4, lineHeight: 1.5 }}>
              A long-lived token produced by running <code>claude setup-token</code> on any machine
              where you&apos;ve already logged in with your Claude subscription. Open a terminal,
              run the command, complete the browser flow, copy the resulting token, and paste it
              here. The worker injects it as <code>CLAUDE_CODE_OAUTH_TOKEN</code> when spawning
              the Claude Code CLI child process.
              <br />
              <br />
              Running Boardroom in Docker? You can also run{' '}
              <code>docker exec -it boardroom claude setup-token</code> inside the container — the
              token it prints can be pasted here.
            </div>
          </label>
        )}
      </section>

      <section>
        <h2>Defaults</h2>
        <label>
          <span>Default model</span>
          <select
            value={settings.defaultModel}
            onChange={(e) => setSettings({ ...settings, defaultModel: e.target.value as ModelId })}
          >
            {DEFAULT_MODELS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Default permission mode</span>
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
          <span>Permission prompt timeout (ms, 0 = hold forever)</span>
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
            Add at least one directory so you can start a conversation.
          </div>
        )}
        {cwdList.map((c) => (
          <div
            key={c.path}
            style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}
          >
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13 }}>{c.label}</div>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>
                {c.path}
              </div>
            </div>
            <button className="btn deny" onClick={() => removeCwd(c.path)}>
              Remove
            </button>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <input placeholder="/absolute/path/to/repo" value={newPath} onChange={(e) => setNewPath(e.target.value)} />
          <input placeholder="Label" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} />
          <button className="btn" onClick={addCwd}>
            Add
          </button>
        </div>
      </section>

      <section>
        <h2>MCP servers (JSON)</h2>
        <label>
          <span>Passed to Claude Agent SDK as mcpServers</span>
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
