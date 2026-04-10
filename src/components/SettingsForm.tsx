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
          openaiApiKey: settings.openaiApiKey,
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
      <p className="lead">Credentials and preferences. Everything lives on the SQLite data volume.</p>

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
            <span className="hint">
              Get one from <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">console.anthropic.com</a>.
              Stored in SQLite on the Boardroom data volume. Overrides the <code>ANTHROPIC_API_KEY</code>
              environment variable if both are set. Leave blank to fall back to the env var.
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
              A long-lived token produced by running <code>claude setup-token</code> on any machine
              where you&apos;ve already logged in with your Claude subscription. Open a terminal,
              run the command, complete the browser flow, copy the resulting token, and paste it
              here. The worker injects it as <code>CLAUDE_CODE_OAUTH_TOKEN</code> when spawning
              the Claude Code CLI child process.
              <br />
              <br />
              Running Boardroom in Docker? Run{' '}
              <code>docker compose exec boardroom claude setup-token</code> inside the container —
              the token it prints can be pasted here.
            </span>
          </label>
        )}

        <label style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
          <span>OpenAI API key (for Codex conversations)</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-..."
            value={settings.openaiApiKey}
            onChange={(e) => setSettings({ ...settings, openaiApiKey: e.target.value })}
          />
          <span className="hint">
            Required for Codex conversations. Get one from{' '}
            <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">
              platform.openai.com
            </a>. Stored encrypted in SQLite. Alternatively, Codex can use its own OAuth
            login (<code>codex login</code> on the host) and this field can be left blank.
          </span>
        </label>
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
        <div className="banner" style={{ marginBottom: 14 }}>
          <strong>Local:</strong> leave Host blank, Path is an absolute local path
          (e.g. <code>/path/to/your/project</code>).<br />
          <strong>Remote (SSH):</strong> Host is <code>user@host[:port]</code>
          (e.g. <code>user@host.example.com</code> or an alias from your{' '}
          <code>~/.ssh/config</code>), Path is the absolute remote path.
          Click <strong>Browse</strong> to navigate via SSH instead of typing.<br />
          <strong>Docker:</strong> for local paths, mount your host project into the container
          first via <code>docker-compose.yml</code>, then add the container-side path
          (e.g. <code>/workspaces/my-app</code>) here.
        </div>
        {cwdList.length === 0 && (
          <div style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 10 }}>
            Add at least one directory so you can start a conversation.
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
                title="Browse for a directory"
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
          <button
            className="btn"
            onClick={addCwd}
            disabled={!newPath.trim() || !newLabel.trim()}
          >
            Add workspace
          </button>
        </div>
      </section>

      {browserOpen && (
        <DirectoryBrowser
          host={newHost}
          initialPath={newPath || (newHost ? '/home' : '/')}
          onPick={(picked) => {
            setNewPath(picked);
            setBrowserOpen(false);
          }}
          onClose={() => setBrowserOpen(false)}
        />
      )}

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
