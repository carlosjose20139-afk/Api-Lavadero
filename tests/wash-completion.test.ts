import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { createDatabase } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrator.js';
import { paymentMethodSchema } from '../src/modules/finance/payments.service.js';
import { hashPassword, newUuid } from '../src/utils/crypto.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';

async function createOperationalWash(
  ctx: TestContext,
  params: {
    keyPrefix: string;
    price?: number;
    targetStatus?: 'confirmed' | 'washing' | 'drying' | 'ready';
    employeeId?: string;
  },
): Promise<{ id: string; price: number; basePrice: number; appliedPendingBalance: number }> {
  const price = params.price ?? 7000;
  const wr = await request(ctx.app)
    .post('/api/v1/wash-requests')
    .set('Authorization', `Bearer ${ctx.adminToken}`)
    .set('X-Idempotency-Key', `${params.keyPrefix}-create-wr`)
    .send({
      customerId: ctx.clienteId,
      motorcycleId: ctx.motoId,
      serviceId: ctx.serviceId,
      price,
    });
  expect(wr.status).toBe(201);
  const washId = wr.body.data.id as string;

  const conf = await request(ctx.app)
    .post(`/api/v1/wash-requests/${washId}/confirm`)
    .set('Authorization', `Bearer ${ctx.clienteToken}`)
    .set('X-Idempotency-Key', `${params.keyPrefix}-confirm-wr`);
  expect(conf.status).toBe(200);

  const targetStatus = params.targetStatus ?? 'ready';
  if (targetStatus !== 'confirmed') {
    const patch = await request(ctx.app)
      .patch(`/api/v1/wash-requests/${washId}/status`)
      .set('Authorization', `Bearer ${ctx.lavadorToken}`)
      .send({
        status: targetStatus,
        ...(params.employeeId ? { employeeId: params.employeeId } : {}),
      });
    expect(patch.status).toBe(200);
  }

  return {
    id: washId,
    price: Number(wr.body.data.price),
    basePrice: Number(wr.body.data.basePrice),
    appliedPendingBalance: Number(wr.body.data.appliedPendingBalance),
  };
}

describe('Cierre transaccional de lavada con pago manual obligatorio (POST /api/v1/wash-requests/:id/complete)', () => {
  let ctx: TestContext;
  let adminId: string;
  let lavadorUserId: string;
  let lavadorEmployeeId: string;

  beforeAll(async () => {
    ctx = await createTestContext();

    const [adminRow, lavadorRow, empRow] = await Promise.all([
      ctx.db.query<{ id: string }>(`SELECT id FROM users WHERE username = 'admin'`),
      ctx.db.query<{ id: string }>(`SELECT id FROM users WHERE username = 'lavador'`),
      ctx.db.query<{ id: string }>(
        `SELECT e.id
         FROM employees e
         INNER JOIN users u ON u.id = e.user_id
         WHERE u.username = 'lavador'`,
      ),
    ]);
    adminId = adminRow.rows[0]!.id;
    lavadorUserId = lavadorRow.rows[0]!.id;
    lavadorEmployeeId = empRow.rows[0]!.id;
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('completa lavadas con Efectivo, Nequi, Daviplata y Bre-B creando exactamente 1 pago, 1 ingreso y auditoría completa (incluyendo ajuste por penalización)', async () => {
    // 1. Efectivo (Administrador, estado ready)
    const washEfectivo = await createOperationalWash(ctx, {
      keyPrefix: 'comp-efectivo',
      price: 7000,
      targetStatus: 'ready',
      employeeId: lavadorEmployeeId,
    });
    const resEfectivo = await request(ctx.app)
      .post(`/api/v1/wash-requests/${washEfectivo.id}/complete`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        paymentMethod: 'Efectivo',
        amount: 7000,
      });

    expect(resEfectivo.status).toBe(200);
    expect(resEfectivo.body.message).toContain('Efectivo');
    expect(resEfectivo.body.data.washRequest.status).toBe('paid');
    expect(resEfectivo.body.data.washRequest.completedAt).toBeTruthy();
    expect(resEfectivo.body.data.payment.method).toBe('Efectivo');
    expect(resEfectivo.body.data.payment.amount).toBe(7000);
    expect(resEfectivo.body.data.payment.recordedBy).toBe(adminId);
    expect(resEfectivo.body.data.payment.employeeCommission).toBe(2100);
    expect(resEfectivo.body.data.income.source).toBe('wash');
    expect(resEfectivo.body.data.income.amount).toBe(7000);
    expect(resEfectivo.body.data.income.paymentId).toBe(
      resEfectivo.body.data.payment.id,
    );
    expect(resEfectivo.body.data.income.recordedBy).toBe(adminId);

    // 2. Nequi (Lavador, estado ready)
    const washNequi = await createOperationalWash(ctx, {
      keyPrefix: 'comp-nequi',
      price: 12000,
      targetStatus: 'ready',
    });
    const resNequi = await request(ctx.app)
      .post(`/api/v1/wash-requests/${washNequi.id}/complete`)
      .set('Authorization', `Bearer ${ctx.lavadorToken}`)
      .send({
        paymentMethod: 'Nequi',
        amount: 12000,
        reference: 'NEQUI-COMP-001',
      });

    expect(resNequi.status).toBe(200);
    expect(resNequi.body.data.washRequest.status).toBe('paid');
    expect(resNequi.body.data.payment.method).toBe('Nequi');
    expect(resNequi.body.data.payment.reference).toBe('NEQUI-COMP-001');
    expect(resNequi.body.data.payment.recordedBy).toBe(lavadorUserId);
    expect(resNequi.body.data.income.amount).toBe(12000);

    // 3. Daviplata (Administrador, estado drying / Secando)
    const washDaviplata = await createOperationalWash(ctx, {
      keyPrefix: 'comp-davi',
      price: 9000,
      targetStatus: 'drying',
    });
    const resDaviplata = await request(ctx.app)
      .post(`/api/v1/wash-requests/${washDaviplata.id}/complete`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        paymentMethod: 'Daviplata',
        amount: 9000,
        reference: 'DAVI-COMP-002',
      });

    expect(resDaviplata.status).toBe(200);
    expect(resDaviplata.body.data.washRequest.status).toBe('paid');
    expect(resDaviplata.body.data.payment.method).toBe('Daviplata');
    expect(resDaviplata.body.data.payment.reference).toBe('DAVI-COMP-002');

    // 4. Bre-B con penalización por cancelación aplicada (tarifa base 7000, pendingBalance 1000 -> final 6000)
    await ctx.db.query(
      `UPDATE users SET pending_balance = 1000 WHERE id = $1`,
      [ctx.clienteId],
    );
    await ctx.db.query(
      `INSERT INTO incomes (id, source, customer_id, amount, status, notes, occurred_at)
       VALUES ($1, 'cancellation_fee', $2, 1000, 'pending', 'Penalización de prueba', NOW())`,
      [newUuid(), ctx.clienteId],
    );

    const washBreB = await createOperationalWash(ctx, {
      keyPrefix: 'comp-breb-pen',
      price: 7000,
      targetStatus: 'ready',
      employeeId: lavadorEmployeeId,
    });
    expect(washBreB.basePrice).toBe(7000);
    expect(washBreB.appliedPendingBalance).toBe(1000);
    expect(washBreB.price).toBe(6000);

    // Si envían el monto sin el ajuste de penalización (7000 en vez de 6000) debe rechazar con 422
    const mismatchAmount = await request(ctx.app)
      .post(`/api/v1/wash-requests/${washBreB.id}/complete`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        paymentMethod: 'Bre-B',
        amount: 7000,
        reference: 'BREB-WRONG-AMOUNT',
      });
    expect(mismatchAmount.status).toBe(422);

    // Con el monto final calculado (6000) completa con Bre-B
    const resBreB = await request(ctx.app)
      .post(`/api/v1/wash-requests/${washBreB.id}/complete`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        paymentMethod: 'Bre-B',
        amount: 6000,
        reference: 'BREB-COMP-003',
      });

    expect(resBreB.status).toBe(200);
    expect(resBreB.body.message).toContain('Bre-B');
    expect(resBreB.body.data.washRequest.status).toBe('paid');
    expect(resBreB.body.data.payment.method).toBe('Bre-B');
    expect(resBreB.body.data.payment.amount).toBe(6000);
    expect(resBreB.body.data.payment.reference).toBe('BREB-COMP-003');
    expect(resBreB.body.data.income.amount).toBe(6000);

    // Verificar exactamente 1 pago y 1 ingreso por cada lavada completada
    for (const wId of [
      washEfectivo.id,
      washNequi.id,
      washDaviplata.id,
      washBreB.id,
    ]) {
      const [payCnt, incCnt] = await Promise.all([
        ctx.db.query<{ cnt: string }>(
          `SELECT COUNT(*) AS cnt FROM payments WHERE wash_request_id = $1`,
          [wId],
        ),
        ctx.db.query<{ cnt: string }>(
          `SELECT COUNT(*) AS cnt FROM incomes WHERE wash_request_id = $1 AND source = 'wash'`,
          [wId],
        ),
      ]);
      expect(Number(payCnt.rows[0]?.cnt)).toBe(1);
      expect(Number(incCnt.rows[0]?.cnt)).toBe(1);
    }

    // Verificar que el cargo por cancelación quedó en status = 'settled'
    const settledFee = await ctx.db.query<{ status: string }>(
      `SELECT status FROM incomes WHERE customer_id = $1 AND source = 'cancellation_fee'`,
      [ctx.clienteId],
    );
    expect(settledFee.rows.every((r) => r.status === 'settled')).toBe(true);

    // Verificar auditoría completa (usuario, rol, fecha, lavada, método y monto)
    const auditRes = await ctx.db.query<{
      actor_id: string;
      actor_role: string;
      action: string;
      entity_type: string;
      entity_id: string;
      changes: Record<string, unknown>;
    }>(
      `SELECT actor_id, actor_role, action, entity_type, entity_id, changes
       FROM audit_logs
       WHERE action = 'wash_request_completed_and_paid' AND entity_id = $1`,
      [washBreB.id],
    );
    expect(auditRes.rows.length).toBe(1);
    expect(auditRes.rows[0]!.actor_id).toBe(adminId);
    expect(auditRes.rows[0]!.actor_role).toBe('Administrador');
    expect(auditRes.rows[0]!.changes).toMatchObject({
      washRequestId: washBreB.id,
      method: 'Bre-B',
      amount: 6000,
      basePrice: 7000,
      appliedPendingBalance: 1000,
      actorId: adminId,
      actorRole: 'Administrador',
      newWashStatus: 'paid',
    });
    expect(auditRes.rows[0]!.changes.paidAt).toBeTruthy();

    // Verificar visibilidad en GET /api/v1/payments y GET /api/v1/incomes
    const [paymentsRes, incomesRes] = await Promise.all([
      request(ctx.app)
        .get(`/api/v1/payments?washRequestId=${washBreB.id}`)
        .set('Authorization', `Bearer ${ctx.adminToken}`),
      request(ctx.app)
        .get('/api/v1/incomes?page=1&pageSize=20')
        .set('Authorization', `Bearer ${ctx.adminToken}`),
    ]);
    expect(paymentsRes.status).toBe(200);
    expect(paymentsRes.body.data.length).toBe(1);
    expect(paymentsRes.body.data[0].method).toBe('Bre-B');

    expect(incomesRes.status).toBe(200);
    const brebIncome = incomesRes.body.data.find(
      (i: { washRequestId?: string; source: string }) =>
        i.washRequestId === washBreB.id && i.source === 'wash',
    );
    expect(brebIncome).toBeTruthy();
    expect(brebIncome.amount).toBe(6000);
    expect(brebIncome.paymentId).toBe(resBreB.body.data.payment.id);
  });

  it('valida permisos (401/403), datos inválidos (422), lavada inexistente (404), cancelada, vencida, rechazada y ya pagada (409)', async () => {
    const validWash = await createOperationalWash(ctx, {
      keyPrefix: 'comp-val-valid',
      price: 8000,
      targetStatus: 'ready',
    });

    // Sin autenticación -> 401
    const unauth = await request(ctx.app)
      .post(`/api/v1/wash-requests/${validWash.id}/complete`)
      .send({ paymentMethod: 'Efectivo', amount: 8000 });
    expect(unauth.status).toBe(401);

    // Cliente no puede completar ni registrar pagos -> 403
    const clientForbidden = await request(ctx.app)
      .post(`/api/v1/wash-requests/${validWash.id}/complete`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({ paymentMethod: 'Efectivo', amount: 8000 });
    expect(clientForbidden.status).toBe(403);

    // Método inválido -> 422
    const badMethod = await request(ctx.app)
      .post(`/api/v1/wash-requests/${validWash.id}/complete`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ paymentMethod: 'TarjetaCredito', amount: 8000 });
    expect(badMethod.status).toBe(422);

    // Monto cero -> 422
    const zeroAmount = await request(ctx.app)
      .post(`/api/v1/wash-requests/${validWash.id}/complete`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ paymentMethod: 'Efectivo', amount: 0 });
    expect(zeroAmount.status).toBe(422);

    // Monto negativo -> 422
    const negativeAmount = await request(ctx.app)
      .post(`/api/v1/wash-requests/${validWash.id}/complete`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ paymentMethod: 'Bre-B', amount: -5000 });
    expect(negativeAmount.status).toBe(422);

    // Monto decimal -> 422
    const decimalAmount = await request(ctx.app)
      .post(`/api/v1/wash-requests/${validWash.id}/complete`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ paymentMethod: 'Nequi', amount: 8000.5 });
    expect(decimalAmount.status).toBe(422);

    // Referencia XSS -> 422
    const xssRef = await request(ctx.app)
      .post(`/api/v1/wash-requests/${validWash.id}/complete`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        paymentMethod: 'Bre-B',
        amount: 8000,
        reference: '<script>alert(1)</script>',
      });
    expect(xssRef.status).toBe(422);

    // Lavada inexistente -> 404
    const notFound = await request(ctx.app)
      .post(`/api/v1/wash-requests/${newUuid()}/complete`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ paymentMethod: 'Bre-B', amount: 8000 });
    expect(notFound.status).toBe(404);

    // Lavada cancelada -> 409
    const cancelledWash = await createOperationalWash(ctx, {
      keyPrefix: 'comp-val-cancelled',
      price: 7000,
      targetStatus: 'confirmed',
    });
    const cancelPatch = await request(ctx.app)
      .patch(`/api/v1/wash-requests/${cancelledWash.id}/status`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ status: 'cancelled' });
    expect(cancelPatch.status).toBe(200);

    const completeCancelled = await request(ctx.app)
      .post(`/api/v1/wash-requests/${cancelledWash.id}/complete`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ paymentMethod: 'Efectivo', amount: 7000 });
    expect(completeCancelled.status).toBe(409);

    // Lavada rechazada -> 409
    const rejectedWr = await request(ctx.app)
      .post('/api/v1/wash-requests')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .set('X-Idempotency-Key', 'comp-val-rejected-wr')
      .send({
        customerId: ctx.clienteId,
        motorcycleId: ctx.motoId,
        serviceId: ctx.serviceId,
        price: 7000,
      });
    expect(rejectedWr.status).toBe(201);
    const rejRes = await request(ctx.app)
      .post(`/api/v1/wash-requests/${rejectedWr.body.data.id}/reject`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .set('X-Idempotency-Key', 'comp-val-rejected-do')
      .send({ reason: 'No puedo asistir' });
    expect(rejRes.status).toBe(200);

    const completeRejected = await request(ctx.app)
      .post(`/api/v1/wash-requests/${rejectedWr.body.data.id}/complete`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ paymentMethod: 'Nequi', amount: 7000 });
    expect(completeRejected.status).toBe(409);

    // Lavada vencida (expired) -> 409
    const expiredWr = await request(ctx.app)
      .post('/api/v1/wash-requests')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .set('X-Idempotency-Key', 'comp-val-expired-wr')
      .send({
        customerId: ctx.clienteId,
        motorcycleId: ctx.motoId,
        serviceId: ctx.serviceId,
        price: 7000,
      });
    expect(expiredWr.status).toBe(201);
    await ctx.db.query(
      `UPDATE wash_requests SET status = 'expired' WHERE id = $1`,
      [expiredWr.body.data.id],
    );
    const completeExpired = await request(ctx.app)
      .post(`/api/v1/wash-requests/${expiredWr.body.data.id}/complete`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ paymentMethod: 'Daviplata', amount: 7000 });
    expect(completeExpired.status).toBe(409);

    // Completar validWash correctamente y luego rechazar segundo intento -> 409
    const okComplete = await request(ctx.app)
      .post(`/api/v1/wash-requests/${validWash.id}/complete`)
      .set('Authorization', `Bearer ${ctx.lavadorToken}`)
      .send({ paymentMethod: 'Bre-B', amount: 8000, reference: 'BREB-VAL-01' });
    expect(okComplete.status).toBe(200);

    const duplicateComplete = await request(ctx.app)
      .post(`/api/v1/wash-requests/${validWash.id}/complete`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ paymentMethod: 'Efectivo', amount: 8000 });
    expect(duplicateComplete.status).toBe(409);

    // También rechazar POST /api/v1/payments sobre una lavada ya completada -> 409
    const duplicateViaPayments = await request(ctx.app)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        washRequestId: validWash.id,
        method: 'Efectivo',
        amount: 8000,
      });
    expect(duplicateViaPayments.status).toBe(409);
  });

  it('garantiza idempotencia ante dos solicitudes simultáneas (con misma clave y sin clave) sin duplicar pagos ni ingresos', async () => {
    // Escenario A: dos solicitudes simultáneas con la MISMA X-Idempotency-Key
    const washSameKey = await createOperationalWash(ctx, {
      keyPrefix: 'comp-conc-samekey',
      price: 10000,
      targetStatus: 'ready',
    });
    const sharedKey = 'idem-concurrent-complete-breb-001';

    const [r1, r2] = await Promise.all([
      request(ctx.app)
        .post(`/api/v1/wash-requests/${washSameKey.id}/complete`)
        .set('Authorization', `Bearer ${ctx.adminToken}`)
        .set('X-Idempotency-Key', sharedKey)
        .send({ paymentMethod: 'Bre-B', amount: 10000, reference: 'BREB-CONC-1' }),
      request(ctx.app)
        .post(`/api/v1/wash-requests/${washSameKey.id}/complete`)
        .set('Authorization', `Bearer ${ctx.adminToken}`)
        .set('X-Idempotency-Key', sharedKey)
        .send({ paymentMethod: 'Bre-B', amount: 10000, reference: 'BREB-CONC-1' }),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.body.data.payment.id).toBe(r2.body.data.payment.id);
    expect(r1.body.data.income.id).toBe(r2.body.data.income.id);

    const [sameKeyPays, sameKeyIncs] = await Promise.all([
      ctx.db.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM payments WHERE wash_request_id = $1`,
        [washSameKey.id],
      ),
      ctx.db.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM incomes WHERE wash_request_id = $1 AND source = 'wash'`,
        [washSameKey.id],
      ),
    ]);
    expect(Number(sameKeyPays.rows[0]?.cnt)).toBe(1);
    expect(Number(sameKeyIncs.rows[0]?.cnt)).toBe(1);

    // Escenario B: dos solicitudes simultáneas SIN X-Idempotency-Key (una gana 200, la otra recibe 409)
    const washNoKey = await createOperationalWash(ctx, {
      keyPrefix: 'comp-conc-nokey',
      price: 11000,
      targetStatus: 'drying',
    });

    const [n1, n2] = await Promise.all([
      request(ctx.app)
        .post(`/api/v1/wash-requests/${washNoKey.id}/complete`)
        .set('Authorization', `Bearer ${ctx.adminToken}`)
        .send({ paymentMethod: 'Nequi', amount: 11000, reference: 'NEQUI-CONC-2' }),
      request(ctx.app)
        .post(`/api/v1/wash-requests/${washNoKey.id}/complete`)
        .set('Authorization', `Bearer ${ctx.lavadorToken}`)
        .send({ paymentMethod: 'Nequi', amount: 11000, reference: 'NEQUI-CONC-2' }),
    ]);

    const statuses = [n1.status, n2.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);

    const [noKeyPays, noKeyIncs] = await Promise.all([
      ctx.db.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM payments WHERE wash_request_id = $1`,
        [washNoKey.id],
      ),
      ctx.db.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM incomes WHERE wash_request_id = $1 AND source = 'wash'`,
        [washNoKey.id],
      ),
    ]);
    expect(Number(noKeyPays.rows[0]?.cnt)).toBe(1);
    expect(Number(noKeyIncs.rows[0]?.cnt)).toBe(1);
  });

  it('revierte completamente la transacción si falla una operación intermedia (sin pagos, sin ingresos y sin cambio de estado)', async () => {
    const washRollback = await createOperationalWash(ctx, {
      keyPrefix: 'comp-rollback',
      price: 7500,
      targetStatus: 'ready',
    });

    // Instalar trigger temporal en incomes para provocar un fallo real después de insertar en payments y actualizar wash_requests
    await ctx.db.exec(`
      CREATE OR REPLACE FUNCTION fail_income_insert_for_test()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.wash_request_id = '${washRollback.id}'::uuid THEN
          RAISE EXCEPTION 'Fallo simulado al registrar ingreso financiero';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_fail_income_insert_for_test ON incomes;
      CREATE TRIGGER trg_fail_income_insert_for_test
        BEFORE INSERT ON incomes
        FOR EACH ROW
        EXECUTE FUNCTION fail_income_insert_for_test();
    `);

    try {
      const failedRes = await request(ctx.app)
        .post(`/api/v1/wash-requests/${washRollback.id}/complete`)
        .set('Authorization', `Bearer ${ctx.adminToken}`)
        .send({
          paymentMethod: 'Bre-B',
          amount: 7500,
          reference: 'BREB-ROLLBACK-TEST',
        });

      expect(failedRes.status).toBe(500);

      // Verificar rollback total: 0 pagos, 0 ingresos, lavada sigue en 'ready' y sin auditoría de pago
      const [wrState, payCnt, incCnt, auditCnt] = await Promise.all([
        ctx.db.query<{ status: string; completed_at: string | null }>(
          `SELECT status, completed_at FROM wash_requests WHERE id = $1`,
          [washRollback.id],
        ),
        ctx.db.query<{ cnt: string }>(
          `SELECT COUNT(*) AS cnt FROM payments WHERE wash_request_id = $1`,
          [washRollback.id],
        ),
        ctx.db.query<{ cnt: string }>(
          `SELECT COUNT(*) AS cnt FROM incomes WHERE wash_request_id = $1`,
          [washRollback.id],
        ),
        ctx.db.query<{ cnt: string }>(
          `SELECT COUNT(*) AS cnt FROM audit_logs WHERE action = 'wash_request_completed_and_paid' AND entity_id = $1`,
          [washRollback.id],
        ),
      ]);

      expect(wrState.rows[0]?.status).toBe('ready');
      expect(wrState.rows[0]?.completed_at).toBeNull();
      expect(Number(payCnt.rows[0]?.cnt)).toBe(0);
      expect(Number(incCnt.rows[0]?.cnt)).toBe(0);
      expect(Number(auditCnt.rows[0]?.cnt)).toBe(0);
    } finally {
      await ctx.db.exec(`
        DROP TRIGGER IF EXISTS trg_fail_income_insert_for_test ON incomes;
        DROP FUNCTION IF EXISTS fail_income_insert_for_test();
      `);
    }
  });

  it('valida migración 009 en base limpia y existente sin borrar datos, y confirma contrato OpenAPI + validadores con Bre-B', async () => {
    // 1. Base limpia: todas las migraciones + idempotencia
    const cleanDb = createDatabase({ pgliteDir: ':memory:' });
    try {
      const applied = await runMigrations(cleanDb);
      expect(applied).toContain('008_payments_breb_and_indexes.sql');
      expect(applied).toContain('009_wash_completion_financial_integrity.sql');
      const secondRun = await runMigrations(cleanDb);
      expect(secondRun).toEqual([]);
    } finally {
      await cleanDb.close();
    }

    // 2. Base existente (hasta 008 con un pago e ingreso previos) -> actualizar a 009 conservando y enlazando datos
    const upgradeDb = createDatabase({ pgliteDir: ':memory:' });
    try {
      const migDir = path.resolve(process.cwd(), 'migrations');
      await upgradeDb.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version VARCHAR(120) PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      for (const file of [
        '001_initial_schema.sql',
        '002_seed_shop_defaults.sql',
        '003_motorcycle_decoupling.sql',
        '004_promotions_lifecycle.sql',
        '005_forum_replies_audit.sql',
        '006_loyalty_lifecycle.sql',
        '007_loyalty_settings.sql',
        '008_payments_breb_and_indexes.sql',
      ]) {
        const sql = fs.readFileSync(path.join(migDir, file), 'utf8');
        await upgradeDb.exec(sql);
        await upgradeDb.query(`INSERT INTO schema_migrations (version) VALUES ($1)`, [
          file,
        ]);
      }

      const uid = newUuid();
      const mid = newUuid();
      const sid = newUuid();
      const wrId = newUuid();
      const payId = newUuid();
      const incId = newUuid();
      const hash = await hashPassword('Pass1234*');

      await upgradeDb.query(
        `INSERT INTO users (id, name, username, password_hash, role, is_active)
         VALUES ($1, 'Cliente Histórico', 'cli_hist_009', $2, 'Cliente', TRUE)`,
        [uid, hash],
      );
      await upgradeDb.query(
        `INSERT INTO motorcycles (id, customer_id, brand, model, cc, is_active)
         VALUES ($1, $2, 'Honda', 'CB 190R', 190, TRUE)`,
        [mid, uid],
      );
      await upgradeDb.query(
        `INSERT INTO services (id, name, description, price, duration_minutes, is_active)
         VALUES ($1, 'Lavada Básica Histórica', 'Servicio histórico', 7000, 30, TRUE)`,
        [sid],
      );
      await upgradeDb.query(
        `INSERT INTO wash_requests (id, customer_id, motorcycle_id, service_id, base_price, price, expires_at, status)
         VALUES ($1, $2, $3, $4, 7000, 7000, NOW() + INTERVAL '15 minutes', 'paid')`,
        [wrId, uid, mid, sid],
      );
      await upgradeDb.query(
        `INSERT INTO payments (id, wash_request_id, method, amount, reference)
         VALUES ($1, $2, 'Bre-B', 7000, 'LEGACY-BREB-009')`,
        [payId, wrId],
      );
      await upgradeDb.query(
        `INSERT INTO incomes (id, source, wash_request_id, customer_id, amount, status, notes)
         VALUES ($1, 'wash', $2, $3, 7000, 'confirmed', 'Pago manual por Bre-B')`,
        [incId, wrId, uid],
      );

      const appliedUpgrade = await runMigrations(upgradeDb);
      expect(appliedUpgrade).toContain(
        '009_wash_completion_financial_integrity.sql',
      );

      // Backfill automático sin perder datos
      const [payRow, incRow] = await Promise.all([
        upgradeDb.query<{ customer_id: string; method: string }>(
          `SELECT customer_id, method FROM payments WHERE id = $1`,
          [payId],
        ),
        upgradeDb.query<{ payment_id: string }>(
          `SELECT payment_id FROM incomes WHERE id = $1`,
          [incId],
        ),
      ]);
      expect(payRow.rows[0]?.customer_id).toBe(uid);
      expect(payRow.rows[0]?.method).toBe('Bre-B');
      expect(incRow.rows[0]?.payment_id).toBe(payId);

      // La restricción única en incomes impide insertar un segundo ingreso 'wash' para la misma lavada
      await expect(
        upgradeDb.query(
          `INSERT INTO incomes (id, source, wash_request_id, customer_id, amount, status)
           VALUES ($1, 'wash', $2, $3, 7000, 'confirmed')`,
          [newUuid(), wrId, uid],
        ),
      ).rejects.toThrow();
    } finally {
      await upgradeDb.close();
    }

    // 3. Verificar validadores Zod + OpenAPI YAML + /api/v1/openapi.json
    expect(paymentMethodSchema.safeParse('Efectivo').success).toBe(true);
    expect(paymentMethodSchema.safeParse('Nequi').success).toBe(true);
    expect(paymentMethodSchema.safeParse('Daviplata').success).toBe(true);
    expect(paymentMethodSchema.safeParse('Bre-B').success).toBe(true);
    expect(paymentMethodSchema.safeParse('Wompi').success).toBe(false);

    const specPath = path.resolve(process.cwd(), 'docs/api/openapi.yaml');
    const spec = YAML.parse(fs.readFileSync(specPath, 'utf8')) as {
      paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
      components: {
        schemas: {
          PaymentMethod?: { enum?: string[] };
          CompleteWashRequestInput?: { required?: string[] };
          Payment?: unknown;
        };
      };
    };

    expect(spec.components.schemas.PaymentMethod?.enum).toEqual([
      'Efectivo',
      'Nequi',
      'Daviplata',
      'Bre-B',
    ]);
    expect(spec.components.schemas.CompleteWashRequestInput?.required).toEqual([
      'paymentMethod',
      'amount',
    ]);
    expect(spec.components.schemas.Payment).toBeTruthy();

    const completeOp = spec.paths['/wash-requests/{id}/complete']?.post;
    expect(completeOp).toBeTruthy();
    for (const code of ['200', '400', '401', '403', '404', '409', '422']) {
      expect(completeOp?.responses?.[code]).toBeTruthy();
    }
    expect(spec.paths['/payments']?.get).toBeTruthy();
    expect(spec.paths['/payments']?.post).toBeTruthy();

    const liveSpecRes = await request(ctx.app).get('/api/v1/openapi.json');
    expect(liveSpecRes.status).toBe(200);
    expect(
      liveSpecRes.body.paths?.['/wash-requests/{id}/complete']?.post,
    ).toBeTruthy();
    expect(
      liveSpecRes.body.components?.schemas?.PaymentMethod?.enum,
    ).toContain('Bre-B');
  });
});
