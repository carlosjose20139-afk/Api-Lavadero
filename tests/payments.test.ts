import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { createDatabase } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrator.js';
import { hashPassword, newUuid } from '../src/utils/crypto.js';
import { toBogotaYmd } from '../src/utils/time.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';

async function createConfirmedReadyWash(
  ctx: TestContext,
  params: {
    customerId: string;
    motorcycleId: string;
    customerToken: string;
    keyPrefix: string;
    price?: number;
    employeeId?: string;
  },
): Promise<string> {
  const price = params.price ?? 7000;
  const wr = await request(ctx.app)
    .post('/api/v1/wash-requests')
    .set('Authorization', `Bearer ${ctx.adminToken}`)
    .set('X-Idempotency-Key', `${params.keyPrefix}-wr`)
    .send({
      customerId: params.customerId,
      motorcycleId: params.motorcycleId,
      serviceId: ctx.serviceId,
      price,
    });
  expect(wr.status).toBe(201);
  const washId = wr.body.data.id as string;

  const conf = await request(ctx.app)
    .post(`/api/v1/wash-requests/${washId}/confirm`)
    .set('Authorization', `Bearer ${params.customerToken}`)
    .set('X-Idempotency-Key', `${params.keyPrefix}-cf`);
  expect(conf.status).toBe(200);

  const ready = await request(ctx.app)
    .patch(`/api/v1/wash-requests/${washId}/status`)
    .set('Authorization', `Bearer ${ctx.lavadorToken}`)
    .send({
      status: 'ready',
      ...(params.employeeId ? { employeeId: params.employeeId } : {}),
    });
  expect(ready.status).toBe(200);

  return washId;
}

describe('Pagos Manuales (Efectivo, Nequi, Daviplata, Bre-B): POST/GET, RBAC, filtros, auditoría, migración 008 y OpenAPI', () => {
  let ctx: TestContext;
  let adminId: string;
  let lavadorUserId: string;
  let lavadorEmployeeId: string;
  let customer2Id: string;
  let customer2Token: string;
  let customer2MotoId: string;

  beforeAll(async () => {
    ctx = await createTestContext();

    const [adminRow, lavadorRow, empRow] = await Promise.all([
      ctx.db.query<{ id: string }>(`SELECT id FROM users WHERE username = 'admin'`),
      ctx.db.query<{ id: string }>(`SELECT id FROM users WHERE username = 'lavador'`),
      ctx.db.query<{ id: string }>(
        `SELECT id FROM employees WHERE name = 'Carlos Lavador'`,
      ),
    ]);
    adminId = adminRow.rows[0]!.id;
    lavadorUserId = lavadorRow.rows[0]!.id;
    lavadorEmployeeId = empRow.rows[0]!.id;

    // Segundo cliente para validar aislamiento RBAC y filtros por customerId
    const c2Res = await request(ctx.app)
      .post('/api/v1/customers')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        name: 'Sofía Motera',
        username: 'sofia.moto',
        password: 'SofiaPass123*',
      });
    expect(c2Res.status).toBe(201);
    customer2Id = c2Res.body.data.id as string;

    const c2MotoRes = await request(ctx.app)
      .post('/api/v1/motorcycles')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        brand: 'Honda',
        model: 'CB 190R',
        cc: 184,
        customerId: customer2Id,
      });
    expect(c2MotoRes.status).toBe(201);
    customer2MotoId = c2MotoRes.body.data.id as string;

    const c2Login = await request(ctx.app)
      .post('/api/v1/auth/login')
      .send({ username: 'sofia.moto', password: 'SofiaPass123*' });
    expect(c2Login.status).toBe(200);
    customer2Token = c2Login.body.data.accessToken as string;
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('crea pagos manuales en Efectivo, Nequi, Daviplata y Bre-B, cambia lavada a paid, registra ingreso financiero y auditoría', async () => {
    const washEfectivo = await createConfirmedReadyWash(ctx, {
      customerId: ctx.clienteId,
      motorcycleId: ctx.motoId,
      customerToken: ctx.clienteToken,
      keyPrefix: 'idem-pay-efectivo-001',
    });
    const washNequi = await createConfirmedReadyWash(ctx, {
      customerId: ctx.clienteId,
      motorcycleId: ctx.motoId,
      customerToken: ctx.clienteToken,
      keyPrefix: 'idem-pay-nequi-00001',
    });
    const washDaviplata = await createConfirmedReadyWash(ctx, {
      customerId: customer2Id,
      motorcycleId: customer2MotoId,
      customerToken: customer2Token,
      keyPrefix: 'idem-pay-davipl-0001',
    });
    const washBreB = await createConfirmedReadyWash(ctx, {
      customerId: customer2Id,
      motorcycleId: customer2MotoId,
      customerToken: customer2Token,
      keyPrefix: 'idem-pay-breb-000001',
      employeeId: lavadorEmployeeId,
    });

    // 1. Efectivo (Admin, con X-Idempotency-Key y sin reference)
    const payEfectivo = await request(ctx.app)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .set('X-Idempotency-Key', 'idem-pay-record-ef-001')
      .send({
        washRequestId: washEfectivo,
        method: 'Efectivo',
        amount: 7000,
      });
    expect(payEfectivo.status).toBe(201);
    expect(payEfectivo.body.data.method).toBe('Efectivo');
    expect(payEfectivo.body.data.amount).toBe(7000);
    expect(payEfectivo.body.data.reference).toBeNull();
    expect(payEfectivo.body.data.recordedBy).toBe(adminId);
    expect(payEfectivo.body.data.washStatus).toBe('paid');
    expect(payEfectivo.body.message).toBe('Pago manual (Efectivo) registrado exitosamente');

    // Replay con la misma X-Idempotency-Key devuelve exactamente el mismo pago sin duplicar
    const replayEfectivo = await request(ctx.app)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .set('X-Idempotency-Key', 'idem-pay-record-ef-001')
      .send({
        washRequestId: washEfectivo,
        method: 'Efectivo',
        amount: 7000,
      });
    expect(replayEfectivo.status).toBe(201);
    expect(replayEfectivo.body.data.id).toBe(payEfectivo.body.data.id);

    // 2. Nequi (Admin, sin header de idempotencia — opcional)
    const payNequi = await request(ctx.app)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        washRequestId: washNequi,
        method: 'Nequi',
        amount: 7000,
        reference: 'NEQ-998811',
      });
    expect(payNequi.status).toBe(201);
    expect(payNequi.body.data.method).toBe('Nequi');
    expect(payNequi.body.data.reference).toBe('NEQ-998811');

    // 3. Daviplata (Admin)
    const payDaviplata = await request(ctx.app)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        washRequestId: washDaviplata,
        method: 'Daviplata',
        amount: 7000,
        reference: 'DAVI-554433',
      });
    expect(payDaviplata.status).toBe(201);
    expect(payDaviplata.body.data.method).toBe('Daviplata');
    expect(payDaviplata.body.data.reference).toBe('DAVI-554433');

    // 4. Bre-B (registrado por Lavador, con comisión calculada del 30%)
    const payBreB = await request(ctx.app)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${ctx.lavadorToken}`)
      .send({
        washRequestId: washBreB,
        method: 'Bre-B',
        amount: 7000,
        reference: 'BREB-20261120-001',
      });
    expect(payBreB.status).toBe(201);
    expect(payBreB.body.data.method).toBe('Bre-B');
    expect(payBreB.body.data.amount).toBe(7000);
    expect(payBreB.body.data.reference).toBe('BREB-20261120-001');
    expect(payBreB.body.data.recordedBy).toBe(lavadorUserId);
    expect(payBreB.body.data.employeeCommission).toBe(2100);
    expect(payBreB.body.data.washStatus).toBe('paid');
    expect(payBreB.body.message).toBe('Pago manual (Bre-B) registrado exitosamente');

    // Verificar que las 4 lavadas quedaron en estado paid
    const washesRes = await ctx.db.query<{ id: string; status: string }>(
      `SELECT id, status FROM wash_requests WHERE id = ANY($1::uuid[])`,
      [[washEfectivo, washNequi, washDaviplata, washBreB]],
    );
    expect(washesRes.rows.length).toBe(4);
    for (const row of washesRes.rows) {
      expect(row.status).toBe('paid');
    }

    // Verificar ingreso financiero confirmado para Bre-B
    const incomeRes = await ctx.db.query<{
      amount: number;
      status: string;
      notes: string;
    }>(
      `SELECT amount, status, notes FROM incomes WHERE wash_request_id = $1 AND source = 'wash'`,
      [washBreB],
    );
    expect(incomeRes.rows.length).toBe(1);
    expect(Number(incomeRes.rows[0]?.amount)).toBe(7000);
    expect(incomeRes.rows[0]?.status).toBe('confirmed');
    expect(incomeRes.rows[0]?.notes).toBe('Pago manual por Bre-B');

    // Verificar auditoría en audit_logs para el pago Bre-B
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
       WHERE action = 'manual_payment_recorded' AND entity_id = $1`,
      [payBreB.body.data.id],
    );
    expect(auditRes.rows.length).toBe(1);
    expect(auditRes.rows[0]?.actor_id).toBe(lavadorUserId);
    expect(auditRes.rows[0]?.actor_role).toBe('Lavador');
    expect(auditRes.rows[0]?.entity_type).toBe('payment');
    expect(auditRes.rows[0]?.changes.method).toBe('Bre-B');
    expect(auditRes.rows[0]?.changes.washRequestId).toBe(washBreB);
    expect(auditRes.rows[0]?.changes.newWashStatus).toBe('paid');
  });

  it('rechaza método inválido, monto <= 0, campos desconocidos, washRequest inexistente, estados no pagables, pago duplicado y cliente sin permiso', async () => {
    const washForErrors = await createConfirmedReadyWash(ctx, {
      customerId: ctx.clienteId,
      motorcycleId: ctx.motoId,
      customerToken: ctx.clienteToken,
      keyPrefix: 'idem-pay-errors-0001',
    });

    // Sin token -> 401
    const unauthPost = await request(ctx.app)
      .post('/api/v1/payments')
      .send({ washRequestId: washForErrors, method: 'Efectivo', amount: 7000 });
    expect(unauthPost.status).toBe(401);

    // Cliente no puede registrar pagos -> 403
    const clientPost = await request(ctx.app)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({ washRequestId: washForErrors, method: 'Efectivo', amount: 7000 });
    expect(clientPost.status).toBe(403);

    // Método inválido (Tarjeta / pasarela) -> 422
    const invalidMethod = await request(ctx.app)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ washRequestId: washForErrors, method: 'Tarjeta', amount: 7000 });
    expect(invalidMethod.status).toBe(422);

    // Monto cero -> 422
    const zeroAmount = await request(ctx.app)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ washRequestId: washForErrors, method: 'Bre-B', amount: 0 });
    expect(zeroAmount.status).toBe(422);

    // Monto negativo -> 422
    const negativeAmount = await request(ctx.app)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ washRequestId: washForErrors, method: 'Bre-B', amount: -500 });
    expect(negativeAmount.status).toBe(422);

    // Monto no entero -> 422
    const floatAmount = await request(ctx.app)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ washRequestId: washForErrors, method: 'Bre-B', amount: 7000.5 });
    expect(floatAmount.status).toBe(422);

    // Datos sensibles/extra prohibidos (ej. cardNumber) -> 422
    const extraField = await request(ctx.app)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        washRequestId: washForErrors,
        method: 'Bre-B',
        amount: 7000,
        cardNumber: '4111111111111111',
      });
    expect(extraField.status).toBe(422);

    // Referencia con HTML/script -> 422
    const xssRef = await request(ctx.app)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        washRequestId: washForErrors,
        method: 'Bre-B',
        amount: 7000,
        reference: '<script>alert(1)</script>',
      });
    expect(xssRef.status).toBe(422);

    // washRequestId inválido (no UUID) -> 422
    const badUuid = await request(ctx.app)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ washRequestId: 'no-es-uuid', method: 'Efectivo', amount: 7000 });
    expect(badUuid.status).toBe(422);

    // washRequest inexistente -> 404
    const notFoundWash = await request(ctx.app)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ washRequestId: newUuid(), method: 'Bre-B', amount: 7000 });
    expect(notFoundWash.status).toBe(404);
    expect(notFoundWash.body.data.code).toBe('WASH_REQUEST_NOT_FOUND');

    // Lavada rechazada no admite pago -> 409 WASH_NOT_PAYABLE
    const rejectedWr = await request(ctx.app)
      .post('/api/v1/wash-requests')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .set('X-Idempotency-Key', 'idem-pay-rej-wr-0001')
      .send({
        customerId: ctx.clienteId,
        motorcycleId: ctx.motoId,
        serviceId: ctx.serviceId,
        price: 7000,
      });
    expect(rejectedWr.status).toBe(201);
    const rejectedWashId = rejectedWr.body.data.id as string;

    const rejectRes = await request(ctx.app)
      .post(`/api/v1/wash-requests/${rejectedWashId}/reject`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .set('X-Idempotency-Key', 'idem-pay-rej-do-0001')
      .send({ reason: 'No puedo asistir hoy' });
    expect(rejectRes.status).toBe(200);

    const payRejected = await request(ctx.app)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ washRequestId: rejectedWashId, method: 'Efectivo', amount: 7000 });
    expect(payRejected.status).toBe(409);
    expect(payRejected.body.data.code).toBe('WASH_NOT_PAYABLE');

    // Lavada cancelada no admite pago -> 409 WASH_NOT_PAYABLE
    const cancelledWr = await request(ctx.app)
      .post('/api/v1/wash-requests')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .set('X-Idempotency-Key', 'idem-pay-can-wr-0001')
      .send({
        customerId: ctx.clienteId,
        motorcycleId: ctx.motoId,
        serviceId: ctx.serviceId,
        price: 7000,
      });
    const cancelledWashId = cancelledWr.body.data.id as string;
    await ctx.db.query(
      `UPDATE wash_requests SET status = 'cancelled' WHERE id = $1`,
      [cancelledWashId],
    );
    const payCancelled = await request(ctx.app)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ washRequestId: cancelledWashId, method: 'Nequi', amount: 7000 });
    expect(payCancelled.status).toBe(409);
    expect(payCancelled.body.data.code).toBe('WASH_NOT_PAYABLE');

    // Registrar pago válido y luego intentar duplicarlo -> 409 PAYMENT_ALREADY_EXISTS
    const firstPay = await request(ctx.app)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ washRequestId: washForErrors, method: 'Efectivo', amount: 7000 });
    expect(firstPay.status).toBe(201);

    const duplicatePay = await request(ctx.app)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ washRequestId: washForErrors, method: 'Bre-B', amount: 7000 });
    expect(duplicatePay.status).toBe(409);
    expect(duplicatePay.body.data.code).toBe('PAYMENT_ALREADY_EXISTS');
  });

  it('GET /api/v1/payments valida RBAC por rol, paginación y filtros por fecha, método, usuario, cliente y washRequestId', async () => {
    // Sin token -> 401
    const unauthGet = await request(ctx.app).get('/api/v1/payments');
    expect(unauthGet.status).toBe(401);

    // Administrador consulta todos paginados (hay 5 pagos creados en los 2 tests previos)
    const adminPage1 = await request(ctx.app)
      .get('/api/v1/payments?page=1&pageSize=2')
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(adminPage1.status).toBe(200);
    expect(adminPage1.body.data.length).toBe(2);
    expect(adminPage1.body.meta).toEqual({
      page: 1,
      pageSize: 2,
      total: 5,
      totalPages: 3,
    });
    expect(adminPage1.body.message).toBe('Pagos consultados exitosamente');

    // Filtro por method=Bre-B
    const filterBreB = await request(ctx.app)
      .get('/api/v1/payments?method=Bre-B')
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(filterBreB.status).toBe(200);
    expect(filterBreB.body.meta.total).toBe(1);
    expect(filterBreB.body.data[0].method).toBe('Bre-B');
    const breBWashId = filterBreB.body.data[0].washRequestId as string;

    // Filtro por washRequestId
    const filterWash = await request(ctx.app)
      .get(`/api/v1/payments?washRequestId=${breBWashId}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(filterWash.status).toBe(200);
    expect(filterWash.body.meta.total).toBe(1);
    expect(filterWash.body.data[0].washRequestId).toBe(breBWashId);

    // Filtro por usuario (userId y recordedBy)
    const filterByUserId = await request(ctx.app)
      .get(`/api/v1/payments?userId=${lavadorUserId}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(filterByUserId.status).toBe(200);
    expect(filterByUserId.body.meta.total).toBe(1);
    expect(filterByUserId.body.data[0].recordedBy).toBe(lavadorUserId);

    const filterByRecordedBy = await request(ctx.app)
      .get(`/api/v1/payments?recordedBy=${adminId}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(filterByRecordedBy.status).toBe(200);
    expect(filterByRecordedBy.body.meta.total).toBe(4);

    // Filtro por customerId
    const filterByCustomer2 = await request(ctx.app)
      .get(`/api/v1/payments?customerId=${customer2Id}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(filterByCustomer2.status).toBe(200);
    expect(filterByCustomer2.body.meta.total).toBe(2);
    for (const item of filterByCustomer2.body.data as Array<{ customerId: string }>) {
      expect(item.customerId).toBe(customer2Id);
    }

    // Filtro por fecha (date = hoy en America/Bogota y rango from..to)
    const todayBogota = toBogotaYmd(new Date());
    const filterDate = await request(ctx.app)
      .get(`/api/v1/payments?date=${todayBogota}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(filterDate.status).toBe(200);
    expect(filterDate.body.meta.total).toBe(5);

    const filterRange = await request(ctx.app)
      .get(`/api/v1/payments?from=${todayBogota}&to=${todayBogota}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(filterRange.status).toBe(200);
    expect(filterRange.body.meta.total).toBe(5);

    // Rango de fechas inválido (to < from) -> 422
    const badDateRange = await request(ctx.app)
      .get('/api/v1/payments?from=2026-12-10&to=2026-12-01')
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(badDateRange.status).toBe(422);

    // Lavador solo ve los pagos permitidos por su rol (el que registró / lavada asignada)
    const lavadorList = await request(ctx.app)
      .get('/api/v1/payments')
      .set('Authorization', `Bearer ${ctx.lavadorToken}`);
    expect(lavadorList.status).toBe(200);
    expect(lavadorList.body.meta.total).toBe(1);
    expect(lavadorList.body.data[0].method).toBe('Bre-B');

    // Lavador intentando filtrar por otro usuario (admin) -> 403
    const lavadorOtherUser = await request(ctx.app)
      .get(`/api/v1/payments?userId=${adminId}`)
      .set('Authorization', `Bearer ${ctx.lavadorToken}`);
    expect(lavadorOtherUser.status).toBe(403);

    // Cliente solo ve sus propios pagos (3 de Mateo, 2 de Sofía)
    const mateoList = await request(ctx.app)
      .get('/api/v1/payments')
      .set('Authorization', `Bearer ${ctx.clienteToken}`);
    expect(mateoList.status).toBe(200);
    expect(mateoList.body.meta.total).toBe(3);
    for (const item of mateoList.body.data as Array<{ customerId: string }>) {
      expect(item.customerId).toBe(ctx.clienteId);
    }

    const sofiaList = await request(ctx.app)
      .get('/api/v1/payments')
      .set('Authorization', `Bearer ${customer2Token}`);
    expect(sofiaList.status).toBe(200);
    expect(sofiaList.body.meta.total).toBe(2);
    for (const item of sofiaList.body.data as Array<{ customerId: string }>) {
      expect(item.customerId).toBe(customer2Id);
    }

    // Cliente intentando consultar pagos de otro cliente -> 403
    const mateoQuerySofia = await request(ctx.app)
      .get(`/api/v1/payments?customerId=${customer2Id}`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`);
    expect(mateoQuerySofia.status).toBe(403);
  });

  it('migración 008 funciona en base limpia y existente sin borrar datos, habilita Bre-B en BD y OpenAPI documenta contrato completo', async () => {
    // 1. Base limpia + idempotencia
    const cleanDb = createDatabase({ pgliteDir: ':memory:' });
    const appliedClean = await runMigrations(cleanDb);
    expect(appliedClean).toContain('008_payments_breb_and_indexes.sql');
    expect(await runMigrations(cleanDb)).toEqual([]);
    await cleanDb.close();

    // 2. Base existente migrada hasta 007 con un pago Efectivo previo -> migra a 008 sin borrar datos y acepta Bre-B
    const existingDb = createDatabase({ pgliteDir: ':memory:' });
    const migrationsDir = path.resolve(process.cwd(), 'migrations');
    for (const file of [
      '001_initial_schema.sql',
      '002_seed_shop_defaults.sql',
      '003_motorcycle_decoupling.sql',
      '004_promotions_lifecycle.sql',
      '005_forum_replies_audit.sql',
      '006_loyalty_lifecycle.sql',
      '007_loyalty_settings.sql',
    ]) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      await existingDb.exec(sql);
      await existingDb.query(`INSERT INTO schema_migrations (version) VALUES ($1)`, [
        file,
      ]);
    }

    const custId = newUuid();
    const motoId = newUuid();
    const svcId = newUuid();
    const wash1Id = newUuid();
    const wash2Id = newUuid();
    const pwdHash = await hashPassword('MigPayPass123*');

    await existingDb.query(
      `INSERT INTO users (id, name, username, password_hash, role, is_active)
       VALUES ($1, 'Cliente Migración', 'mig.pay', $2, 'Cliente', TRUE)`,
      [custId, pwdHash],
    );
    await existingDb.query(
      `INSERT INTO motorcycles (id, customer_id, brand, model, cc)
       VALUES ($1, $2, 'Yamaha', 'FZ', 150)`,
      [motoId, custId],
    );
    await existingDb.query(
      `INSERT INTO services (id, name, description, price, duration_minutes)
       VALUES ($1, 'Lavada Test', 'Desc', 7000, 30)`,
      [svcId],
    );
    await existingDb.query(
      `INSERT INTO wash_requests (id, customer_id, motorcycle_id, service_id, base_price, price, expires_at, status)
       VALUES ($1, $3, $4, $5, 7000, 7000, NOW() + INTERVAL '15 minutes', 'paid'),
              ($2, $3, $4, $5, 7000, 7000, NOW() + INTERVAL '15 minutes', 'ready')`,
      [wash1Id, wash2Id, custId, motoId, svcId],
    );
    await existingDb.query(
      `INSERT INTO payments (id, wash_request_id, method, amount)
       VALUES ($1, $2, 'Efectivo', 7000)`,
      [newUuid(), wash1Id],
    );

    const appliedUpgrade = await runMigrations(existingDb);
    expect(appliedUpgrade).toContain('008_payments_breb_and_indexes.sql');

    // Pago previo preservado + inserción Bre-B permitida en BD
    await existingDb.query(
      `INSERT INTO payments (id, wash_request_id, method, amount, reference)
       VALUES ($1, $2, 'Bre-B', 7000, 'BREB-MIG-01')`,
      [newUuid(), wash2Id],
    );

    const allPayRes = await existingDb.query<{ method: string }>(
      `SELECT method FROM payments ORDER BY method ASC`,
    );
    expect(allPayRes.rows.map((r) => r.method)).toEqual(['Bre-B', 'Efectivo']);
    await existingDb.close();

    // 3. Validación directa de OpenAPI YAML
    const specRaw = fs.readFileSync(
      path.resolve(process.cwd(), 'docs/api/openapi.yaml'),
      'utf8',
    );
    const spec = YAML.parse(specRaw) as {
      paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
      components: {
        schemas: {
          PaymentMethod?: { enum?: string[] };
          Payment?: unknown;
          PaymentPage?: unknown;
        };
      };
    };

    expect(spec.paths['/payments']?.get).toBeTruthy();
    expect(spec.paths['/payments']?.post).toBeTruthy();
    expect(spec.components.schemas.PaymentMethod?.enum).toEqual([
      'Efectivo',
      'Nequi',
      'Daviplata',
      'Bre-B',
    ]);
    expect(spec.components.schemas.Payment).toBeTruthy();
    expect(spec.components.schemas.PaymentPage).toBeTruthy();
    for (const code of ['201', '400', '401', '403', '404', '409', '422']) {
      expect(spec.paths['/payments']?.post?.responses?.[code]).toBeTruthy();
    }
    for (const code of ['200', '400', '401', '403', '422']) {
      expect(spec.paths['/payments']?.get?.responses?.[code]).toBeTruthy();
    }
  });
});
