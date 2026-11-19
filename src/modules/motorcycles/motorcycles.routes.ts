import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { DbClient } from '../../db/index.js';
import { createAuthMiddleware } from '../../middleware/auth.js';
import {
  idParamSchema,
  paginationQuerySchema,
  uuidSchema,
  validateBody,
  validateParams,
  validateQuery,
} from '../../middleware/validate.js';
import { AppError, created, ok, paginated } from '../../utils/response.js';
import {
  assignMotorcycle,
  createMotorcycle,
  deleteMotorcyclePermanently,
  listMotorcycleAssignments,
  listMotorcycles,
  unlinkMotorcycle,
  updateMotorcycle,
} from './motorcycles.service.js';

const listMotorcyclesQuerySchema = paginationQuerySchema.extend({
  customerId: uuidSchema.optional(),
  status: z.enum(['assigned', 'unassigned']).optional(),
  search: z.string().trim().max(100).optional(),
  includeInactive: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
});

// Estricto: solo marca, modelo, cilindraje, apodo, color opcional y customerId opcional (nullable).
// Prohibido placa, teléfono, correo o cédula.
const createMotorcycleSchema = z
  .object({
    customerId: uuidSchema.nullable().optional(),
    brand: z.string().trim().min(1, 'La marca es obligatoria').max(80),
    model: z.string().trim().min(1, 'El modelo es obligatorio').max(80),
    cc: z.coerce
      .number()
      .int('El cilindraje debe ser entero')
      .min(1, 'El cilindraje debe ser mayor a 0')
      .max(5000),
    nickname: z.string().trim().max(80).nullable().optional(),
    color: z.string().trim().max(40).nullable().optional(),
  })
  .strict();

const patchMotorcycleSchema = z
  .object({
    customerId: uuidSchema.nullable().optional(),
    brand: z.string().trim().min(1).max(80).optional(),
    model: z.string().trim().min(1).max(80).optional(),
    cc: z.coerce.number().int().min(1).max(5000).optional(),
    nickname: z.string().trim().max(80).nullable().optional(),
    color: z.string().trim().max(40).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

const assignMotorcycleSchema = z
  .object({
    customerId: uuidSchema,
    reason: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

const unlinkMotorcycleSchema = z
  .object({
    reason: z.string().trim().max(500).nullable().optional(),
  })
  .strict()
  .optional();

function requireAdminMessage(message: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new AppError(401, 'UNAUTHORIZED', 'Se requiere autenticación'));
      return;
    }
    if (req.user.role !== 'Administrador') {
      next(new AppError(403, 'FORBIDDEN', message));
      return;
    }
    next();
  };
}

export function createMotorcyclesRouter(db: DbClient): Router {
  const router = Router();
  const { authenticate, requireRoles } = createAuthMiddleware(db);

  router.get(
    '/',
    authenticate(),
    validateQuery(listMotorcyclesQuerySchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const query = res.locals.query as z.infer<
          typeof listMotorcyclesQuerySchema
        >;
        const { items, total } = await listMotorcycles(db, actor, query);

        return paginated(
          res,
          items,
          query.page,
          query.pageSize,
          total,
          'Motos consultadas exitosamente',
        );
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/',
    authenticate(),
    requireAdminMessage('Solo el administrador puede registrar motos.'),
    validateBody(createMotorcycleSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const body = req.body as z.infer<typeof createMotorcycleSchema>;
        const moto = await createMotorcycle(db, actor, body, req.clientIp);
        return created(res, moto, 'Moto registrada exitosamente');
      } catch (err) {
        next(err);
      }
    },
  );

  router.patch(
    '/:id',
    authenticate(),
    requireAdminMessage('Solo el administrador puede editar motos.'),
    validateParams(idParamSchema),
    validateBody(patchMotorcycleSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { id } = res.locals.params as { id: string };
        const body = req.body as z.infer<typeof patchMotorcycleSchema>;
        const updated = await updateMotorcycle(
          db,
          actor,
          id,
          body,
          req.clientIp,
        );
        return ok(res, updated, 'Moto actualizada exitosamente');
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/:id/assignment',
    authenticate(),
    requireRoles('Administrador'),
    validateParams(idParamSchema),
    validateBody(assignMotorcycleSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { id } = res.locals.params as { id: string };
        const body = req.body as z.infer<typeof assignMotorcycleSchema>;
        const result = await assignMotorcycle(
          db,
          actor,
          id,
          body,
          req.clientIp,
        );
        return ok(res, result, 'Moto asociada correctamente');
      } catch (err) {
        next(err);
      }
    },
  );

  router.delete(
    '/:id/assignment',
    authenticate(),
    requireRoles('Administrador'),
    validateParams(idParamSchema),
    validateBody(unlinkMotorcycleSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { id } = res.locals.params as { id: string };
        const body = req.body as z.infer<typeof unlinkMotorcycleSchema>;
        const result = await unlinkMotorcycle(
          db,
          actor,
          id,
          body?.reason,
          req.clientIp,
        );
        return ok(
          res,
          result,
          'Moto desvinculada correctamente. El registro y su historial fueron conservados.',
        );
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    '/:id/assignments',
    authenticate(),
    requireRoles('Administrador'),
    validateParams(idParamSchema),
    validateQuery(paginationQuerySchema),
    async (req, res, next) => {
      try {
        const { id } = res.locals.params as { id: string };
        const { page, pageSize } = res.locals.query as z.infer<
          typeof paginationQuerySchema
        >;
        const { items, total } = await listMotorcycleAssignments(db, id, {
          page,
          pageSize,
        });
        return paginated(
          res,
          items,
          page,
          pageSize,
          total,
          'Historial de asociaciones consultado exitosamente',
        );
      } catch (err) {
        next(err);
      }
    },
  );

  router.delete(
    '/:id',
    authenticate(),
    requireAdminMessage(
      'Solo el administrador puede eliminar motos definitivamente.',
    ),
    validateParams(idParamSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { id } = res.locals.params as { id: string };
        await deleteMotorcyclePermanently(db, actor, id, req.clientIp);
        return res.status(204).send();
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
