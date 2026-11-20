import { Router } from 'express';
import { z } from 'zod';
import type { DbClient } from '../../db/index.js';
import { createAuthMiddleware } from '../../middleware/auth.js';
import {
  runIdempotent,
  validateIdempotencyHeader,
} from '../../middleware/idempotency.js';
import {
  isoDateSchema,
  isoDateTimeSchema,
  paginationQuerySchema,
  uuidSchema,
  validateBody,
  validateQuery,
} from '../../middleware/validate.js';
import { recordAuditLog } from '../../services/audit.service.js';
import { newUuid } from '../../utils/crypto.js';
import { created, paginated } from '../../utils/response.js';
import { toIsoBogota } from '../../utils/time.js';
import {
  listManualPayments,
  paymentMethodSchema,
  recordManualPaymentTx,
} from './payments.service.js';

const paymentInputSchema = z
  .object({
    washRequestId: uuidSchema,
    method: paymentMethodSchema,
    amount: z
      .number({ message: 'El monto en COP debe ser un número entero mayor que cero' })
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

const dateOrDateTimeFilterSchema = z.union([isoDateSchema, isoDateTimeSchema]);

const listPaymentsQuerySchema = paginationQuerySchema.extend({
  date: isoDateSchema.optional(),
  from: dateOrDateTimeFilterSchema.optional(),
  to: dateOrDateTimeFilterSchema.optional(),
  method: paymentMethodSchema.optional(),
  recordedBy: uuidSchema.optional(),
  userId: uuidSchema.optional(),
  customerId: uuidSchema.optional(),
  washRequestId: uuidSchema.optional(),
});

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

  router.get(
    '/',
    authenticate(),
    validateQuery(listPaymentsQuerySchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const query = res.locals.query as z.infer<typeof listPaymentsQuerySchema>;

        const { items, total } = await listManualPayments(db, actor, query);

        return paginated(
          res,
          items,
          query.page,
          query.pageSize,
          total,
          'Pagos consultados exitosamente',
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
    validateIdempotencyHeader(false),
    validateBody(paymentInputSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const body = req.body as z.infer<typeof paymentInputSchema>;
        const idempotencyKey = res.locals.idempotencyKey as string | undefined;

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
            const result = await recordManualPaymentTx(tx, {
              actor,
              washRequestId: body.washRequestId,
              method: body.method,
              amount: body.amount,
              reference: body.reference,
              ipAddress: req.clientIp,
              mode: 'payment',
            });
            return { data: result.data, message: result.message };
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
          payment_id: string | null;
          customer_id: string | null;
          amount: number;
          status: string;
          notes: string | null;
          recorded_by: string | null;
          occurred_at: Date | string;
        }>(
          `SELECT id, source, wash_request_id, payment_id, customer_id, amount, status, notes, recorded_by, occurred_at
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
            paymentId: r.payment_id,
            customerId: r.customer_id,
            amount: Number(r.amount),
            status: r.status,
            notes: r.notes,
            recordedBy: r.recorded_by,
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
