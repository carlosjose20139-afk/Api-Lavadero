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
import {
  createForumReply,
  detectUnsafeForumHtml,
  fetchForumPostById,
  hydrateForumPost,
  listForumAudits,
  listForumPosts,
  softDeleteForumReply,
  updateForumReply,
} from './forum.service.js';

const listPostsQuerySchema = paginationQuerySchema.extend({
  includeDeleted: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
});

const forumInputSchema = z
  .object({
    title: z.string().trim().max(160).optional().default(''),
    content: z.string().trim().min(1, 'El contenido es obligatorio').max(5000),
  })
  .strict();

const forumEditSchema = z
  .object({
    content: z.string().trim().min(1, 'El contenido es obligatorio').max(5000),
  })
  .strict();

// Para respuestas validamos estructura estricta en Zod y delegamos vacío / >5000 / HTML / ofensivo
// a sanitizeAndValidateForumReplyContent() para emitir consistentemente FORUM_REPLY_INVALID_CONTENT.
const forumReplyInputSchema = z
  .object({
    content: z.string({ message: 'El contenido de la respuesta es obligatorio' }),
  })
  .strict();

const forumAuditQuerySchema = paginationQuerySchema.extend({
  actorId: uuidSchema.optional(),
  action: z.enum(['created', 'edited', 'deleted', 'moderated']).optional(),
  targetType: z.enum(['forum_post', 'forum_reply']).optional(),
});

export function createForumRouter(db: DbClient): Router {
  const router = Router();
  const { authenticate, optionalAuthenticate, requireRoles } =
    createAuthMiddleware(db);

  router.get(
    '/posts',
    optionalAuthenticate(),
    validateQuery(listPostsQuerySchema),
    async (req, res, next) => {
      try {
        const query = res.locals.query as z.infer<typeof listPostsQuerySchema>;
        const { items, total } = await listForumPosts(db, req.user?.role, query);

        return paginated(
          res,
          items,
          query.page,
          query.pageSize,
          total,
          'Publicaciones del foro consultadas exitosamente',
        );
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/posts',
    authenticate(),
    validateBody(forumInputSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const body = req.body as z.infer<typeof forumInputSchema>;

        if (
          detectUnsafeForumHtml(body.title ?? '') ||
          detectUnsafeForumHtml(body.content)
        ) {
          throw new AppError(
            422,
            'VALIDATION_ERROR',
            'El contenido contiene HTML o scripts no permitidos',
            { content: 'No se permite HTML, scripts ni etiquetas peligrosas' },
          );
        }

        const modCheck = moderationService.checkText(
          `${body.title ?? ''} ${body.content}`,
        );
        if (modCheck.flagged) {
          throw new AppError(
            422,
            'OFFENSIVE_CONTENT',
            modCheck.reason ?? 'Contenido bloqueado por moderación automática',
            { content: 'Contiene lenguaje ofensivo' },
          );
        }

        const postId = newUuid();
        const createdPost = await db.withTransaction(async (tx) => {
          await tx.query(
            `INSERT INTO forum_posts (id, parent_id, author_id, title, content)
             VALUES ($1, NULL, $2, $3, $4)`,
            [postId, actor.id, body.title ?? '', body.content],
          );

          await tx.query(
            `INSERT INTO forum_audits (
               id, post_id, target_type, actor_id, actor_name, action,
               previous_content, new_content, ip_address
             )
             VALUES ($1, $2, 'forum_post', $3, $4, 'created', NULL, $5, $6)`,
            [newUuid(), postId, actor.id, actor.name, body.content, req.clientIp ?? null],
          );

          await recordAuditLog(tx, {
            actorId: actor.id,
            actorRole: actor.role,
            action: 'forum_post_created',
            entityType: 'forum_post',
            entityId: postId,
            ipAddress: req.clientIp,
          });

          const row = await fetchForumPostById(tx, postId);
          return hydrateForumPost(tx, row!);
        });

        return created(res, createdPost, 'Publicación creada exitosamente');
      } catch (err) {
        next(err);
      }
    },
  );

  router.patch(
    '/posts/:id',
    authenticate(),
    validateParams(idParamSchema),
    validateBody(forumEditSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { id } = res.locals.params as { id: string };
        const { content } = req.body as z.infer<typeof forumEditSchema>;

        if (detectUnsafeForumHtml(content)) {
          throw new AppError(
            422,
            'VALIDATION_ERROR',
            'El contenido contiene HTML o scripts no permitidos',
            { content: 'No se permite HTML, scripts ni etiquetas peligrosas' },
          );
        }

        const modCheck = moderationService.checkText(content);
        if (modCheck.flagged) {
          throw new AppError(
            422,
            'OFFENSIVE_CONTENT',
            modCheck.reason ?? 'Contenido bloqueado por moderación automática',
            { content: 'Contiene lenguaje ofensivo' },
          );
        }

        const updatedPost = await db.withTransaction(async (tx) => {
          const existing = await fetchForumPostById(tx, id, true);
          if (!existing || existing.parent_id !== null) {
            throw new AppError(
              404,
              'FORUM_POST_NOT_FOUND',
              'Publicación no encontrada',
            );
          }

          if (existing.deleted_at !== null) {
            throw new AppError(
              409,
              'FORUM_POST_DELETED',
              'No se puede editar una publicación eliminada',
            );
          }

          const isAuthor = existing.author_id === actor.id;
          const isAdmin = actor.role === 'Administrador';
          if (!isAuthor && !isAdmin) {
            throw new AppError(
              403,
              'FORBIDDEN',
              'Solo el autor o el administrador pueden modificar esta publicación',
            );
          }

          const auditAction = isAuthor ? 'edited' : 'moderated';

          await tx.query(
            `UPDATE forum_posts
             SET content = $1, edited_at = NOW()
             WHERE id = $2`,
            [content, id],
          );

          await tx.query(
            `INSERT INTO forum_audits (
               id, post_id, target_type, actor_id, actor_name, action,
               previous_content, new_content, ip_address
             )
             VALUES ($1, $2, 'forum_post', $3, $4, $5, $6, $7, $8)`,
            [
              newUuid(),
              id,
              actor.id,
              actor.name,
              auditAction,
              existing.content,
              content,
              req.clientIp ?? null,
            ],
          );

          if (!isAuthor && isAdmin) {
            await notificationService.createAndNotifyUser(tx, {
              userId: existing.author_id,
              title: 'Tu publicación del foro fue moderada',
              body: 'Un administrador editó tu publicación para ajustarla a las normas de la comunidad.',
              type: 'moderation',
              deepLink: `/forum/posts/${id}`,
              payload: { postId: id, action: 'moderated' },
            });
          }

          await recordAuditLog(tx, {
            actorId: actor.id,
            actorRole: actor.role,
            action: `forum_post_${auditAction}`,
            entityType: 'forum_post',
            entityId: id,
            ipAddress: req.clientIp,
          });

          const row = await fetchForumPostById(tx, id);
          return hydrateForumPost(tx, row!, actor.role === 'Administrador');
        });

        return ok(res, updatedPost, 'Publicación actualizada exitosamente');
      } catch (err) {
        next(err);
      }
    },
  );

  router.delete(
    '/posts/:id',
    authenticate(),
    validateParams(idParamSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { id } = res.locals.params as { id: string };

        await db.withTransaction(async (tx) => {
          const existing = await fetchForumPostById(tx, id, true);
          if (!existing || existing.parent_id !== null) {
            throw new AppError(
              404,
              'FORUM_POST_NOT_FOUND',
              'Publicación no encontrada',
            );
          }

          if (existing.deleted_at !== null) {
            throw new AppError(
              409,
              'FORUM_POST_ALREADY_DELETED',
              'La publicación ya fue eliminada',
            );
          }

          const isAuthor = existing.author_id === actor.id;
          const isAdmin = actor.role === 'Administrador';
          if (!isAuthor && !isAdmin) {
            throw new AppError(
              403,
              'FORBIDDEN',
              'Solo el autor o el administrador pueden eliminar esta publicación',
            );
          }

          const auditAction = isAuthor ? 'deleted' : 'moderated';

          // Soft-delete conservando el historial en forum_audits para siempre
          await tx.query(
            `UPDATE forum_posts SET deleted_at = NOW() WHERE id = $1`,
            [id],
          );

          await tx.query(
            `INSERT INTO forum_audits (
               id, post_id, target_type, actor_id, actor_name, action,
               previous_content, new_content, ip_address
             )
             VALUES ($1, $2, 'forum_post', $3, $4, $5, $6, NULL, $7)`,
            [
              newUuid(),
              id,
              actor.id,
              actor.name,
              auditAction,
              existing.content,
              req.clientIp ?? null,
            ],
          );

          if (!isAuthor && isAdmin) {
            await notificationService.createAndNotifyUser(tx, {
              userId: existing.author_id,
              title: 'Tu publicación del foro fue eliminada por moderación',
              body: 'Un administrador retiró tu publicación por incumplir las normas del foro.',
              type: 'moderation',
              deepLink: `/forum/posts/${id}`,
              payload: { postId: id, action: 'deleted' },
            });
          }

          await recordAuditLog(tx, {
            actorId: actor.id,
            actorRole: actor.role,
            action: `forum_post_${auditAction}`,
            entityType: 'forum_post',
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

  router.post(
    '/posts/:id/replies',
    authenticate(),
    validateParams(idParamSchema),
    validateBody(forumReplyInputSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { id } = res.locals.params as { id: string };
        const { content } = req.body as z.infer<typeof forumReplyInputSchema>;
        const updatedParent = await createForumReply(
          db,
          actor,
          id,
          content,
          req.clientIp,
        );

        return created(res, updatedParent, 'Respuesta publicada exitosamente');
      } catch (err) {
        next(err);
      }
    },
  );

  router.patch(
    '/replies/:id',
    authenticate(),
    validateParams(idParamSchema),
    validateBody(forumReplyInputSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { id } = res.locals.params as { id: string };
        const { content } = req.body as z.infer<typeof forumReplyInputSchema>;
        const updated = await updateForumReply(
          db,
          actor,
          id,
          content,
          req.clientIp,
        );

        return ok(res, updated, 'Respuesta actualizada exitosamente');
      } catch (err) {
        next(err);
      }
    },
  );

  router.delete(
    '/replies/:id',
    authenticate(),
    validateParams(idParamSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { id } = res.locals.params as { id: string };
        const deleted = await softDeleteForumReply(db, actor, id, req.clientIp);

        return ok(res, deleted, 'Respuesta eliminada exitosamente');
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    '/audit',
    authenticate(),
    requireRoles('Administrador'),
    validateQuery(forumAuditQuerySchema),
    async (_req, res, next) => {
      try {
        const query = res.locals.query as z.infer<typeof forumAuditQuerySchema>;
        const { items, total } = await listForumAudits(db, query);

        return paginated(
          res,
          items,
          query.page,
          query.pageSize,
          total,
          'Historial de auditoría del foro consultado exitosamente',
        );
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
