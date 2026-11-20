import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/testApp.js';

describe('Fidelización 7+1, Pagos Manuales y Finanzas', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('no otorga sello a lavadas pendientes/rechazadas; otorga 1 sello por lavada pagada, habilita premio 7+1 y valida vigencia al redimir', async () => {
    // 1. Crear una lavada pendiente y tratar de sellarla -> 409
    const pendingWash = await request(ctx.app)
      .post('/api/v1/wash-requests')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .set('X-Idempotency-Key', 'idem-loyalty-pend-001')
      .send({
        customerId: ctx.clienteId,
        motorcycleId: ctx.motoId,
        serviceId: ctx.serviceId,
        price: 7000,
      });
    const pendingId = pendingWash.body.data.id as string;

    const badStamp = await request(ctx.app)
      .post('/api/v1/loyalty/stamps')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .set('X-Idempotency-Key', 'idem-stamp-pending-001')
      .send({ washRequestId: pendingId });
    expect(badStamp.status).toBe(409);

    // 2. Rechazar métodos de pago con tarjeta o pasarela
    const confirmPending = await request(ctx.app)
      .post(`/api/v1/wash-requests/${pendingId}/confirm`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .set('X-Idempotency-Key', 'idem-conf-pay-00001');
    expect(confirmPending.status).toBe(200);

    const invalidCardPayment = await request(ctx.app)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .set('X-Idempotency-Key', 'idem-pay-card-00001')
      .send({
        washRequestId: pendingId,
        method: 'Tarjeta',
        amount: 7000,
      });
    expect(invalidCardPayment.status).toBe(422);

    // 3. Completar y pagar 7 lavadas con Efectivo, Nequi y Daviplata
    const methods = ['Efectivo', 'Nequi', 'Daviplata'] as const;
    let lastCardRewards: Array<{ id: string; status: string }> = [];

    for (let i = 1; i <= 7; i += 1) {
      let washId = pendingId;
      if (i > 1) {
        const w = await request(ctx.app)
          .post('/api/v1/wash-requests')
          .set('Authorization', `Bearer ${ctx.adminToken}`)
          .set('X-Idempotency-Key', `idem-loy-w-000000${i}`)
          .send({
            customerId: ctx.clienteId,
            motorcycleId: ctx.motoId,
            serviceId: ctx.serviceId,
            price: 7000,
          });
        washId = w.body.data.id as string;

        await request(ctx.app)
          .post(`/api/v1/wash-requests/${washId}/confirm`)
          .set('Authorization', `Bearer ${ctx.clienteToken}`)
          .set('X-Idempotency-Key', `idem-loy-c-000000${i}`);
      }

      await request(ctx.app)
        .patch(`/api/v1/wash-requests/${washId}/status`)
        .set('Authorization', `Bearer ${ctx.lavadorToken}`)
        .send({ status: 'ready' });

      const payRes = await request(ctx.app)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${ctx.adminToken}`)
        .set('X-Idempotency-Key', `idem-loy-p-000000${i}`)
        .send({
          washRequestId: washId,
          method: methods[i % 3],
          amount: 7000,
        });
      expect(payRes.status).toBe(201);

      const stampRes = await request(ctx.app)
        .post('/api/v1/loyalty/stamps')
        .set('Authorization', `Bearer ${ctx.adminToken}`)
        .set('X-Idempotency-Key', `idem-loy-s-000000${i}`)
        .send({ washRequestId: washId });
      expect(stampRes.status).toBe(201);
      expect(stampRes.body.data.stamps).toBe(i === 7 ? 0 : i);
      expect(stampRes.body.data.completedWashes).toBe(i);
      lastCardRewards = stampRes.body.data.rewards;

      // Sello duplicado con otra key falla con 409
      const dupStamp = await request(ctx.app)
        .post('/api/v1/loyalty/stamps')
        .set('Authorization', `Bearer ${ctx.adminToken}`)
        .set('X-Idempotency-Key', `idem-loy-dup-0000${i}`)
        .send({ washRequestId: washId });
      expect(dupStamp.status).toBe(409);
    }

    expect(lastCardRewards.length).toBe(1);
    expect(lastCardRewards[0]!.status).toBe('available');
    const rewardId = lastCardRewards[0]!.id;

    // 4. Cita de premio fuera de validFrom..validUntil falla
    const outOfWindowAppt = await request(ctx.app)
      .post('/api/v1/appointments')
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({
        customerId: ctx.clienteId,
        motorcycleId: ctx.motoId,
        serviceId: ctx.serviceId,
        startAt: '2028-01-15T10:00:00-05:00',
        isLoyaltyRedemption: true,
      });
    expect(outOfWindowAppt.status).toBe(409);

    // 5. Redimir dentro del periodo funciona
    const redeemRes = await request(ctx.app)
      .post(`/api/v1/loyalty/rewards/${rewardId}/redeem`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .set('X-Idempotency-Key', 'idem-redeem-reward-01')
      .send({});
    expect(redeemRes.status).toBe(200);
    expect(redeemRes.body.data.rewards[0].status).toBe('redeemed');
    expect(redeemRes.body.data.stamps).toBe(0);

    // 6. Gastos e ingresos
    const expenseRes = await request(ctx.app)
      .post('/api/v1/expenses')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        category: 'Jabon',
        description: 'Garrafa 20L shampoo neutro',
        amount: 65000,
        occurredAt: '2026-11-18T10:00:00-05:00',
      });
    expect(expenseRes.status).toBe(201);
  });
});
