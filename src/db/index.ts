import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

export interface QueryResultRow {
  [column: string]: unknown;
}

export interface DbResult<T = QueryResultRow> {
  rows: T[];
  rowCount: number;
}

export interface DbExecutor {
  query<T = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<DbResult<T>>;
}

export interface DbClient extends DbExecutor {
  readonly driver: 'pg' | 'pglite';
  exec(sql: string): Promise<void>;
  withTransaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

class PgDatabase implements DbClient {
  public readonly driver = 'pg' as const;
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 20,
      idleTimeoutMillis: 30000,
    });
  }

  async query<T = QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<DbResult<T>> {
    const res = await this.pool.query(text, params);
    return { rows: res.rows as T[], rowCount: res.rowCount ?? res.rows.length };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async withTransaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const executor: DbExecutor = {
        query: async <R = QueryResultRow>(
          text: string,
          params: unknown[] = [],
        ) => {
          const res = await client.query(text, params);
          return { rows: res.rows as R[], rowCount: res.rowCount ?? res.rows.length };
        },
      };
      const result = await fn(executor);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

class PgliteDatabase implements DbClient {
  public readonly driver = 'pglite' as const;
  private readonly db: PGlite;
  private txLock: Promise<void> = Promise.resolve();

  constructor(dataDir?: string) {
    if (dataDir && dataDir !== ':memory:') {
      const resolved = path.resolve(dataDir);
      fs.mkdirSync(resolved, { recursive: true });
      this.db = new PGlite(resolved);
    } else {
      this.db = new PGlite();
    }
  }

  async query<T = QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<DbResult<T>> {
    const res = await this.db.query<T>(text, params);
    return {
      rows: res.rows,
      rowCount: res.affectedRows ?? res.rows.length,
    };
  }

  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  async withTransaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
    // PGlite ejecuta en un solo proceso WASM; serializamos transacciones para evitar conflictos
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = this.txLock;
    this.txLock = next;
    await prev;

    try {
      return await this.db.transaction(async (tx) => {
        const executor: DbExecutor = {
          query: async <R = QueryResultRow>(
            text: string,
            params: unknown[] = [],
          ) => {
            const res = await tx.query<R>(text, params);
            return {
              rows: res.rows,
              rowCount: res.affectedRows ?? res.rows.length,
            };
          },
        };
        return fn(executor);
      });
    } finally {
      release();
    }
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

export function createDatabase(options?: {
  databaseUrl?: string;
  pgliteDir?: string;
}): DbClient {
  const databaseUrl = options?.databaseUrl ?? env.DATABASE_URL;
  if (databaseUrl && databaseUrl.trim().length > 0) {
    logger.info('Conectando a PostgreSQL mediante DATABASE_URL');
    return new PgDatabase(databaseUrl);
  }
  const dir = options?.pgliteDir ?? env.PGLITE_DATA_DIR;
  logger.info({ pgliteDir: dir }, 'Usando PostgreSQL embebido local (PGlite)');
  return new PgliteDatabase(dir);
}
