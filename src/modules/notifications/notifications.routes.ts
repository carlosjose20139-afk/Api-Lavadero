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
import { newUuid } from '../../utils/crypto.js';
import { AppError, ok, paginated } from '../../utils/response.js';
import { toIsoBogota } from '../../utils/time.js';

const listNotificationsQuerySchema = paginationQuerySchema.extend({
  unread: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

const registerDeviceSchema = z
  .object({
    token: z.string().trim().min(10, 'El token FCM es inválido').max(512),
    platform: z.enum(['android', 'ios', 'web']),
  })
  .strict();

interface NotificationRow {
  id: string;
  user_id: string;
  title: string;
  body: string;
  type: string;
  deep_link: string | null;
  payload: Record<string, unknown>;
  is_read: boolean;
  created_at: Date | string;
}

function mapNotification(row: NotificationRow) {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    body: row.body,
    type: row.type,
    deepLink: row.deep_link,
    payload: row.payload ?? {},
    isRead: row.is_read,
    createdAt: toIsoBogota(row.created_at),
  };
}

export function createNotificationsRouter(db: DbClient): Router {
  const router = Router();
  const { authenticate } = createAuthMiddleware(db);

  router.get(
    '/',
    authenticate(),
    validateQuery(listNotificationsQuerySchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { page, pageSize, unread } = res.locals.query as z.infer<
          typeof listNotificationsQuerySchema
        >;

        // Nunca devolver notificaciones de otro usuario
        const conditions: string[] = ['user_id = $1'];
        const params: unknown[] = [actor.id];

        if (unread !== undefined) {
          params.push(!unread);
          conditions.push(`is_read = $${params.length}`);
        }

        const whereSql = `WHERE ${conditions.join(' AND ')}`;
        const countRes = await db.query<{ cnt: string | number }>(
          `SELECT COUNT(*) AS cnt FROM notifications ${whereSql}`,
          params,
        );
        const total = Number(countRes.rows[0]?.cnt ?? 0);

        const offset = (page - 1) * pageSize;
        const rowsRes = await db.query<NotificationRow>(
          `SELECT id, user_id, title, body, type, deep_link, payload, is_read, created_at
           FROM notifications
           ${whereSql}
           ORDER BY created_at DESC
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, pageSize, offset],
        );

        return paginated(
          res,
          rowsRes.rows.map(mapNotification),
          page,
          pageSize,
          total,
          'Notificaciones consultadas exitosamente',
        );
      } catch (err) {
        next(err);
      }
    },
  );

  router.patch(
    '/:id/read',
    authenticate(),
    validateParams(idParamSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { id } = res.locals.params as { id: string };

        const existingRes = await db.query<NotificationRow>(
          `SELECT id, user_id, title, body, type, deep_link, payload, is_read, created_at
           FROM notifications WHERE id = $1`,
          [id],
        );
        const existing = existingRes.rows[0];
        if (!existing) {
          throw new AppError(
            404,
            'NOTIFICATION_NOT_FOUND',
            'Notificación no encontrada',
          );
        }
        if (existing.user_id !== actor.id) {
          throw new AppError(
            403,
            'FORBIDDEN',
            'No puedes modificar notificaciones de otro usuario',
          );
        }

        const updRes = await db.query<NotificationRow>(
          `UPDATE notifications
           SET is_read = TRUE
           WHERE id = $1 AND user_id = $2
           RETURNING id, user_id, title, body, type, deep_link, payload, is_read, created_at`,
          [id, actor.id],
        );

        return ok(
          res,
          mapNotification(updRes.rows[0]!),
          'Notificación marcada como leída',
        );
      } catch (err) {
        next(err);
      }
    },
  );

  router.post('/read-all', authenticate(), async (req, res, next) => {
    try {
      const actor = req.user!;
      await db.query(
        `UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND is_read = FALSE`,
        [actor.id],
      );
      return ok(res, null, 'Todas las notificaciones marcadas como leídas');
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export function createDevicesRouter(db: DbClient): Router {
  const router = Router();
  const { authenticate } = createAuthMiddleware(db);

  router.post(
    '/',
    authenticate(),
    validateBody(registerDeviceSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { token, platform } = req.body as z.infer<
          typeof registerDeviceSchema
        >;

        await db.query(
          `INSERT INTO device_tokens (id, user_id, token, platform, is_valid, last_seen_at)
           VALUES ($1, $2, $3, $4, TRUE, NOW())
           ON CONFLICT (token)
           DO UPDATE SET user_id = EXCLUDED.user_id,
                         platform = EXCLUDED.platform,
                         is_valid = TRUE,
                         last_seen_at = NOW()`,
          [newUuid(), actor.id, token, platform],
        );

        return res.status(201).json({
          data: null,
          message: 'Dispositivo FCM registrado exitosamente',
        });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
