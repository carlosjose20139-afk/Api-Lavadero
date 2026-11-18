import { Router } from 'express';
import { z } from 'zod';
import type { DbClient, DbExecutor } from '../../db/index.js';
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
import { toIsoBogota, toIsoBogotaNullable } from '../../utils/time.js';

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

const forumAuditQuerySchema = paginationQuerySchema.extend({
  actorId: uuidSchema.optional(),
  action: z.enum(['created', 'edited', 'deleted', 'moderated']).optional(),
});

interface ForumPostRow {
  id: string;
  parent_id: string | null;
  author_id: string;
  author_name: string;
  title: string;
  content: string;
  edited_at: Date | string | null;
  deleted_at: Date | string | null;
  created_at: Date | string;
}

async function hydrateForumPost(db: DbExecutor, post: ForumPostRow) {
  const repliesRes = await db.query<ForumPostRow>(
    `SELECT p.id, p.parent_id, p.author_id, u.name AS author_name,
            p.title, p.content, p.edited_at, p.deleted_at, p.created_at
     FROM forum_posts p
     INNER JOIN users u ON u.id = p.author_id
     WHERE p.parent_id = $1 AND p.deleted_at IS NULL
     ORDER BY p.created_at ASC`,
    [post.id],
  );

  return {
    id: post.id,
    authorId: post.author_id,
    authorName: post.author_name,
    title: post.title,
    content: post.content,
    editedAt: toIsoBogotaNullable(post.edited_at),
    deletedAt: toIsoBogotaNullable(post.deleted_at),
    replies: repliesRes.rows.map((r) => ({
      id: r.id,
      authorId: r.author_id,
      authorName: r.author_name,
      content: r.content,
      editedAt: toIsoBogotaNullable(r.edited_at),
      deletedAt: toIsoBogotaNullable(r.deleted_at),
      createdAt: toIsoBogota(r.created_at),
    })),
  };
}

async function fetchForumPostById(
  db: DbExecutor,
  id: string,
): Promise<ForumPostRow | null> {
  const res = await db.query<ForumPostRow>(
    `SELECT p.id, p.parent_id, p.author_id, u.name AS author_name,
            p.title, p.content, p.edited_at, p.deleted_at, p.created_at
     FROM forum_posts p
     INNER JOIN users u ON u.id = p.author_id
     WHERE p.id = $1`,
    [id],
  );
  return res.rows[0] ?? null;
}

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
        const { page, pageSize, includeDeleted } = res.locals.query as z.infer<
          typeof listPostsQuerySchema
        >;
        const showDeleted =
          includeDeleted && req.user?.role === 'Administrador';
        const whereSql = showDeleted
          ? 'WHERE p.parent_id IS NULL'
          : 'WHERE p.parent_id IS NULL AND p.deleted_at IS NULL';

        const countRes = await db.query<{ cnt: string | number }>(
          `SELECT COUNT(*) AS cnt FROM forum_posts p ${whereSql}`,
        );
        const total = Number(countRes.rows[0]?.cnt ?? 0);
        const offset = (page - 1) * pageSize;

        const postsRes = await db.query<ForumPostRow>(
          `SELECT p.id, p.parent_id, p.author_id, u.name AS author_name,
                  p.title, p.content, p.edited_at, p.deleted_at, p.created_at
           FROM forum_posts p
           INNER JOIN users u ON u.id = p.author_id
           ${whereSql}
           ORDER BY p.created_at DESC
           LIMIT $1 OFFSET $2`,
          [pageSize, offset],
        );

        const hydrated = await Promise.all(
          postsRes.rows.map((p) => hydrateForumPost(db, p)),
        );

        return paginated(
          res,
          hydrated,
          page,
          pageSize,
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
               id, post_id, actor_id, actor_name, action,
               previous_content, new_content, ip_address
             )
             VALUES ($1, $2, $3, $4, 'created', NULL, $5, $6)`,
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
          const existing = await fetchForumPostById(tx, id);
          if (!existing) {
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
               id, post_id, actor_id, actor_name, action,
               previous_content, new_content, ip_address
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
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
          return hydrateForumPost(tx, row!);
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
          const existing = await fetchForumPostById(tx, id);
          if (!existing) {
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
               id, post_id, actor_id, actor_name, action,
               previous_content, new_content, ip_address
             )
             VALUES ($1, $2, $3, $4, $5, $6, NULL, $7)`,
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
    validateBody(forumEditSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { id } = res.locals.params as { id: string };
        const { content } = req.body as z.infer<typeof forumEditSchema>;

        const modCheck = moderationService.checkText(content);
        if (modCheck.flagged) {
          throw new AppError(
            422,
            'OFFENSIVE_CONTENT',
            modCheck.reason ?? 'Contenido bloqueado por moderación automática',
            { content: 'Contiene lenguaje ofensivo' },
          );
        }

        const updatedParent = await db.withTransaction(async (tx) => {
          const parent = await fetchForumPostById(tx, id);
          if (!parent || parent.deleted_at !== null) {
            throw new AppError(
              404,
              'FORUM_POST_NOT_FOUND',
              'La publicación a responder no existe o fue eliminada',
            );
          }

          const replyId = newUuid();
          await tx.query(
            `INSERT INTO forum_posts (id, parent_id, author_id, title, content)
             VALUES ($1, $2, $3, '', $4)`,
            [replyId, id, actor.id, content],
          );

          await tx.query(
            `INSERT INTO forum_audits (
               id, post_id, actor_id, actor_name, action,
               previous_content, new_content, ip_address
             )
             VALUES ($1, $2, $3, $4, 'created', NULL, $5, $6)`,
            [newUuid(), replyId, actor.id, actor.name, content, req.clientIp ?? null],
          );

          await recordAuditLog(tx, {
            actorId: actor.id,
            actorRole: actor.role,
            action: 'forum_reply_created',
            entityType: 'forum_post',
            entityId: replyId,
            ipAddress: req.clientIp,
            changes: { parentId: id },
          });

          const refreshedParent = await fetchForumPostById(tx, id);
          return hydrateForumPost(tx, refreshedParent!);
        });

        return created(res, updatedParent, 'Respuesta publicada exitosamente');
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
        const { page, pageSize, actorId, action } = res.locals.query as z.infer<
          typeof forumAuditQuerySchema
        >;

        const conditions: string[] = [];
        const params: unknown[] = [];

        if (actorId) {
          params.push(actorId);
          conditions.push(`actor_id = $${params.length}`);
        }
        if (action) {
          params.push(action);
          conditions.push(`action = $${params.length}`);
        }

        const whereSql =
          conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const countRes = await db.query<{ cnt: string | number }>(
          `SELECT COUNT(*) AS cnt FROM forum_audits ${whereSql}`,
          params,
        );
        const total = Number(countRes.rows[0]?.cnt ?? 0);
        const offset = (page - 1) * pageSize;

        const rowsRes = await db.query<{
          id: string;
          actor_id: string;
          actor_name: string;
          action: string;
          occurred_at: Date | string;
          previous_content: string | null;
          new_content: string | null;
        }>(
          `SELECT id, actor_id, actor_name, action, occurred_at, previous_content, new_content
           FROM forum_audits
           ${whereSql}
           ORDER BY occurred_at DESC
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, pageSize, offset],
        );

        return paginated(
          res,
          rowsRes.rows.map((r) => ({
            id: r.id,
            actorId: r.actor_id,
            actorName: r.actor_name,
            action: r.action,
            occurredAt: toIsoBogota(r.occurred_at),
            previousContent: r.previous_content,
            newContent: r.new_content,
          })),
          page,
          pageSize,
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
