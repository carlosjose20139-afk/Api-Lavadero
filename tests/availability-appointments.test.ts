import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getColombianHoliday } from '../src/config/colombiaHolidays.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';

describe('Disponibilidad, Festivos de Colombia, Capacidad y Penalización < 3 horas', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('calcula festivos de Colombia (fijos, Ley Emiliani y Pascua) y devuelve sin cupos en festivo o fecha bloqueada', async () => {
    // 2026-07-20 es lunes (Independencia), 2026-05-18 es Ascensión del Señor
    expect(getColombianHoliday('2026-07-20')?.name).toBe('Día de la Independencia');
    expect(getColombianHoliday('2026-05-18')?.name).toBe('Ascensión del Señor');

    const holidayAvail = await request(ctx.app)
      .get('/api/v1/appointments/availability')
      .query({ date: '2026-07-20', serviceId: ctx.serviceId });
    expect(holidayAvail.status).toBe(200);
    expect(holidayAvail.body.data.slots).toEqual([]);

    // Bloquear una fecha hábil (2026-12-10 es jueves)
    const blockRes = await request(ctx.app)
      .post('/api/v1/appointments/blocked-dates')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ date: '2026-12-10', reason: 'Mantenimiento hidráulico' });
    expect(blockRes.status).toBe(201);

    const blockedAvail = await request(ctx.app)
      .get('/api/v1/appointments/availability')
      .query({ date: '2026-12-10', serviceId: ctx.serviceId });
    expect(blockedAvail.status).toBe(200);
    expect(blockedAvail.body.data.slots).toEqual([]);

    // No permite agendar en fecha bloqueada ni festivo
    const bookBlocked = await request(ctx.app)
      .post('/api/v1/appointments')
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({
        customerId: ctx.clienteId,
        motorcycleId: ctx.motoId,
        serviceId: ctx.serviceId,
        startAt: '2026-12-10T10:00:00-05:00',
      });
    expect(bookBlocked.status).toBe(409);
  });

  it('controla capacidad de puestos paralelos según duración del servicio y permite reprogramar', async () => {
    // Fecha hábil sin festivos: 2026-12-11 (viernes)
    const slotTime = '2026-12-11T09:00:00-05:00';

    // Puesto 1
    const appt1 = await request(ctx.app)
      .post('/api/v1/appointments')
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({
        customerId: ctx.clienteId,
        motorcycleId: ctx.motoId,
        serviceId: ctx.serviceId,
        startAt: slotTime,
      });
    expect(appt1.status).toBe(201);

    // Puesto 2 (parallel_bays = 2)
    const appt2 = await request(ctx.app)
      .post('/api/v1/appointments')
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({
        customerId: ctx.clienteId,
        motorcycleId: ctx.motoId,
        serviceId: ctx.serviceId,
        startAt: slotTime,
      });
    expect(appt2.status).toBe(201);

    // Puesto 3 debe fallar con 409
    const appt3 = await request(ctx.app)
      .post('/api/v1/appointments')
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({
        customerId: ctx.clienteId,
        motorcycleId: ctx.motoId,
        serviceId: ctx.serviceId,
        startAt: slotTime,
      });
    expect(appt3.status).toBe(409);

    // Reprogramar cita 2 a las 11:00 libera el cupo de las 09:00
    const resched = await request(ctx.app)
      .post(`/api/v1/appointments/${appt2.body.data.id}/reschedule`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({ startAt: '2026-12-11T11:00:00-05:00' });
    expect(resched.status).toBe(200);

    const availAfter = await request(ctx.app)
      .get('/api/v1/appointments/availability')
      .query({ date: '2026-12-11', serviceId: ctx.serviceId });
    const nineSlot = (
      availAfter.body.data.slots as Array<{ startAt: string; availableCapacity: number }>
    ).find((s) => s.startAt.startsWith('2026-12-11T09:00'));
    expect(nineSlot?.availableCapacity).toBe(1);
  });

  it('cobra COP 1.000 por cancelar con menos de 3 horas, lo registra como pendingBalance e ingreso pendiente, y lo descuenta de la próxima lavada (7.000 -> 6.000)', async () => {
    // Insertamos una cita próxima en 90 minutos (menos de 3 horas) directamente en DB para evitar restricciones de hora actual en horario laboral
    const startSoon = new Date(Date.now() + 90 * 60 * 1000);
    const endSoon = new Date(startSoon.getTime() + 30 * 60 * 1000);
    const apptId = '11111111-1111-4111-8111-111111111111';
    await ctx.db.query(
      `INSERT INTO appointments (id, customer_id, motorcycle_id, service_id, start_at, end_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'scheduled')`,
      [apptId, ctx.clienteId, ctx.motoId, ctx.serviceId, startSoon, endSoon],
    );

    const cancelRes = await request(ctx.app)
      .post(`/api/v1/appointments/${apptId}/cancel`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({ reason: 'Lluvia fuerte' });
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.data.cancellationFee).toBe(1000);
    expect(cancelRes.body.message).toContain('COP 1000');

    // Verificar pendingBalance del cliente
    const custRes = await request(ctx.app)
      .get(`/api/v1/customers/${ctx.clienteId}`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`);
    expect(custRes.body.data.pendingBalance).toBe(1000);

    // Verificar ingreso pendiente por cancelación
    const incomesRes = await request(ctx.app)
      .get('/api/v1/incomes')
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(incomesRes.status).toBe(200);
    expect(
      incomesRes.body.data.some(
        (i: { source: string; amount: number }) =>
          i.source === 'cancellation_fee' && i.amount === 1000,
      ),
    ).toBe(true);

    // Verificar notificación explicativa al cliente
    const notifRes = await request(ctx.app)
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${ctx.clienteToken}`);
    expect(
      notifRes.body.data.some(
        (n: { type: string }) => n.type === 'pending_charge',
      ),
    ).toBe(true);

    // Próxima lavada de COP 7.000 queda en COP 6.000 descontando pendingBalance
    const washRes = await request(ctx.app)
      .post('/api/v1/wash-requests')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .set('X-Idempotency-Key', 'idem-wash-discount-001')
      .send({
        customerId: ctx.clienteId,
        motorcycleId: ctx.motoId,
        serviceId: ctx.serviceId,
        price: 7000,
        expiresInMinutes: 15,
      });
    expect(washRes.status).toBe(201);
    expect(washRes.body.data.price).toBe(6000);
    expect(washRes.body.message).toContain('6000');
  });
});
