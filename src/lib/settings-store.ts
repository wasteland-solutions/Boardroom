import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { getDb } from './db';
import { settings } from './schema';
import { encrypt, decrypt } from './crypto';
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type AuthMode,
  type ModelId,
  type PermissionMode,
} from './types';

// --- User registration (single-user) ---

const USER_KEYS = {
  username: 'user_username',
  passwordHash: 'user_password_hash',
} as const;

/** Returns true if a user has been registered (setup is complete). */
export function isSetupComplete(): boolean {
  const db = getDb();
  const row = db.select().from(settings).where(eq(settings.key, USER_KEYS.passwordHash)).get();
  return !!row;
}

/** Get the registered user, or null if setup hasn't been completed. */
export function getUser(): { username: string; passwordHash: string } | null {
  const db = getDb();
  const rows = db
    .select()
    .from(settings)
    .where(inArray(settings.key, Object.values(USER_KEYS)))
    .all();
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const username = map.get(USER_KEYS.username);
  const passwordHash = map.get(USER_KEYS.passwordHash);
  if (!username || !passwordHash) return null;
  try {
    return { username: JSON.parse(username), passwordHash: JSON.parse(passwordHash) };
  } catch {
    return null;
  }
}

/** Register the first (and only) user. Throws if a user already exists. */
export function createUser(username: string, password: string): void {
  if (isSetupComplete()) throw new Error('User already registered');
  const db = getDb();
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  const passwordHash = `scrypt:${salt}:${hash}`;
  db.insert(settings).values({ key: USER_KEYS.username, value: JSON.stringify(username) }).run();
  db.insert(settings).values({ key: USER_KEYS.passwordHash, value: JSON.stringify(passwordHash) }).run();
}

/** Verify a password against the stored hash. */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hash] = parts;
  const derived = scryptSync(password, salt, 64).toString('hex');
  try {
    return timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(derived, 'hex'));
  } catch {
    return false;
  }
}

const KEYS = {
  authMode: 'auth_mode',
  anthropicApiKey: 'anthropic_api_key',
  claudeCodeOauthToken: 'claude_code_oauth_token',
  defaultModel: 'default_model',
  defaultPermissionMode: 'default_permission_mode',
  mcpServers: 'mcp_servers',
  permissionTimeoutMs: 'permission_timeout_ms',
  oidcIssuerUrl: 'oidc_issuer_url',
  oidcClientId: 'oidc_client_id',
  oidcClientSecret: 'oidc_client_secret',
  oidcAllowedEmail: 'oidc_allowed_email',
} as const;

export function getSettings(): AppSettings {
  const db = getDb();
  const rows = db
    .select()
    .from(settings)
    .where(inArray(settings.key, Object.values(KEYS)))
    .all();
  const map = new Map(rows.map((r) => [r.key, r.value]));

  const parseJson = <T>(key: string, fallback: T): T => {
    const raw = map.get(key);
    if (raw === undefined) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  };

  return {
    authMode: parseJson<AuthMode>(KEYS.authMode, DEFAULT_SETTINGS.authMode),
    // Sensitive values are encrypted at rest; decrypt on read.
    anthropicApiKey: decrypt(parseJson<string>(KEYS.anthropicApiKey, DEFAULT_SETTINGS.anthropicApiKey)),
    claudeCodeOauthToken: decrypt(parseJson<string>(KEYS.claudeCodeOauthToken, DEFAULT_SETTINGS.claudeCodeOauthToken)),
    defaultModel: parseJson<ModelId>(KEYS.defaultModel, DEFAULT_SETTINGS.defaultModel),
    defaultPermissionMode: parseJson<PermissionMode>(KEYS.defaultPermissionMode, DEFAULT_SETTINGS.defaultPermissionMode),
    mcpServers: parseJson(KEYS.mcpServers, DEFAULT_SETTINGS.mcpServers),
    permissionTimeoutMs: parseJson(KEYS.permissionTimeoutMs, DEFAULT_SETTINGS.permissionTimeoutMs),
    oidcIssuerUrl: decrypt(parseJson<string>(KEYS.oidcIssuerUrl, DEFAULT_SETTINGS.oidcIssuerUrl)),
    oidcClientId: decrypt(parseJson<string>(KEYS.oidcClientId, DEFAULT_SETTINGS.oidcClientId)),
    oidcClientSecret: decrypt(parseJson<string>(KEYS.oidcClientSecret, DEFAULT_SETTINGS.oidcClientSecret)),
    oidcAllowedEmail: parseJson<string>(KEYS.oidcAllowedEmail, DEFAULT_SETTINGS.oidcAllowedEmail),
  };
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const db = getDb();
  const next = { ...getSettings(), ...patch };

  const upsert = (key: string, value: unknown) => {
    const json = JSON.stringify(value);
    const existing = db.select().from(settings).where(eq(settings.key, key)).get();
    if (existing) {
      db.update(settings).set({ value: json }).where(eq(settings.key, key)).run();
    } else {
      db.insert(settings).values({ key, value: json }).run();
    }
  };

  if ('authMode' in patch) upsert(KEYS.authMode, next.authMode);
  // Encrypt sensitive values before writing to SQLite.
  if ('anthropicApiKey' in patch) upsert(KEYS.anthropicApiKey, encrypt(next.anthropicApiKey));
  if ('claudeCodeOauthToken' in patch) upsert(KEYS.claudeCodeOauthToken, encrypt(next.claudeCodeOauthToken));
  if ('defaultModel' in patch) upsert(KEYS.defaultModel, next.defaultModel);
  if ('defaultPermissionMode' in patch) upsert(KEYS.defaultPermissionMode, next.defaultPermissionMode);
  if ('mcpServers' in patch) upsert(KEYS.mcpServers, next.mcpServers);
  if ('permissionTimeoutMs' in patch) upsert(KEYS.permissionTimeoutMs, next.permissionTimeoutMs);
  if ('oidcIssuerUrl' in patch) upsert(KEYS.oidcIssuerUrl, encrypt(next.oidcIssuerUrl));
  if ('oidcClientId' in patch) upsert(KEYS.oidcClientId, encrypt(next.oidcClientId));
  if ('oidcClientSecret' in patch) upsert(KEYS.oidcClientSecret, encrypt(next.oidcClientSecret));
  if ('oidcAllowedEmail' in patch) upsert(KEYS.oidcAllowedEmail, next.oidcAllowedEmail);

  return next;
}
