import type { NextFunction, Request, Response } from 'express';
import type { DbClient, DbExecutor } from '../db/index.js';
import { sha256 } from '../utils/crypto.js';
import { AppError } from '../utils/response.js';

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

export function validateIdempotencyHeader(required = true) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const rawPrimary = req.headers['x-idempotency-key'];
    const rawStandard = req.headers['idempotency-key'];
    const primaryKey = Array.isArray(rawPrimary) ? rawPrimary[0] : rawPrimary;
    const standardKey = Array.isArray(rawStandard) ? rawStandard[0] : rawStandard;

    if (primaryKey && standardKey && primaryKey !== standardKey) {
      next(
        new AppError(
          422,
          'INVALID_IDEMPOTENCY_KEY',
          'Los encabezados Idempotency-Key y X-Idempotency-Key no pueden tener valores distintos',
          { 'Idempotency-Key': 'Conflictivo con X-Idempotency-Key' },
        ),
      );
      return;
    }

    const key = primaryKey ?? standardKey;

    if (!key) {
      if (required) {
        next(
          new AppError(
            422,
            'IDEMPOTENCY_KEY_REQUIRED',
            'El encabezado Idempotency-Key o X-Idempotency-Key es obligatorio para esta operación',
            { 'X-Idempotency-Key': 'Requerido (16 a 100 caracteres)' },
          ),
        );
        return;
      }
      next();
      return;
    }

    if (key.length < 16 || key.length > 100) {
      next(
        new AppError(
          422,
          'INVALID_IDEMPOTENCY_KEY',
          'La clave de idempotencia debe tener entre 16 y 100 caracteres',
          { 'X-Idempotency-Key': 'Longitud inválida (16 a 100 caracteres)' },
        ),
      );
      return;
    }

    res.locals.idempotencyKey = key;
    next();
  };
}

export async function runIdempotent<T>(
  db: DbClient,
  params: {
    key?: string;
    actorId: string;
    method: string;
    path: string;
    requestBody: unknown;
    successStatus: number;
  },
  fn: (tx: DbExecutor) => Promise<T>,
): Promise<{ statusCode: number; body: T; replayed: boolean }> {
  const { key, actorId, method, path, requestBody, successStatus } = params;
  const requestHash = sha256(stableStringify(requestBody ?? {}));

  return db.withTransaction(async (tx) => {
    if (key) {
      // Serializa solicitudes simultáneas con la misma clave de idempotencia sin condiciones de carrera
      await tx.query(
        `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
        [`${actorId}:${method}:${path}`, key],
      );

      const existing = await tx.query<{
        request_hash: string;
        status_code: number;
        response_body: T;
      }>(
        `SELECT request_hash, status_code, response_body
         FROM idempotency_keys
         WHERE idempotency_key = $1 AND actor_id = $2 AND method = $3 AND path = $4
         FOR UPDATE`,
        [key, actorId, method, path],
      );

      if (existing.rows[0]) {
        const record = existing.rows[0];
        if (record.request_hash !== requestHash) {
          throw new AppError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'La clave X-Idempotency-Key ya fue usada con datos diferentes',
          );
        }
        return {
          statusCode: record.status_code,
          body: record.response_body,
          replayed: true,
        };
      }
    }

    const result = await fn(tx);

    if (key) {
      await tx.query(
        `INSERT INTO idempotency_keys (idempotency_key, actor_id, method, path, request_hash, status_code, response_body)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [key, actorId, method, path, requestHash, successStatus, JSON.stringify(result)],
      );
    }

    return {
      statusCode: successStatus,
      body: result,
      replayed: false,
    };
  });
}
