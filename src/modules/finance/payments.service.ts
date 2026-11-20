import { z } from 'zod';
import type { DbClient, DbExecutor } from '../../db/index.js';
import type { AuthUser } from '../../middleware/auth.js';
import { recordAuditLog } from '../../services/audit.service.js';
import { newUuid } from '../../utils/crypto.js';
import { AppError } from '../../utils/response.js';
import { bogotaDayBoundsUtc, toIsoBogota } from '../../utils/time.js';

export const MANUAL_PAYMENT_METHODS = [
  'Efectivo',
  'Nequi',
  'Daviplata',
  'Bre-B',
] as const;

export type ManualPaymentMethod = (typeof MANUAL_PAYMENT_METHODS)[number];

// Solo métodos manuales: Efectivo, Nequi, Daviplata y Bre-B. Sin pasarelas ni tarjetas.
export const paymentMethodSchema = z.enum(MANUAL_PAYMENT_METHODS, {
  message:
    'Método de pago inválido. Métodos permitidos: Efectivo, Nequi, Daviplata o Bre-B',
});

export interface PaymentDto {
  id: string;
  washRequestId: string;
  customerId: string;
  customerName: string;
  method: ManualPaymentMethod;
  amount: number;
  reference: string | null;
  paidAt: string;
  employeeCommission: number;
  recordedBy: string | null;
  recordedByName: string | null;
  washStatus: string;
}

export interface IncomeDto {
  id: string;
  source: string;
  washRequestId: string | null;
  paymentId: string | null;
  customerId: string | null;
  amount: number;
  status: string;
  notes: string | null;
  recordedBy: string | null;
  occurredAt: string;
}

interface PaymentJoinedRow {
  id: string;
  wash_request_id: string;
  customer_id: string;
  customer_name: string;
  method: ManualPaymentMethod;
  amount: number;
  reference: string | null;
  employee_commission: number;
  recorded_by: string | null;
  recorded_by_name: string | null;
  paid_at: Date | string;
  wash_status: string;
}

const UNSAFE_HTML_PATTERN =
  /<\s*\/?\s*[a-zA-Z!][^>]*>|<!--[\s\S]*?-->|\b(?:javascript|vbscript)\s*:|\bdata\s*:\s*text\/html|\bon[a-z]+\s*=/i;

export function sanitizePaymentReference(
  raw: string | null | undefined,
): string | null {
  if (raw === null || raw === undefined) return null;
  const cleaned = raw
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
  if (cleaned.length === 0) return null;

  if (cleaned.length > 120) {
    throw new AppError(
      422,
      'VALIDATION_ERROR',
      'La referencia del pago no puede superar 120 caracteres',
      { reference: 'Máximo 120 caracteres' },
    );
  }

  if (UNSAFE_HTML_PATTERN.test(cleaned)) {
    throw new AppError(
      422,
      'VALIDATION_ERROR',
      'La referencia del pago contiene etiquetas o scripts no permitidos',
      { reference: 'No se permite HTML ni scripts' },
    );
  }

  return cleaned;
}

function mapPaymentRow(row: PaymentJoinedRow): PaymentDto {
  return {
    id: row.id,
    washRequestId: row.wash_request_id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    method: row.method,
    amount: Number(row.amount),
    reference: row.reference,
    paidAt: toIsoBogota(row.paid_at),
    employeeCommission: Number(row.employee_commission),
    recordedBy: row.recorded_by,
    recordedByName: row.recorded_by_name,
    washStatus: row.wash_status,
  };
}

export async function recordManualPaymentTx(
  tx: DbExecutor,
  params: {
    actor: AuthUser;
    washRequestId: string;
    method: ManualPaymentMethod;
    amount: number;
    reference?: string | null;
    ipAddress?: string;
    mode?: 'payment' | 'complete';
  },
): Promise<{ data: PaymentDto; income: IncomeDto; message: string }> {
  const { actor, washRequestId, method, amount, ipAddress } = params;
  const mode = params.mode ?? 'payment';
  const cleanReference = sanitizePaymentReference(params.reference);

  // Bloqueo pesimista sobre la lavada para evitar doble confirmación o pagos duplicados concurrentes
  const wrRes = await tx.query<{
    id: string;
    customer_id: string;
    customer_name: string;
    appointment_id: string | null;
    employee_id: string | null;
    base_price: number;
    applied_pending_balance: number;
    price: number;
    status: string;
  }>(
    `SELECT wr.id, wr.customer_id, u.name AS customer_name, wr.appointment_id,
            wr.employee_id, wr.base_price, wr.applied_pending_balance, wr.price, wr.status
     FROM wash_requests wr
     INNER JOIN users u ON u.id = wr.customer_id
     WHERE wr.id = $1
     FOR UPDATE OF wr`,
    [washRequestId],
  );
  const wr = wrRes.rows[0];
  if (!wr) {
    throw new AppError(
      404,
      'WASH_REQUEST_NOT_FOUND',
      'Solicitud de lavada no encontrada',
    );
  }

  // Verificar explícitamente si ya existe pago registrado o si la lavada ya está pagada
  const existingPayRes = await tx.query<{ id: string }>(
    `SELECT id FROM payments WHERE wash_request_id = $1 FOR UPDATE`,
    [washRequestId],
  );
  if (existingPayRes.rows[0] || wr.status === 'paid') {
    throw new AppError(
      409,
      mode === 'complete' ? 'WASH_ALREADY_PAID' : 'PAYMENT_ALREADY_EXISTS',
      mode === 'complete'
        ? 'La lavada ya fue completada y pagada previamente'
        : 'Ya existe un pago registrado para esta lavada',
    );
  }

  // Estados operativos válidos para completar/pagar (se rechazan pending_confirmation, cancelled, rejected y expired)
  const payableStates = ['confirmed', 'washing', 'drying', 'ready'];
  if (!payableStates.includes(wr.status)) {
    throw new AppError(
      409,
      mode === 'complete' ? 'WASH_NOT_COMPLETABLE' : 'WASH_NOT_PAYABLE',
      mode === 'complete'
        ? `La lavada en estado '${wr.status}' no puede completarse ni pagarse`
        : `La lavada en estado '${wr.status}' no admite registro de pago`,
    );
  }

  const expectedFinalAmount = Number(wr.price);
  if (amount !== expectedFinalAmount) {
    const appliedBalance = Number(wr.applied_pending_balance);
    const detailMsg =
      appliedBalance > 0
        ? `El monto en COP (${amount}) debe coincidir con el valor final calculado de la lavada (COP ${expectedFinalAmount}, tarifa base COP ${wr.base_price} con ajuste por saldo/penalización de COP ${appliedBalance})`
        : `El monto en COP (${amount}) debe coincidir con el valor final de la lavada (COP ${expectedFinalAmount})`;
    throw new AppError(422, 'PAYMENT_AMOUNT_MISMATCH', detailMsg, {
      amount: `Debe ser exactamente ${expectedFinalAmount}`,
    });
  }

  let commission = 0;
  if (wr.employee_id) {
    const empRes = await tx.query<{ commission_percent: string | number }>(
      `SELECT commission_percent FROM employees WHERE id = $1`,
      [wr.employee_id],
    );
    if (empRes.rows[0]) {
      const pct = Number(empRes.rows[0].commission_percent);
      commission = Math.round((amount * pct) / 100);
    }
  }

  const paymentId = newUuid();
  const payIns = await tx.query<{
    id: string;
    wash_request_id: string;
    customer_id: string | null;
    method: ManualPaymentMethod;
    amount: number;
    reference: string | null;
    employee_commission: number;
    recorded_by: string | null;
    paid_at: Date | string;
  }>(
    `INSERT INTO payments (
       id, wash_request_id, customer_id, method, amount, reference, employee_commission, recorded_by
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, wash_request_id, customer_id, method, amount, reference, employee_commission, recorded_by, paid_at`,
    [
      paymentId,
      washRequestId,
      wr.customer_id,
      method,
      amount,
      cleanReference,
      commission,
      actor.id,
    ],
  );

  await tx.query(
    `UPDATE wash_requests
     SET status = 'paid', completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
     WHERE id = $1`,
    [washRequestId],
  );

  if (wr.appointment_id) {
    await tx.query(
      `UPDATE appointments SET status = 'completed', updated_at = NOW() WHERE id = $1`,
      [wr.appointment_id],
    );
  }

  const incomeId = newUuid();
  const incomeNotes = `Pago manual por ${method}`;

  const incIns = await tx.query<{
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
    `INSERT INTO incomes (
       id, source, wash_request_id, payment_id, customer_id, amount, status, notes, recorded_by, occurred_at
     )
     VALUES ($1, 'wash', $2, $3, $4, $5, 'confirmed', $6, $7, NOW())
     RETURNING id, source, wash_request_id, payment_id, customer_id, amount, status, notes, recorded_by, occurred_at`,
    [
      incomeId,
      washRequestId,
      paymentId,
      wr.customer_id,
      amount,
      incomeNotes,
      actor.id,
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
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      newUuid(),
      washRequestId,
      actor.id,
      actor.name,
      mode === 'complete' ? 'completed_and_paid' : 'paid',
      wr.status,
      `paid (${method} COP ${amount})`,
      ipAddress ?? null,
    ],
  );

  const p = payIns.rows[0]!;
  const inc = incIns.rows[0]!;
  const paidAtIso = toIsoBogota(p.paid_at);

  await recordAuditLog(tx, {
    actorId: actor.id,
    actorRole: actor.role,
    action:
      mode === 'complete'
        ? 'wash_request_completed_and_paid'
        : 'manual_payment_recorded',
    entityType: mode === 'complete' ? 'wash_request' : 'payment',
    entityId: mode === 'complete' ? washRequestId : paymentId,
    ipAddress,
    changes: {
      washRequestId,
      paymentId,
      incomeId,
      customerId: wr.customer_id,
      actorId: actor.id,
      actorRole: actor.role,
      recordedBy: actor.id,
      paidAt: paidAtIso,
      method,
      amount,
      basePrice: Number(wr.base_price),
      appliedPendingBalance: Number(wr.applied_pending_balance),
      reference: cleanReference,
      previousWashStatus: wr.status,
      newWashStatus: 'paid',
    },
  });

  const dto: PaymentDto = {
    id: p.id,
    washRequestId: p.wash_request_id,
    customerId: wr.customer_id,
    customerName: wr.customer_name,
    method: p.method,
    amount: Number(p.amount),
    reference: p.reference,
    paidAt: paidAtIso,
    employeeCommission: Number(p.employee_commission),
    recordedBy: p.recorded_by,
    recordedByName: actor.name,
    washStatus: 'paid',
  };

  const incomeDto: IncomeDto = {
    id: inc.id,
    source: inc.source,
    washRequestId: inc.wash_request_id,
    paymentId: inc.payment_id,
    customerId: inc.customer_id,
    amount: Number(inc.amount),
    status: inc.status,
    notes: inc.notes,
    recordedBy: inc.recorded_by,
    occurredAt: toIsoBogota(inc.occurred_at),
  };

  return {
    data: dto,
    income: incomeDto,
    message:
      mode === 'complete'
        ? `Lavada completada y pago manual (${method}) registrado exitosamente`
        : `Pago manual (${method}) registrado exitosamente`,
  };
}

export interface ListPaymentsQuery {
  page: number;
  pageSize: number;
  date?: string;
  from?: string;
  to?: string;
  method?: ManualPaymentMethod;
  recordedBy?: string;
  userId?: string;
  customerId?: string;
  washRequestId?: string;
}

function parseFilterBoundaryDate(
  raw: string,
  fieldName: 'from' | 'to',
  endOfDayIfDateOnly: boolean,
): Date {
  const value = raw.trim();
  let normalized = value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    normalized = endOfDayIfDateOnly
      ? `${value}T23:59:59.999-05:00`
      : `${value}T00:00:00.000-05:00`;
  }
  const ms = Date.parse(normalized);
  if (Number.isNaN(ms)) {
    throw new AppError(
      422,
      'VALIDATION_ERROR',
      `El parámetro ${fieldName} no tiene un formato de fecha válido`,
      { [fieldName]: 'Formato ISO-8601 inválido (YYYY-MM-DD o fecha-hora con zona horaria)' },
    );
  }
  return new Date(ms);
}

export async function listManualPayments(
  db: DbClient,
  actor: AuthUser,
  query: ListPaymentsQuery,
): Promise<{ items: PaymentDto[]; total: number }> {
  if (query.recordedBy && query.userId && query.recordedBy !== query.userId) {
    throw new AppError(
      422,
      'VALIDATION_ERROR',
      'Los parámetros recordedBy y userId no pueden tener valores distintos',
      { userId: 'Conflictivo con recordedBy' },
    );
  }

  const effectiveRecorderId = query.recordedBy ?? query.userId;

  // Reglas de control de acceso por rol
  if (actor.role === 'Cliente') {
    if (query.customerId && query.customerId !== actor.id) {
      throw new AppError(
        403,
        'FORBIDDEN',
        'No puedes consultar los pagos de otro cliente',
      );
    }
    if (effectiveRecorderId) {
      throw new AppError(
        403,
        'FORBIDDEN',
        'No tienes permisos para filtrar pagos por usuario operador',
      );
    }
  } else if (actor.role === 'Lavador') {
    if (effectiveRecorderId && effectiveRecorderId !== actor.id) {
      throw new AppError(
        403,
        'FORBIDDEN',
        'Un lavador solo puede consultar los pagos registrados por él o asociados a sus lavadas',
      );
    }
  }

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (actor.role === 'Cliente') {
    params.push(actor.id);
    conditions.push(`wr.customer_id = $${params.length}`);
  } else if (actor.role === 'Lavador') {
    params.push(actor.id);
    conditions.push(
      `(p.recorded_by = $${params.length} OR e.user_id = $${params.length})`,
    );
  }

  if (query.customerId && actor.role !== 'Cliente') {
    params.push(query.customerId);
    conditions.push(`wr.customer_id = $${params.length}`);
  }

  if (effectiveRecorderId && actor.role === 'Administrador') {
    params.push(effectiveRecorderId);
    conditions.push(`p.recorded_by = $${params.length}`);
  }

  if (query.washRequestId) {
    params.push(query.washRequestId);
    conditions.push(`p.wash_request_id = $${params.length}`);
  }

  if (query.method) {
    params.push(query.method);
    conditions.push(`p.method = $${params.length}`);
  }

  if (query.date) {
    const { start, end } = bogotaDayBoundsUtc(query.date);
    params.push(start);
    conditions.push(`p.paid_at >= $${params.length}`);
    params.push(end);
    conditions.push(`p.paid_at < $${params.length}`);
  }

  let fromDate: Date | undefined;
  let toDate: Date | undefined;
  if (query.from) {
    fromDate = parseFilterBoundaryDate(query.from, 'from', false);
  }
  if (query.to) {
    toDate = parseFilterBoundaryDate(query.to, 'to', true);
  }
  if (fromDate && toDate && toDate < fromDate) {
    throw new AppError(
      422,
      'INVALID_DATE_RANGE',
      'La fecha final (to) no puede ser anterior a la fecha inicial (from)',
      { to: 'Debe ser posterior o igual a from' },
    );
  }
  if (fromDate) {
    params.push(fromDate);
    conditions.push(`p.paid_at >= $${params.length}`);
  }
  if (toDate) {
    params.push(toDate);
    conditions.push(`p.paid_at <= $${params.length}`);
  }

  const whereSql =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const baseFromSql = `
    FROM payments p
    INNER JOIN wash_requests wr ON wr.id = p.wash_request_id
    INNER JOIN users cust ON cust.id = wr.customer_id
    LEFT JOIN users rec ON rec.id = p.recorded_by
    LEFT JOIN employees e ON e.id = wr.employee_id
  `;

  const countRes = await db.query<{ cnt: string | number }>(
    `SELECT COUNT(*) AS cnt ${baseFromSql} ${whereSql}`,
    params,
  );
  const total = Number(countRes.rows[0]?.cnt ?? 0);

  const offset = (query.page - 1) * query.pageSize;
  const rowsRes = await db.query<PaymentJoinedRow>(
    `SELECT
       p.id,
       p.wash_request_id,
       wr.customer_id,
       cust.name AS customer_name,
       p.method,
       p.amount,
       p.reference,
       p.employee_commission,
       p.recorded_by,
       rec.name AS recorded_by_name,
       p.paid_at,
       wr.status AS wash_status
     ${baseFromSql}
     ${whereSql}
     ORDER BY p.paid_at DESC, p.id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, query.pageSize, offset],
  );

  return {
    items: rowsRes.rows.map(mapPaymentRow),
    total,
  };
}
