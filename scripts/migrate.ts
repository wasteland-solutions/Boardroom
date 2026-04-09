#!/usr/bin/env tsx
// Run pending Drizzle migrations against the configured SQLite database.
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

const dbPath = resolve(process.env.DATABASE_PATH ?? './data/boardroom.db');
const dir = dirname(dbPath);
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

const db = drizzle(sqlite);
migrate(db, { migrationsFolder: './drizzle' });

console.log(`[boardroom] migrations applied to ${dbPath}`);
sqlite.close();
