import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

// Singleton better-sqlite3 handle. Used both from Next.js route handlers and
// from the agent worker — same database file, WAL mode so concurrent readers
// and a single writer are safe.
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let _sqlite: Database.Database | null = null;

export function getDb() {
  if (_db) return _db;

  const dbPath = resolve(process.env.DATABASE_PATH ?? './data/boardroom.db');
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  _sqlite = new Database(dbPath);
  _sqlite.pragma('journal_mode = WAL');
  _sqlite.pragma('foreign_keys = ON');
  _sqlite.pragma('synchronous = NORMAL');
  _sqlite.pragma('busy_timeout = 5000');

  _db = drizzle(_sqlite, { schema });
  return _db;
}

export function getRawSqlite(): Database.Database {
  if (!_sqlite) getDb();
  return _sqlite!;
}

export function closeDb() {
  if (_sqlite) {
    _sqlite.close();
    _sqlite = null;
    _db = null;
  }
}

export { schema };
