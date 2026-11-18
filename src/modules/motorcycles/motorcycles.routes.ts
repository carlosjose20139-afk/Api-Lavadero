import { Router } from 'express';
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
import { recordAuditLog } from '../../services/audit.service.js';
import { newUuid } from '../../utils/crypto.js';
import { AppError, created, ok, paginated } from '../../utils/response.js';
import { toIsoBogota } from '../../utils/time.js';

const listMotorcyclesQuerySchema = paginationQuerySchema.extend({
  customerId: uuidSchema.optional(),
  includeInactive: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
});

// Estricto: solo marca, modelo, cilindraje, apodo y color opcional. No existe placa.
const createMotorcycleSchema = z
  .object({
    customerId: uuidSchema.optional(),
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
    customerId: uuidSchema.optional(),
    brand: z.string().trim().min(1).max(80).optional(),
    model: z.string().trim().min(1).max(80).optional(),
    cc: z.coerce.number().int().min(1).max(5000).optional(),
    nickname: z.string().trim().max(80).nullable().optional(),
    color: z.string().trim().max(40).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

interface MotorcycleRow {
  id: string;
  customer_id: string;
  brand: string;
  model: string;
  cc: number;
  nickname: string | null;
  color: string | null;
  is_active: boolean;
  created_at: Date | string;
}

function mapMotorcycle(row: MotorcycleRow) {
  return {
    id: row.id,
    customerId: row.customer_id,
    brand: row.brand,
    model: row.model,
    cc: Number(row.cc),
    nickname: row.nickname,
    color: row.color,
    createdAt: toIsoBogota(row.created_at),
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
        const { page, pageSize, customerId, includeInactive } = res.locals
          .query as z.infer<typeof listMotorcyclesQuerySchema>;

        if (actor.role === 'Cliente' && customerId && customerId !== actor.id) {
          throw new AppError(
            403,
            'FORBIDDEN',
            'No puedes consultar motos de otro cliente',
          );
        }

        const effectiveCustomerId =
          actor.role === 'Cliente' ? actor.id : customerId;
        const conditions: string[] = [];
        const params: unknown[] = [];

        if (!includeInactive || actor.role === 'Cliente') {
          conditions.push('is_active = TRUE');
        }
        if (effectiveCustomerId) {
          params.push(effectiveCustomerId);
          conditions.push(`customer_id = $${params.length}`);
        }

        const whereSql =
          conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const countRes = await db.query<{ cnt: string | number }>(
          `SELECT COUNT(*) AS cnt FROM motorcycles ${whereSql}`,
          params,
        );
        const total = Number(countRes.rows[0]?.cnt ?? 0);

        const offset = (page - 1) * pageSize;
        const listRes = await db.query<MotorcycleRow>(
          `SELECT id, customer_id, brand, model, cc, nickname, color, is_active, created_at
           FROM motorcycles
           ${whereSql}
           ORDER BY created_at DESC
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, pageSize, offset],
        );

        return paginated(
          res,
          listRes.rows.map(mapMotorcycle),
          page,
          pageSize,
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
    requireRoles('Cliente', 'Administrador'),
    validateBody(createMotorcycleSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const body = req.body as z.infer<typeof createMotorcycleSchema>;

        let targetCustomerId = actor.id;
        if (actor.role === 'Cliente') {
          if (body.customerId && body.customerId !== actor.id) {
            throw new AppError(
              403,
              'FORBIDDEN',
              'Un cliente solo puede registrar sus propias motos',
            );
          }
        } else {
          if (!body.customerId) {
            throw new AppError(
              422,
              'VALIDATION_ERROR',
              'El administrador debe especificar customerId',
              { customerId: 'Obligatorio para registrar moto a un cliente' },
            );
          }
          targetCustomerId = body.customerId;
        }

        const custRes = await db.query<{ id: string; role: string }>(
          `SELECT id, role FROM users WHERE id = $1 AND role = 'Cliente'`,
          [targetCustomerId],
        );
        if (!custRes.rows[0]) {
          throw new AppError(404, 'CUSTOMER_NOT_FOUND', 'Cliente no encontrado');
        }

        const motoId = newUuid();
        const inserted = await db.withTransaction(async (tx) => {
          const ins = await tx.query<MotorcycleRow>(
            `INSERT INTO motorcycles (id, customer_id, brand, model, cc, nickname, color)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id, customer_id, brand, model, cc, nickname, color, is_active, created_at`,
            [
              motoId,
              targetCustomerId,
              body.brand,
              body.model,
              body.cc,
              body.nickname ?? null,
              body.color ?? null,
            ],
          );

          await recordAuditLog(tx, {
            actorId: actor.id,
            actorRole: actor.role,
            action: 'motorcycle_created',
            entityType: 'motorcycle',
            entityId: motoId,
            ipAddress: req.clientIp,
            changes: {
              customerId: targetCustomerId,
              brand: body.brand,
              model: body.model,
              cc: body.cc,
            },
          });

          return ins.rows[0]!;
        });

        return created(res, mapMotorcycle(inserted), 'Moto registrada exitosamente');
      } catch (err) {
        next(err);
      }
    },
  );

  router.patch(
    '/:id',
    authenticate(),
    requireRoles('Cliente', 'Administrador'),
    validateParams(idParamSchema),
    validateBody(patchMotorcycleSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { id } = res.locals.params as { id: string };
        const body = req.body as z.infer<typeof patchMotorcycleSchema>;

        const updated = await db.withTransaction(async (tx) => {
          const existingRes = await tx.query<MotorcycleRow>(
            `SELECT id, customer_id, brand, model, cc, nickname, color, is_active, created_at
             FROM motorcycles
             WHERE id = $1
             FOR UPDATE`,
            [id],
          );
          const existing = existingRes.rows[0];
          if (!existing) {
            throw new AppError(404, 'MOTORCYCLE_NOT_FOUND', 'Moto no encontrada');
          }

          if (actor.role === 'Cliente') {
            if (existing.customer_id !== actor.id) {
              throw new AppError(
                403,
                'FORBIDDEN',
                'No tienes permiso para modificar esta moto',
              );
            }
            if (body.customerId && body.customerId !== actor.id) {
              throw new AppError(
                403,
                'FORBIDDEN',
                'No puedes transferir una moto a otro cliente',
              );
            }
          }

          const nextCustomerId = body.customerId ?? existing.customer_id;
          if (nextCustomerId !== existing.customer_id) {
            const cust = await tx.query<{ id: string }>(
              `SELECT id FROM users WHERE id = $1 AND role = 'Cliente'`,
              [nextCustomerId],
            );
            if (!cust.rows[0]) {
              throw new AppError(404, 'CUSTOMER_NOT_FOUND', 'Cliente destino no encontrado');
            }
          }

          const upd = await tx.query<MotorcycleRow>(
            `UPDATE motorcycles
             SET customer_id = $1,
                 brand = $2,
                 model = $3,
                 cc = $4,
                 nickname = $5,
                 color = $6,
                 is_active = $7,
                 updated_at = NOW()
             WHERE id = $8
             RETURNING id, customer_id, brand, model, cc, nickname, color, is_active, created_at`,
            [
              nextCustomerId,
              body.brand ?? existing.brand,
              body.model ?? existing.model,
              body.cc ?? existing.cc,
              body.nickname !== undefined ? body.nickname : existing.nickname,
              body.color !== undefined ? body.color : existing.color,
              body.isActive !== undefined ? body.isActive : existing.is_active,
              id,
            ],
          );

          await recordAuditLog(tx, {
            actorId: actor.id,
            actorRole: actor.role,
            action: 'motorcycle_updated',
            entityType: 'motorcycle',
            entityId: id,
            ipAddress: req.clientIp,
            changes: body,
          });

          return upd.rows[0]!;
        });

        return ok(res, mapMotorcycle(updated), 'Moto actualizada exitosamente');
      } catch (err) {
        next(err);
      }
    },
  );

  router.delete(
    '/:id',
    authenticate(),
    requireRoles('Cliente', 'Administrador'),
    validateParams(idParamSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { id } = res.locals.params as { id: string };

        await db.withTransaction(async (tx) => {
          const existingRes = await tx.query<{ id: string; customer_id: string }>(
            `SELECT id, customer_id FROM motorcycles WHERE id = $1 FOR UPDATE`,
            [id],
          );
          const existing = existingRes.rows[0];
          if (!existing) {
            throw new AppError(404, 'MOTORCYCLE_NOT_FOUND', 'Moto no encontrada');
          }

          if (actor.role === 'Cliente' && existing.customer_id !== actor.id) {
            throw new AppError(
              403,
              'FORBIDDEN',
              'No tienes permiso para eliminar esta moto',
            );
          }

          const [apptCount, washCount] = await Promise.all([
            tx.query<{ cnt: string | number }>(
              `SELECT COUNT(*) AS cnt FROM appointments WHERE motorcycle_id = $1`,
              [id],
            ),
            tx.query<{ cnt: string | number }>(
              `SELECT COUNT(*) AS cnt FROM wash_requests WHERE motorcycle_id = $1`,
              [id],
            ),
          ]);

          const hasHistory =
            Number(apptCount.rows[0]?.cnt ?? 0) > 0 ||
            Number(washCount.rows[0]?.cnt ?? 0) > 0;

          if (hasHistory) {
            throw new AppError(
              409,
              'MOTORCYCLE_HAS_HISTORY',
              'La moto tiene citas o historial de lavadas asociado y no puede eliminarse. Puedes desactivarla mediante PATCH /motorcycles/' +
                id,
            );
          }

          await tx.query(`DELETE FROM motorcycles WHERE id = $1`, [id]);

          await recordAuditLog(tx, {
            actorId: actor.id,
            actorRole: actor.role,
            action: 'motorcycle_deleted',
            entityType: 'motorcycle',
            entityId: id,
            ipAddress: req.clientIp,
          });
        });

        return res.status(204).send();
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
