import { Router } from 'express';
import { z } from 'zod';
import type { DbClient } from '../../db/index.js';
import { createAuthMiddleware } from '../../middleware/auth.js';
import {
  isoDateTimeSchema,
  paginationQuerySchema,
  validateBody,
  validateQuery,
} from '../../middleware/validate.js';
import { recordAuditLog } from '../../services/audit.service.js';
import { newUuid } from '../../utils/crypto.js';
import { AppError, created, paginated } from '../../utils/response.js';
import { toIsoBogota } from '../../utils/time.js';

const listPromotionsQuerySchema = paginationQuerySchema.extend({
  all: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
});

const promotionInputSchema = z
  .object({
    title: z.string().trim().min(2).max(160),
    description: z.string().trim().min(2).max(2000),
    discountAmount: z.coerce.number().int().min(0).nullable().optional(),
    discountPercent: z.coerce.number().min(0).max(100).nullable().optional(),
    startsAt: isoDateTimeSchema,
    endsAt: isoDateTimeSchema,
    isActive: z.boolean().optional().default(true),
  })
  .strict();

interface PromotionRow {
  id: string;
  title: string;
  description: string;
  discount_amount: number | null;
  discount_percent: string | number | null;
  starts_at: Date | string;
  ends_at: Date | string;
  is_active: boolean;
}

function mapPromotion(row: PromotionRow) {
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
  };
}

export function createPromotionsRouter(db: DbClient): Router {
  const router = Router();
  const { authenticate, optionalAuthenticate, requireRoles } =
    createAuthMiddleware(db);

  router.get(
    '/',
    optionalAuthenticate(),
    validateQuery(listPromotionsQuerySchema),
    async (req, res, next) => {
      try {
        const { page, pageSize, all } = res.locals.query as z.infer<
          typeof listPromotionsQuerySchema
        >;
        const showAll = all && req.user?.role === 'Administrador';
        const whereSql = showAll
          ? ''
          : 'WHERE is_active = TRUE AND ends_at >= NOW()';

        const countRes = await db.query<{ cnt: string | number }>(
          `SELECT COUNT(*) AS cnt FROM promotions ${whereSql}`,
        );
        const total = Number(countRes.rows[0]?.cnt ?? 0);
        const offset = (page - 1) * pageSize;

        const rowsRes = await db.query<PromotionRow>(
          `SELECT id, title, description, discount_amount, discount_percent,
                  starts_at, ends_at, is_active
           FROM promotions
           ${whereSql}
           ORDER BY starts_at DESC
           LIMIT $1 OFFSET $2`,
          [pageSize, offset],
        );

        return paginated(
          res,
          rowsRes.rows.map(mapPromotion),
          page,
          pageSize,
          total,
          'Promociones consultadas exitosamente',
        );
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/',
    authenticate(),
    requireRoles('Administrador'),
    validateBody(promotionInputSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const body = req.body as z.infer<typeof promotionInputSchema>;
        const startsAt = new Date(body.startsAt);
        const endsAt = new Date(body.endsAt);

        if (endsAt <= startsAt) {
          throw new AppError(
            422,
            'VALIDATION_ERROR',
            'La fecha de fin debe ser posterior a la fecha de inicio',
            { endsAt: 'Debe ser posterior a startsAt' },
          );
        }

        const id = newUuid();
        const inserted = await db.withTransaction(async (tx) => {
          const ins = await tx.query<PromotionRow>(
            `INSERT INTO promotions (
               id, title, description, discount_amount, discount_percent,
               starts_at, ends_at, is_active, created_by
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING id, title, description, discount_amount, discount_percent,
                       starts_at, ends_at, is_active`,
            [
              id,
              body.title,
              body.description,
              body.discountAmount ?? null,
              body.discountPercent ?? null,
              startsAt,
              endsAt,
              body.isActive ?? true,
              actor.id,
            ],
          );

          await recordAuditLog(tx, {
            actorId: actor.id,
            actorRole: actor.role,
            action: 'promotion_created',
            entityType: 'promotion',
            entityId: id,
            ipAddress: req.clientIp,
            changes: body,
          });

          return ins.rows[0]!;
        });

        return created(
          res,
          mapPromotion(inserted),
          'Promoción creada exitosamente',
        );
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
