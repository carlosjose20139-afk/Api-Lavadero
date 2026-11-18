import { Router } from 'express';
import { z } from 'zod';
import type { DbClient, DbExecutor } from '../../db/index.js';
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
import { recordAuditLog } from '../../services/audit.service.js';
import { notificationService } from '../../services/notification.service.js';
import { expireOutdatedLoyaltyRewards } from '../../services/scheduler.service.js';
import { generateOpaqueToken, newUuid } from '../../utils/crypto.js';
import { AppError, ok, paginated } from '../../utils/response.js';
import { toIsoBogota } from '../../utils/time.js';

const stampSchema = z
  .object({
    washRequestId: uuidSchema,
  })
  .strict();

const rewardsQuerySchema = paginationQuerySchema.extend({
  customerId: uuidSchema.optional(),
});

const redeemSchema = z
  .object({
    appointmentId: uuidSchema.nullable().optional(),
  })
  .strict()
  .optional();

interface LoyaltyRewardRow {
  id: string;
  title: string;
  valid_from: Date | string;
  valid_until: Date | string;
  status: 'available' | 'redeemed' | 'expired';
}

async function getOrCreateLoyaltyCard(db: DbExecutor, customerId: string) {
  let cardRes = await db.query<{
    customer_id: string;
    stamps: number;
    completed_washes: number;
    qr_token: string;
  }>(
    `SELECT customer_id, stamps, completed_washes, qr_token
     FROM loyalty_cards
     WHERE customer_id = $1`,
    [customerId],
  );

  if (!cardRes.rows[0]) {
    const qrToken = `LM-${generateOpaqueToken(12)}`;
    await db.query(
      `INSERT INTO loyalty_cards (customer_id, stamps, completed_washes, qr_token)
       VALUES ($1, 0, 0, $2)
       ON CONFLICT (customer_id) DO NOTHING`,
      [customerId, qrToken],
    );
    cardRes = await db.query<{
      customer_id: string;
      stamps: number;
      completed_washes: number;
      qr_token: string;
    }>(
      `SELECT customer_id, stamps, completed_washes, qr_token
       FROM loyalty_cards
       WHERE customer_id = $1`,
      [customerId],
    );
  }

  const card = cardRes.rows[0]!;
  const rewardsRes = await db.query<LoyaltyRewardRow>(
    `SELECT id, title, valid_from, valid_until, status
     FROM loyalty_rewards
     WHERE customer_id = $1
     ORDER BY created_at DESC`,
    [customerId],
  );

  return {
    customerId: card.customer_id,
    stamps: Number(card.stamps),
    completedWashes: Number(card.completed_washes),
    qrToken: card.qr_token,
    rewards: rewardsRes.rows.map((r) => ({
      id: r.id,
      title: r.title,
      validFrom: toIsoBogota(r.valid_from),
      validUntil: toIsoBogota(r.valid_until),
      status: r.status,
    })),
  };
}

export function createLoyaltyRouter(db: DbClient): Router {
  const router = Router();
  const { authenticate, requireRoles } = createAuthMiddleware(db);

  router.get('/me', authenticate(), async (req, res, next) => {
    try {
      const actor = req.user!;
      await expireOutdatedLoyaltyRewards(db);
      const card = await getOrCreateLoyaltyCard(db, actor.id);
      return ok(res, card, 'Tarjeta de fidelización 7+1 consultada exitosamente');
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
            const wrRes = await tx.query<{
              id: string;
              customer_id: string;
              status: string;
            }>(
              `SELECT id, customer_id, status
               FROM wash_requests WHERE id = $1 FOR UPDATE`,
              [washRequestId],
            );
            const wr = wrRes.rows[0];
            if (!wr) {
              throw new AppError(
                404,
                'WASH_REQUEST_NOT_FOUND',
                'Solicitud de lavada no encontrada',
              );
            }

            if (wr.status !== 'paid') {
              throw new AppError(
                409,
                'WASH_NOT_PAID',
                `Solo se otorga sello a una lavada pagada (estado actual: '${wr.status}')`,
              );
            }

            const dupStamp = await tx.query<{ id: string }>(
              `SELECT id FROM loyalty_stamps WHERE wash_request_id = $1`,
              [washRequestId],
            );
            if (dupStamp.rows[0]) {
              throw new AppError(
                409,
                'DUPLICATE_STAMP',
                'Esta lavada ya tiene un sello de fidelización registrado',
              );
            }

            // Aseguramos tarjeta existente y bloqueamos fila
            await getOrCreateLoyaltyCard(tx, wr.customer_id);
            const cardRes = await tx.query<{
              stamps: number;
              completed_washes: number;
            }>(
              `SELECT stamps, completed_washes
               FROM loyalty_cards
               WHERE customer_id = $1
               FOR UPDATE`,
              [wr.customer_id],
            );
            const current = cardRes.rows[0]!;
            const nextStamps =
              Number(current.stamps) >= 7 ? 1 : Number(current.stamps) + 1;
            const nextCompleted = Number(current.completed_washes) + 1;

            await tx.query(
              `INSERT INTO loyalty_stamps (id, customer_id, wash_request_id, granted_by)
               VALUES ($1, $2, $3, $4)`,
              [newUuid(), wr.customer_id, washRequestId, actor.id],
            );

            await tx.query(
              `UPDATE loyalty_cards
               SET stamps = $1, completed_washes = $2, updated_at = NOW()
               WHERE customer_id = $3`,
              [nextStamps, nextCompleted, wr.customer_id],
            );

            let rewardGranted = false;
            if (nextStamps === 7) {
              rewardGranted = true;
              const rewardId = newUuid();
              const validFrom = new Date();
              const validUntil = new Date(
                validFrom.getTime() + 30 * 24 * 60 * 60 * 1000,
              );

              await tx.query(
                `INSERT INTO loyalty_rewards (id, customer_id, title, valid_from, valid_until, status)
                 VALUES ($1, $2, $3, $4, $5, 'available')`,
                [
                  rewardId,
                  wr.customer_id,
                  'Premio 7+1: Lavada Gratis',
                  validFrom,
                  validUntil,
                ],
              );

              await notificationService.createAndNotifyUser(tx, {
                userId: wr.customer_id,
                title: '¡Completaste 7 sellos en Los Malditos!',
                body: `Tienes disponible una lavada gratis (Premio 7+1). Puedes agendarla y redimirla hasta ${toIsoBogota(validUntil)}.`,
                type: 'reward_assigned',
                deepLink: '/loyalty/rewards',
                payload: {
                  rewardId,
                  validFrom: toIsoBogota(validFrom),
                  validUntil: toIsoBogota(validUntil),
                },
              });
            }

            await recordAuditLog(tx, {
              actorId: actor.id,
              actorRole: actor.role,
              action: 'loyalty_stamp_granted',
              entityType: 'loyalty_card',
              entityId: wr.customer_id,
              ipAddress: req.clientIp,
              changes: {
                washRequestId,
                stamps: nextStamps,
                rewardGranted,
              },
            });

            const card = await getOrCreateLoyaltyCard(tx, wr.customer_id);
            return {
              data: card,
              message: rewardGranted
                ? 'Sello registrado. ¡El cliente completó 7 sellos y recibió un premio 7+1!'
                : 'Sello de fidelización registrado exitosamente',
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
        const { page, pageSize, customerId } = res.locals.query as z.infer<
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
          const card = await getOrCreateLoyaltyCard(db, actor.id);
          return paginated(
            res,
            [card],
            1,
            pageSize,
            1,
            'Premios y fidelización consultados exitosamente',
          );
        }

        const conditions: string[] = [`u.role = 'Cliente'`];
        const params: unknown[] = [];
        if (customerId) {
          params.push(customerId);
          conditions.push(`u.id = $${params.length}`);
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
          usersRes.rows.map((u) => getOrCreateLoyaltyCard(db, u.id)),
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
            const rewardRes = await tx.query<{
              id: string;
              customer_id: string;
              valid_from: Date | string;
              valid_until: Date | string;
              status: string;
            }>(
              `SELECT id, customer_id, valid_from, valid_until, status
               FROM loyalty_rewards WHERE id = $1 FOR UPDATE`,
              [id],
            );
            const reward = rewardRes.rows[0];
            if (!reward) {
              throw new AppError(404, 'REWARD_NOT_FOUND', 'Premio no encontrado');
            }

            if (actor.role === 'Cliente' && reward.customer_id !== actor.id) {
              throw new AppError(
                403,
                'FORBIDDEN',
                'No puedes redimir premios de otro cliente',
              );
            }

            const now = new Date();
            const validFrom = new Date(reward.valid_from);
            const validUntil = new Date(reward.valid_until);

            if (reward.status === 'expired' || now > validUntil) {
              throw new AppError(
                409,
                'REWARD_EXPIRED',
                'El premio venció y ya no puede ser redimido',
              );
            }
            if (reward.status !== 'available') {
              throw new AppError(
                409,
                'REWARD_ALREADY_REDEEMED',
                'El premio ya fue redimido anteriormente',
              );
            }
            if (now < validFrom) {
              throw new AppError(
                409,
                'REWARD_NOT_YET_VALID',
                `El premio solo puede redimirse a partir de ${toIsoBogota(validFrom)}`,
              );
            }

            if (body.appointmentId) {
              const apptRes = await tx.query<{
                id: string;
                customer_id: string;
                start_at: Date | string;
                status: string;
              }>(
                `SELECT id, customer_id, start_at, status
                 FROM appointments WHERE id = $1`,
                [body.appointmentId],
              );
              const appt = apptRes.rows[0];
              if (!appt || appt.customer_id !== reward.customer_id) {
                throw new AppError(
                  404,
                  'APPOINTMENT_NOT_FOUND',
                  'La cita no existe o no pertenece al cliente',
                );
              }
              const apptStart = new Date(appt.start_at);
              if (apptStart < validFrom || apptStart > validUntil) {
                throw new AppError(
                  409,
                  'REWARD_WINDOW_INVALID',
                  'La cita debe estar agendada dentro del periodo de vigencia del premio (validFrom - validUntil)',
                );
              }
            }

            await tx.query(
              `UPDATE loyalty_rewards
               SET status = 'redeemed',
                   redeemed_appointment_id = $1,
                   redeemed_at = NOW()
               WHERE id = $2`,
              [body.appointmentId ?? null, id],
            );

            // Al redimir con 7 sellos acumulados, reiniciamos el contador de la tarjeta a 0
            await tx.query(
              `UPDATE loyalty_cards
               SET stamps = CASE WHEN stamps = 7 THEN 0 ELSE stamps END,
                   updated_at = NOW()
               WHERE customer_id = $1`,
              [reward.customer_id],
            );

            await recordAuditLog(tx, {
              actorId: actor.id,
              actorRole: actor.role,
              action: 'loyalty_reward_redeemed',
              entityType: 'loyalty_reward',
              entityId: id,
              ipAddress: req.clientIp,
              changes: { appointmentId: body.appointmentId ?? null },
            });

            const card = await getOrCreateLoyaltyCard(tx, reward.customer_id);
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

  return router;
}
