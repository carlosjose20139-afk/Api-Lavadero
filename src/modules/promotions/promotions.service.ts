import type { DbClient, DbExecutor } from '../../db/index.js';
import type { AuthUser, UserRole } from '../../middleware/auth.js';
import { recordAuditLog } from '../../services/audit.service.js';
import { newUuid } from '../../utils/crypto.js';
import { AppError } from '../../utils/response.js';
import { toIsoBogota, toIsoBogotaNullable } from '../../utils/time.js';

export interface PromotionRow {
  id: string;
  title: string;
  description: string;
  discount_amount: number | null;
  discount_percent: string | number | null;
  starts_at: Date | string;
  ends_at: Date | string;
  is_active: boolean;
  created_at: Date | string;
  updated_at: Date | string;
  deleted_at: Date | string | null;
}

export interface PromotionDto {
  id: string;
  title: string;
  description: string;
  discountAmount: number | null;
  discountPercent: number | null;
  startsAt: string;
  endsAt: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface CreatePromotionInput {
  title: string;
  description: string;
  discountAmount?: number | null;
  discountPercent?: number | null;
  startsAt: string;
  endsAt: string;
  isActive?: boolean;
}

export interface UpdatePromotionInput {
  title?: string;
  description?: string;
  discountAmount?: number | null;
  discountPercent?: number | null;
  startsAt?: string;
  endsAt?: string;
}

export interface ListPromotionsQuery {
  page: number;
  pageSize: number;
  includeInactive?: boolean;
  all?: boolean;
}

const ISO_DATETIME_TZ_REGEX =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|[+-]\d{2}:\d{2})$/;

export function sanitizePromotionText(raw: string): string {
  return raw
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/?[a-zA-Z!][^>]*>/g, ' ')
    .replace(/\b(?:javascript|vbscript|data)\s*:/gi, '')
    .replace(/\bon[a-z]+\s*=\s*(['"]).*?\1/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sanitizeAndValidatePromotionField(
  raw: string,
  field: 'title' | 'description',
  maxLength: number,
): string {
  const sanitized = sanitizePromotionText(raw);
  const label = field === 'title' ? 'El título' : 'La descripción';
  if (sanitized.length < 2) {
    throw new AppError(
      422,
      'VALIDATION_ERROR',
      `${label} debe tener al menos 2 caracteres válidos sin HTML ni scripts`,
      { [field]: `${label} debe tener al menos 2 caracteres válidos` },
    );
  }
  if (sanitized.length > maxLength) {
    throw new AppError(
      422,
      'VALIDATION_ERROR',
      `${label} no puede superar ${maxLength} caracteres`,
      { [field]: `Máximo ${maxLength} caracteres` },
    );
  }
  return sanitized;
}

export function parsePromotionIsoDate(
  value: string,
  field: 'startsAt' | 'endsAt',
): Date {
  const match = ISO_DATETIME_TZ_REGEX.exec(value);
  if (!match) {
    throw new AppError(
      422,
      'PROMOTION_INVALID_DATES',
      'Las fechas de la promoción deben usar formato ISO-8601 válido con zona horaria',
      { [field]: 'Formato ISO-8601 inválido (ej. 2026-12-01T00:00:00.000Z o -05:00)' },
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? '0');

  // Validar calendario real para evitar rollovers como 2026-02-30
  const utcCheck = new Date(Date.UTC(year, month - 1, day));
  if (
    utcCheck.getUTCFullYear() !== year ||
    utcCheck.getUTCMonth() !== month - 1 ||
    utcCheck.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new AppError(
      422,
      'PROMOTION_INVALID_DATES',
      'La fecha ingresada no corresponde a una fecha y hora válida',
      { [field]: 'Fecha u hora fuera de rango calendario' },
    );
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError(
      422,
      'PROMOTION_INVALID_DATES',
      'La fecha de la promoción no es válida',
      { [field]: 'Fecha ISO-8601 inválida' },
    );
  }

  return parsed;
}

export function validatePromotionDateWindow(startsAt: Date, endsAt: Date): void {
  if (endsAt.getTime() <= startsAt.getTime()) {
    throw new AppError(
      422,
      'PROMOTION_INVALID_DATES',
      'La fecha de fin debe ser posterior a la fecha de inicio',
      { endsAt: 'Debe ser posterior a startsAt' },
    );
  }
}

export function validatePromotionDiscounts(
  discountAmount: number | null | undefined,
  discountPercent: number | null | undefined,
): void {
  if (discountAmount !== undefined && discountAmount !== null) {
    if (!Number.isInteger(discountAmount) || discountAmount < 0) {
      throw new AppError(
        422,
        'PROMOTION_INVALID_DISCOUNT',
        'El descuento en COP debe ser un número entero mayor o igual a 0',
        { discountAmount: 'Debe ser un entero >= 0' },
      );
    }
  }

  if (discountPercent !== undefined && discountPercent !== null) {
    if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
      throw new AppError(
        422,
        'PROMOTION_INVALID_DISCOUNT',
        'El porcentaje de descuento debe estar entre 0 y 100',
        { discountPercent: 'Debe estar entre 0 y 100' },
      );
    }
  }

  if (
    discountAmount !== undefined &&
    discountAmount !== null &&
    discountPercent !== undefined &&
    discountPercent !== null
  ) {
    throw new AppError(
      422,
      'PROMOTION_INVALID_DISCOUNT',
      'Solo puedes definir descuento en valor fijo (COP) o en porcentaje, no ambos al mismo tiempo',
      {
        discountAmount: 'No puede combinarse con discountPercent',
        discountPercent: 'No puede combinarse con discountAmount',
      },
    );
  }
}

export function mapPromotion(row: PromotionRow): PromotionDto {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    discountAmount:
      row.discount_amount !== null ? Number(row.discount_amount) : null,
    discountPercent:
      row.discount_percent !== null ? Number(row.discount_percent) : null,
    startsAt: toIsoBogota(row.starts_at),
    endsAt: toIsoBogota(row.ends_at),
    isActive: row.is_active,
    createdAt: toIsoBogota(row.created_at),
    updatedAt: toIsoBogota(row.updated_at),
    deletedAt: toIsoBogotaNullable(row.deleted_at),
  };
}

const PROMOTION_COLUMNS = `
  id, title, description, discount_amount, discount_percent,
  starts_at, ends_at, is_active, created_at, updated_at, deleted_at
`;

async function lockActivePromotion(
  tx: DbExecutor,
  id: string,
): Promise<PromotionRow> {
  const existingRes = await tx.query<PromotionRow>(
    `SELECT ${PROMOTION_COLUMNS}
     FROM promotions
     WHERE id = $1 AND deleted_at IS NULL
     FOR UPDATE`,
    [id],
  );
  const existing = existingRes.rows[0];
  if (!existing) {
    throw new AppError(404, 'PROMOTION_NOT_FOUND', 'Promoción no encontrada');
  }
  return existing;
}

export async function listPromotions(
  db: DbClient,
  actorRole: UserRole | undefined,
  query: ListPromotionsQuery,
): Promise<{ items: PromotionDto[]; total: number }> {
  const showAllNonDeleted =
    Boolean(query.includeInactive || query.all) && actorRole === 'Administrador';

  const whereSql = showAllNonDeleted
    ? 'WHERE deleted_at IS NULL'
    : 'WHERE deleted_at IS NULL AND is_active = TRUE AND starts_at <= NOW() AND ends_at >= NOW()';

  const countRes = await db.query<{ cnt: string | number }>(
    `SELECT COUNT(*) AS cnt FROM promotions ${whereSql}`,
  );
  const total = Number(countRes.rows[0]?.cnt ?? 0);
  const offset = (query.page - 1) * query.pageSize;

  const rowsRes = await db.query<PromotionRow>(
    `SELECT ${PROMOTION_COLUMNS}
     FROM promotions
     ${whereSql}
     ORDER BY starts_at DESC, created_at DESC
     LIMIT $1 OFFSET $2`,
    [query.pageSize, offset],
  );

  return {
    items: rowsRes.rows.map(mapPromotion),
    total,
  };
}

export async function createPromotion(
  db: DbClient,
  actor: AuthUser,
  body: CreatePromotionInput,
  ipAddress?: string,
): Promise<PromotionDto> {
  const title = sanitizeAndValidatePromotionField(body.title, 'title', 160);
  const description = sanitizeAndValidatePromotionField(
    body.description,
    'description',
    2000,
  );
  const startsAt = parsePromotionIsoDate(body.startsAt, 'startsAt');
  const endsAt = parsePromotionIsoDate(body.endsAt, 'endsAt');
  validatePromotionDateWindow(startsAt, endsAt);
  validatePromotionDiscounts(body.discountAmount, body.discountPercent);

  const id = newUuid();
  const inserted = await db.withTransaction(async (tx) => {
    const ins = await tx.query<PromotionRow>(
      `INSERT INTO promotions (
         id, title, description, discount_amount, discount_percent,
         starts_at, ends_at, is_active, created_by
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${PROMOTION_COLUMNS}`,
      [
        id,
        title,
        description,
        body.discountAmount ?? null,
        body.discountPercent ?? null,
        startsAt,
        endsAt,
        body.isActive ?? true,
        actor.id,
      ],
    );

    const mapped = mapPromotion(ins.rows[0]!);
    await recordAuditLog(tx, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'promotion_created',
      entityType: 'promotion',
      entityId: id,
      ipAddress,
      changes: {
        previous: null,
        new: mapped,
      },
    });

    return mapped;
  });

  return inserted;
}

export async function updatePromotion(
  db: DbClient,
  actor: AuthUser,
  id: string,
  body: UpdatePromotionInput,
  ipAddress?: string,
): Promise<PromotionDto> {
  const sanitizedTitle =
    body.title !== undefined
      ? sanitizeAndValidatePromotionField(body.title, 'title', 160)
      : undefined;
  const sanitizedDescription =
    body.description !== undefined
      ? sanitizeAndValidatePromotionField(body.description, 'description', 2000)
      : undefined;

  const parsedStartsAt =
    body.startsAt !== undefined
      ? parsePromotionIsoDate(body.startsAt, 'startsAt')
      : undefined;
  const parsedEndsAt =
    body.endsAt !== undefined
      ? parsePromotionIsoDate(body.endsAt, 'endsAt')
      : undefined;

  validatePromotionDiscounts(body.discountAmount, body.discountPercent);

  return db.withTransaction(async (tx) => {
    const existing = await lockActivePromotion(tx, id);
    const previousMapped = mapPromotion(existing);

    const effectiveStartsAt = parsedStartsAt ?? new Date(existing.starts_at);
    const effectiveEndsAt = parsedEndsAt ?? new Date(existing.ends_at);
    validatePromotionDateWindow(effectiveStartsAt, effectiveEndsAt);

    let nextDiscountAmount: number | null =
      existing.discount_amount !== null ? Number(existing.discount_amount) : null;
    let nextDiscountPercent: number | null =
      existing.discount_percent !== null ? Number(existing.discount_percent) : null;

    if (body.discountAmount !== undefined) {
      nextDiscountAmount = body.discountAmount;
      if (body.discountAmount !== null && body.discountPercent === undefined) {
        nextDiscountPercent = null;
      }
    }
    if (body.discountPercent !== undefined) {
      nextDiscountPercent = body.discountPercent;
      if (body.discountPercent !== null && body.discountAmount === undefined) {
        nextDiscountAmount = null;
      }
    }

    const upd = await tx.query<PromotionRow>(
      `UPDATE promotions
       SET title = $1,
           description = $2,
           discount_amount = $3,
           discount_percent = $4,
           starts_at = $5,
           ends_at = $6,
           updated_at = NOW()
       WHERE id = $7 AND deleted_at IS NULL
       RETURNING ${PROMOTION_COLUMNS}`,
      [
        sanitizedTitle ?? existing.title,
        sanitizedDescription ?? existing.description,
        nextDiscountAmount,
        nextDiscountPercent,
        effectiveStartsAt,
        effectiveEndsAt,
        id,
      ],
    );

    const updatedMapped = mapPromotion(upd.rows[0]!);
    await recordAuditLog(tx, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'promotion_updated',
      entityType: 'promotion',
      entityId: id,
      ipAddress,
      changes: {
        previous: previousMapped,
        new: updatedMapped,
        updatedFields: Object.keys(body),
      },
    });

    return updatedMapped;
  });
}

export async function updatePromotionStatus(
  db: DbClient,
  actor: AuthUser,
  id: string,
  isActive: boolean,
  ipAddress?: string,
): Promise<PromotionDto> {
  return db.withTransaction(async (tx) => {
    const existing = await lockActivePromotion(tx, id);
    const previousMapped = mapPromotion(existing);

    const upd = await tx.query<PromotionRow>(
      `UPDATE promotions
       SET is_active = $1,
           updated_at = NOW()
       WHERE id = $2 AND deleted_at IS NULL
       RETURNING ${PROMOTION_COLUMNS}`,
      [isActive, id],
    );

    const updatedMapped = mapPromotion(upd.rows[0]!);
    await recordAuditLog(tx, {
      actorId: actor.id,
      actorRole: actor.role,
      action: isActive ? 'promotion_activated' : 'promotion_deactivated',
      entityType: 'promotion',
      entityId: id,
      ipAddress,
      changes: {
        previous: { isActive: previousMapped.isActive },
        new: { isActive: updatedMapped.isActive },
      },
    });

    return updatedMapped;
  });
}

export async function softDeletePromotion(
  db: DbClient,
  actor: AuthUser,
  id: string,
  ipAddress?: string,
): Promise<PromotionDto> {
  return db.withTransaction(async (tx) => {
    const existing = await lockActivePromotion(tx, id);
    const previousMapped = mapPromotion(existing);

    const del = await tx.query<PromotionRow>(
      `UPDATE promotions
       SET deleted_at = NOW(),
           is_active = FALSE,
           updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING ${PROMOTION_COLUMNS}`,
      [id],
    );

    const deletedMapped = mapPromotion(del.rows[0]!);
    await recordAuditLog(tx, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'promotion_deleted',
      entityType: 'promotion',
      entityId: id,
      ipAddress,
      changes: {
        previous: previousMapped,
        new: deletedMapped,
      },
    });

    return deletedMapped;
  });
}
