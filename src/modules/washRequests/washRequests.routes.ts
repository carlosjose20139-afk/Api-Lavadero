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
  isoDateSchema,
  isoDateTimeSchema,
  paginationQuerySchema,
  uuidSchema,
  validateBody,
  validateParams,
  validateQuery,
} from '../../middleware/validate.js';
import { recordAuditLog } from '../../services/audit.service.js';
import { notificationService } from '../../services/notification.service.js';
import { newUuid } from '../../utils/crypto.js';
import { AppError, paginated } from '../../utils/response.js';
import {
  bogotaDayBoundsUtc,
  toIsoBogota,
  toIsoBogotaNullable,
} from '../../utils/time.js';
import {
  paymentMethodSchema,
  recordManualPaymentTx,
} from '../finance/payments.service.js';

const WASH_STATUSES = [
  'pending_confirmation',
  'confirmed',
  'rejected',
  'expired',
  'washing',
  'drying',
  'ready',
  'paid',
  'cancelled',
] as const;

const listWashRequestsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(WASH_STATUSES).optional(),
  date: isoDateSchema.optional(),
});

const createWashRequestSchema = z
  .object({
    customerId: uuidSchema,
    motorcycleId: uuidSchema,
    serviceId: uuidSchema,
    appointmentId: uuidSchema.nullable().optional(),
    price: z.coerce.number().int().min(0, 'El precio en COP debe ser >= 0'),
    scheduledAt: isoDateTimeSchema.nullable().optional(),
    expiresInMinutes: z.coerce.number().int().min(1).max(1440).default(15),
  })
  .strict();

const rejectWashRequestSchema = z
  .object({
    reason: z.string().trim().max(500).nullable().optional(),
  })
  .strict()
  .optional();

const updateWashStatusSchema = z
  .object({
    status: z.enum(['washing', 'drying', 'ready', 'paid', 'cancelled']),
    employeeId: uuidSchema.nullable().optional(),
    beforePhotoUrl: z.string().url().nullable().optional(),
    afterPhotoUrl: z.string().url().nullable().optional(),
  })
  .strict();

const completeWashRequestSchema = z
  .object({
    paymentMethod: paymentMethodSchema,
    amount: z
      .number({
        message: 'El monto en COP debe ser un número entero mayor que cero',
      })
      .int('El monto en COP debe ser un número entero')
      .min(1, 'El monto en COP debe ser mayor que cero'),
    reference: z
      .string({ message: 'La referencia debe ser una cadena de texto' })
      .trim()
      .max(120, 'La referencia no puede superar 120 caracteres')
      .nullable()
      .optional(),
  })
  .strict();

interface WashRequestRow {
  id: string;
  customer_id: string;
  motorcycle_id: string;
  service_id: string;
  appointment_id: string | null;
  employee_id: string | null;
  base_price: number;
  applied_pending_balance: number;
  price: number;
  scheduled_at: Date | string | null;
  expires_in_minutes: number;
  expires_at: Date | string;
  status: (typeof WASH_STATUSES)[number];
  rejection_reason: string | null;
  confirmed_at: Date | string | null;
  completed_at: Date | string | null;
  customer_name: string;
  motorcycle_name: string;
  service_name: string;
}

interface WashAuditRow {
  id: string;
  actor_id: string | null;
  actor_name: string;
  action: string;
  occurred_at: Date | string;
  previous_content: string | null;
  new_content: string | null;
}

const VALID_OPERATIONAL_TRANSITIONS: Record<string, string[]> = {
  confirmed: ['washing', 'drying', 'ready', 'cancelled'],
  washing: ['drying', 'ready', 'cancelled'],
  drying: ['ready', 'cancelled'],
  ready: ['paid', 'cancelled'],
};

async function hydrateWashRequest(db: DbExecutor, row: WashRequestRow) {
  const auditRes = await db.query<WashAuditRow>(
    `SELECT id, actor_id, actor_name, action, occurred_at, previous_content, new_content
     FROM wash_request_audits
     WHERE wash_request_id = $1
     ORDER BY occurred_at ASC`,
    [row.id],
  );

  return {
    id: row.id,
    customerId: row.customer_id,
    motorcycleId: row.motorcycle_id,
    serviceId: row.service_id,
    appointmentId: row.appointment_id,
    basePrice: Number(row.base_price),
    appliedPendingBalance: Number(row.applied_pending_balance),
    price: Number(row.price),
    scheduledAt: toIsoBogotaNullable(row.scheduled_at),
    expiresInMinutes: Number(row.expires_in_minutes),
    customerName: row.customer_name,
    motorcycleName: row.motorcycle_name,
    serviceName: row.service_name,
    status: row.status,
    rejectionReason: row.rejection_reason,
    confirmedAt: toIsoBogotaNullable(row.confirmed_at),
    completedAt: toIsoBogotaNullable(row.completed_at),
    audit: auditRes.rows.map((a) => ({
      id: a.id,
      actorId: a.actor_id,
      actorName: a.actor_name,
      action: a.action,
      occurredAt: toIsoBogota(a.occurred_at),
      previousContent: a.previous_content,
      newContent: a.new_content,
    })),
  };
}

async function fetchWashRequestRow(
  db: DbExecutor,
  id: string,
): Promise<WashRequestRow | null> {
  const res = await db.query<WashRequestRow>(
    `SELECT wr.id, wr.customer_id, wr.motorcycle_id, wr.service_id, wr.appointment_id,
            wr.employee_id, wr.base_price, wr.applied_pending_balance, wr.price,
            wr.scheduled_at, wr.expires_in_minutes, wr.expires_at, wr.status,
            wr.rejection_reason, wr.confirmed_at, wr.completed_at,
            u.name AS customer_name,
            CONCAT(m.brand, ' ', m.model, COALESCE(' (' || m.nickname || ')', '')) AS motorcycle_name,
            s.name AS service_name
     FROM wash_requests wr
     INNER JOIN users u ON u.id = wr.customer_id
     INNER JOIN motorcycles m ON m.id = wr.motorcycle_id
     INNER JOIN services s ON s.id = wr.service_id
     WHERE wr.id = $1`,
    [id],
  );
  return res.rows[0] ?? null;
}

export function createWashRequestsRouter(db: DbClient): Router {
  const router = Router();
  const { authenticate, requireRoles } = createAuthMiddleware(db);

  router.get(
    '/',
    authenticate(),
    validateQuery(listWashRequestsQuerySchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { page, pageSize, status, date } = res.locals.query as z.infer<
          typeof listWashRequestsQuerySchema
        >;

        const conditions: string[] = [];
        const params: unknown[] = [];

        if (actor.role === 'Cliente') {
          params.push(actor.id);
          conditions.push(`wr.customer_id = $${params.length}`);
        }
        if (status) {
          params.push(status);
          conditions.push(`wr.status = $${params.length}`);
        }
        if (date) {
          const { start, end } = bogotaDayBoundsUtc(date);
          params.push(start, end);
          conditions.push(
            `COALESCE(wr.scheduled_at, wr.created_at) >= $${params.length - 1} AND COALESCE(wr.scheduled_at, wr.created_at) < $${params.length}`,
          );
        }

        const whereSql =
          conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const countRes = await db.query<{ cnt: string | number }>(
          `SELECT COUNT(*) AS cnt FROM wash_requests wr ${whereSql}`,
          params,
        );
        const total = Number(countRes.rows[0]?.cnt ?? 0);

        const offset = (page - 1) * pageSize;
        const rowsRes = await db.query<WashRequestRow>(
          `SELECT wr.id, wr.customer_id, wr.motorcycle_id, wr.service_id, wr.appointment_id,
                  wr.employee_id, wr.base_price, wr.applied_pending_balance, wr.price,
                  wr.scheduled_at, wr.expires_in_minutes, wr.expires_at, wr.status,
                  wr.rejection_reason, wr.confirmed_at, wr.completed_at,
                  u.name AS customer_name,
                  CONCAT(m.brand, ' ', m.model, COALESCE(' (' || m.nickname || ')', '')) AS motorcycle_name,
                  s.name AS service_name
           FROM wash_requests wr
           INNER JOIN users u ON u.id = wr.customer_id
           INNER JOIN motorcycles m ON m.id = wr.motorcycle_id
           INNER JOIN services s ON s.id = wr.service_id
           ${whereSql}
           ORDER BY wr.created_at DESC
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, pageSize, offset],
        );

        const hydrated = await Promise.all(
          rowsRes.rows.map((row) => hydrateWashRequest(db, row)),
        );

        return paginated(
          res,
          hydrated,
          page,
          pageSize,
          total,
          'Lavadas consultadas exitosamente',
        );
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/',
    authenticate(),
    requireRoles('Administrador', 'Lavador'),
    validateIdempotencyHeader(true),
    validateBody(createWashRequestSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const body = req.body as z.infer<typeof createWashRequestSchema>;
        const idempotencyKey = res.locals.idempotencyKey as string;

        const out = await runIdempotent(
          db,
          {
            key: idempotencyKey,
            actorId: actor.id,
            method: 'POST',
            path: '/wash-requests',
            requestBody: body,
            successStatus: 201,
          },
          async (tx) => {
            const custRes = await tx.query<{
              id: string;
              name: string;
              is_active: boolean;
              pending_balance: number;
            }>(
              `SELECT id, name, is_active, pending_balance
               FROM users
               WHERE id = $1 AND role = 'Cliente'
               FOR UPDATE`,
              [body.customerId],
            );
            const customer = custRes.rows[0];
            if (!customer || !customer.is_active) {
              throw new AppError(
                404,
                'CUSTOMER_NOT_FOUND',
                'Cliente no encontrado o bloqueado',
              );
            }

            const [motoRes, svcRes] = await Promise.all([
              tx.query<{
                id: string;
                customer_id: string;
                is_active: boolean;
                brand: string;
                model: string;
              }>(
                `SELECT id, customer_id, is_active, brand, model FROM motorcycles WHERE id = $1`,
                [body.motorcycleId],
              ),
              tx.query<{ id: string; name: string; is_active: boolean }>(
                `SELECT id, name, is_active FROM services WHERE id = $1`,
                [body.serviceId],
              ),
            ]);

            const moto = motoRes.rows[0];
            if (!moto || !moto.is_active || moto.customer_id !== body.customerId) {
              throw new AppError(
                404,
                'MOTORCYCLE_NOT_FOUND',
                'La moto no existe, está inactiva o no pertenece al cliente',
              );
            }

            const svc = svcRes.rows[0];
            if (!svc || !svc.is_active) {
              throw new AppError(
                404,
                'SERVICE_NOT_FOUND',
                'El servicio no existe o está inactivo',
              );
            }

            if (body.appointmentId) {
              const apptRes = await tx.query<{ id: string; customer_id: string }>(
                `SELECT id, customer_id FROM appointments WHERE id = $1`,
                [body.appointmentId],
              );
              if (
                !apptRes.rows[0] ||
                apptRes.rows[0].customer_id !== body.customerId
              ) {
                throw new AppError(
                  404,
                  'APPOINTMENT_NOT_FOUND',
                  'La cita referenciada no existe para este cliente',
                );
              }
            }

            // Descuento automático de pendingBalance sobre la próxima lavada (ej. 7.000 -> 6.000)
            const currentPending = Number(customer.pending_balance);
            const appliedBalance = Math.min(body.price, currentPending);
            const finalPrice = body.price - appliedBalance;

            if (appliedBalance > 0) {
              await tx.query(
                `UPDATE users
                 SET pending_balance = pending_balance - $1, updated_at = NOW()
                 WHERE id = $2`,
                [appliedBalance, body.customerId],
              );
            }

            const washId = newUuid();
            const expiresInMinutes = body.expiresInMinutes ?? 15;
            const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000);
            const scheduledAt = body.scheduledAt ? new Date(body.scheduledAt) : null;

            await tx.query(
              `INSERT INTO wash_requests (
                 id, customer_id, motorcycle_id, service_id, appointment_id,
                 base_price, applied_pending_balance, price, scheduled_at,
                 expires_in_minutes, expires_at, status, created_by
               )
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending_confirmation', $12)`,
              [
                washId,
                body.customerId,
                body.motorcycleId,
                body.serviceId,
                body.appointmentId ?? null,
                body.price,
                appliedBalance,
                finalPrice,
                scheduledAt,
                expiresInMinutes,
                expiresAt,
                actor.id,
              ],
            );

            const balanceNote =
              appliedBalance > 0
                ? ` (tarifa base COP ${body.price}, descuento pendingBalance COP ${appliedBalance}, total COP ${finalPrice})`
                : ` (COP ${finalPrice})`;

            await tx.query(
              `INSERT INTO wash_request_audits (
                 id, wash_request_id, actor_id, actor_name, action,
                 previous_content, new_content, ip_address
               )
               VALUES ($1, $2, $3, $4, 'created', NULL, $5, $6)`,
              [
                newUuid(),
                washId,
                actor.id,
                actor.name,
                `pending_confirmation${balanceNote}`,
                req.clientIp ?? null,
              ],
            );

            await notificationService.createAndNotifyUser(tx, {
              userId: body.customerId,
              title: 'Confirma tu lavada en Los Malditos',
              body:
                appliedBalance > 0
                  ? `Servicio ${svc.name} para tu ${moto.brand} ${moto.model}. Se aplicó tu saldo pendiente de COP ${appliedBalance} sobre COP ${body.price}; valor final: COP ${finalPrice}. Confirma en los próximos ${expiresInMinutes} min.`
                  : `Servicio ${svc.name} para tu ${moto.brand} ${moto.model} por COP ${finalPrice}. Confirma en los próximos ${expiresInMinutes} minutos.`,
              type: 'wash_confirmation_required',
              deepLink: `/wash-requests/${washId}`,
              payload: {
                washRequestId: washId,
                price: finalPrice,
                basePrice: body.price,
                appliedPendingBalance: appliedBalance,
                expiresInMinutes,
              },
            });

            await recordAuditLog(tx, {
              actorId: actor.id,
              actorRole: actor.role,
              action: 'wash_request_created',
              entityType: 'wash_request',
              entityId: washId,
              ipAddress: req.clientIp,
              changes: {
                customerId: body.customerId,
                basePrice: body.price,
                appliedPendingBalance: appliedBalance,
                price: finalPrice,
              },
            });

            const row = await fetchWashRequestRow(tx, washId);
            const data = await hydrateWashRequest(tx, row!);
            const message =
              appliedBalance > 0
                ? `Solicitud de lavada enviada para confirmación. Se descontó pendingBalance de COP ${appliedBalance} sobre COP ${body.price}, quedando en COP ${finalPrice}.`
                : 'Solicitud de lavada creada y enviada para confirmación del cliente';

            return { data, message };
          },
        );

        return res.status(out.statusCode).json(out.body);
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/:id/confirm',
    authenticate(),
    requireRoles('Cliente'),
    validateParams(idParamSchema),
    validateIdempotencyHeader(true),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { id } = res.locals.params as { id: string };
        const idempotencyKey = res.locals.idempotencyKey as string;

        const out = await runIdempotent(
          db,
          {
            key: idempotencyKey,
            actorId: actor.id,
            method: 'POST',
            path: `/wash-requests/${id}/confirm`,
            requestBody: {},
            successStatus: 200,
          },
          async (tx) => {
            const wrRes = await tx.query<{
              id: string;
              customer_id: string;
              appointment_id: string | null;
              status: string;
              expires_at: Date | string;
              applied_pending_balance: number;
            }>(
              `SELECT id, customer_id, appointment_id, status, expires_at, applied_pending_balance
               FROM wash_requests WHERE id = $1 FOR UPDATE`,
              [id],
            );
            const wr = wrRes.rows[0];
            if (!wr) {
              throw new AppError(
                404,
                'WASH_REQUEST_NOT_FOUND',
                'Solicitud de lavada no encontrada',
              );
            }

            if (wr.customer_id !== actor.id) {
              throw new AppError(
                403,
                'FORBIDDEN',
                'Solo el cliente propietario puede confirmar esta lavada',
              );
            }

            if (
              wr.status === 'pending_confirmation' &&
              new Date(wr.expires_at) <= new Date()
            ) {
              throw new AppError(
                409,
                'WASH_REQUEST_EXPIRED',
                'La solicitud de lavada venció. Pide al administrador que la reenvíe',
              );
            }

            if (wr.status !== 'pending_confirmation') {
              throw new AppError(
                409,
                'INVALID_WASH_TRANSITION',
                `La lavada ya está en estado '${wr.status}' y no admite confirmación`,
              );
            }

            await tx.query(
              `UPDATE wash_requests
               SET status = 'confirmed', confirmed_at = NOW(), updated_at = NOW()
               WHERE id = $1`,
              [id],
            );

            if (wr.appointment_id) {
              await tx.query(
                `UPDATE appointments SET status = 'confirmed', updated_at = NOW() WHERE id = $1`,
                [wr.appointment_id],
              );
            }

            await tx.query(
              `INSERT INTO wash_request_audits (
                 id, wash_request_id, actor_id, actor_name, action,
                 previous_content, new_content, ip_address
               )
               VALUES ($1, $2, $3, $4, 'confirmed', 'pending_confirmation', 'confirmed', $5)`,
              [newUuid(), id, actor.id, actor.name, req.clientIp ?? null],
            );

            const hydratedRow = await fetchWashRequestRow(tx, id);
            await notificationService.notifyAdmins(tx, {
              title: 'Lavada confirmada por el cliente',
              body: `${actor.name} confirmó la lavada (${hydratedRow!.motorcycle_name} - ${hydratedRow!.service_name}). Ya aparece en la cola del día.`,
              type: 'wash_confirmed',
              deepLink: `/wash-requests/${id}`,
              payload: { washRequestId: id, customerId: actor.id },
            });

            await recordAuditLog(tx, {
              actorId: actor.id,
              actorRole: actor.role,
              action: 'wash_request_confirmed',
              entityType: 'wash_request',
              entityId: id,
              ipAddress: req.clientIp,
            });

            return {
              data: await hydrateWashRequest(tx, hydratedRow!),
              message: 'Lavada confirmada exitosamente y agregada a la cola del día',
            };
          },
        );

        return res.status(out.statusCode).json(out.body);
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/:id/reject',
    authenticate(),
    requireRoles('Cliente'),
    validateParams(idParamSchema),
    validateIdempotencyHeader(true),
    validateBody(rejectWashRequestSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { id } = res.locals.params as { id: string };
        const body = (req.body ?? {}) as { reason?: string | null };
        const idempotencyKey = res.locals.idempotencyKey as string;

        const out = await runIdempotent(
          db,
          {
            key: idempotencyKey,
            actorId: actor.id,
            method: 'POST',
            path: `/wash-requests/${id}/reject`,
            requestBody: body,
            successStatus: 200,
          },
          async (tx) => {
            const wrRes = await tx.query<{
              id: string;
              customer_id: string;
              status: string;
              applied_pending_balance: number;
            }>(
              `SELECT id, customer_id, status, applied_pending_balance
               FROM wash_requests WHERE id = $1 FOR UPDATE`,
              [id],
            );
            const wr = wrRes.rows[0];
            if (!wr) {
              throw new AppError(
                404,
                'WASH_REQUEST_NOT_FOUND',
                'Solicitud de lavada no encontrada',
              );
            }

            if (wr.customer_id !== actor.id) {
              throw new AppError(
                403,
                'FORBIDDEN',
                'Solo el cliente propietario puede rechazar esta lavada',
              );
            }

            if (wr.status !== 'pending_confirmation') {
              throw new AppError(
                409,
                'INVALID_WASH_TRANSITION',
                `La lavada ya está en estado '${wr.status}' y no puede rechazarse`,
              );
            }

            await tx.query(
              `UPDATE wash_requests
               SET status = 'rejected', rejection_reason = $1, updated_at = NOW()
               WHERE id = $2`,
              [body.reason ?? null, id],
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
              `INSERT INTO wash_request_audits (
                 id, wash_request_id, actor_id, actor_name, action,
                 previous_content, new_content, ip_address
               )
               VALUES ($1, $2, $3, $4, 'rejected', 'pending_confirmation', $5, $6)`,
              [
                newUuid(),
                id,
                actor.id,
                actor.name,
                body.reason ? `rejected: ${body.reason}` : 'rejected',
                req.clientIp ?? null,
              ],
            );

            const hydratedRow = await fetchWashRequestRow(tx, id);
            await notificationService.notifyAdmins(tx, {
              title: 'Lavada rechazada por el cliente',
              body: `${actor.name} rechazó la lavada (${hydratedRow!.motorcycle_name})${body.reason ? `: ${body.reason}` : '.'}`,
              type: 'wash_rejected',
              deepLink: `/wash-requests/${id}`,
              payload: {
                washRequestId: id,
                customerId: actor.id,
                reason: body.reason ?? null,
              },
            });

            await recordAuditLog(tx, {
              actorId: actor.id,
              actorRole: actor.role,
              action: 'wash_request_rejected',
              entityType: 'wash_request',
              entityId: id,
              ipAddress: req.clientIp,
              changes: { reason: body.reason ?? null },
            });

            return {
              data: await hydrateWashRequest(tx, hydratedRow!),
              message: 'Solicitud de lavada rechazada',
            };
          },
        );

        return res.status(out.statusCode).json(out.body);
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/:id/resend',
    authenticate(),
    requireRoles('Administrador'),
    validateParams(idParamSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { id } = res.locals.params as { id: string };

        const result = await db.withTransaction(async (tx) => {
          const wrRes = await tx.query<{
            id: string;
            customer_id: string;
            status: string;
            base_price: number;
            expires_in_minutes: number;
          }>(
            `SELECT id, customer_id, status, base_price, expires_in_minutes
             FROM wash_requests WHERE id = $1 FOR UPDATE`,
            [id],
          );
          const wr = wrRes.rows[0];
          if (!wr) {
            throw new AppError(
              404,
              'WASH_REQUEST_NOT_FOUND',
              'Solicitud de lavada no encontrada',
            );
          }

          if (wr.status !== 'expired' && wr.status !== 'rejected') {
            throw new AppError(
              409,
              'INVALID_RESEND_STATE',
              'Solo se pueden reenviar solicitudes vencidas o rechazadas',
            );
          }

          const custRes = await tx.query<{ pending_balance: number }>(
            `SELECT pending_balance FROM users WHERE id = $1 FOR UPDATE`,
            [wr.customer_id],
          );
          const currentPending = Number(custRes.rows[0]?.pending_balance ?? 0);
          const appliedBalance = Math.min(Number(wr.base_price), currentPending);
          const finalPrice = Number(wr.base_price) - appliedBalance;

          if (appliedBalance > 0) {
            await tx.query(
              `UPDATE users SET pending_balance = pending_balance - $1, updated_at = NOW() WHERE id = $2`,
              [appliedBalance, wr.customer_id],
            );
          }

          const expiresAt = new Date(
            Date.now() + Number(wr.expires_in_minutes) * 60 * 1000,
          );

          await tx.query(
            `UPDATE wash_requests
             SET status = 'pending_confirmation',
                 rejection_reason = NULL,
                 applied_pending_balance = $1,
                 price = $2,
                 expires_at = $3,
                 updated_at = NOW()
             WHERE id = $4`,
            [appliedBalance, finalPrice, expiresAt, id],
          );

          await tx.query(
            `INSERT INTO wash_request_audits (
               id, wash_request_id, actor_id, actor_name, action,
               previous_content, new_content, ip_address
             )
             VALUES ($1, $2, $3, $4, 'resent', $5, 'pending_confirmation', $6)`,
            [newUuid(), id, actor.id, actor.name, wr.status, req.clientIp ?? null],
          );

          const hydratedRow = await fetchWashRequestRow(tx, id);
          await notificationService.createAndNotifyUser(tx, {
            userId: wr.customer_id,
            title: 'Nueva confirmación de lavada',
            body: `El administrador reenvió la solicitud de ${hydratedRow!.service_name} (${hydratedRow!.motorcycle_name}) por COP ${finalPrice}.`,
            type: 'wash_confirmation_required',
            deepLink: `/wash-requests/${id}`,
            payload: { washRequestId: id, price: finalPrice },
          });

          await recordAuditLog(tx, {
            actorId: actor.id,
            actorRole: actor.role,
            action: 'wash_request_resent',
            entityType: 'wash_request',
            entityId: id,
            ipAddress: req.clientIp,
          });

          return await hydrateWashRequest(tx, hydratedRow!);
        });

        return res.status(200).json({
          data: result,
          message: 'Solicitud de lavada reenviada exitosamente al cliente',
        });
      } catch (err) {
        next(err);
      }
    },
  );

  router.patch(
    '/:id/status',
    authenticate(),
    requireRoles('Lavador', 'Administrador'),
    validateParams(idParamSchema),
    validateBody(updateWashStatusSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { id } = res.locals.params as { id: string };
        const body = req.body as z.infer<typeof updateWashStatusSchema>;

        const updated = await db.withTransaction(async (tx) => {
          const wrRes = await tx.query<{
            id: string;
            customer_id: string;
            appointment_id: string | null;
            employee_id: string | null;
            status: string;
            applied_pending_balance: number;
            before_photo_url: string | null;
            after_photo_url: string | null;
          }>(
            `SELECT id, customer_id, appointment_id, employee_id, status,
                    applied_pending_balance, before_photo_url, after_photo_url
             FROM wash_requests WHERE id = $1 FOR UPDATE`,
            [id],
          );
          const wr = wrRes.rows[0];
          if (!wr) {
            throw new AppError(
              404,
              'WASH_REQUEST_NOT_FOUND',
              'Solicitud de lavada no encontrada',
            );
          }

          const allowedNext = VALID_OPERATIONAL_TRANSITIONS[wr.status] ?? [];
          if (!allowedNext.includes(body.status)) {
            throw new AppError(
              409,
              'INVALID_WASH_TRANSITION',
              `No es válido cambiar de '${wr.status}' a '${body.status}'`,
            );
          }

          if (body.employeeId) {
            const empRes = await tx.query<{ id: string }>(
              `SELECT id FROM employees WHERE id = $1 AND is_active = TRUE`,
              [body.employeeId],
            );
            if (!empRes.rows[0]) {
              throw new AppError(
                404,
                'EMPLOYEE_NOT_FOUND',
                'El lavador asignado no existe o está inactivo',
              );
            }
          }

          const nextEmployeeId =
            body.employeeId !== undefined ? body.employeeId : wr.employee_id;
          const nextBefore =
            body.beforePhotoUrl !== undefined
              ? body.beforePhotoUrl
              : wr.before_photo_url;
          const nextAfter =
            body.afterPhotoUrl !== undefined
              ? body.afterPhotoUrl
              : wr.after_photo_url;

          const completedAt = body.status === 'paid' ? new Date() : null;
          await tx.query(
            `UPDATE wash_requests
             SET status = $1,
                 employee_id = $2,
                 before_photo_url = $3,
                 after_photo_url = $4,
                 completed_at = COALESCE($5, completed_at),
                 updated_at = NOW()
             WHERE id = $6`,
            [body.status, nextEmployeeId, nextBefore, nextAfter, completedAt, id],
          );

          if (body.status === 'cancelled' && wr.applied_pending_balance > 0) {
            await tx.query(
              `UPDATE users
               SET pending_balance = pending_balance + $1, updated_at = NOW()
               WHERE id = $2`,
              [wr.applied_pending_balance, wr.customer_id],
            );
          }

          if (body.status === 'paid' && wr.appointment_id) {
            await tx.query(
              `UPDATE appointments SET status = 'completed', updated_at = NOW() WHERE id = $1`,
              [wr.appointment_id],
            );
          }

          await tx.query(
            `INSERT INTO wash_request_audits (
               id, wash_request_id, actor_id, actor_name, action,
               previous_content, new_content, ip_address
             )
             VALUES ($1, $2, $3, $4, 'status_changed', $5, $6, $7)`,
            [
              newUuid(),
              id,
              actor.id,
              actor.name,
              wr.status,
              body.status,
              req.clientIp ?? null,
            ],
          );

          const hydratedRow = await fetchWashRequestRow(tx, id);
          if (body.status === 'ready') {
            await notificationService.createAndNotifyUser(tx, {
              userId: wr.customer_id,
              title: '¡Tu moto está lista!',
              body: `Tu ${hydratedRow!.motorcycle_name} ya terminó el servicio ${hydratedRow!.service_name}. Puedes pasar a recogerla en el lavadero.`,
              type: 'wash_ready',
              deepLink: `/wash-requests/${id}`,
              payload: { washRequestId: id },
            });
          }

          await recordAuditLog(tx, {
            actorId: actor.id,
            actorRole: actor.role,
            action: 'wash_request_status_changed',
            entityType: 'wash_request',
            entityId: id,
            ipAddress: req.clientIp,
            changes: { from: wr.status, to: body.status },
          });

          return await hydrateWashRequest(tx, hydratedRow!);
        });

        return res.status(200).json({
          data: updated,
          message: `Estado operativo actualizado a '${body.status}'`,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/:id/complete',
    authenticate(),
    requireRoles('Administrador', 'Lavador'),
    validateParams(idParamSchema),
    validateIdempotencyHeader(false),
    validateBody(completeWashRequestSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { id } = res.locals.params as { id: string };
        const body = req.body as z.infer<typeof completeWashRequestSchema>;
        const idempotencyKey = res.locals.idempotencyKey as string | undefined;

        const out = await runIdempotent(
          db,
          {
            key: idempotencyKey,
            actorId: actor.id,
            method: 'POST',
            path: `/wash-requests/${id}/complete`,
            requestBody: body,
            successStatus: 200,
          },
          async (tx) => {
            const paymentResult = await recordManualPaymentTx(tx, {
              actor,
              washRequestId: id,
              method: body.paymentMethod,
              amount: body.amount,
              reference: body.reference,
              ipAddress: req.clientIp,
              mode: 'complete',
            });

            const hydratedRow = await fetchWashRequestRow(tx, id);
            const washRequest = await hydrateWashRequest(tx, hydratedRow!);

            return {
              data: {
                washRequest,
                payment: paymentResult.data,
                income: paymentResult.income,
              },
              message: paymentResult.message,
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
