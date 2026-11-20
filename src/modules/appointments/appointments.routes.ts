import { Router } from 'express';
import { z } from 'zod';
import type { DbClient, DbExecutor } from '../../db/index.js';
import { env } from '../../config/env.js';
import { getColombianHoliday } from '../../config/colombiaHolidays.js';
import { createAuthMiddleware } from '../../middleware/auth.js';
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
import { expireOutdatedLoyaltyRewards } from '../../services/scheduler.service.js';
import {
  assertLoyaltyEnabled,
  isLoyaltyEnabled,
} from '../settings/settings.service.js';
import { newUuid } from '../../utils/crypto.js';
import { AppError, created, ok, paginated } from '../../utils/response.js';
import {
  bogotaDateTimeToUtc,
  bogotaDayBoundsUtc,
  getBogotaDayOfWeek,
  toBogotaYmd,
  toIsoBogota,
} from '../../utils/time.js';

const availabilityQuerySchema = z.object({
  date: isoDateSchema,
  serviceId: uuidSchema,
  motorcycleId: uuidSchema.optional(),
});

const listAppointmentsQuerySchema = paginationQuerySchema.extend({
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
  status: z
    .enum(['scheduled', 'confirmed', 'completed', 'cancelled', 'waitlisted'])
    .optional(),
  customerId: uuidSchema.optional(),
});

// No existe servicio a domicilio: esquema estricto sin campos de dirección/domicilio.
const createAppointmentSchema = z
  .object({
    customerId: uuidSchema,
    motorcycleId: uuidSchema,
    serviceId: uuidSchema,
    startAt: isoDateTimeSchema,
    notes: z.string().max(1000).nullable().optional(),
    isLoyaltyRedemption: z.boolean().optional().default(false),
  })
  .strict();

const cancelAppointmentSchema = z
  .object({
    reason: z.string().max(500).nullable().optional(),
  })
  .strict()
  .optional();

const rescheduleAppointmentSchema = z
  .object({
    startAt: isoDateTimeSchema,
  })
  .strict();

const blockedDateSchema = z
  .object({
    date: isoDateSchema,
    reason: z.string().trim().min(2).max(300),
  })
  .strict();

const updateSettingsSchema = z
  .object({
    openHour: z.coerce.number().int().min(0).max(23).optional(),
    closeHour: z.coerce.number().int().min(1).max(24).optional(),
    parallelBays: z.coerce.number().int().min(1).max(50).optional(),
    slotStepMinutes: z.coerce.number().int().min(5).max(120).optional(),
    openSunday: z.boolean().optional(),
  })
  .strict();

interface ShopSettings {
  openHour: number;
  closeHour: number;
  parallelBays: number;
  slotStepMinutes: number;
  openSunday: boolean;
}

interface AppointmentJoinedRow {
  id: string;
  customer_id: string;
  motorcycle_id: string;
  service_id: string;
  start_at: Date | string;
  end_at: Date | string;
  notes: string | null;
  is_loyalty_redemption: boolean;
  status: string;
  cancellation_reason: string | null;
  cancellation_fee: number;
  customer_name: string;
  motorcycle_name: string;
  service_name: string;
}

function mapAppointment(row: AppointmentJoinedRow) {
  return {
    id: row.id,
    customerId: row.customer_id,
    motorcycleId: row.motorcycle_id,
    serviceId: row.service_id,
    startAt: toIsoBogota(row.start_at),
    endAt: toIsoBogota(row.end_at),
    notes: row.notes,
    isLoyaltyRedemption: row.is_loyalty_redemption,
    status: row.status,
    customerName: row.customer_name,
    motorcycleName: row.motorcycle_name,
    serviceName: row.service_name,
    cancellationReason: row.cancellation_reason,
    cancellationFee: Number(row.cancellation_fee),
  };
}

async function getShopSettings(db: DbExecutor): Promise<ShopSettings> {
  const res = await db.query<{
    open_hour: number;
    close_hour: number;
    parallel_bays: number;
    slot_step_minutes: number;
    open_sunday: boolean;
  }>(
    `SELECT open_hour, close_hour, parallel_bays, slot_step_minutes, open_sunday
     FROM shop_settings WHERE id = 1`,
  );
  const row = res.rows[0];
  if (!row) {
    return {
      openHour: env.SHOP_OPEN_HOUR,
      closeHour: env.SHOP_CLOSE_HOUR,
      parallelBays: env.SHOP_PARALLEL_BAYS,
      slotStepMinutes: env.SHOP_SLOT_STEP_MINUTES,
      openSunday: env.SHOP_OPEN_SUNDAY,
    };
  }
  return {
    openHour: Number(row.open_hour),
    closeHour: Number(row.close_hour),
    parallelBays: Number(row.parallel_bays),
    slotStepMinutes: Number(row.slot_step_minutes),
    openSunday: row.open_sunday,
  };
}

async function fetchAppointmentById(
  db: DbExecutor,
  id: string,
): Promise<AppointmentJoinedRow | null> {
  const res = await db.query<AppointmentJoinedRow>(
    `SELECT a.id, a.customer_id, a.motorcycle_id, a.service_id, a.start_at, a.end_at,
            a.notes, a.is_loyalty_redemption, a.status, a.cancellation_reason,
            a.cancellation_fee,
            u.name AS customer_name,
            CONCAT(m.brand, ' ', m.model, COALESCE(' (' || m.nickname || ')', '')) AS motorcycle_name,
            s.name AS service_name
     FROM appointments a
     INNER JOIN users u ON u.id = a.customer_id
     INNER JOIN motorcycles m ON m.id = a.motorcycle_id
     INNER JOIN services s ON s.id = a.service_id
     WHERE a.id = $1`,
    [id],
  );
  return res.rows[0] ?? null;
}

async function assertOperationalDayAndHours(
  db: DbExecutor,
  settings: ShopSettings,
  startAt: Date,
  endAt: Date,
): Promise<void> {
  const ymd = toBogotaYmd(startAt);
  const endYmd = toBogotaYmd(new Date(endAt.getTime() - 1));
  if (ymd !== endYmd) {
    throw new AppError(
      409,
      'OUTSIDE_BUSINESS_HOURS',
      'La cita excede el horario de atención del día en el lavadero',
    );
  }

  const dow = getBogotaDayOfWeek(ymd);
  if (dow === 0 && !settings.openSunday) {
    throw new AppError(
      409,
      'CLOSED_SUNDAY',
      'El lavadero no atiende los domingos',
    );
  }

  const holiday = getColombianHoliday(ymd);
  if (holiday) {
    throw new AppError(
      409,
      'COLOMBIAN_HOLIDAY',
      `No hay servicio por festivo en Colombia (${holiday.name})`,
    );
  }

  const blocked = await db.query<{ reason: string }>(
    `SELECT reason FROM blocked_dates WHERE blocked_date = $1::date`,
    [ymd],
  );
  if (blocked.rows[0]) {
    throw new AppError(
      409,
      'BLOCKED_DATE',
      `La fecha está bloqueada: ${blocked.rows[0].reason}`,
    );
  }

  const openUtc = bogotaDateTimeToUtc(ymd, settings.openHour, 0);
  const closeUtc = bogotaDateTimeToUtc(ymd, settings.closeHour, 0);
  if (startAt < openUtc || endAt > closeUtc) {
    throw new AppError(
      409,
      'OUTSIDE_BUSINESS_HOURS',
      `El horario de atención en el lavadero es de ${settings.openHour}:00 a ${settings.closeHour}:00 (America/Bogota)`,
    );
  }
}

export function createAppointmentsRouter(db: DbClient): Router {
  const router = Router();
  const { authenticate, requireRoles } = createAuthMiddleware(db);

  router.get(
    '/availability',
    validateQuery(availabilityQuerySchema),
    async (_req, res, next) => {
      try {
        const { date, serviceId } = res.locals.query as z.infer<
          typeof availabilityQuerySchema
        >;

        const serviceRes = await db.query<{
          id: string;
          duration_minutes: number;
          is_active: boolean;
        }>(
          `SELECT id, duration_minutes, is_active FROM services WHERE id = $1`,
          [serviceId],
        );
        const service = serviceRes.rows[0];
        if (!service || !service.is_active) {
          throw new AppError(
            404,
            'SERVICE_NOT_FOUND',
            'El servicio seleccionado no existe o está inactivo',
          );
        }

        const settings = await getShopSettings(db);
        const dow = getBogotaDayOfWeek(date);
        if (dow === 0 && !settings.openSunday) {
          return ok(
            res,
            { date, slots: [] },
            'El lavadero no atiende los domingos',
          );
        }

        const holiday = getColombianHoliday(date);
        if (holiday) {
          return ok(
            res,
            { date, slots: [] },
            `Sin disponibilidad por festivo en Colombia: ${holiday.name}`,
          );
        }

        const blocked = await db.query<{ reason: string }>(
          `SELECT reason FROM blocked_dates WHERE blocked_date = $1::date`,
          [date],
        );
        if (blocked.rows[0]) {
          return ok(
            res,
            { date, slots: [] },
            `Fecha bloqueada: ${blocked.rows[0].reason}`,
          );
        }

        const { start: dayStart, end: dayEnd } = bogotaDayBoundsUtc(date);
        const existingAppts = await db.query<{
          start_at: Date | string;
          end_at: Date | string;
        }>(
          `SELECT start_at, end_at
           FROM appointments
           WHERE status IN ('scheduled', 'confirmed', 'waitlisted')
             AND start_at < $2 AND end_at > $1`,
          [dayStart, dayEnd],
        );

        const openUtc = bogotaDateTimeToUtc(date, settings.openHour, 0);
        const closeUtc = bogotaDateTimeToUtc(date, settings.closeHour, 0);
        const durationMs = Number(service.duration_minutes) * 60 * 1000;
        const stepMs = settings.slotStepMinutes * 60 * 1000;

        const slots: Array<{
          startAt: string;
          endAt: string;
          availableCapacity: number;
        }> = [];

        for (
          let cursor = openUtc.getTime();
          cursor + durationMs <= closeUtc.getTime();
          cursor += stepMs
        ) {
          const slotStart = new Date(cursor);
          const slotEnd = new Date(cursor + durationMs);
          let occupied = 0;

          for (const appt of existingAppts.rows) {
            const aStart = new Date(appt.start_at).getTime();
            const aEnd = new Date(appt.end_at).getTime();
            if (aStart < slotEnd.getTime() && aEnd > slotStart.getTime()) {
              occupied += 1;
            }
          }

          const availableCapacity = settings.parallelBays - occupied;
          if (availableCapacity > 0) {
            slots.push({
              startAt: toIsoBogota(slotStart),
              endAt: toIsoBogota(slotEnd),
              availableCapacity,
            });
          }
        }

        return ok(
          res,
          { date, slots },
          'Disponibilidad calculada exitosamente',
        );
      } catch (err) {
        next(err);
      }
    },
  );

  // Endpoints administrativos auxiliares para configurar capacidad y fechas bloqueadas
  router.get(
    '/blocked-dates',
    authenticate(),
    requireRoles('Administrador', 'Lavador'),
    async (_req, res, next) => {
      try {
        const rows = await db.query<{
          id: string;
          blocked_date: Date | string;
          reason: string;
        }>(
          `SELECT id, blocked_date, reason FROM blocked_dates ORDER BY blocked_date ASC`,
        );
        return ok(
          res,
          rows.rows.map((r) => ({
            id: r.id,
            date:
              r.blocked_date instanceof Date
                ? r.blocked_date.toISOString().slice(0, 10)
                : String(r.blocked_date).slice(0, 10),
            reason: r.reason,
          })),
          'Fechas bloqueadas consultadas exitosamente',
        );
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/blocked-dates',
    authenticate(),
    requireRoles('Administrador'),
    validateBody(blockedDateSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { date, reason } = req.body as z.infer<typeof blockedDateSchema>;
        const id = newUuid();

        await db.withTransaction(async (tx) => {
          await tx.query(
            `INSERT INTO blocked_dates (id, blocked_date, reason, created_by)
             VALUES ($1, $2::date, $3, $4)`,
            [id, date, reason, actor.id],
          );
          await recordAuditLog(tx, {
            actorId: actor.id,
            actorRole: actor.role,
            action: 'blocked_date_created',
            entityType: 'blocked_date',
            entityId: id,
            ipAddress: req.clientIp,
            changes: { date, reason },
          });
        });

        return created(
          res,
          { id, date, reason },
          'Fecha bloqueada registrada exitosamente',
        );
      } catch (err) {
        next(err);
      }
    },
  );

  router.patch(
    '/settings',
    authenticate(),
    requireRoles('Administrador'),
    validateBody(updateSettingsSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const body = req.body as z.infer<typeof updateSettingsSchema>;
        const current = await getShopSettings(db);
        const nextSettings: ShopSettings = {
          openHour: body.openHour ?? current.openHour,
          closeHour: body.closeHour ?? current.closeHour,
          parallelBays: body.parallelBays ?? current.parallelBays,
          slotStepMinutes: body.slotStepMinutes ?? current.slotStepMinutes,
          openSunday: body.openSunday ?? current.openSunday,
        };
        if (nextSettings.closeHour <= nextSettings.openHour) {
          throw new AppError(
            422,
            'VALIDATION_ERROR',
            'La hora de cierre debe ser mayor a la hora de apertura',
          );
        }

        await db.withTransaction(async (tx) => {
          await tx.query(
            `UPDATE shop_settings
             SET open_hour = $1, close_hour = $2, parallel_bays = $3,
                 slot_step_minutes = $4, open_sunday = $5, updated_at = NOW()
             WHERE id = 1`,
            [
              nextSettings.openHour,
              nextSettings.closeHour,
              nextSettings.parallelBays,
              nextSettings.slotStepMinutes,
              nextSettings.openSunday,
            ],
          );
          await recordAuditLog(tx, {
            actorId: actor.id,
            actorRole: actor.role,
            action: 'shop_settings_updated',
            entityType: 'shop_settings',
            entityId: '1',
            ipAddress: req.clientIp,
            changes: nextSettings as unknown as Record<string, unknown>,
          });
        });

        return ok(res, nextSettings, 'Configuración de agenda actualizada');
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    '/',
    authenticate(),
    validateQuery(listAppointmentsQuerySchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { page, pageSize, from, to, status, customerId } = res.locals
          .query as z.infer<typeof listAppointmentsQuerySchema>;

        if (actor.role === 'Cliente' && customerId && customerId !== actor.id) {
          throw new AppError(
            403,
            'FORBIDDEN',
            'No puedes consultar citas de otro cliente',
          );
        }

        const effectiveCustomerId =
          actor.role === 'Cliente' ? actor.id : customerId;
        const conditions: string[] = [];
        const params: unknown[] = [];

        if (effectiveCustomerId) {
          params.push(effectiveCustomerId);
          conditions.push(`a.customer_id = $${params.length}`);
        }
        if (status) {
          params.push(status);
          conditions.push(`a.status = $${params.length}`);
        }
        if (from) {
          params.push(new Date(from));
          conditions.push(`a.start_at >= $${params.length}`);
        }
        if (to) {
          params.push(new Date(to));
          conditions.push(`a.start_at <= $${params.length}`);
        }

        const whereSql =
          conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const countRes = await db.query<{ cnt: string | number }>(
          `SELECT COUNT(*) AS cnt FROM appointments a ${whereSql}`,
          params,
        );
        const total = Number(countRes.rows[0]?.cnt ?? 0);

        const offset = (page - 1) * pageSize;
        const rowsRes = await db.query<AppointmentJoinedRow>(
          `SELECT a.id, a.customer_id, a.motorcycle_id, a.service_id, a.start_at, a.end_at,
                  a.notes, a.is_loyalty_redemption, a.status, a.cancellation_reason,
                  a.cancellation_fee,
                  u.name AS customer_name,
                  CONCAT(m.brand, ' ', m.model, COALESCE(' (' || m.nickname || ')', '')) AS motorcycle_name,
                  s.name AS service_name
           FROM appointments a
           INNER JOIN users u ON u.id = a.customer_id
           INNER JOIN motorcycles m ON m.id = a.motorcycle_id
           INNER JOIN services s ON s.id = a.service_id
           ${whereSql}
           ORDER BY a.start_at ASC
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, pageSize, offset],
        );

        return paginated(
          res,
          rowsRes.rows.map(mapAppointment),
          page,
          pageSize,
          total,
          'Citas consultadas exitosamente',
        );
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/',
    authenticate(),
    requireRoles('Cliente', 'Administrador'),
    validateBody(createAppointmentSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const body = req.body as z.infer<typeof createAppointmentSchema>;

        if (actor.role === 'Cliente' && body.customerId !== actor.id) {
          throw new AppError(
            403,
            'FORBIDDEN',
            'Solo puedes agendar citas para tu propia cuenta',
          );
        }

        if (await isLoyaltyEnabled(db)) {
          await expireOutdatedLoyaltyRewards(db);
        }

        const appointmentId = newUuid();
        const createdAppt = await db.withTransaction(async (tx) => {
          // Bloqueamos shop_settings para serializar reservas concurrentes sobre la capacidad
          await tx.query(`SELECT id FROM shop_settings WHERE id = 1 FOR UPDATE`);
          const settings = await getShopSettings(tx);

          const [custRes, motoRes, svcRes] = await Promise.all([
            tx.query<{ id: string; is_active: boolean }>(
              `SELECT id, is_active FROM users WHERE id = $1 AND role = 'Cliente'`,
              [body.customerId],
            ),
            tx.query<{ id: string; customer_id: string; is_active: boolean }>(
              `SELECT id, customer_id, is_active FROM motorcycles WHERE id = $1`,
              [body.motorcycleId],
            ),
            tx.query<{
              id: string;
              name: string;
              duration_minutes: number;
              is_active: boolean;
            }>(
              `SELECT id, name, duration_minutes, is_active FROM services WHERE id = $1`,
              [body.serviceId],
            ),
          ]);

          const cust = custRes.rows[0];
          if (!cust || !cust.is_active) {
            throw new AppError(404, 'CUSTOMER_NOT_FOUND', 'Cliente no encontrado o bloqueado');
          }

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

          const startAt = new Date(body.startAt);
          const endAt = new Date(
            startAt.getTime() + Number(svc.duration_minutes) * 60 * 1000,
          );

          await assertOperationalDayAndHours(tx, settings, startAt, endAt);

          let rewardId: string | null = null;
          if (body.isLoyaltyRedemption) {
            await assertLoyaltyEnabled(tx);
            const rewardRes = await tx.query<{ id: string }>(
              `SELECT id
               FROM loyalty_rewards
               WHERE customer_id = $1
                 AND status = 'available'
                 AND valid_from <= $2
                 AND valid_until >= $2
               ORDER BY valid_until ASC
               LIMIT 1
               FOR UPDATE`,
              [body.customerId, startAt],
            );
            if (!rewardRes.rows[0]) {
              throw new AppError(
                409,
                'REWARD_WINDOW_INVALID',
                'No tienes un premio 7+1 disponible cuya vigencia (validFrom - validUntil) cubra la fecha de la cita',
              );
            }
            rewardId = rewardRes.rows[0].id;
          }

          const overlapRes = await tx.query<{ cnt: string | number }>(
            `SELECT COUNT(*) AS cnt
             FROM appointments
             WHERE status IN ('scheduled', 'confirmed', 'waitlisted')
               AND start_at < $2 AND end_at > $1`,
            [startAt, endAt],
          );
          const occupied = Number(overlapRes.rows[0]?.cnt ?? 0);
          if (occupied >= settings.parallelBays) {
            throw new AppError(
              409,
              'SLOT_UNAVAILABLE',
              'No hay cupos disponibles en el horario seleccionado',
            );
          }

          await tx.query(
            `INSERT INTO appointments (
               id, customer_id, motorcycle_id, service_id, start_at, end_at,
               notes, is_loyalty_redemption, loyalty_reward_id, status
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'scheduled')`,
            [
              appointmentId,
              body.customerId,
              body.motorcycleId,
              body.serviceId,
              startAt,
              endAt,
              body.notes ?? null,
              body.isLoyaltyRedemption ?? false,
              rewardId,
            ],
          );

          await notificationService.createAndNotifyUser(tx, {
            userId: body.customerId,
            title: 'Cita agendada en Los Malditos',
            body: `Tu cita para ${svc.name} quedó programada para ${toIsoBogota(startAt)}.`,
            type: 'appointment_reminder',
            deepLink: `/appointments/${appointmentId}`,
            payload: { appointmentId, startAt: toIsoBogota(startAt) },
          });

          await recordAuditLog(tx, {
            actorId: actor.id,
            actorRole: actor.role,
            action: 'appointment_created',
            entityType: 'appointment',
            entityId: appointmentId,
            ipAddress: req.clientIp,
            changes: {
              customerId: body.customerId,
              startAt: toIsoBogota(startAt),
              isLoyaltyRedemption: body.isLoyaltyRedemption,
            },
          });

          const row = await fetchAppointmentById(tx, appointmentId);
          return row!;
        });

        return created(
          res,
          mapAppointment(createdAppt),
          'Cita agendada exitosamente en el lavadero',
        );
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/:id/cancel',
    authenticate(),
    requireRoles('Cliente', 'Administrador'),
    validateParams(idParamSchema),
    validateBody(cancelAppointmentSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { id } = res.locals.params as { id: string };
        const body = (req.body ?? {}) as { reason?: string | null };

        const result = await db.withTransaction(async (tx) => {
          const apptRes = await tx.query<{
            id: string;
            customer_id: string;
            start_at: Date | string;
            status: string;
          }>(
            `SELECT id, customer_id, start_at, status
             FROM appointments WHERE id = $1 FOR UPDATE`,
            [id],
          );
          const appt = apptRes.rows[0];
          if (!appt) {
            throw new AppError(404, 'APPOINTMENT_NOT_FOUND', 'Cita no encontrada');
          }

          if (actor.role === 'Cliente' && appt.customer_id !== actor.id) {
            throw new AppError(
              403,
              'FORBIDDEN',
              'No puedes cancelar citas de otro cliente',
            );
          }

          if (appt.status === 'cancelled' || appt.status === 'completed') {
            throw new AppError(
              409,
              'INVALID_APPOINTMENT_STATE',
              'La cita ya fue completada o cancelada previamente',
            );
          }

          const now = new Date();
          const startAt = new Date(appt.start_at);
          const hoursRemaining =
            (startAt.getTime() - now.getTime()) / (1000 * 60 * 60);

          const applyPenalty = hoursRemaining < env.CANCELLATION_MIN_HOURS;
          const cancellationFee = applyPenalty ? env.CANCELLATION_PENALTY_COP : 0;

          await tx.query(
            `UPDATE appointments
             SET status = 'cancelled',
                 cancellation_reason = $1,
                 cancellation_fee = $2,
                 cancelled_at = NOW(),
                 updated_at = NOW()
             WHERE id = $3`,
            [body.reason ?? null, cancellationFee, id],
          );

          if (cancellationFee > 0) {
            await tx.query(
              `UPDATE users
               SET pending_balance = pending_balance + $1, updated_at = NOW()
               WHERE id = $2`,
              [cancellationFee, appt.customer_id],
            );

            await tx.query(
              `INSERT INTO incomes (id, source, appointment_id, customer_id, amount, status, notes, occurred_at)
               VALUES ($1, 'cancellation_fee', $2, $3, $4, 'pending', $5, NOW())`,
              [
                newUuid(),
                id,
                appt.customer_id,
                cancellationFee,
                'Cargo por cancelación con menos de 3 horas de anticipación',
              ],
            );

            await notificationService.createAndNotifyUser(tx, {
              userId: appt.customer_id,
              title: 'Cargo pendiente por cancelación tardía',
              body: `Cancelaste con menos de 3 horas de anticipación. Se generó un cargo de COP ${cancellationFee.toLocaleString('es-CO')} como saldo pendiente (pendingBalance) que se descontará en tu próxima lavada.`,
              type: 'pending_charge',
              deepLink: `/appointments/${id}`,
              payload: { appointmentId: id, cancellationFee },
            });
          }

          await recordAuditLog(tx, {
            actorId: actor.id,
            actorRole: actor.role,
            action: 'appointment_cancelled',
            entityType: 'appointment',
            entityId: id,
            ipAddress: req.clientIp,
            changes: {
              reason: body.reason ?? null,
              cancellationFee,
              hoursRemaining: Number(hoursRemaining.toFixed(2)),
            },
          });

          const hydrated = await fetchAppointmentById(tx, id);
          return {
            appointment: mapAppointment(hydrated!),
            cancellationFee,
          };
        });

        const message =
          result.cancellationFee > 0
            ? `Cita cancelada con menos de 3 horas de anticipación. Se registró un cargo de COP ${result.cancellationFee} como pendingBalance e ingreso pendiente, el cual se descontará de la próxima lavada.`
            : 'Cita cancelada exitosamente sin cargo adicional';

        return ok(res, result.appointment, message);
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/:id/reschedule',
    authenticate(),
    requireRoles('Cliente', 'Administrador'),
    validateParams(idParamSchema),
    validateBody(rescheduleAppointmentSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { id } = res.locals.params as { id: string };
        const { startAt: startAtIso } = req.body as z.infer<
          typeof rescheduleAppointmentSchema
        >;

        if (await isLoyaltyEnabled(db)) {
          await expireOutdatedLoyaltyRewards(db);
        }

        const updated = await db.withTransaction(async (tx) => {
          await tx.query(`SELECT id FROM shop_settings WHERE id = 1 FOR UPDATE`);
          const settings = await getShopSettings(tx);

          const apptRes = await tx.query<{
            id: string;
            customer_id: string;
            service_id: string;
            status: string;
            is_loyalty_redemption: boolean;
          }>(
            `SELECT id, customer_id, service_id, status, is_loyalty_redemption
             FROM appointments WHERE id = $1 FOR UPDATE`,
            [id],
          );
          const appt = apptRes.rows[0];
          if (!appt) {
            throw new AppError(404, 'APPOINTMENT_NOT_FOUND', 'Cita no encontrada');
          }
          if (actor.role === 'Cliente' && appt.customer_id !== actor.id) {
            throw new AppError(
              403,
              'FORBIDDEN',
              'No puedes reprogramar citas de otro cliente',
            );
          }
          if (appt.status === 'cancelled' || appt.status === 'completed') {
            throw new AppError(
              409,
              'INVALID_APPOINTMENT_STATE',
              'No se puede reprogramar una cita completada o cancelada',
            );
          }

          const svcRes = await tx.query<{ duration_minutes: number }>(
            `SELECT duration_minutes FROM services WHERE id = $1`,
            [appt.service_id],
          );
          const durationMinutes = Number(svcRes.rows[0]!.duration_minutes);
          const newStart = new Date(startAtIso);
          const newEnd = new Date(newStart.getTime() + durationMinutes * 60 * 1000);

          await assertOperationalDayAndHours(tx, settings, newStart, newEnd);

          if (appt.is_loyalty_redemption) {
            const rewardRes = await tx.query<{ id: string }>(
              `SELECT id
               FROM loyalty_rewards
               WHERE customer_id = $1
                 AND status = 'available'
                 AND valid_from <= $2
                 AND valid_until >= $2
               LIMIT 1`,
              [appt.customer_id, newStart],
            );
            if (!rewardRes.rows[0]) {
              throw new AppError(
                409,
                'REWARD_WINDOW_INVALID',
                'La nueva fecha está fuera de la vigencia (validFrom - validUntil) del premio 7+1',
              );
            }
          }

          const overlapRes = await tx.query<{ cnt: string | number }>(
            `SELECT COUNT(*) AS cnt
             FROM appointments
             WHERE id <> $1
               AND status IN ('scheduled', 'confirmed', 'waitlisted')
               AND start_at < $3 AND end_at > $2`,
            [id, newStart, newEnd],
          );
          if (Number(overlapRes.rows[0]?.cnt ?? 0) >= settings.parallelBays) {
            throw new AppError(
              409,
              'SLOT_UNAVAILABLE',
              'No hay capacidad disponible en el nuevo horario seleccionado',
            );
          }

          await tx.query(
            `UPDATE appointments
             SET start_at = $1, end_at = $2, updated_at = NOW()
             WHERE id = $3`,
            [newStart, newEnd, id],
          );

          await recordAuditLog(tx, {
            actorId: actor.id,
            actorRole: actor.role,
            action: 'appointment_rescheduled',
            entityType: 'appointment',
            entityId: id,
            ipAddress: req.clientIp,
            changes: { startAt: toIsoBogota(newStart) },
          });

          const row = await fetchAppointmentById(tx, id);
          return mapAppointment(row!);
        });

        return ok(res, updated, 'Cita reprogramada exitosamente');
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
