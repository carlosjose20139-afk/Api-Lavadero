import { Router } from 'express';
import { z } from 'zod';
import type { DbClient } from '../../db/index.js';
import { createAuthMiddleware } from '../../middleware/auth.js';
import {
  runIdempotent,
  validateIdempotencyHeader,
} from '../../middleware/idempotency.js';
import {
  idParamSchema,
  paginationQuerySchema,
  uuidSchema,
  validateBody,
  validateParams,
  validateQuery,
} from '../../middleware/validate.js';
import { expireOutdatedLoyaltyRewards, expireOutdatedLoyaltyRewardsDetailed } from '../../services/scheduler.service.js';
import { AppError, ok, paginated } from '../../utils/response.js';
import { toIsoBogota } from '../../utils/time.js';
import {
  assignManualLoyaltyReward,
  cancelLoyaltyReward,
  getLoyaltyCustomerDetail,
  getOrCreateLoyaltyCard,
  grantLoyaltyStampTx,
  listLoyaltyCustomers,
  redeemLoyaltyRewardTx,
  reverseLoyaltyStamp,
  type RewardStatus,
} from './loyalty.service.js';

const stampSchema = z
  .object({
    washRequestId: uuidSchema,
  })
  .strict();

const customerStampSchema = z
  .object({
    washRequestId: uuidSchema,
    reason: z.string().max(500).optional(),
  })
  .strict();

const optionalReasonSchema = z
  .object({
    reason: z.string().max(500).optional(),
  })
  .strict()
  .optional();

const manualRewardSchema = z
  .object({
    title: z.string().min(1, 'El título es obligatorio').max(160),
    validFrom: z.string().min(1, 'validFrom es obligatorio'),
    validUntil: z.string().min(1, 'validUntil es obligatorio'),
    reason: z.string().max(500).optional(),
  })
  .strict();

const rewardsQuerySchema = paginationQuerySchema.extend({
  customerId: uuidSchema.optional(),
  status: z.enum(['available', 'redeemed', 'expired', 'cancelled']).optional(),
});

const customersQuerySchema = paginationQuerySchema.extend({
  search: z.string().trim().max(120).optional(),
  status: z
    .enum(['all', 'available_reward', 'no_reward', 'blocked'])
    .default('all'),
  sort: z
    .enum(['stamps_desc', 'completed_washes_desc', 'newest'])
    .default('newest'),
});

const customerIdParamSchema = z.object({
  customerId: uuidSchema,
});

const customerStampParamsSchema = z.object({
  customerId: uuidSchema,
  stampId: uuidSchema,
});

const redeemSchema = z
  .object({
    appointmentId: uuidSchema.nullable().optional(),
  })
  .strict()
  .optional();

export function createLoyaltyRouter(db: DbClient): Router {
  const router = Router();
  const { authenticate, requireRoles } = createAuthMiddleware(db);

  router.get('/me', authenticate(), async (req, res, next) => {
    try {
      const actor = req.user!;
      await expireOutdatedLoyaltyRewards(db);
      const card = await getOrCreateLoyaltyCard(db, actor.id);
      return ok(
        res,
        card,
        'Información de fidelización consultada exitosamente',
      );
    } catch (err) {
      next(err);
    }
  });

  router.post(
    '/stamps',
    authenticate(),
    requireRoles('Administrador', 'Lavador'),
    validateIdempotencyHeader(true),
    validateBody(stampSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { washRequestId } = req.body as z.infer<typeof stampSchema>;
        const idempotencyKey = res.locals.idempotencyKey as string;

        const out = await runIdempotent(
          db,
          {
            key: idempotencyKey,
            actorId: actor.id,
            method: 'POST',
            path: '/loyalty/stamps',
            requestBody: { washRequestId },
            successStatus: 201,
          },
          async (tx) => {
            const result = await grantLoyaltyStampTx(tx, {
              actor,
              washRequestId,
              ipAddress: req.clientIp,
            });
            return {
              data: {
                ...result.card,
                lastStamp: result.stamp,
                rewardCreated: result.rewardCreated,
              },
              message: result.message,
            };
          },
        );

        return res.status(out.statusCode).json(out.body);
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    '/rewards',
    authenticate(),
    validateQuery(rewardsQuerySchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { page, pageSize, customerId, status } = res.locals.query as z.infer<
          typeof rewardsQuerySchema
        >;

        await expireOutdatedLoyaltyRewards(db);

        if (actor.role === 'Cliente') {
          if (customerId && customerId !== actor.id) {
            throw new AppError(
              403,
              'FORBIDDEN',
              'No puedes consultar premios de otro cliente',
            );
          }
          const card = await getOrCreateLoyaltyCard(db, actor.id, {
            rewardStatusFilter: status as RewardStatus | undefined,
          });
          return paginated(
            res,
            [card],
            1,
            pageSize,
            1,
            'Premios y fidelización consultados exitosamente',
          );
        }

        // Regla del sistema: Administrador y Lavador pueden consultar tarjetas/premios
        const conditions: string[] = [`u.role = 'Cliente'`];
        const params: unknown[] = [];
        if (customerId) {
          params.push(customerId);
          conditions.push(`u.id = $${params.length}`);
        }
        if (status) {
          params.push(status);
          conditions.push(
            `EXISTS (SELECT 1 FROM loyalty_rewards lr WHERE lr.customer_id = u.id AND lr.status = $${params.length})`,
          );
        }
        const whereSql = `WHERE ${conditions.join(' AND ')}`;

        const countRes = await db.query<{ cnt: string | number }>(
          `SELECT COUNT(*) AS cnt FROM users u ${whereSql}`,
          params,
        );
        const total = Number(countRes.rows[0]?.cnt ?? 0);

        const offset = (page - 1) * pageSize;
        const usersRes = await db.query<{ id: string }>(
          `SELECT u.id FROM users u ${whereSql} ORDER BY u.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, pageSize, offset],
        );

        const cards = await Promise.all(
          usersRes.rows.map((u) =>
            getOrCreateLoyaltyCard(db, u.id, {
              rewardStatusFilter: status as RewardStatus | undefined,
            }),
          ),
        );

        return paginated(
          res,
          cards,
          page,
          pageSize,
          total,
          'Premios y tarjetas de fidelización consultados exitosamente',
        );
      } catch (err) {
        next(err);
      }
    },
  );

  router.delete(
    '/rewards/:id',
    authenticate(),
    requireRoles('Administrador'),
    validateParams(idParamSchema),
    validateBody(optionalReasonSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { id } = res.locals.params as { id: string };
        const body = (req.body ?? {}) as { reason?: string };

        const cancelled = await cancelLoyaltyReward(db, {
          actor,
          rewardId: id,
          reason: body.reason,
          ipAddress: req.clientIp,
        });

        return ok(res, cancelled, 'Recompensa cancelada exitosamente');
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/rewards/:id/redeem',
    authenticate(),
    validateParams(idParamSchema),
    validateIdempotencyHeader(true),
    validateBody(redeemSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { id } = res.locals.params as { id: string };
        const body = (req.body ?? {}) as { appointmentId?: string | null };
        const idempotencyKey = res.locals.idempotencyKey as string;

        await expireOutdatedLoyaltyRewards(db);

        const out = await runIdempotent(
          db,
          {
            key: idempotencyKey,
            actorId: actor.id,
            method: 'POST',
            path: `/loyalty/rewards/${id}/redeem`,
            requestBody: body,
            successStatus: 200,
          },
          async (tx) => {
            const card = await redeemLoyaltyRewardTx(tx, {
              actor,
              rewardId: id,
              appointmentId: body.appointmentId,
              ipAddress: req.clientIp,
            });
            return {
              data: card,
              message: 'Premio 7+1 redimido exitosamente',
            };
          },
        );

        return res.status(out.statusCode).json(out.body);
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    '/customers',
    authenticate(),
    requireRoles('Administrador'),
    validateQuery(customersQuerySchema),
    async (_req, res, next) => {
      try {
        const query = res.locals.query as z.infer<typeof customersQuerySchema>;
        const { items, total } = await listLoyaltyCustomers(db, query);

        return paginated(
          res,
          items,
          query.page,
          query.pageSize,
          total,
          'Clientes de fidelización consultados exitosamente',
        );
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    '/customers/:customerId',
    authenticate(),
    requireRoles('Administrador'),
    validateParams(customerIdParamSchema),
    async (_req, res, next) => {
      try {
        const { customerId } = res.locals.params as { customerId: string };
        const detail = await getLoyaltyCustomerDetail(db, customerId);
        return ok(
          res,
          detail,
          'Detalle e historial de fidelización del cliente consultados exitosamente',
        );
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/customers/:customerId/stamps',
    authenticate(),
    requireRoles('Administrador', 'Lavador'),
    validateParams(customerIdParamSchema),
    validateIdempotencyHeader(true),
    validateBody(customerStampSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { customerId } = res.locals.params as { customerId: string };
        const body = req.body as z.infer<typeof customerStampSchema>;
        const idempotencyKey = res.locals.idempotencyKey as string;

        const out = await runIdempotent(
          db,
          {
            key: idempotencyKey,
            actorId: actor.id,
            method: 'POST',
            path: `/loyalty/customers/${customerId}/stamps`,
            requestBody: body,
            successStatus: 201,
          },
          async (tx) => {
            const result = await grantLoyaltyStampTx(tx, {
              actor,
              washRequestId: body.washRequestId,
              expectedCustomerId: customerId,
              reason: body.reason,
              ipAddress: req.clientIp,
            });
            return {
              data: {
                ...result.card,
                stamp: result.stamp,
                rewardCreated: result.rewardCreated,
              },
              message: result.message,
            };
          },
        );

        return res.status(out.statusCode).json(out.body);
      } catch (err) {
        next(err);
      }
    },
  );

  router.delete(
    '/customers/:customerId/stamps/:stampId',
    authenticate(),
    requireRoles('Administrador'),
    validateParams(customerStampParamsSchema),
    validateBody(optionalReasonSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { customerId, stampId } = res.locals.params as {
          customerId: string;
          stampId: string;
        };
        const body = (req.body ?? {}) as { reason?: string };

        const result = await reverseLoyaltyStamp(db, {
          actor,
          customerId,
          stampId,
          reason: body.reason,
          ipAddress: req.clientIp,
        });

        return ok(res, result, 'Sello revertido exitosamente');
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/customers/:customerId/rewards',
    authenticate(),
    requireRoles('Administrador'),
    validateParams(customerIdParamSchema),
    validateBody(manualRewardSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { customerId } = res.locals.params as { customerId: string };
        const body = req.body as z.infer<typeof manualRewardSchema>;

        const reward = await assignManualLoyaltyReward(db, {
          actor,
          customerId,
          title: body.title,
          validFrom: body.validFrom,
          validUntil: body.validUntil,
          reason: body.reason,
          ipAddress: req.clientIp,
        });

        return res.status(201).json({
          data: reward,
          message: 'Recompensa manual asignada exitosamente',
        });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/expire',
    authenticate(),
    requireRoles('Administrador'),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const result = await expireOutdatedLoyaltyRewardsDetailed(
          db,
          new Date(),
          {
            actorId: actor.id,
            actorRole: actor.role,
            actorName: actor.name,
            ipAddress: req.clientIp,
            reason: 'Expiración manual ejecutada por administración',
          },
        );

        return ok(
          res,
          {
            expiredCount: result.expiredCount,
            expiredRewardIds: result.expiredRewardIds,
            executedAt: toIsoBogota(new Date()),
          },
          'Proceso de expiración de recompensas ejecutado exitosamente',
        );
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
