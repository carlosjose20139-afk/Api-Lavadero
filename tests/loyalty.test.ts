import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { createDatabase } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrator.js';
import {
  parseBogotaRewardDate,
  sanitizeAndAssertSafeLoyaltyText,
} from '../src/modules/loyalty/loyalty.service.js';
import { expireOutdatedLoyaltyRewardsDetailed } from '../src/services/scheduler.service.js';
import { hashPassword, newUuid } from '../src/utils/crypto.js';
import { AppError } from '../src/utils/response.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';

async function createPaidWash(
  ctx: TestContext,
  params: {
    customerId: string;
    motorcycleId: string;
    customerToken: string;
    keyPrefix: string;
    price?: number;
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
    .send({ status: 'ready' });
  expect(ready.status).toBe(200);

  const pay = await request(ctx.app)
    .post('/api/v1/payments')
    .set('Authorization', `Bearer ${ctx.adminToken}`)
    .set('X-Idempotency-Key', `${params.keyPrefix}-py`)
    .send({
      washRequestId: washId,
      method: 'Efectivo',
      amount: price,
    });
  expect(pay.status).toBe(201);

  return washId;
}

describe('Módulo de Fidelización 7+1: Pruebas unitarias, integración, RBAC, idempotencia y migraciones', () => {
  let ctx: TestContext;
  let customer2Id: string;
  let customer2Token: string;
  let customer2MotoId: string;

  beforeAll(async () => {
    ctx = await createTestContext();

    // Creamos un segundo cliente y su moto para pruebas de aislamiento RBAC, filtros y cross-customer
    const c2Res = await request(ctx.app)
      .post('/api/v1/customers')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        name: 'Laura Rider',
        username: 'laura.rider',
        password: 'Cliente2Pass*',
      });
    expect(c2Res.status).toBe(201);
    customer2Id = c2Res.body.data.id as string;

    const c2Moto = await request(ctx.app)
      .post('/api/v1/motorcycles')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        brand: 'Suzuki',
        model: 'Gixxer 150',
        cc: 155,
        customerId: customer2Id,
      });
    expect(c2Moto.status).toBe(201);
    customer2MotoId = c2Moto.body.data.id as string;

    const c2Login = await request(ctx.app)
      .post('/api/v1/auth/login')
      .send({ username: 'laura.rider', password: 'Cliente2Pass*' });
    expect(c2Login.status).toBe(200);
    customer2Token = c2Login.body.data.accessToken as string;
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('unitarias: sanitiza textos contra HTML/XSS e interpreta fechas en America/Bogota con validaciones estrictas', () => {
    expect(
      sanitizeAndAssertSafeLoyaltyText('  Lavada gratis especial  ', 'title', 160, true),
    ).toBe('Lavada gratis especial');

    expect(() =>
      sanitizeAndAssertSafeLoyaltyText('<script>alert(1)</script>', 'title', 160, true),
    ).toThrowError(AppError);

    expect(() =>
      sanitizeAndAssertSafeLoyaltyText('javascript:alert(1)', 'reason', 500, false),
    ).toThrowError(AppError);

    const parsedDateOnlyStart = parseBogotaRewardDate('2026-12-01', 'validFrom', false);
    expect(parsedDateOnlyStart.toISOString()).toBe('2026-12-01T05:00:00.000Z');

    const parsedDateOnlyEnd = parseBogotaRewardDate('2026-12-01', 'validUntil', true);
    expect(parsedDateOnlyEnd.toISOString()).toBe('2026-12-02T04:59:59.999Z');

    expect(() =>
      parseBogotaRewardDate('2026-02-30T10:00:00-05:00', 'validFrom', false),
    ).toThrowError(AppError);
  });

  it('1, 2, 3 y 10: Cliente consulta su tarjeta con QR con expiración, no ve la de otro, y Admin consulta todos los clientes', async () => {
    // Sin sesión -> 401
    const unauthMe = await request(ctx.app).get('/api/v1/loyalty/me');
    expect(unauthMe.status).toBe(401);

    // 1. Cliente consulta su tarjeta
    const meRes = await request(ctx.app)
      .get('/api/v1/loyalty/me')
      .set('Authorization', `Bearer ${ctx.clienteToken}`);
    expect(meRes.status).toBe(200);
    expect(meRes.body.data.customerId).toBe(ctx.clienteId);
    expect(meRes.body.data.stamps).toBe(0);
    expect(meRes.body.data.completedWashes).toBe(0);
    expect(typeof meRes.body.data.qrToken).toBe('string');
    expect(meRes.body.data.qrTokenExpiresAt).toBeTruthy();

    // Si el QR ya expiró, GET /loyalty/me lo rota automáticamente
    const oldToken = meRes.body.data.qrToken as string;
    await ctx.db.query(
      `UPDATE loyalty_cards SET qr_token_expires_at = NOW() - INTERVAL '5 minutes' WHERE customer_id = $1`,
      [ctx.clienteId],
    );
    const rotatedRes = await request(ctx.app)
      .get('/api/v1/loyalty/me')
      .set('Authorization', `Bearer ${ctx.clienteToken}`);
    expect(rotatedRes.status).toBe(200);
    expect(rotatedRes.body.data.qrToken).not.toBe(oldToken);

    // 3. Cliente no puede consultar tarjeta/recompensas/detalle/listado de otro cliente
    const otherRewards = await request(ctx.app)
      .get(`/api/v1/loyalty/rewards?customerId=${customer2Id}`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`);
    expect(otherRewards.status).toBe(403);

    const clientListCustomers = await request(ctx.app)
      .get('/api/v1/loyalty/customers')
      .set('Authorization', `Bearer ${ctx.clienteToken}`);
    expect(clientListCustomers.status).toBe(403);

    const clientDetailOther = await request(ctx.app)
      .get(`/api/v1/loyalty/customers/${customer2Id}`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`);
    expect(clientDetailOther.status).toBe(403);

    // 10. Cliente no puede otorgar sellos ni asignarse recompensas
    const clientSelfReward = await request(ctx.app)
      .post(`/api/v1/loyalty/customers/${ctx.clienteId}/rewards`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({
        title: 'Auto premio',
        validFrom: '2026-11-19T00:00:00-05:00',
        validUntil: '2026-11-25T23:59:59-05:00',
      });
    expect(clientSelfReward.status).toBe(403);

    // 2. Administrador consulta todos los clientes con filtros y ordenamiento
    const adminList = await request(ctx.app)
      .get('/api/v1/loyalty/customers?search=Laura&status=all&sort=newest&page=1&pageSize=10')
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(adminList.status).toBe(200);
    expect(adminList.body.meta.total).toBe(1);
    expect(adminList.body.data[0].customerId).toBe(customer2Id);
    expect(adminList.body.data[0].customerName).toBe('Laura Rider');
  });

  it('4, 5, 6, 7, 8 y 18: sello por lavada pagada, rechaza no pagada, evita duplicados, ciclo 7->0 y notificaciones solo al customerId', async () => {
    // 5. Lavada pendiente no puede sellarse
    const pendingWr = await request(ctx.app)
      .post('/api/v1/wash-requests')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .set('X-Idempotency-Key', 'idem-loy2-pend-0001')
      .send({
        customerId: ctx.clienteId,
        motorcycleId: ctx.motoId,
        serviceId: ctx.serviceId,
        price: 7000,
      });
    expect(pendingWr.status).toBe(201);
    const pendingId = pendingWr.body.data.id as string;

    const rejectUnpaid = await request(ctx.app)
      .post(`/api/v1/loyalty/customers/${ctx.clienteId}/stamps`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .set('Idempotency-Key', 'idem-loy2-unpaid-001')
      .send({ washRequestId: pendingId, reason: 'Intento sin pago' });
    expect(rejectUnpaid.status).toBe(409);
    expect(rejectUnpaid.body.data.code).toBe('WASH_NOT_PAID');

    // No permitir usar una lavada de Mateo como sello de Laura (cross-customer)
    const crossCustomer = await request(ctx.app)
      .post(`/api/v1/loyalty/customers/${customer2Id}/stamps`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .set('Idempotency-Key', 'idem-loy2-cross-0001')
      .send({ washRequestId: pendingId });
    expect(crossCustomer.status).toBe(409);
    expect(crossCustomer.body.data.code).toBe('WASH_CUSTOMER_MISMATCH');

    // 4 y 6. Sellar 7 lavadas pagadas (probando Idempotency-Key estándar en #1 y replay idempotente)
    let seventhStampId = '';
    for (let i = 1; i <= 7; i += 1) {
      const washId = await createPaidWash(ctx, {
        customerId: ctx.clienteId,
        motorcycleId: ctx.motoId,
        customerToken: ctx.clienteToken,
        keyPrefix: `idem-loy2-c1-${String(i).padStart(2, '0')}`,
      });

      const key = `idem-loy2-st-00000${i}`;
      const endpoint =
        i % 2 === 0
          ? `/api/v1/loyalty/customers/${ctx.clienteId}/stamps`
          : '/api/v1/loyalty/stamps';
      const bodyPayload =
        i % 2 === 0
          ? { washRequestId: washId, reason: `Sello #${i} en mostrador` }
          : { washRequestId: washId };

      const stampRes = await request(ctx.app)
        .post(endpoint)
        .set('Authorization', `Bearer ${i === 1 ? ctx.lavadorToken : ctx.adminToken}`)
        .set('Idempotency-Key', key)
        .send(bodyPayload);
      expect(stampRes.status).toBe(201);
      expect(stampRes.body.data.completedWashes).toBe(i);
      if (i < 7) {
        expect(stampRes.body.data.stamps).toBe(i);
      } else {
        // 7 y 8: Al séptimo sello se crea recompensa y stamps vuelve a 0 conservando completedWashes = 7
        expect(stampRes.body.data.stamps).toBe(0);
        expect(stampRes.body.data.rewardCreated).toBeTruthy();
        expect(stampRes.body.data.rewardCreated.status).toBe('available');
        expect(stampRes.body.data.rewards.some((r: { status: string }) => r.status === 'available')).toBe(true);
        seventhStampId = (stampRes.body.data.lastStamp?.id ?? stampRes.body.data.stamp?.id) as string;
      }

      // Replay con la misma Idempotency-Key devuelve el mismo resultado sin duplicar
      const replayRes = await request(ctx.app)
        .post(endpoint)
        .set('Authorization', `Bearer ${i === 1 ? ctx.lavadorToken : ctx.adminToken}`)
        .set('Idempotency-Key', key)
        .send(bodyPayload);
      expect(replayRes.status).toBe(201);
      expect(replayRes.body.data.completedWashes).toBe(i);

      // 6. Otra key con mismo washRequestId falla con 409 DUPLICATE_STAMP
      const dupRes = await request(ctx.app)
        .post(endpoint)
        .set('Authorization', `Bearer ${ctx.adminToken}`)
        .set('Idempotency-Key', `idem-loy2-dup-0000${i}`)
        .send(bodyPayload);
      expect(dupRes.status).toBe(409);
      expect(dupRes.body.data.code).toBe('DUPLICATE_STAMP');
    }

    expect(seventhStampId).toBeTruthy();

    // 18. Verificar que las notificaciones de sello/recompensa llegaron al customerId y NO al admin
    const mateoNotifs = await request(ctx.app)
      .get('/api/v1/notifications?page=1&pageSize=50')
      .set('Authorization', `Bearer ${ctx.clienteToken}`);
    expect(mateoNotifs.status).toBe(200);
    const notifTypes = (mateoNotifs.body.data as Array<{ type: string; userId: string }>).map(
      (n) => n.type,
    );
    expect(notifTypes).toContain('loyalty_stamp_created');
    expect(notifTypes).toContain('reward_assigned');
    for (const n of mateoNotifs.body.data as Array<{ userId: string }>) {
      expect(n.userId).toBe(ctx.clienteId);
    }

    const adminNotifs = await request(ctx.app)
      .get('/api/v1/notifications?page=1&pageSize=50')
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    const adminRewardNotifs = (
      adminNotifs.body.data as Array<{ type: string }>
    ).filter((n) => n.type === 'reward_assigned' || n.type === 'loyalty_stamp_created');
    expect(adminRewardNotifs.length).toBe(0);
  });

  it('9, 11, 12, 13, 14, 15, 16, 17 y 19: recompensa manual, reversión de sello, bloqueo si redimida, redención, expiración, cancelación y auditoría', async () => {
    // A) 11. Reversión de un sello que generó recompensa available (la cancela y devuelve stamps a 6)
    const detailBeforeRev = await request(ctx.app)
      .get(`/api/v1/loyalty/customers/${ctx.clienteId}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(detailBeforeRev.status).toBe(200);
    const latestStampId = detailBeforeRev.body.data.stampsHistory[0].id as string;

    // Lavador NO puede revertir sello (solo Admin)
    const lavadorRev = await request(ctx.app)
      .delete(`/api/v1/loyalty/customers/${ctx.clienteId}/stamps/${latestStampId}`)
      .set('Authorization', `Bearer ${ctx.lavadorToken}`)
      .send({ reason: 'Intento lavador' });
    expect(lavadorRev.status).toBe(403);

    const revRes = await request(ctx.app)
      .delete(`/api/v1/loyalty/customers/${ctx.clienteId}/stamps/${latestStampId}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ reason: 'Sello registrado por error' });
    expect(revRes.status).toBe(200);
    expect(revRes.body.data.stamp.status).toBe('reversed');
    expect(revRes.body.data.card.stamps).toBe(6);
    expect(revRes.body.data.card.completedWashes).toBe(6);
    expect(revRes.body.data.revertedReward.status).toBe('cancelled');

    // No se puede revertir el mismo sello dos veces
    const revAgain = await request(ctx.app)
      .delete(`/api/v1/loyalty/customers/${ctx.clienteId}/stamps/${latestStampId}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(revAgain.status).toBe(409);

    // Volvemos a otorgar el 7° sello sobre una nueva lavada pagada y esta vez lo REDIMIMOS para probar #12, #13, #15
    const wash7b = await createPaidWash(ctx, {
      customerId: ctx.clienteId,
      motorcycleId: ctx.motoId,
      customerToken: ctx.clienteToken,
      keyPrefix: 'idem-loy2-7b-001',
    });
    const stamp7b = await request(ctx.app)
      .post(`/api/v1/loyalty/customers/${ctx.clienteId}/stamps`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .set('Idempotency-Key', 'idem-loy2-7b-stamp-1')
      .send({ washRequestId: wash7b, reason: 'Séptimo sello válido' });
    expect(stamp7b.status).toBe(201);
    expect(stamp7b.body.data.stamps).toBe(0);
    const stamp7bId = stamp7b.body.data.stamp.id as string;
    const reward7bId = stamp7b.body.data.rewardCreated.id as string;

    // 13. Cliente redime recompensa disponible con cita dentro del rango
    const apptInWindow = await request(ctx.app)
      .post('/api/v1/appointments')
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({
        customerId: ctx.clienteId,
        motorcycleId: ctx.motoId,
        serviceId: ctx.serviceId,
        startAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 11) + '10:00:00-05:00',
        isLoyaltyRedemption: true,
      });
    // Si por fin de semana/festivo no pudo agendar en exactamente +2d, probamos redención directa sin cita o ajustando día hábil
    const apptId =
      apptInWindow.status === 201 ? (apptInWindow.body.data.id as string) : undefined;

    // Otro cliente NO puede redimir recompensa ajena -> 403
    const otherRedeem = await request(ctx.app)
      .post(`/api/v1/loyalty/rewards/${reward7bId}/redeem`)
      .set('Authorization', `Bearer ${customer2Token}`)
      .set('Idempotency-Key', 'idem-loy2-oth-redeem1')
      .send({});
    expect(otherRedeem.status).toBe(403);

    const redeem7b = await request(ctx.app)
      .post(`/api/v1/loyalty/rewards/${reward7bId}/redeem`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .set('Idempotency-Key', 'idem-loy2-redeem-7b')
      .send(apptId ? { appointmentId: apptId } : {});
    expect(redeem7b.status).toBe(200);

    // Reflejo inmediato en GET /loyalty/me
    const meAfterRedeem = await request(ctx.app)
      .get('/api/v1/loyalty/me')
      .set('Authorization', `Bearer ${ctx.clienteToken}`);
    const redeemedItem = (
      meAfterRedeem.body.data.rewards as Array<{ id: string; status: string }>
    ).find((r) => r.id === reward7bId);
    expect(redeemedItem?.status).toBe('redeemed');

    // 15. No se permiten dos redenciones de la misma recompensa (con distinta key -> 409)
    const doubleRedeem = await request(ctx.app)
      .post(`/api/v1/loyalty/rewards/${reward7bId}/redeem`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .set('Idempotency-Key', 'idem-loy2-redeem-dup')
      .send({});
    expect(doubleRedeem.status).toBe(409);
    expect(doubleRedeem.body.data.code).toBe('REWARD_ALREADY_REDEEMED');

    // 12. No se puede revertir un sello cuya recompensa ya fue redimida
    const revRedeemedStamp = await request(ctx.app)
      .delete(`/api/v1/loyalty/customers/${ctx.clienteId}/stamps/${stamp7bId}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ reason: 'Intento ilegal sobre recompensa redimida' });
    expect(revRedeemedStamp.status).toBe(409);
    expect(revRedeemedStamp.body.data.code).toBe('REWARD_ALREADY_REDEEMED');

    // Tampoco se puede cancelar una recompensa ya redimida
    const cancelRedeemed = await request(ctx.app)
      .delete(`/api/v1/loyalty/rewards/${reward7bId}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(cancelRedeemed.status).toBe(409);
    expect(cancelRedeemed.body.data.code).toBe('REWARD_ALREADY_REDEEMED');

    // B) 9. Administrador asigna recompensa manual (validaciones de fecha, rango máximo, HTML)
    const badRange = await request(ctx.app)
      .post(`/api/v1/loyalty/customers/${customer2Id}/rewards`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        title: 'Premio inválido',
        validFrom: '2026-12-10T00:00:00-05:00',
        validUntil: '2026-12-05T23:59:59-05:00',
      });
    expect(badRange.status).toBe(422);

    const tooLong = await request(ctx.app)
      .post(`/api/v1/loyalty/customers/${customer2Id}/rewards`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        title: 'Premio eterno',
        validFrom: '2026-12-01T00:00:00-05:00',
        validUntil: '2028-12-01T23:59:59-05:00',
      });
    expect(tooLong.status).toBe(422);
    expect(tooLong.body.data.code).toBe('VALIDITY_WINDOW_TOO_LONG');

    // Recompensa manual futura (aún no inicia -> 14. redención fuera de vigencia antes de validFrom falla con 409)
    const futureFrom = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    const futureUntil = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
    const manualFuture = await request(ctx.app)
      .post(`/api/v1/loyalty/customers/${customer2Id}/rewards`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        title: 'Lavada VIP futura',
        validFrom: futureFrom,
        validUntil: futureUntil,
        reason: 'Premio especial autorizado por administración',
      });
    expect(manualFuture.status).toBe(201);
    const futureRewardId = manualFuture.body.data.id as string;

    // Verificar que no modificó stamps de customer2
    const c2Me = await request(ctx.app)
      .get('/api/v1/loyalty/me')
      .set('Authorization', `Bearer ${customer2Token}`);
    expect(c2Me.body.data.stamps).toBe(0);

    // 14. Redimir antes de validFrom -> 409 REWARD_NOT_YET_VALID
    const redeemTooEarly = await request(ctx.app)
      .post(`/api/v1/loyalty/rewards/${futureRewardId}/redeem`)
      .set('Authorization', `Bearer ${customer2Token}`)
      .set('Idempotency-Key', 'idem-loy2-early-001')
      .send({});
    expect(redeemTooEarly.status).toBe(409);
    expect(redeemTooEarly.body.data.code).toBe('REWARD_NOT_YET_VALID');

    // 17. Cancelar esa recompensa y confirmar que luego NO se puede redimir
    const cancelFuture = await request(ctx.app)
      .delete(`/api/v1/loyalty/rewards/${futureRewardId}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ reason: 'Anulada por cambio de campaña' });
    expect(cancelFuture.status).toBe(200);
    expect(cancelFuture.body.data.status).toBe('cancelled');

    const redeemCancelled = await request(ctx.app)
      .post(`/api/v1/loyalty/rewards/${futureRewardId}/redeem`)
      .set('Authorization', `Bearer ${customer2Token}`)
      .set('Idempotency-Key', 'idem-loy2-canc-0001')
      .send({});
    expect(redeemCancelled.status).toBe(409);
    expect(redeemCancelled.body.data.code).toBe('REWARD_CANCELLED');

    // C) 16. Expiración de recompensas (POST /api/v1/loyalty/expire e idempotencia)
    const pastFrom = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const pastUntil = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const manualPast = await request(ctx.app)
      .post(`/api/v1/loyalty/customers/${customer2Id}/rewards`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        title: 'Lavada vencida test',
        validFrom: pastFrom,
        validUntil: pastUntil,
        reason: 'Prueba de expiración',
      });
    expect(manualPast.status).toBe(201);
    const pastRewardId = manualPast.body.data.id as string;

    const expireRes = await request(ctx.app)
      .post('/api/v1/loyalty/expire')
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(expireRes.status).toBe(200);
    expect(expireRes.body.data.expiredCount).toBe(1);
    expect(expireRes.body.data.expiredRewardIds).toContain(pastRewardId);

    // Segunda llamada es idempotente (0 expiradas)
    const expireAgain = await request(ctx.app)
      .post('/api/v1/loyalty/expire')
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(expireAgain.status).toBe(200);
    expect(expireAgain.body.data.expiredCount).toBe(0);

    // También comprobamos expireOutdatedLoyaltyRewardsDetailed directamente
    const directSchedulerRes = await expireOutdatedLoyaltyRewardsDetailed(ctx.db);
    expect(directSchedulerRes.expiredCount).toBe(0);

    // Intentar redimir o cancelar una recompensa expired -> 409
    const redeemExpired = await request(ctx.app)
      .post(`/api/v1/loyalty/rewards/${pastRewardId}/redeem`)
      .set('Authorization', `Bearer ${customer2Token}`)
      .set('Idempotency-Key', 'idem-loy2-exp-00001')
      .send({});
    expect(redeemExpired.status).toBe(409);
    expect(redeemExpired.body.data.code).toBe('REWARD_EXPIRED');

    const cancelExpired = await request(ctx.app)
      .delete(`/api/v1/loyalty/rewards/${pastRewardId}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(cancelExpired.status).toBe(409);
    expect(cancelExpired.body.data.code).toBe('REWARD_ALREADY_EXPIRED');

    // GET /loyalty/rewards con filtro status=cancelled para customer2
    const filteredRewards = await request(ctx.app)
      .get('/api/v1/loyalty/rewards?status=cancelled')
      .set('Authorization', `Bearer ${customer2Token}`);
    expect(filteredRewards.status).toBe(200);
    expect(filteredRewards.body.data[0].rewards.length).toBe(1);
    expect(filteredRewards.body.data[0].rewards[0].id).toBe(futureRewardId);

    // 19. Auditoría completa visible en GET /loyalty/customers/:customerId y en audit_logs
    const detailFinal = await request(ctx.app)
      .get(`/api/v1/loyalty/customers/${ctx.clienteId}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(detailFinal.status).toBe(200);
    expect(detailFinal.body.data.stamps).toBe(0);
    expect(detailFinal.body.data.completedWashes).toBe(7);
    expect(detailFinal.body.data.stampsHistory.length).toBe(8);
    expect(detailFinal.body.data.rewards.redeemed.length).toBe(1);
    expect(detailFinal.body.data.rewards.cancelled.length).toBe(1);

    const actionsMateo = (
      detailFinal.body.data.audit as Array<{ action: string }>
    ).map((a) => a.action);
    expect(actionsMateo).toContain('loyalty_stamp_created');
    expect(actionsMateo).toContain('loyalty_stamp_reversed');
    expect(actionsMateo).toContain('loyalty_reward_created');
    expect(actionsMateo).toContain('loyalty_reward_cancelled');
    expect(actionsMateo).toContain('loyalty_reward_redeemed');

    const detailC2 = await request(ctx.app)
      .get(`/api/v1/loyalty/customers/${customer2Id}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    const actionsC2 = (
      detailC2.body.data.audit as Array<{ action: string }>
    ).map((a) => a.action);
    expect(actionsC2).toContain('loyalty_reward_created');
    expect(actionsC2).toContain('loyalty_reward_cancelled');
    expect(actionsC2).toContain('loyalty_reward_expired');

    // Verificar también en audit_logs global
    const globalAuditRes = await ctx.db.query<{ action: string }>(
      `SELECT DISTINCT action FROM audit_logs WHERE action LIKE 'loyalty_%'`,
    );
    const globalActions = globalAuditRes.rows.map((r) => r.action);
    expect(globalActions).toContain('loyalty_stamp_created');
    expect(globalActions).toContain('loyalty_stamp_reversed');
    expect(globalActions).toContain('loyalty_reward_created');
    expect(globalActions).toContain('loyalty_reward_redeemed');
    expect(globalActions).toContain('loyalty_reward_cancelled');
    expect(globalActions).toContain('loyalty_reward_expired');
  });

  it('20, 21 y 22: migración 006 funciona en base limpia, en base existente haciendo backfill y OpenAPI documenta las nuevas rutas', async () => {
    // 20. Base limpia completa
    const cleanDb = createDatabase({ pgliteDir: ':memory:' });
    const appliedClean = await runMigrations(cleanDb);
    expect(appliedClean).toContain('006_loyalty_lifecycle.sql');
    const cardCols = await cleanDb.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'loyalty_cards'`,
    );
    expect(cardCols.rows.map((r) => r.column_name)).toContain('qr_token_expires_at');
    expect(cardCols.rows.map((r) => r.column_name)).toContain('id');
    await cleanDb.close();

    // 21. Base existente (migrada hasta 005 con datos legacy de fidelización)
    const existingDb = createDatabase({ pgliteDir: ':memory:' });
    const migrationsDir = path.resolve(process.cwd(), 'migrations');
    for (const file of [
      '001_initial_schema.sql',
      '002_seed_shop_defaults.sql',
      '003_motorcycle_decoupling.sql',
      '004_promotions_lifecycle.sql',
      '005_forum_replies_audit.sql',
    ]) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      await existingDb.exec(sql);
      await existingDb.query(`INSERT INTO schema_migrations (version) VALUES ($1)`, [
        file,
      ]);
    }

    const legacyCustomerId = newUuid();
    const legacyAdminId = newUuid();
    const legacyMotoId = newUuid();
    const legacyServiceId = newUuid();
    const legacyWashId = newUuid();
    const legacyStampId = newUuid();
    const legacyRewardId = newUuid();
    const pwdHash = await hashPassword('LegacyPass123*');

    await existingDb.query(
      `INSERT INTO users (id, name, username, password_hash, role, is_active)
       VALUES ($1, 'Legacy Admin', 'legacy.admin', $3, 'Administrador', TRUE),
              ($2, 'Legacy Client', 'legacy.client', $3, 'Cliente', TRUE)`,
      [legacyAdminId, legacyCustomerId, pwdHash],
    );
    await existingDb.query(
      `INSERT INTO motorcycles (id, customer_id, brand, model, cc)
       VALUES ($1, $2, 'Honda', 'CB 125F', 125)`,
      [legacyMotoId, legacyCustomerId],
    );
    await existingDb.query(
      `INSERT INTO services (id, name, description, price, duration_minutes)
       VALUES ($1, 'Lavada Legacy', 'Prueba', 7000, 30)`,
      [legacyServiceId],
    );
    await existingDb.query(
      `INSERT INTO wash_requests (id, customer_id, motorcycle_id, service_id, base_price, price, expires_at, status)
       VALUES ($1, $2, $3, $4, 7000, 7000, NOW() + INTERVAL '15 minutes', 'paid')`,
      [legacyWashId, legacyCustomerId, legacyMotoId, legacyServiceId],
    );
    await existingDb.query(
      `INSERT INTO loyalty_cards (customer_id, stamps, completed_washes, qr_token)
       VALUES ($1, 1, 1, 'LM-LEGACY-QR-001')`,
      [legacyCustomerId],
    );
    await existingDb.query(
      `INSERT INTO loyalty_stamps (id, customer_id, wash_request_id, granted_by)
       VALUES ($1, $2, $3, $4)`,
      [legacyStampId, legacyCustomerId, legacyWashId, legacyAdminId],
    );
    await existingDb.query(
      `INSERT INTO loyalty_rewards (id, customer_id, title, valid_from, valid_until, status)
       VALUES ($1, $2, 'Premio Legacy', NOW(), NOW() + INTERVAL '7 days', 'available')`,
      [legacyRewardId, legacyCustomerId],
    );

    const appliedUpgrade = await runMigrations(existingDb);
    expect(appliedUpgrade).toContain('006_loyalty_lifecycle.sql');

    const backfilledStamp = await existingDb.query<{
      loyalty_card_id: string | null;
      actor_id: string | null;
      status: string;
    }>(`SELECT loyalty_card_id, actor_id, status FROM loyalty_stamps WHERE id = $1`, [
      legacyStampId,
    ]);
    expect(backfilledStamp.rows[0]?.loyalty_card_id).toBeTruthy();
    expect(backfilledStamp.rows[0]?.actor_id).toBe(legacyAdminId);
    expect(backfilledStamp.rows[0]?.status).toBe('active');
    await existingDb.close();

    // 22. OpenAPI declara todas las rutas y esquemas de Fidelización
    const specRaw = fs.readFileSync(
      path.resolve(process.cwd(), 'docs/api/openapi.yaml'),
      'utf8',
    );
    const spec = YAML.parse(specRaw) as {
      paths: Record<string, Record<string, unknown>>;
    };
    expect(spec.paths['/loyalty/me']?.get).toBeTruthy();
    expect(spec.paths['/loyalty/stamps']?.post).toBeTruthy();
    expect(spec.paths['/loyalty/rewards']?.get).toBeTruthy();
    expect(spec.paths['/loyalty/rewards/{id}']?.delete).toBeTruthy();
    expect(spec.paths['/loyalty/rewards/{id}/redeem']?.post).toBeTruthy();
    expect(spec.paths['/loyalty/customers']?.get).toBeTruthy();
    expect(spec.paths['/loyalty/customers/{customerId}']?.get).toBeTruthy();
    expect(spec.paths['/loyalty/customers/{customerId}/stamps']?.post).toBeTruthy();
    expect(spec.paths['/loyalty/customers/{customerId}/stamps/{stampId}']?.delete).toBeTruthy();
    expect(spec.paths['/loyalty/customers/{customerId}/rewards']?.post).toBeTruthy();
    expect(spec.paths['/loyalty/expire']?.post).toBeTruthy();
  });
});
