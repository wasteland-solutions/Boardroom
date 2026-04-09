import { eq, inArray } from 'drizzle-orm';
import { getDb } from './db';
import { settings } from './schema';
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type AuthMode,
  type ModelId,
  type PermissionMode,
} from './types';

const KEYS = {
  authMode: 'auth_mode',
  defaultModel: 'default_model',
  defaultPermissionMode: 'default_permission_mode',
  mcpServers: 'mcp_servers',
  permissionTimeoutMs: 'permission_timeout_ms',
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
    defaultModel: parseJson<ModelId>(KEYS.defaultModel, DEFAULT_SETTINGS.defaultModel),
    defaultPermissionMode: parseJson<PermissionMode>(KEYS.defaultPermissionMode, DEFAULT_SETTINGS.defaultPermissionMode),
    mcpServers: parseJson(KEYS.mcpServers, DEFAULT_SETTINGS.mcpServers),
    permissionTimeoutMs: parseJson(KEYS.permissionTimeoutMs, DEFAULT_SETTINGS.permissionTimeoutMs),
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
  if ('defaultModel' in patch) upsert(KEYS.defaultModel, next.defaultModel);
  if ('defaultPermissionMode' in patch) upsert(KEYS.defaultPermissionMode, next.defaultPermissionMode);
  if ('mcpServers' in patch) upsert(KEYS.mcpServers, next.mcpServers);
  if ('permissionTimeoutMs' in patch) upsert(KEYS.permissionTimeoutMs, next.permissionTimeoutMs);

  return next;
}
