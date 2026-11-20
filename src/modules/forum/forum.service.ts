import type { DbClient, DbExecutor } from '../../db/index.js';
import type { AuthUser, UserRole } from '../../middleware/auth.js';
import { recordAuditLog } from '../../services/audit.service.js';
import { moderationService } from '../../services/moderation.service.js';
import { notificationService } from '../../services/notification.service.js';
import { newUuid } from '../../utils/crypto.js';
import { AppError } from '../../utils/response.js';
import { toIsoBogota, toIsoBogotaNullable } from '../../utils/time.js';

export type ForumTargetType = 'forum_post' | 'forum_reply';
export type ForumAuditAction = 'created' | 'edited' | 'deleted' | 'moderated';

export interface ForumPostRow {
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

export interface ForumReplyDto {
  id: string;
  postId: string;
  authorId: string;
  authorName: string;
  content: string;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
}

export interface ForumPostDto {
  id: string;
  authorId: string;
  authorName: string;
  title: string;
  content: string;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  replies: ForumReplyDto[];
}

export interface ForumAuditDto {
  id: string;
  actorId: string;
  actorName: string;
  action: ForumAuditAction;
  targetId: string;
  targetType: ForumTargetType;
  before: { content: string } | null;
  after: { content: string } | null;
  previousContent: string | null;
  newContent: string | null;
  createdAt: string;
  occurredAt: string;
  ipAddress: string | null;
}

const HTML_OR_SCRIPT_PATTERN =
  /<\s*\/?\s*[a-zA-Z!][^>]*>|<!--[\s\S]*?-->|\b(?:javascript|vbscript)\s*:|\bdata\s*:\s*text\/html|\bon[a-z]+\s*=/i;

export function detectUnsafeForumHtml(value: string): boolean {
  return HTML_OR_SCRIPT_PATTERN.test(value);
}

export function sanitizeAndValidateForumReplyContent(rawContent: string): string {
  const withoutControl = rawContent.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();

  if (withoutControl.length === 0) {
    throw new AppError(
      422,
      'FORUM_REPLY_INVALID_CONTENT',
      'El contenido de la respuesta es obligatorio y no puede estar vacío',
      { content: 'El contenido no puede estar vacío' },
    );
  }

  if (withoutControl.length > 5000) {
    throw new AppError(
      422,
      'FORUM_REPLY_INVALID_CONTENT',
      'El contenido de la respuesta no puede superar 5000 caracteres',
      { content: 'Máximo 5000 caracteres' },
    );
  }

  if (detectUnsafeForumHtml(withoutControl)) {
    throw new AppError(
      422,
      'FORUM_REPLY_INVALID_CONTENT',
      'El contenido contiene HTML, etiquetas o scripts no permitidos',
      { content: 'No se permite HTML, scripts ni etiquetas peligrosas' },
    );
  }

  const modCheck = moderationService.checkText(withoutControl);
  if (modCheck.flagged) {
    throw new AppError(
      422,
      'FORUM_REPLY_INVALID_CONTENT',
      modCheck.reason ?? 'Contenido bloqueado por moderación automática',
      { content: 'Contiene lenguaje ofensivo' },
    );
  }

  return withoutControl;
}

export function mapForumReply(row: ForumPostRow): ForumReplyDto {
  return {
    id: row.id,
    postId: row.parent_id!,
    authorId: row.author_id,
    authorName: row.author_name,
    content: row.content,
    createdAt: toIsoBogota(row.created_at),
    editedAt: toIsoBogotaNullable(row.edited_at),
    deletedAt: toIsoBogotaNullable(row.deleted_at),
  };
}

export async function fetchForumPostById(
  db: DbExecutor,
  id: string,
  forUpdate = false,
): Promise<ForumPostRow | null> {
  const lockClause = forUpdate ? 'FOR UPDATE OF p' : '';
  const res = await db.query<ForumPostRow>(
    `SELECT p.id, p.parent_id, p.author_id, u.name AS author_name,
            p.title, p.content, p.edited_at, p.deleted_at, p.created_at
     FROM forum_posts p
     INNER JOIN users u ON u.id = p.author_id
     WHERE p.id = $1
     ${lockClause}`,
    [id],
  );
  return res.rows[0] ?? null;
}

export async function fetchForumReplyById(
  db: DbExecutor,
  id: string,
  forUpdate = false,
): Promise<ForumPostRow | null> {
  const lockClause = forUpdate ? 'FOR UPDATE OF p' : '';
  const res = await db.query<ForumPostRow>(
    `SELECT p.id, p.parent_id, p.author_id, u.name AS author_name,
            p.title, p.content, p.edited_at, p.deleted_at, p.created_at
     FROM forum_posts p
     INNER JOIN users u ON u.id = p.author_id
     WHERE p.id = $1 AND p.parent_id IS NOT NULL
     ${lockClause}`,
    [id],
  );
  return res.rows[0] ?? null;
}

export async function hydrateForumPost(
  db: DbExecutor,
  post: ForumPostRow,
  includeDeletedReplies = false,
): Promise<ForumPostDto> {
  const deletedFilter = includeDeletedReplies ? '' : 'AND p.deleted_at IS NULL';
  const repliesRes = await db.query<ForumPostRow>(
    `SELECT p.id, p.parent_id, p.author_id, u.name AS author_name,
            p.title, p.content, p.edited_at, p.deleted_at, p.created_at
     FROM forum_posts p
     INNER JOIN users u ON u.id = p.author_id
     WHERE p.parent_id = $1 ${deletedFilter}
     ORDER BY p.created_at ASC`,
    [post.id],
  );

  return {
    id: post.id,
    authorId: post.author_id,
    authorName: post.author_name,
    title: post.title,
    content: post.content,
    createdAt: toIsoBogota(post.created_at),
    editedAt: toIsoBogotaNullable(post.edited_at),
    deletedAt: toIsoBogotaNullable(post.deleted_at),
    replies: repliesRes.rows.map(mapForumReply),
  };
}

export async function listForumPosts(
  db: DbClient,
  actorRole: UserRole | undefined,
  query: { page: number; pageSize: number; includeDeleted?: boolean },
): Promise<{ items: ForumPostDto[]; total: number }> {
  const showDeleted =
    Boolean(query.includeDeleted) && actorRole === 'Administrador';
  const whereSql = showDeleted
    ? 'WHERE p.parent_id IS NULL'
    : 'WHERE p.parent_id IS NULL AND p.deleted_at IS NULL';

  const countRes = await db.query<{ cnt: string | number }>(
    `SELECT COUNT(*) AS cnt FROM forum_posts p ${whereSql}`,
  );
  const total = Number(countRes.rows[0]?.cnt ?? 0);
  const offset = (query.page - 1) * query.pageSize;

  const postsRes = await db.query<ForumPostRow>(
    `SELECT p.id, p.parent_id, p.author_id, u.name AS author_name,
            p.title, p.content, p.edited_at, p.deleted_at, p.created_at
     FROM forum_posts p
     INNER JOIN users u ON u.id = p.author_id
     ${whereSql}
     ORDER BY p.created_at DESC
     LIMIT $1 OFFSET $2`,
    [query.pageSize, offset],
  );

  const hydrated = await Promise.all(
    postsRes.rows.map((p) => hydrateForumPost(db, p, showDeleted)),
  );

  return { items: hydrated, total };
}

export async function createForumReply(
  db: DbClient,
  actor: AuthUser,
  postId: string,
  rawContent: string,
  ipAddress?: string,
): Promise<ForumPostDto> {
  const content = sanitizeAndValidateForumReplyContent(rawContent);

  return db.withTransaction(async (tx) => {
    const parent = await fetchForumPostById(tx, postId, true);
    if (!parent || parent.parent_id !== null || parent.deleted_at !== null) {
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
      [replyId, postId, actor.id, content],
    );

    await tx.query(
      `INSERT INTO forum_audits (
         id, post_id, target_type, actor_id, actor_name, action,
         previous_content, new_content, ip_address
       )
       VALUES ($1, $2, 'forum_reply', $3, $4, 'created', NULL, $5, $6)`,
      [newUuid(), replyId, actor.id, actor.name, content, ipAddress ?? null],
    );

    const createdReply = await fetchForumReplyById(tx, replyId);
    const createdDto = mapForumReply(createdReply!);

    await recordAuditLog(tx, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'forum_reply_created',
      entityType: 'forum_reply',
      entityId: replyId,
      ipAddress,
      changes: {
        action: 'created',
        actorId: actor.id,
        targetId: replyId,
        targetType: 'forum_reply',
        postId,
        before: null,
        after: {
          content: createdDto.content,
          createdAt: createdDto.createdAt,
        },
        createdAt: createdDto.createdAt,
      },
    });

    const refreshedParent = await fetchForumPostById(tx, postId);
    return hydrateForumPost(tx, refreshedParent!, actor.role === 'Administrador');
  });
}

export async function updateForumReply(
  db: DbClient,
  actor: AuthUser,
  replyId: string,
  rawContent: string,
  ipAddress?: string,
): Promise<ForumReplyDto> {
  const content = sanitizeAndValidateForumReplyContent(rawContent);

  return db.withTransaction(async (tx) => {
    const existing = await fetchForumReplyById(tx, replyId, true);
    if (!existing) {
      throw new AppError(
        404,
        'FORUM_REPLY_NOT_FOUND',
        'Respuesta no encontrada',
      );
    }

    if (existing.deleted_at !== null) {
      throw new AppError(
        409,
        'FORUM_REPLY_DELETED',
        'No se puede editar una respuesta eliminada',
      );
    }

    const isAuthor = existing.author_id === actor.id;
    const isAdmin = actor.role === 'Administrador';
    if (!isAuthor && !isAdmin) {
      throw new AppError(
        403,
        'FORUM_REPLY_FORBIDDEN',
        'Solo el autor o el administrador pueden editar esta respuesta',
      );
    }

    const auditAction: ForumAuditAction = isAuthor ? 'edited' : 'moderated';

    await tx.query(
      `UPDATE forum_posts
       SET content = $1, edited_at = NOW()
       WHERE id = $2 AND parent_id IS NOT NULL`,
      [content, replyId],
    );

    await tx.query(
      `INSERT INTO forum_audits (
         id, post_id, target_type, actor_id, actor_name, action,
         previous_content, new_content, ip_address
       )
       VALUES ($1, $2, 'forum_reply', $3, $4, $5, $6, $7, $8)`,
      [
        newUuid(),
        replyId,
        actor.id,
        actor.name,
        auditAction,
        existing.content,
        content,
        ipAddress ?? null,
      ],
    );

    if (!isAuthor && isAdmin) {
      await notificationService.createAndNotifyUser(tx, {
        userId: existing.author_id,
        title: 'Tu respuesta del foro fue moderada',
        body: 'Un administrador editó tu respuesta para ajustarla a las normas de la comunidad.',
        type: 'moderation',
        deepLink: `/forum/posts/${existing.parent_id}`,
        payload: {
          postId: existing.parent_id,
          replyId,
          action: 'moderated',
        },
      });
    }

    const updatedRow = await fetchForumReplyById(tx, replyId);
    const updatedDto = mapForumReply(updatedRow!);

    await recordAuditLog(tx, {
      actorId: actor.id,
      actorRole: actor.role,
      action: `forum_reply_${auditAction}`,
      entityType: 'forum_reply',
      entityId: replyId,
      ipAddress,
      changes: {
        action: auditAction,
        operation: 'edited',
        actorId: actor.id,
        targetId: replyId,
        targetType: 'forum_reply',
        postId: existing.parent_id,
        before: {
          content: existing.content,
          editedAt: toIsoBogotaNullable(existing.edited_at),
        },
        after: {
          content: updatedDto.content,
          editedAt: updatedDto.editedAt,
        },
        createdAt: updatedDto.editedAt,
      },
    });

    return updatedDto;
  });
}

export async function softDeleteForumReply(
  db: DbClient,
  actor: AuthUser,
  replyId: string,
  ipAddress?: string,
): Promise<{ id: string; deletedAt: string }> {
  return db.withTransaction(async (tx) => {
    const existing = await fetchForumReplyById(tx, replyId, true);
    if (!existing) {
      throw new AppError(
        404,
        'FORUM_REPLY_NOT_FOUND',
        'Respuesta no encontrada',
      );
    }

    if (existing.deleted_at !== null) {
      throw new AppError(
        409,
        'FORUM_REPLY_ALREADY_DELETED',
        'La respuesta ya fue eliminada',
      );
    }

    const isAuthor = existing.author_id === actor.id;
    const isAdmin = actor.role === 'Administrador';
    if (!isAuthor && !isAdmin) {
      throw new AppError(
        403,
        'FORUM_REPLY_FORBIDDEN',
        'Solo el autor o el administrador pueden eliminar esta respuesta',
      );
    }

    const auditAction: ForumAuditAction = isAuthor ? 'deleted' : 'moderated';

    const delRes = await tx.query<{ deleted_at: Date | string }>(
      `UPDATE forum_posts
       SET deleted_at = NOW()
       WHERE id = $1 AND parent_id IS NOT NULL AND deleted_at IS NULL
       RETURNING deleted_at`,
      [replyId],
    );

    const deletedAtIso = toIsoBogota(delRes.rows[0]!.deleted_at);

    await tx.query(
      `INSERT INTO forum_audits (
         id, post_id, target_type, actor_id, actor_name, action,
         previous_content, new_content, ip_address
       )
       VALUES ($1, $2, 'forum_reply', $3, $4, $5, $6, NULL, $7)`,
      [
        newUuid(),
        replyId,
        actor.id,
        actor.name,
        auditAction,
        existing.content,
        ipAddress ?? null,
      ],
    );

    if (!isAuthor && isAdmin) {
      await notificationService.createAndNotifyUser(tx, {
        userId: existing.author_id,
        title: 'Tu respuesta del foro fue eliminada por moderación',
        body: 'Un administrador retiró tu respuesta por incumplir las normas del foro.',
        type: 'moderation',
        deepLink: `/forum/posts/${existing.parent_id}`,
        payload: {
          postId: existing.parent_id,
          replyId,
          action: 'deleted',
        },
      });
    }

    await recordAuditLog(tx, {
      actorId: actor.id,
      actorRole: actor.role,
      action: `forum_reply_${auditAction}`,
      entityType: 'forum_reply',
      entityId: replyId,
      ipAddress,
      changes: {
        action: auditAction,
        operation: 'deleted',
        actorId: actor.id,
        targetId: replyId,
        targetType: 'forum_reply',
        postId: existing.parent_id,
        before: {
          content: existing.content,
          deletedAt: null,
        },
        after: {
          deletedAt: deletedAtIso,
        },
        createdAt: deletedAtIso,
      },
    });

    return {
      id: replyId,
      deletedAt: deletedAtIso,
    };
  });
}

export async function listForumAudits(
  db: DbClient,
  query: {
    page: number;
    pageSize: number;
    actorId?: string;
    action?: ForumAuditAction;
    targetType?: ForumTargetType;
  },
): Promise<{ items: ForumAuditDto[]; total: number }> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (query.actorId) {
    params.push(query.actorId);
    conditions.push(`actor_id = $${params.length}`);
  }
  if (query.action) {
    params.push(query.action);
    conditions.push(`action = $${params.length}`);
  }
  if (query.targetType) {
    params.push(query.targetType);
    conditions.push(`target_type = $${params.length}`);
  }

  const whereSql =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRes = await db.query<{ cnt: string | number }>(
    `SELECT COUNT(*) AS cnt FROM forum_audits ${whereSql}`,
    params,
  );
  const total = Number(countRes.rows[0]?.cnt ?? 0);
  const offset = (query.page - 1) * query.pageSize;

  const rowsRes = await db.query<{
    id: string;
    post_id: string;
    target_type: ForumTargetType;
    actor_id: string;
    actor_name: string;
    action: ForumAuditAction;
    occurred_at: Date | string;
    previous_content: string | null;
    new_content: string | null;
    ip_address: string | null;
  }>(
    `SELECT id, post_id, target_type, actor_id, actor_name, action,
            occurred_at, previous_content, new_content, ip_address
     FROM forum_audits
     ${whereSql}
     ORDER BY occurred_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, query.pageSize, offset],
  );

  return {
    items: rowsRes.rows.map((r) => {
      const timestamp = toIsoBogota(r.occurred_at);
      return {
        id: r.id,
        actorId: r.actor_id,
        actorName: r.actor_name,
        action: r.action,
        targetId: r.post_id,
        targetType: r.target_type,
        before: r.previous_content !== null ? { content: r.previous_content } : null,
        after: r.new_content !== null ? { content: r.new_content } : null,
        previousContent: r.previous_content,
        newContent: r.new_content,
        createdAt: timestamp,
        occurredAt: timestamp,
        ipAddress: r.ip_address,
      };
    }),
    total,
  };
}
