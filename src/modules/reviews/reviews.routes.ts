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
import { moderationService } from '../../services/moderation.service.js';
import { notificationService } from '../../services/notification.service.js';
import { newUuid } from '../../utils/crypto.js';
import { AppError, created, ok, paginated } from '../../utils/response.js';
import { toIsoBogota } from '../../utils/time.js';

const listReviewsQuerySchema = paginationQuerySchema.extend({
  includeHidden: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
});

const createReviewSchema = z
  .object({
    washRequestId: uuidSchema,
    rating: z.coerce.number().int().min(1).max(5),
    comment: z.string().trim().min(2).max(1000),
  })
  .strict();

const moderateReviewSchema = z
  .object({
    isVisible: z.boolean().optional(),
    adminReply: z.string().trim().max(1000).nullable().optional(),
  })
  .strict();

interface ReviewJoinedRow {
  id: string;
  customer_id: string;
  wash_request_id: string;
  customer_name: string;
  rating: number;
  comment: string;
  admin_reply: string | null;
  is_visible: boolean;
  created_at: Date | string;
}

function mapReview(row: ReviewJoinedRow) {
  return {
    id: row.id,
    customerId: row.customer_id,
    washRequestId: row.wash_request_id,
    customerName: row.customer_name,
    rating: Number(row.rating),
    comment: row.comment,
    adminReply: row.admin_reply,
    isVisible: row.is_visible,
    createdAt: toIsoBogota(row.created_at),
  };
}

export function createReviewsRouter(db: DbClient): Router {
  const router = Router();
  const { authenticate, optionalAuthenticate, requireRoles } =
    createAuthMiddleware(db);

  router.get(
    '/',
    optionalAuthenticate(),
    validateQuery(listReviewsQuerySchema),
    async (req, res, next) => {
      try {
        const { page, pageSize, includeHidden } = res.locals.query as z.infer<
          typeof listReviewsQuerySchema
        >;
        const showHidden =
          includeHidden && req.user?.role === 'Administrador';
        const whereSql = showHidden ? '' : 'WHERE r.is_visible = TRUE';

        const countRes = await db.query<{ cnt: string | number }>(
          `SELECT COUNT(*) AS cnt FROM reviews r ${whereSql}`,
        );
        const total = Number(countRes.rows[0]?.cnt ?? 0);
        const offset = (page - 1) * pageSize;

        const rowsRes = await db.query<ReviewJoinedRow>(
          `SELECT r.id, r.customer_id, r.wash_request_id, u.name AS customer_name,
                  r.rating, r.comment, r.admin_reply, r.is_visible, r.created_at
           FROM reviews r
           INNER JOIN users u ON u.id = r.customer_id
           ${whereSql}
           ORDER BY r.created_at DESC
           LIMIT $1 OFFSET $2`,
          [pageSize, offset],
        );

        return paginated(
          res,
          rowsRes.rows.map(mapReview),
          page,
          pageSize,
          total,
          'Reseñas consultadas exitosamente',
        );
      } catch (err) {
        next(err);
      }
    },
  );

  // Solo el Cliente que recibió la lavada pagada puede crear una reseña
  router.post(
    '/',
    authenticate(),
    requireRoles('Cliente'),
    validateBody(createReviewSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const body = req.body as z.infer<typeof createReviewSchema>;

        const modCheck = moderationService.checkText(body.comment);
        if (modCheck.flagged) {
          throw new AppError(
            422,
            'OFFENSIVE_CONTENT',
            modCheck.reason ?? 'El comentario contiene lenguaje no permitido',
            { comment: 'Contiene lenguaje ofensivo' },
          );
        }

        const reviewId = newUuid();
        const createdReview = await db.withTransaction(async (tx) => {
          const wrRes = await tx.query<{
            id: string;
            customer_id: string;
            status: string;
          }>(
            `SELECT id, customer_id, status FROM wash_requests WHERE id = $1`,
            [body.washRequestId],
          );
          const wr = wrRes.rows[0];
          if (!wr) {
            throw new AppError(
              404,
              'WASH_REQUEST_NOT_FOUND',
              'La lavada referenciada no existe',
            );
          }

          if (wr.customer_id !== actor.id) {
            throw new AppError(
              403,
              'FORBIDDEN',
              'Solo puedes dejar reseña sobre tus propias lavadas',
            );
          }

          if (wr.status !== 'paid') {
            throw new AppError(
              409,
              'WASH_NOT_COMPLETED',
              'Solo puedes crear una reseña cuando la lavada esté completada y pagada',
            );
          }

          const dup = await tx.query<{ id: string }>(
            `SELECT id FROM reviews WHERE wash_request_id = $1`,
            [body.washRequestId],
          );
          if (dup.rows[0]) {
            throw new AppError(
              409,
              'REVIEW_ALREADY_EXISTS',
              'Ya registraste una reseña para esta lavada',
            );
          }

          await tx.query(
            `INSERT INTO reviews (id, customer_id, wash_request_id, rating, comment, is_visible)
             VALUES ($1, $2, $3, $4, $5, TRUE)`,
            [reviewId, actor.id, body.washRequestId, body.rating, body.comment],
          );

          await recordAuditLog(tx, {
            actorId: actor.id,
            actorRole: actor.role,
            action: 'review_created',
            entityType: 'review',
            entityId: reviewId,
            ipAddress: req.clientIp,
            changes: { washRequestId: body.washRequestId, rating: body.rating },
          });

          const fetched = await tx.query<ReviewJoinedRow>(
            `SELECT r.id, r.customer_id, r.wash_request_id, u.name AS customer_name,
                    r.rating, r.comment, r.admin_reply, r.is_visible, r.created_at
             FROM reviews r
             INNER JOIN users u ON u.id = r.customer_id
             WHERE r.id = $1`,
            [reviewId],
          );
          return fetched.rows[0]!;
        });

        return created(
          res,
          mapReview(createdReview),
          'Reseña publicada exitosamente',
        );
      } catch (err) {
        next(err);
      }
    },
  );

  router.patch(
    '/:id/moderate',
    authenticate(),
    requireRoles('Administrador'),
    validateParams(idParamSchema),
    validateBody(moderateReviewSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { id } = res.locals.params as { id: string };
        const body = req.body as z.infer<typeof moderateReviewSchema>;

        const updated = await db.withTransaction(async (tx) => {
          const existingRes = await tx.query<{
            id: string;
            customer_id: string;
            is_visible: boolean;
            admin_reply: string | null;
          }>(
            `SELECT id, customer_id, is_visible, admin_reply
             FROM reviews WHERE id = $1 FOR UPDATE`,
            [id],
          );
          const existing = existingRes.rows[0];
          if (!existing) {
            throw new AppError(404, 'REVIEW_NOT_FOUND', 'Reseña no encontrada');
          }

          const nextVisible =
            body.isVisible !== undefined ? body.isVisible : existing.is_visible;
          const nextReply =
            body.adminReply !== undefined ? body.adminReply : existing.admin_reply;

          await tx.query(
            `UPDATE reviews
             SET is_visible = $1, admin_reply = $2, moderated_by = $3, moderated_at = NOW()
             WHERE id = $4`,
            [nextVisible, nextReply, actor.id, id],
          );

          await notificationService.createAndNotifyUser(tx, {
            userId: existing.customer_id,
            title:
              nextVisible === false
                ? 'Tu reseña fue moderada'
                : 'El administrador respondió tu reseña',
            body:
              nextVisible === false
                ? 'Un administrador ocultó tu reseña por revisión de políticas.'
                : `Respuesta del administrador: ${nextReply ?? ''}`,
            type: 'moderation',
            deepLink: `/reviews/${id}`,
            payload: { reviewId: id, isVisible: nextVisible },
          });

          await recordAuditLog(tx, {
            actorId: actor.id,
            actorRole: actor.role,
            action: 'review_moderated',
            entityType: 'review',
            entityId: id,
            ipAddress: req.clientIp,
            changes: { isVisible: nextVisible, adminReply: nextReply },
          });

          const fetched = await tx.query<ReviewJoinedRow>(
            `SELECT r.id, r.customer_id, r.wash_request_id, u.name AS customer_name,
                    r.rating, r.comment, r.admin_reply, r.is_visible, r.created_at
             FROM reviews r
             INNER JOIN users u ON u.id = r.customer_id
             WHERE r.id = $1`,
            [id],
          );
          return fetched.rows[0]!;
        });

        return ok(res, mapReview(updated), 'Reseña moderada exitosamente');
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
