import { Router } from 'express';
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
import { recordAuditLog } from '../../services/audit.service.js';
import { newUuid } from '../../utils/crypto.js';
import { AppError, created, ok, paginated } from '../../utils/response.js';

const listServicesQuerySchema = paginationQuerySchema.extend({
  includeInactive: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
});

const serviceInputSchema = z
  .object({
    name: z.string().trim().min(2, 'El nombre del servicio es obligatorio').max(120),
    description: z.string().max(1000).optional().default(''),
    price: z.coerce.number().int().min(0, 'El precio en COP debe ser >= 0'),
    durationMinutes: z.coerce
      .number()
      .int()
      .min(1, 'La duración mínima es 1 minuto')
      .max(600),
    surchargeFromCc: z.coerce.number().int().min(1).nullable().optional(),
    isActive: z.boolean().optional().default(true),
  })
  .strict();

const servicePatchSchema = serviceInputSchema.partial();

interface ServiceRow {
  id: string;
  name: string;
  description: string;
  price: number;
  duration_minutes: number;
  surcharge_from_cc: number | null;
  is_active: boolean;
}

function mapService(row: ServiceRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    price: Number(row.price),
    durationMinutes: Number(row.duration_minutes),
    surchargeFromCc:
      row.surcharge_from_cc !== null ? Number(row.surcharge_from_cc) : null,
    isActive: row.is_active,
  };
}

export function createServicesRouter(db: DbClient): Router {
  const router = Router();
  const { authenticate, optionalAuthenticate, requireRoles } =
    createAuthMiddleware(db);

  router.get(
    '/',
    optionalAuthenticate(),
    validateQuery(listServicesQuerySchema),
    async (req, res, next) => {
      try {
        const { page, pageSize, includeInactive } = res.locals.query as z.infer<
          typeof listServicesQuerySchema
        >;
        const showAll =
          includeInactive && req.user?.role === 'Administrador';

        const whereSql = showAll ? '' : 'WHERE is_active = TRUE';
        const countRes = await db.query<{ cnt: string | number }>(
          `SELECT COUNT(*) AS cnt FROM services ${whereSql}`,
        );
        const total = Number(countRes.rows[0]?.cnt ?? 0);

        const offset = (page - 1) * pageSize;
        const listRes = await db.query<ServiceRow>(
          `SELECT id, name, description, price, duration_minutes, surcharge_from_cc, is_active
           FROM services
           ${whereSql}
           ORDER BY price ASC, name ASC
           LIMIT $1 OFFSET $2`,
          [pageSize, offset],
        );

        return paginated(
          res,
          listRes.rows.map(mapService),
          page,
          pageSize,
          total,
          'Catálogo de servicios consultado exitosamente',
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
    validateBody(serviceInputSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const body = req.body as z.infer<typeof serviceInputSchema>;
        const id = newUuid();

        const inserted = await db.withTransaction(async (tx) => {
          const resIns = await tx.query<ServiceRow>(
            `INSERT INTO services (id, name, description, price, duration_minutes, surcharge_from_cc, is_active)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id, name, description, price, duration_minutes, surcharge_from_cc, is_active`,
            [
              id,
              body.name,
              body.description ?? '',
              body.price,
              body.durationMinutes,
              body.surchargeFromCc ?? null,
              body.isActive ?? true,
            ],
          );

          await recordAuditLog(tx, {
            actorId: actor.id,
            actorRole: actor.role,
            action: 'service_created',
            entityType: 'service',
            entityId: id,
            ipAddress: req.clientIp,
            changes: body,
          });

          return resIns.rows[0]!;
        });

        return created(res, mapService(inserted), 'Servicio creado exitosamente');
      } catch (err) {
        next(err);
      }
    },
  );

  router.patch(
    '/:id',
    authenticate(),
    requireRoles('Administrador'),
    validateParams(idParamSchema),
    validateBody(servicePatchSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { id } = res.locals.params as { id: string };
        const body = req.body as z.infer<typeof servicePatchSchema>;

        const updated = await db.withTransaction(async (tx) => {
          const existingRes = await tx.query<ServiceRow>(
            `SELECT id, name, description, price, duration_minutes, surcharge_from_cc, is_active
             FROM services WHERE id = $1 FOR UPDATE`,
            [id],
          );
          const existing = existingRes.rows[0];
          if (!existing) {
            throw new AppError(404, 'SERVICE_NOT_FOUND', 'Servicio no encontrado');
          }

          const upd = await tx.query<ServiceRow>(
            `UPDATE services
             SET name = $1,
                 description = $2,
                 price = $3,
                 duration_minutes = $4,
                 surcharge_from_cc = $5,
                 is_active = $6,
                 updated_at = NOW()
             WHERE id = $7
             RETURNING id, name, description, price, duration_minutes, surcharge_from_cc, is_active`,
            [
              body.name ?? existing.name,
              body.description ?? existing.description,
              body.price ?? existing.price,
              body.durationMinutes ?? existing.duration_minutes,
              body.surchargeFromCc !== undefined
                ? body.surchargeFromCc
                : existing.surcharge_from_cc,
              body.isActive !== undefined ? body.isActive : existing.is_active,
              id,
            ],
          );

          await recordAuditLog(tx, {
            actorId: actor.id,
            actorRole: actor.role,
            action: 'service_updated',
            entityType: 'service',
            entityId: id,
            ipAddress: req.clientIp,
            changes: body,
          });

          return upd.rows[0]!;
        });

        return ok(res, mapService(updated), 'Servicio actualizado exitosamente');
      } catch (err) {
        next(err);
      }
    },
  );

  router.delete(
    '/:id',
    authenticate(),
    requireRoles('Administrador'),
    validateParams(idParamSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { id } = res.locals.params as { id: string };

        await db.withTransaction(async (tx) => {
          const check = await tx.query<{ id: string }>(
            `SELECT id FROM services WHERE id = $1 FOR UPDATE`,
            [id],
          );
          if (!check.rows[0]) {
            throw new AppError(404, 'SERVICE_NOT_FOUND', 'Servicio no encontrado');
          }

          const [appts, washes] = await Promise.all([
            tx.query<{ cnt: string | number }>(
              `SELECT COUNT(*) AS cnt FROM appointments WHERE service_id = $1`,
              [id],
            ),
            tx.query<{ cnt: string | number }>(
              `SELECT COUNT(*) AS cnt FROM wash_requests WHERE service_id = $1`,
              [id],
            ),
          ]);

          if (
            Number(appts.rows[0]?.cnt ?? 0) > 0 ||
            Number(washes.rows[0]?.cnt ?? 0) > 0
          ) {
            throw new AppError(
              409,
              'SERVICE_IN_USE',
              'El servicio tiene citas o lavadas asociadas y no puede eliminarse; desactívalo mediante PATCH /services/' +
                id,
            );
          }

          await tx.query(`DELETE FROM services WHERE id = $1`, [id]);

          await recordAuditLog(tx, {
            actorId: actor.id,
            actorRole: actor.role,
            action: 'service_deleted',
            entityType: 'service',
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
