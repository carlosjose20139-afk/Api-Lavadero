import type { DbClient } from '../db/index.js';
import { logger } from '../config/logger.js';
import { newUuid } from '../utils/crypto.js';
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

export async function expireOutdatedLoyaltyRewards(
  db: DbClient,
  referenceNow: Date = new Date(),
): Promise<number> {
  const res = await db.query<{ id: string }>(
    `UPDATE loyalty_rewards
     SET status = 'expired'
     WHERE status = 'available' AND valid_until < $1
     RETURNING id`,
    [referenceNow],
  );
  return res.rowCount;
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
