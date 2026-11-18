import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../utils/response.js';
import { logger } from '../config/logger.js';

export function notFoundHandler(_req: Request, res: Response): Response {
  return res.status(404).json({
    data: { code: 'NOT_FOUND' },
    message: 'El recurso solicitado no existe',
  });
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): Response {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      data: {
        code: err.code,
        ...(err.fields ? { fields: err.fields } : {}),
      },
      message: err.message,
    });
  }

  // JSON malformado en express.json()
  if (
    typeof err === 'object' &&
    err !== null &&
    'type' in err &&
    (err as { type?: string }).type === 'entity.parse.failed'
  ) {
    return res.status(400).json({
      data: { code: 'INVALID_JSON' },
      message: 'El cuerpo de la petición no es un JSON válido',
    });
  }

  if (
    typeof err === 'object' &&
    err !== null &&
    'type' in err &&
    (err as { type?: string }).type === 'entity.too.large'
  ) {
    return res.status(413).json({
      data: { code: 'PAYLOAD_TOO_LARGE' },
      message: 'El tamaño de la petición supera el límite permitido',
    });
  }

  // Errores estándar de PostgreSQL (unique_violation = 23505, foreign_key_violation = 23503)
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const pgCode = (err as { code?: string }).code;
    if (pgCode === '23505') {
      return res.status(409).json({
        data: { code: 'DUPLICATE_RESOURCE' },
        message: 'Ya existe un registro con los mismos datos únicos',
      });
    }
    if (pgCode === '23503') {
      return res.status(409).json({
        data: { code: 'REFERENCE_CONFLICT' },
        message: 'No se puede completar la operación por referencias activas',
      });
    }
  }

  logger.error(
    {
      err: err instanceof Error ? { name: err.name, message: err.message } : 'unknown',
      method: req.method,
      path: req.originalUrl,
    },
    'Error interno no controlado',
  );

  return res.status(500).json({
    data: { code: 'INTERNAL_SERVER_ERROR' },
    message: 'Ocurrió un error interno al procesar la solicitud',
  });
}
