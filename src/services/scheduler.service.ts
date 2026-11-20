import type { DbClient } from '../db/index.js';
import { logger } from '../config/logger.js';
import { newUuid } from '../utils/crypto.js';
import { toIsoBogota } from '../utils/time.js';
import { notificationService } from './notification.service.js';

export async function expirePendingWashRequests(
  db: DbClient,
  referenceNow: Date = new Date(),
): Promise<number> {
  return db.withTransaction(async (tx) => {
    const expiredRes = await tx.query<{
      id: string;
      customer_id: string;
      applied_pending_balance: number;
      customer_name: string;
      motorcycle_label: string;
      service_name: string;
    }>(
      `SELECT wr.id, wr.customer_id, wr.applied_pending_balance,
              u.name AS customer_name,
              CONCAT(m.brand, ' ', m.model) AS motorcycle_label,
              s.name AS service_name
       FROM wash_requests wr
       INNER JOIN users u ON u.id = wr.customer_id
       INNER JOIN motorcycles m ON m.id = wr.motorcycle_id
       INNER JOIN services s ON s.id = wr.service_id
       WHERE wr.status = 'pending_confirmation' AND wr.expires_at <= $1
       FOR UPDATE OF wr SKIP LOCKED`,
      [referenceNow],
    );

    if (expiredRes.rows.length === 0) {
      return 0;
    }

    for (const wr of expiredRes.rows) {
      await tx.query(
        `UPDATE wash_requests
         SET status = 'expired', updated_at = NOW()
         WHERE id = $1`,
        [wr.id],
      );

      if (wr.applied_pending_balance > 0) {
        await tx.query(
          `UPDATE users
           SET pending_balance = pending_balance + $1, updated_at = NOW()
           WHERE id = $2`,
          [wr.applied_pending_balance, wr.customer_id],
        );
      }

      await tx.query(
        `INSERT INTO wash_request_audits (id, wash_request_id, actor_id, actor_name, action, previous_content, new_content)
         VALUES ($1, $2, NULL, 'Sistema', 'expired', 'pending_confirmation', 'expired')`,
        [newUuid(), wr.id],
      );

      await notificationService.notifyAdmins(tx, {
        title: 'Lavada vencida sin confirmación',
        body: `La solicitud de ${wr.customer_name} (${wr.motorcycle_label} - ${wr.service_name}) venció sin respuesta.`,
        type: 'wash_expired',
        deepLink: `/wash-requests/${wr.id}`,
        payload: { washRequestId: wr.id, customerId: wr.customer_id },
      });
    }

    return expiredRes.rows.length;
  });
}

export interface LoyaltyExpireOptions {
  actorId?: string | null;
  actorRole?: string | null;
  actorName?: string | null;
  ipAddress?: string | null;
  reason?: string | null;
}

export async function expireOutdatedLoyaltyRewardsDetailed(
  db: DbClient,
  referenceNow: Date = new Date(),
  options: LoyaltyExpireOptions = {},
): Promise<{ expiredCount: number; expiredRewardIds: string[] }> {
  return db.withTransaction(async (tx) => {
    const expiredRes = await tx.query<{
      id: string;
      customer_id: string;
      title: string;
      valid_from: Date | string;
      valid_until: Date | string;
    }>(
      `SELECT id, customer_id, title, valid_from, valid_until
       FROM loyalty_rewards
       WHERE status = 'available' AND valid_until < $1
       FOR UPDATE SKIP LOCKED`,
      [referenceNow],
    );

    if (expiredRes.rows.length === 0) {
      return { expiredCount: 0, expiredRewardIds: [] };
    }

    const actorId = options.actorId ?? null;
    const actorRole = options.actorRole ?? 'Sistema';
    const actorName = options.actorName ?? 'Sistema';
    const reason = options.reason ?? 'Recompensa expirada automáticamente al vencer validUntil';
    const nowIso = toIsoBogota(new Date());
    const expiredRewardIds: string[] = [];

    for (const reward of expiredRes.rows) {
      expiredRewardIds.push(reward.id);

      await tx.query(
        `UPDATE loyalty_rewards
         SET status = 'expired', updated_at = NOW()
         WHERE id = $1 AND status = 'available'`,
        [reward.id],
      );

      const beforeState = {
        status: 'available',
        validFrom: toIsoBogota(reward.valid_from),
        validUntil: toIsoBogota(reward.valid_until),
      };
      const afterState = {
        status: 'expired',
        validFrom: toIsoBogota(reward.valid_from),
        validUntil: toIsoBogota(reward.valid_until),
      };

      await tx.query(
        `INSERT INTO loyalty_audits (
           id, customer_id, actor_id, actor_role, actor_name, action,
           target_id, target_type, before_state, after_state, reason, ip_address
         )
         VALUES ($1, $2, $3, $4, $5, 'loyalty_reward_expired', $6, 'loyalty_reward', $7::jsonb, $8::jsonb, $9, $10)`,
        [
          newUuid(),
          reward.customer_id,
          actorId,
          actorRole,
          actorName,
          reward.id,
          JSON.stringify(beforeState),
          JSON.stringify(afterState),
          reason,
          options.ipAddress ?? null,
        ],
      );

      await tx.query(
        `INSERT INTO audit_logs (id, actor_id, actor_role, action, entity_type, entity_id, ip_address, changes)
         VALUES ($1, $2, $3, 'loyalty_reward_expired', 'loyalty_reward', $4, $5, $6::jsonb)`,
        [
          newUuid(),
          actorId,
          actorRole,
          reward.id,
          options.ipAddress ?? null,
          JSON.stringify({
            actorId,
            actorRole,
            customerId: reward.customer_id,
            targetId: reward.id,
            targetType: 'loyalty_reward',
            before: beforeState,
            after: afterState,
            reason,
            createdAt: nowIso,
          }),
        ],
      );

      await notificationService.createAndNotifyUser(tx, {
        userId: reward.customer_id,
        title: 'Tu recompensa de fidelización venció',
        body: `El premio "${reward.title}" expiró al finalizar su vigencia.`,
        type: 'loyalty_reward_expired',
        deepLink: '/loyalty/rewards',
        payload: {
          rewardId: reward.id,
          customerId: reward.customer_id,
          validUntil: toIsoBogota(reward.valid_until),
        },
      });
    }

    return {
      expiredCount: expiredRewardIds.length,
      expiredRewardIds,
    };
  });
}

export async function expireOutdatedLoyaltyRewards(
  db: DbClient,
  referenceNow: Date = new Date(),
): Promise<number> {
  const { expiredCount } = await expireOutdatedLoyaltyRewardsDetailed(
    db,
    referenceNow,
  );
  return expiredCount;
}

export function startBackgroundScheduler(
  db: DbClient,
  intervalMs: number,
): () => void {
  let running = false;

  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const expiredWashes = await expirePendingWashRequests(db);
      const expiredRewards = await expireOutdatedLoyaltyRewards(db);
      if (expiredWashes > 0 || expiredRewards > 0) {
        logger.info(
          { expiredWashes, expiredRewards },
          'Proceso programado de vencimientos ejecutado',
        );
      }
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : 'unknown' },
        'Error ejecutando proceso programado de vencimientos',
      );
    } finally {
      running = false;
    }
  }, intervalMs);

  timer.unref();

  return () => {
    clearInterval(timer);
  };
}
