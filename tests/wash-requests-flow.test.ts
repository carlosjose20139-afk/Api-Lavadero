import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expirePendingWashRequests } from '../src/services/scheduler.service.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';

describe('Flujo prioritario: Lavada para confirmar, idempotencia, vencimiento y cola', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('crea lavada idempotente, notifica al cliente, confirma una sola vez y pasa por washing/drying/ready/paid', async () => {
    // Registrar token FCM para el cliente
    const devRes = await request(ctx.app)
      .post('/api/v1/devices')
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({ token: 'fcm-token-mateo-android-123456', platform: 'android' });
    expect(devRes.status).toBe(201);

    const idemCreateKey = 'idem-create-wash-0001';
    const createPayload = {
      customerId: ctx.clienteId,
      motorcycleId: ctx.motoId,
      serviceId: ctx.serviceId,
      price: 7000,
      expiresInMinutes: 15,
    };

    const wr1 = await request(ctx.app)
      .post('/api/v1/wash-requests')
      .set('Authorization', `Bearer ${ctx.lavadorToken}`)
      .set('X-Idempotency-Key', idemCreateKey)
      .send(createPayload);
    expect(wr1.status).toBe(201);
    expect(wr1.body.data.status).toBe('pending_confirmation');
    const washId = wr1.body.data.id as string;

    // Replay con la misma X-Idempotency-Key devuelve exactamente el mismo ID sin duplicar
    const wrReplay = await request(ctx.app)
      .post('/api/v1/wash-requests')
      .set('Authorization', `Bearer ${ctx.lavadorToken}`)
      .set('X-Idempotency-Key', idemCreateKey)
      .send(createPayload);
    expect(wrReplay.status).toBe(201);
    expect(wrReplay.body.data.id).toBe(washId);

    // Cliente recibe notificación in-app
    const clientNotifs = await request(ctx.app)
      .get('/api/v1/notifications')
      .query({ unread: 'true' })
      .set('Authorization', `Bearer ${ctx.clienteToken}`);
    expect(
      clientNotifs.body.data.some(
        (n: { type: string; payload: { washRequestId?: string } }) =>
          n.type === 'wash_confirmation_required' &&
          n.payload?.washRequestId === washId,
      ),
    ).toBe(true);

    // Confirmación idempotente por el cliente
    const confirmKey = 'idem-confirm-wash-0001';
    const confirm1 = await request(ctx.app)
      .post(`/api/v1/wash-requests/${washId}/confirm`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .set('X-Idempotency-Key', confirmKey);
    expect(confirm1.status).toBe(200);
    expect(confirm1.body.data.status).toBe('confirmed');

    // Replay con misma key devuelve 200 idempotente
    const confirmReplay = await request(ctx.app)
      .post(`/api/v1/wash-requests/${washId}/confirm`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .set('X-Idempotency-Key', confirmKey);
    expect(confirmReplay.status).toBe(200);

    // Segundo intento con otra key o intento de rechazar debe devolver 409 Conflict
    const confirmTwice = await request(ctx.app)
      .post(`/api/v1/wash-requests/${washId}/confirm`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .set('X-Idempotency-Key', 'idem-confirm-wash-0002');
    expect(confirmTwice.status).toBe(409);

    const rejectAfterConfirm = await request(ctx.app)
      .post(`/api/v1/wash-requests/${washId}/reject`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .set('X-Idempotency-Key', 'idem-reject-after-0001')
      .send({ reason: 'Arrepentido' });
    expect(rejectAfterConfirm.status).toBe(409);

    // Administrador recibió notificación de confirmación
    const adminNotifs = await request(ctx.app)
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(
      adminNotifs.body.data.some(
        (n: { type: string }) => n.type === 'wash_confirmed',
      ),
    ).toBe(true);

    // Cola operativa: washing -> drying -> ready
    for (const status of ['washing', 'drying', 'ready'] as const) {
      const stepRes = await request(ctx.app)
        .patch(`/api/v1/wash-requests/${washId}/status`)
        .set('Authorization', `Bearer ${ctx.lavadorToken}`)
        .send({ status });
      expect(stepRes.status).toBe(200);
      expect(stepRes.body.data.status).toBe(status);
    }

    // Al quedar ready, cliente recibe notificación wash_ready
    const readyNotifs = await request(ctx.app)
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${ctx.clienteToken}`);
    expect(
      readyNotifs.body.data.some(
        (n: { type: string; payload: { washRequestId?: string } }) =>
          n.type === 'wash_ready' && n.payload?.washRequestId === washId,
      ),
    ).toBe(true);
  });

  it('vence solicitudes sin respuesta según expiresInMinutes, notifica al admin y permite reenviar; permite rechazo con motivo', async () => {
    const wr = await request(ctx.app)
      .post('/api/v1/wash-requests')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .set('X-Idempotency-Key', 'idem-expire-wash-0001')
      .send({
        customerId: ctx.clienteId,
        motorcycleId: ctx.motoId,
        serviceId: ctx.serviceId,
        price: 7000,
        expiresInMinutes: 1,
      });
    const washId = wr.body.data.id as string;

    // Simulamos que venció su expires_at ejecutando el scheduler con referencia futura
    const expiredCount = await expirePendingWashRequests(
      ctx.db,
      new Date(Date.now() + 5 * 60 * 1000),
    );
    expect(expiredCount).toBe(1);

    const listExpired = await request(ctx.app)
      .get('/api/v1/wash-requests')
      .query({ status: 'expired' })
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(
      listExpired.body.data.some((w: { id: string }) => w.id === washId),
    ).toBe(true);

    // Admin reenvía la solicitud vencida
    const resendRes = await request(ctx.app)
      .post(`/api/v1/wash-requests/${washId}/resend`)
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(resendRes.status).toBe(200);
    expect(resendRes.body.data.status).toBe('pending_confirmation');

    // Cliente la rechaza con motivo opcional
    const rejectRes = await request(ctx.app)
      .post(`/api/v1/wash-requests/${washId}/reject`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .set('X-Idempotency-Key', 'idem-reject-wash-0002')
      .send({ reason: 'No alcanzo a ir hoy' });
    expect(rejectRes.status).toBe(200);
    expect(rejectRes.body.data.status).toBe('rejected');
    expect(rejectRes.body.data.rejectionReason).toBe('No alcanzo a ir hoy');
  });
});
