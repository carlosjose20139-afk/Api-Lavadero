import { Router } from 'express';
import { z } from 'zod';
import type { DbClient } from '../../db/index.js';
import { createAuthMiddleware } from '../../middleware/auth.js';
import {
  runIdempotent,
  validateIdempotencyHeader,
} from '../../middleware/idempotency.js';
import {
  isoDateTimeSchema,
  paginationQuerySchema,
  uuidSchema,
  validateBody,
  validateQuery,
} from '../../middleware/validate.js';
import { recordAuditLog } from '../../services/audit.service.js';
import { newUuid } from '../../utils/crypto.js';
import { AppError, created, paginated } from '../../utils/response.js';
import { toIsoBogota } from '../../utils/time.js';

// Solo métodos manuales: Efectivo, Nequi, Daviplata. Sin pasarelas ni tarjetas.
const paymentInputSchema = z
  .object({
    washRequestId: uuidSchema,
    method: z.enum(['Efectivo', 'Nequi', 'Daviplata']),
    amount: z.coerce.number().int().min(0, 'El monto en COP debe ser >= 0'),
    reference: z.string().trim().max(120).nullable().optional(),
  })
  .strict();

const expenseInputSchema = z
  .object({
    category: z.enum([
      'Agua',
      'Jabon',
      'Luz',
      'Nomina',
      'Guantes',
      'Paños',
      'Otro',
    ]),
    description: z.string().trim().min(2).max(500),
    amount: z.coerce.number().int().min(0),
    occurredAt: isoDateTimeSchema,
    isRecurring: z.boolean().optional().default(false),
  })
  .strict();

export function createPaymentsRouter(db: DbClient): Router {
  const router = Router();
  const { authenticate, requireRoles } = createAuthMiddleware(db);

  router.post(
    '/',
    authenticate(),
    requireRoles('Administrador', 'Lavador'),
    validateIdempotencyHeader(true),
    validateBody(paymentInputSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const body = req.body as z.infer<typeof paymentInputSchema>;
        const idempotencyKey = res.locals.idempotencyKey as string;

        const out = await runIdempotent(
          db,
          {
            key: idempotencyKey,
            actorId: actor.id,
            method: 'POST',
            path: '/payments',
            requestBody: body,
            successStatus: 201,
          },
          async (tx) => {
            const wrRes = await tx.query<{
              id: string;
              customer_id: string;
              appointment_id: string | null;
              employee_id: string | null;
              price: number;
              applied_pending_balance: number;
              status: string;
            }>(
              `SELECT id, customer_id, appointment_id, employee_id, price,
                      applied_pending_balance, status
               FROM wash_requests WHERE id = $1 FOR UPDATE`,
              [body.washRequestId],
            );
            const wr = wrRes.rows[0];
            if (!wr) {
              throw new AppError(
                404,
                'WASH_REQUEST_NOT_FOUND',
                'Solicitud de lavada no encontrada',
              );
            }

            const payableStates = ['confirmed', 'washing', 'drying', 'ready'];
            if (!payableStates.includes(wr.status)) {
              throw new AppError(
                409,
                'WASH_NOT_PAYABLE',
                `La lavada en estado '${wr.status}' no admite registro de pago`,
              );
            }

            if (body.amount !== Number(wr.price)) {
              throw new AppError(
                422,
                'PAYMENT_AMOUNT_MISMATCH',
                `El monto en COP (${body.amount}) debe coincidir con el saldo de la lavada (COP ${wr.price})`,
                { amount: `Debe ser exactamente ${wr.price}` },
              );
            }

            let commission = 0;
            if (wr.employee_id) {
              const empRes = await tx.query<{ commission_percent: string | number }>(
                `SELECT commission_percent FROM employees WHERE id = $1`,
                [wr.employee_id],
              );
              if (empRes.rows[0]) {
                const pct = Number(empRes.rows[0].commission_percent);
                commission = Math.round((body.amount * pct) / 100);
              }
            }

            const paymentId = newUuid();
            const payIns = await tx.query<{
              id: string;
              wash_request_id: string;
              method: string;
              amount: number;
              reference: string | null;
              employee_commission: number;
              paid_at: Date | string;
            }>(
              `INSERT INTO payments (
                 id, wash_request_id, method, amount, reference, employee_commission, recorded_by
               )
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               RETURNING id, wash_request_id, method, amount, reference, employee_commission, paid_at`,
              [
                paymentId,
                body.washRequestId,
                body.method,
                body.amount,
                body.reference ?? null,
                commission,
                actor.id,
              ],
            );

            await tx.query(
              `UPDATE wash_requests
               SET status = 'paid', completed_at = NOW(), updated_at = NOW()
               WHERE id = $1`,
              [body.washRequestId],
            );

            if (wr.appointment_id) {
              await tx.query(
                `UPDATE appointments SET status = 'completed', updated_at = NOW() WHERE id = $1`,
                [wr.appointment_id],
              );
            }

            await tx.query(
              `INSERT INTO incomes (id, source, wash_request_id, customer_id, amount, status, notes, occurred_at)
               VALUES ($1, 'wash', $2, $3, $4, 'confirmed', $5, NOW())`,
              [
                newUuid(),
                body.washRequestId,
                wr.customer_id,
                body.amount,
                `Pago manual por ${body.method}`,
              ],
            );

            if (Number(wr.applied_pending_balance) > 0) {
              await tx.query(
                `UPDATE incomes
                 SET status = 'settled'
                 WHERE customer_id = $1 AND source = 'cancellation_fee' AND status = 'pending'`,
                [wr.customer_id],
              );
            }

            await tx.query(
              `INSERT INTO wash_request_audits (
                 id, wash_request_id, actor_id, actor_name, action,
                 previous_content, new_content, ip_address
               )
               VALUES ($1, $2, $3, $4, 'paid', $5, $6, $7)`,
              [
                newUuid(),
                body.washRequestId,
                actor.id,
                actor.name,
                wr.status,
                `paid (${body.method} COP ${body.amount})`,
                req.clientIp ?? null,
              ],
            );

            await recordAuditLog(tx, {
              actorId: actor.id,
              actorRole: actor.role,
              action: 'manual_payment_recorded',
              entityType: 'payment',
              entityId: paymentId,
              ipAddress: req.clientIp,
              changes: {
                washRequestId: body.washRequestId,
                method: body.method,
                amount: body.amount,
              },
            });

            const p = payIns.rows[0]!;
            return {
              data: {
                id: p.id,
                washRequestId: p.wash_request_id,
                method: p.method,
                amount: Number(p.amount),
                reference: p.reference,
                paidAt: toIsoBogota(p.paid_at),
                employeeCommission: Number(p.employee_commission),
              },
              message: `Pago manual (${body.method}) registrado exitosamente`,
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

export function createExpensesRouter(db: DbClient): Router {
  const router = Router();
  const { authenticate, requireRoles } = createAuthMiddleware(db);

  router.get(
    '/',
    authenticate(),
    requireRoles('Administrador'),
    validateQuery(paginationQuerySchema),
    async (_req, res, next) => {
      try {
        const { page, pageSize } = res.locals.query as z.infer<
          typeof paginationQuerySchema
        >;
        const countRes = await db.query<{ cnt: string | number }>(
          `SELECT COUNT(*) AS cnt FROM expenses`,
        );
        const total = Number(countRes.rows[0]?.cnt ?? 0);
        const offset = (page - 1) * pageSize;

        const rowsRes = await db.query<{
          id: string;
          category: string;
          description: string;
          amount: number;
          occurred_at: Date | string;
          is_recurring: boolean;
        }>(
          `SELECT id, category, description, amount, occurred_at, is_recurring
           FROM expenses
           ORDER BY occurred_at DESC
           LIMIT $1 OFFSET $2`,
          [pageSize, offset],
        );

        return paginated(
          res,
          rowsRes.rows.map((r) => ({
            id: r.id,
            category: r.category,
            description: r.description,
            amount: Number(r.amount),
            occurredAt: toIsoBogota(r.occurred_at),
            isRecurring: r.is_recurring,
          })),
          page,
          pageSize,
          total,
          'Gastos consultados exitosamente',
        );
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/',
    authenticate(),
    requireRoles('Administrador'),
    validateBody(expenseInputSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const body = req.body as z.infer<typeof expenseInputSchema>;
        const id = newUuid();

        const inserted = await db.withTransaction(async (tx) => {
          const ins = await tx.query<{
            id: string;
            category: string;
            description: string;
            amount: number;
            occurred_at: Date | string;
            is_recurring: boolean;
          }>(
            `INSERT INTO expenses (id, category, description, amount, occurred_at, is_recurring, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id, category, description, amount, occurred_at, is_recurring`,
            [
              id,
              body.category,
              body.description,
              body.amount,
              new Date(body.occurredAt),
              body.isRecurring ?? false,
              actor.id,
            ],
          );

          await recordAuditLog(tx, {
            actorId: actor.id,
            actorRole: actor.role,
            action: 'expense_created',
            entityType: 'expense',
            entityId: id,
            ipAddress: req.clientIp,
            changes: body,
          });

          return ins.rows[0]!;
        });

        return created(
          res,
          {
            id: inserted.id,
            category: inserted.category,
            description: inserted.description,
            amount: Number(inserted.amount),
            occurredAt: toIsoBogota(inserted.occurred_at),
            isRecurring: inserted.is_recurring,
          },
          'Gasto registrado exitosamente',
        );
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

export function createIncomesRouter(db: DbClient): Router {
  const router = Router();
  const { authenticate, requireRoles } = createAuthMiddleware(db);

  router.get(
    '/',
    authenticate(),
    requireRoles('Administrador'),
    validateQuery(paginationQuerySchema),
    async (_req, res, next) => {
      try {
        const { page, pageSize } = res.locals.query as z.infer<
          typeof paginationQuerySchema
        >;
        const countRes = await db.query<{ cnt: string | number }>(
          `SELECT COUNT(*) AS cnt FROM incomes`,
        );
        const total = Number(countRes.rows[0]?.cnt ?? 0);
        const offset = (page - 1) * pageSize;

        const rowsRes = await db.query<{
          id: string;
          source: string;
          wash_request_id: string | null;
          customer_id: string | null;
          amount: number;
          occurred_at: Date | string;
        }>(
          `SELECT id, source, wash_request_id, customer_id, amount, occurred_at
           FROM incomes
           ORDER BY occurred_at DESC
           LIMIT $1 OFFSET $2`,
          [pageSize, offset],
        );

        return paginated(
          res,
          rowsRes.rows.map((r) => ({
            id: r.id,
            source: r.source,
            washRequestId: r.wash_request_id,
            customerId: r.customer_id,
            amount: Number(r.amount),
            occurredAt: toIsoBogota(r.occurred_at),
          })),
          page,
          pageSize,
          total,
          'Ingresos consultados exitosamente',
        );
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
