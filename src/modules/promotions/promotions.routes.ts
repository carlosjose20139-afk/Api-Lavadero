import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { DbClient } from '../../db/index.js';
import { createAuthMiddleware } from '../../middleware/auth.js';
import {
  idParamSchema,
  paginationQuerySchema,
  validateBody,
  validateParams,
  validateQuery,
} from '../../middleware/validate.js';
import { AppError, created, ok, paginated } from '../../utils/response.js';
import {
  createPromotion,
  listPromotions,
  softDeletePromotion,
  updatePromotion,
  updatePromotionStatus,
} from './promotions.service.js';

const listPromotionsQuerySchema = paginationQuerySchema.extend({
  includeInactive: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  all: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
});

const numericInputSchema = z.union([
  z.number().refine((v) => Number.isFinite(v), 'Debe ser un número válido'),
  z
    .string()
    .trim()
    .regex(/^-?\d+(?:\.\d+)?$/, 'Debe ser un valor numérico válido')
    .transform((v) => Number(v)),
]);

const promotionCreateSchema = z
  .object({
    title: z
      .string({ message: 'El título debe ser una cadena de texto' })
      .trim()
      .min(2, 'El título debe tener al menos 2 caracteres')
      .max(160, 'El título no puede superar 160 caracteres'),
    description: z
      .string({ message: 'La descripción debe ser una cadena de texto' })
      .trim()
      .min(2, 'La descripción debe tener al menos 2 caracteres')
      .max(2000, 'La descripción no puede superar 2000 caracteres'),
    discountAmount: numericInputSchema.nullable().optional(),
    discountPercent: numericInputSchema.nullable().optional(),
    startsAt: z
      .string({ message: 'startsAt debe ser una fecha ISO-8601 válida' })
      .trim()
      .min(1, 'startsAt es obligatorio'),
    endsAt: z
      .string({ message: 'endsAt debe ser una fecha ISO-8601 válida' })
      .trim()
      .min(1, 'endsAt es obligatorio'),
    isActive: z
      .boolean({ message: 'isActive debe ser booleano' })
      .optional()
      .default(true),
  })
  .strict();

const promotionPatchSchema = z
  .object({
    title: z
      .string({ message: 'El título debe ser una cadena de texto' })
      .trim()
      .min(2, 'El título debe tener al menos 2 caracteres')
      .max(160, 'El título no puede superar 160 caracteres')
      .optional(),
    description: z
      .string({ message: 'La descripción debe ser una cadena de texto' })
      .trim()
      .min(2, 'La descripción debe tener al menos 2 caracteres')
      .max(2000, 'La descripción no puede superar 2000 caracteres')
      .optional(),
    discountAmount: numericInputSchema.nullable().optional(),
    discountPercent: numericInputSchema.nullable().optional(),
    startsAt: z
      .string({ message: 'startsAt debe ser una fecha ISO-8601 válida' })
      .trim()
      .min(1, 'startsAt no puede estar vacío')
      .optional(),
    endsAt: z
      .string({ message: 'endsAt debe ser una fecha ISO-8601 válida' })
      .trim()
      .min(1, 'endsAt no puede estar vacío')
      .optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Debes enviar al menos un campo para actualizar la promoción',
  });

const promotionStatusSchema = z
  .object({
    isActive: z.boolean({
      message: 'El campo isActive es obligatorio y debe ser booleano (true o false)',
    }),
  })
  .strict();

function requirePromotionAdmin() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new AppError(401, 'UNAUTHORIZED', 'Se requiere autenticación'));
      return;
    }
    if (req.user.role !== 'Administrador') {
      next(
        new AppError(
          403,
          'PROMOTION_FORBIDDEN',
          'Solo el administrador puede gestionar promociones',
        ),
      );
      return;
    }
    next();
  };
}

export function createPromotionsRouter(db: DbClient): Router {
  const router = Router();
  const { authenticate, optionalAuthenticate } = createAuthMiddleware(db);

  router.get(
    '/',
    optionalAuthenticate(),
    validateQuery(listPromotionsQuerySchema),
    async (req, res, next) => {
      try {
        const query = res.locals.query as z.infer<
          typeof listPromotionsQuerySchema
        >;
        const { items, total } = await listPromotions(db, req.user?.role, query);

        return paginated(
          res,
          items,
          query.page,
          query.pageSize,
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
    requirePromotionAdmin(),
    validateBody(promotionCreateSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const body = req.body as z.infer<typeof promotionCreateSchema>;
        const promo = await createPromotion(db, actor, body, req.clientIp);

        return created(res, promo, 'Promoción creada exitosamente');
      } catch (err) {
        next(err);
      }
    },
  );

  router.patch(
    '/:id',
    authenticate(),
    requirePromotionAdmin(),
    validateParams(idParamSchema),
    validateBody(promotionPatchSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { id } = res.locals.params as { id: string };
        const body = req.body as z.infer<typeof promotionPatchSchema>;
        const updated = await updatePromotion(db, actor, id, body, req.clientIp);

        return ok(res, updated, 'Promoción actualizada');
      } catch (err) {
        next(err);
      }
    },
  );

  router.patch(
    '/:id/status',
    authenticate(),
    requirePromotionAdmin(),
    validateParams(idParamSchema),
    validateBody(promotionStatusSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { id } = res.locals.params as { id: string };
        const { isActive } = req.body as z.infer<typeof promotionStatusSchema>;
        const updated = await updatePromotionStatus(
          db,
          actor,
          id,
          isActive,
          req.clientIp,
        );

        return ok(
          res,
          updated,
          isActive
            ? 'Promoción activada exitosamente'
            : 'Promoción desactivada exitosamente',
        );
      } catch (err) {
        next(err);
      }
    },
  );

  router.delete(
    '/:id',
    authenticate(),
    requirePromotionAdmin(),
    validateParams(idParamSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { id } = res.locals.params as { id: string };
        const deleted = await softDeletePromotion(db, actor, id, req.clientIp);

        return ok(res, deleted, 'Promoción eliminada exitosamente');
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
