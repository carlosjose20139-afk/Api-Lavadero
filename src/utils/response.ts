import type { Response } from 'express';

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly fields?: Record<string, string>;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    fields?: Record<string, string>,
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.fields = fields;
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export function ok<T>(res: Response, data: T, message = 'Operación exitosa', statusCode = 200): Response {
  return res.status(statusCode).json({
    data,
    message,
  });
}

export function created<T>(res: Response, data: T, message = 'Recurso creado exitosamente'): Response {
  return res.status(201).json({
    data,
    message,
  });
}

export function paginated<T>(
  res: Response,
  data: T[],
  page: number,
  pageSize: number,
  total: number,
  message = 'Consulta exitosa',
): Response {
  const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
  const meta: PageMeta = {
    page,
    pageSize,
    total,
    totalPages,
  };
  return res.status(200).json({
    data,
    meta,
    message,
  });
}
