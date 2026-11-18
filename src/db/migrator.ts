import fs from 'node:fs';
import path from 'node:path';
import type { DbClient } from './index.js';
import { logger } from '../config/logger.js';

export async function runMigrations(
  db: DbClient,
  migrationsDir = path.resolve(process.cwd(), 'migrations'),
): Promise<string[]> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const existing = await db.query<{ version: string }>(
    'SELECT version FROM schema_migrations',
  );
  const appliedSet = new Set(existing.rows.map((r) => r.version));
  const newlyApplied: string[] = [];

  for (const file of files) {
    if (appliedSet.has(file)) {
      continue;
    }
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await db.exec(sql);
    await db.query(
      'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
      [file],
    );
    newlyApplied.push(file);
    logger.info({ migration: file }, 'Migración aplicada');
  }

  return newlyApplied;
}
