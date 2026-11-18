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
import { notificationService } from '../../services/notification.service.js';
import { newUuid } from '../../utils/crypto.js';
import { AppError, created, ok, paginated } from '../../utils/response.js';
import { toIsoBogota, toIsoBogotaNullable } from '../../utils/time.js';

const createDataRequestSchema = z
  .object({
    requestType: z.enum(['access', 'rectification', 'deletion', 'revocation']),
    details: z.string().trim().min(5).max(2000),
  })
  .strict();

const updateDataRequestSchema = z
  .object({
    status: z.enum(['in_review', 'resolved', 'rejected']),
    adminNotes: z.string().trim().max(2000).optional(),
  })
  .strict();

export function createLegalRouter(db: DbClient): Router {
  const router = Router();
  const { authenticate, requireRoles } = createAuthMiddleware(db);

  // Términos y política de privacidad conforme a la Ley 1581 de 2012 (Colombia)
  router.get('/terms', (_req, res) => {
    return ok(
      res,
      {
        version: '2026.1-ley1581',
        country: 'CO',
        lawReference: 'Ley 1581 de 2012 y Decreto 1377 de 2013',
        dataMinimizationPolicy:
          'Los Malditos únicamente trata nombre, usuario de acceso, información operativa de la motocicleta (marca, modelo, cilindraje, apodo y color opcional) e historial del servicio. No recolecta teléfono, correo electrónico, cédula ni placa.',
        purposes: [
          'Gestión de citas y lavadas presenciales en el establecimiento',
          'Confirmación operativa de solicitudes y notificaciones de estado',
          'Administración del programa de fidelización 7+1',
          'Soporte contable manual de pagos en Efectivo, Nequi o Daviplata',
        ],
        rights: [
          'Conocer, actualizar y rectificar sus datos frente al administrador',
          'Solicitar prueba de la autorización otorgada',
          'Solicitar la supresión o revocatoria mediante /api/v1/legal/data-requests',
        ],
      },
      'Política de tratamiento de datos personales (Ley 1581 de 2012)',
    );
  });

  router.post(
    '/data-requests',
    authenticate(),
    validateBody(createDataRequestSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const body = req.body as z.infer<typeof createDataRequestSchema>;
        const id = newUuid();

        const createdReq = await db.withTransaction(async (tx) => {
          const ins = await tx.query<{
            id: string;
            user_id: string;
            request_type: string;
            details: string;
            status: string;
            admin_notes: string | null;
            resolved_at: Date | string | null;
            created_at: Date | string;
          }>(
            `INSERT INTO data_management_requests (id, user_id, request_type, details, status)
             VALUES ($1, $2, $3, $4, 'pending')
             RETURNING id, user_id, request_type, details, status, admin_notes, resolved_at, created_at`,
            [id, actor.id, body.requestType, body.details],
          );

          await notificationService.notifyAdmins(tx, {
            title: 'Nueva solicitud Ley 1581 de gestión de datos',
            body: `El usuario ${actor.name} envió una solicitud de tipo '${body.requestType}'.`,
            type: 'data_request',
            deepLink: `/legal/data-requests/${id}`,
            payload: { requestId: id, userId: actor.id, requestType: body.requestType },
          });

          await recordAuditLog(tx, {
            actorId: actor.id,
            actorRole: actor.role,
            action: 'data_management_request_created',
            entityType: 'data_management_request',
            entityId: id,
            ipAddress: req.clientIp,
            changes: { requestType: body.requestType },
          });

          return ins.rows[0]!;
        });

        return created(
          res,
          {
            id: createdReq.id,
            userId: createdReq.user_id,
            requestType: createdReq.request_type,
            details: createdReq.details,
            status: createdReq.status,
            adminNotes: createdReq.admin_notes,
            resolvedAt: toIsoBogotaNullable(createdReq.resolved_at),
            createdAt: toIsoBogota(createdReq.created_at),
          },
          'Solicitud de gestión de datos personales registrada exitosamente',
        );
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    '/data-requests',
    authenticate(),
    validateQuery(paginationQuerySchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { page, pageSize } = res.locals.query as z.infer<
          typeof paginationQuerySchema
        >;
        const whereSql =
          actor.role === 'Administrador' ? '' : 'WHERE user_id = $1';
        const params = actor.role === 'Administrador' ? [] : [actor.id];

        const countRes = await db.query<{ cnt: string | number }>(
          `SELECT COUNT(*) AS cnt FROM data_management_requests ${whereSql}`,
          params,
        );
        const total = Number(countRes.rows[0]?.cnt ?? 0);
        const offset = (page - 1) * pageSize;

        const rowsRes = await db.query<{
          id: string;
          user_id: string;
          request_type: string;
          details: string;
          status: string;
          admin_notes: string | null;
          resolved_at: Date | string | null;
          created_at: Date | string;
        }>(
          `SELECT id, user_id, request_type, details, status, admin_notes, resolved_at, created_at
           FROM data_management_requests
           ${whereSql}
           ORDER BY created_at DESC
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, pageSize, offset],
        );

        return paginated(
          res,
          rowsRes.rows.map((r) => ({
            id: r.id,
            userId: r.user_id,
            requestType: r.request_type,
            details: r.details,
            status: r.status,
            adminNotes: r.admin_notes,
            resolvedAt: toIsoBogotaNullable(r.resolved_at),
            createdAt: toIsoBogota(r.created_at),
          })),
          page,
          pageSize,
          total,
          'Solicitudes de gestión de datos consultadas exitosamente',
        );
      } catch (err) {
        next(err);
      }
    },
  );

  router.patch(
    '/data-requests/:id',
    authenticate(),
    requireRoles('Administrador'),
    validateParams(idParamSchema),
    validateBody(updateDataRequestSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { id } = res.locals.params as { id: string };
        const body = req.body as z.infer<typeof updateDataRequestSchema>;

        const updated = await db.withTransaction(async (tx) => {
          const check = await tx.query<{ id: string }>(
            `SELECT id FROM data_management_requests WHERE id = $1 FOR UPDATE`,
            [id],
          );
          if (!check.rows[0]) {
            throw new AppError(
              404,
              'DATA_REQUEST_NOT_FOUND',
              'Solicitud no encontrada',
            );
          }

          const resolvedAt =
            body.status === 'resolved' || body.status === 'rejected'
              ? new Date()
              : null;
          const upd = await tx.query<{
            id: string;
            user_id: string;
            request_type: string;
            details: string;
            status: string;
            admin_notes: string | null;
            resolved_at: Date | string | null;
            created_at: Date | string;
          }>(
            `UPDATE data_management_requests
             SET status = $1,
                 admin_notes = COALESCE($2, admin_notes),
                 resolved_by = $3,
                 resolved_at = COALESCE($4, resolved_at)
             WHERE id = $5
             RETURNING id, user_id, request_type, details, status, admin_notes, resolved_at, created_at`,
            [body.status, body.adminNotes ?? null, actor.id, resolvedAt, id],
          );

          await recordAuditLog(tx, {
            actorId: actor.id,
            actorRole: actor.role,
            action: 'data_management_request_updated',
            entityType: 'data_management_request',
            entityId: id,
            ipAddress: req.clientIp,
            changes: body,
          });

          return upd.rows[0]!;
        });

        return ok(
          res,
          {
            id: updated.id,
            userId: updated.user_id,
            requestType: updated.request_type,
            details: updated.details,
            status: updated.status,
            adminNotes: updated.admin_notes,
            resolvedAt: toIsoBogotaNullable(updated.resolved_at),
            createdAt: toIsoBogota(updated.created_at),
          },
          'Solicitud Ley 1581 actualizada exitosamente',
        );
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
