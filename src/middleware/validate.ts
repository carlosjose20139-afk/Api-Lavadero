import type { NextFunction, Request, Response } from 'express';
import { z, type ZodType } from 'zod';
import { AppError } from '../utils/response.js';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const uuidSchema = z
  .string({ message: 'Debe ser un identificador UUID válido' })
  .regex(UUID_REGEX, 'Debe ser un UUID válido');

export const isoDateSchema = z
  .string({ message: 'La fecha debe tener formato YYYY-MM-DD' })
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha debe tener formato YYYY-MM-DD')
  .refine((val) => !Number.isNaN(Date.parse(`${val}T00:00:00-05:00`)), {
    message: 'Fecha calendario inválida',
  });

export const isoDateTimeSchema = z
  .string({ message: 'Debe ser una fecha y hora ISO-8601 válida' })
  .refine(
    (val) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/.test(
        val,
      ) && !Number.isNaN(Date.parse(val)),
    {
      message:
        'Debe ser una fecha ISO-8601 válida con zona horaria (ej. -05:00 o Z)',
    },
  );

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

function formatZodFields(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : 'body';
    if (!fields[key]) {
      fields[key] = issue.message;
    }
  }
  return fields;
}

export function validateBody<T>(schema: ZodType<T>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      next(
        new AppError(
          422,
          'VALIDATION_ERROR',
          'Los datos enviados no son válidos',
          formatZodFields(parsed.error),
        ),
      );
      return;
    }
    req.body = parsed.data;
    next();
  };
}

export function validateQuery<T>(schema: ZodType<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) {
      next(
        new AppError(
          422,
          'VALIDATION_ERROR',
          'Los parámetros de consulta no son válidos',
          formatZodFields(parsed.error),
        ),
      );
      return;
    }
    res.locals.query = parsed.data;
    next();
  };
}

export function validateParams<T>(schema: ZodType<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req.params);
    if (!parsed.success) {
      next(
        new AppError(
          422,
          'VALIDATION_ERROR',
          'Los parámetros de ruta no son válidos',
          formatZodFields(parsed.error),
        ),
      );
      return;
    }
    res.locals.params = parsed.data;
    next();
  };
}

export const idParamSchema = z.object({
  id: uuidSchema,
});
