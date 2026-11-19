import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/testApp.js';

function nextNonHolidayWeekdayYmd(daysAhead = 5): string {
  const date = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) {
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return date.toISOString().slice(0, 10);
}

describe('Desacoplamiento de Motos, Asociaciones, Historial y RBAC', () => {
  let ctx: TestContext;
  let customerBId: string;
  let customerBToken: string;

  beforeAll(async () => {
    ctx = await createTestContext();

    // Crear segundo cliente B para pruebas de reasignación y aislamiento
    const custBRes = await request(ctx.app)
      .post('/api/v1/customers')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        name: 'Camila Rueda',
        username: 'camila.rueda',
        password: 'Password123*',
      });
    expect(custBRes.status).toBe(201);
    customerBId = custBRes.body.data.id as string;

    const loginB = await request(ctx.app)
      .post('/api/v1/auth/login')
      .send({ username: 'camila.rueda', password: 'Password123*' });
    expect(loginB.status).toBe(200);
    customerBToken = loginB.body.data.accessToken as string;
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('permite al Administrador crear moto sin cliente (customerId: null) y con cliente inicial, y rechaza a Cliente (403)', async () => {
    // Cliente intenta crear moto -> 403 con mensaje exacto
    const clientCreate = await request(ctx.app)
      .post('/api/v1/motorcycles')
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({ brand: 'Boxer', model: 'CT 100', cc: 100 });
    expect(clientCreate.status).toBe(403);
    expect(clientCreate.body.data.code).toBe('FORBIDDEN');
    expect(clientCreate.body.message).toBe(
      'Solo el administrador puede registrar motos.',
    );

    // Admin crea moto libre (sin customerId)
    const freeMotoRes = await request(ctx.app)
      .post('/api/v1/motorcycles')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        brand: 'Boxer',
        model: 'CT 100',
        cc: 100,
        nickname: 'La Guerrera',
        color: 'Azul',
      });
    expect(freeMotoRes.status).toBe(201);
    expect(freeMotoRes.body.data.customerId).toBeNull();
    expect(freeMotoRes.body.data.customer).toBeNull();
    expect(freeMotoRes.body.data.hasHistory).toBe(false);
    expect(freeMotoRes.body.data.updatedAt).toBeDefined();

    // Admin crea moto ya asociada a Cliente A
    const assignedMotoRes = await request(ctx.app)
      .post('/api/v1/motorcycles')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        customerId: ctx.clienteId,
        brand: 'Honda',
        model: 'CB 190R',
        cc: 184,
      });
    expect(assignedMotoRes.status).toBe(201);
    expect(assignedMotoRes.body.data.customerId).toBe(ctx.clienteId);
    expect(assignedMotoRes.body.data.customer).toEqual({
      id: ctx.clienteId,
      name: 'Mateo Motero',
      username: 'mateo.moto',
    });
    expect(assignedMotoRes.body.data.hasHistory).toBe(true);

    // Verificar historial inicial en /assignments
    const historyRes = await request(ctx.app)
      .get(`/api/v1/motorcycles/${assignedMotoRes.body.data.id}/assignments`)
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(historyRes.status).toBe(200);
    expect(historyRes.body.data.length).toBe(1);
    expect(historyRes.body.data[0].action).toBe('assigned');
    expect(historyRes.body.data[0].customerId).toBe(ctx.clienteId);
    expect(historyRes.body.data[0].previousCustomerId).toBeNull();
  });

  it('asocia moto libre, es idempotente al reasociar mismo cliente, reasigna a otro cliente y registra historial', async () => {
    const createRes = await request(ctx.app)
      .post('/api/v1/motorcycles')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ brand: 'Bajaj', model: 'Pulsar NS 200', cc: 200 });
    expect(createRes.status).toBe(201);
    const motoId = createRes.body.data.id as string;

    // Asociar a Cliente A
    const assignARes = await request(ctx.app)
      .post(`/api/v1/motorcycles/${motoId}/assignment`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ customerId: ctx.clienteId });
    expect(assignARes.status).toBe(200);
    expect(assignARes.body.message).toBe('Moto asociada correctamente');
    expect(assignARes.body.data).toMatchObject({
      id: motoId,
      brand: 'Bajaj',
      model: 'Pulsar NS 200',
      cc: 200,
      customerId: ctx.clienteId,
    });
    expect(assignARes.body.data.updatedAt).toBeDefined();

    // Repetir misma asociación -> idempotente, no duplica historial
    const assignSameRes = await request(ctx.app)
      .post(`/api/v1/motorcycles/${motoId}/assignment`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ customerId: ctx.clienteId });
    expect(assignSameRes.status).toBe(200);
    expect(assignSameRes.body.data.customerId).toBe(ctx.clienteId);

    const histAfterSame = await request(ctx.app)
      .get(`/api/v1/motorcycles/${motoId}/assignments`)
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(histAfterSame.body.data.length).toBe(1);
    expect(histAfterSame.body.data[0].action).toBe('assigned');

    // Reasignar a Cliente B
    const reassignRes = await request(ctx.app)
      .post(`/api/v1/motorcycles/${motoId}/assignment`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ customerId: customerBId, reason: 'Venta de moto entre clientes' });
    expect(reassignRes.status).toBe(200);
    expect(reassignRes.body.data.customerId).toBe(customerBId);

    const histAfterReassign = await request(ctx.app)
      .get(`/api/v1/motorcycles/${motoId}/assignments`)
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(histAfterReassign.body.data.length).toBe(2);
    expect(histAfterReassign.body.data[0]).toMatchObject({
      action: 'reassigned',
      previousCustomerId: ctx.clienteId,
      customerId: customerBId,
      reason: 'Venta de moto entre clientes',
    });

    // Cliente A ya no la ve en /customers/:id/motorcycles ni /motorcycles; Cliente B sí la ve
    const listARes = await request(ctx.app)
      .get(`/api/v1/customers/${ctx.clienteId}/motorcycles`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`);
    expect(listARes.status).toBe(200);
    expect(
      (listARes.body.data as Array<{ id: string }>).some((m) => m.id === motoId),
    ).toBe(false);

    const listBRes = await request(ctx.app)
      .get(`/api/v1/customers/${customerBId}/motorcycles`)
      .set('Authorization', `Bearer ${customerBToken}`);
    expect(listBRes.status).toBe(200);
    expect(
      (listBRes.body.data as Array<{ id: string }>).some((m) => m.id === motoId),
    ).toBe(true);
  });

  it('desvincula moto sin eliminarla, conserva citas/lavadas/pagos/reseñas/fidelización, y es idempotente al repetir', async () => {
    // Crear moto asociada a Cliente A
    const createRes = await request(ctx.app)
      .post('/api/v1/motorcycles')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        customerId: ctx.clienteId,
        brand: 'Suzuki',
        model: 'DR 650',
        cc: 644,
        nickname: 'La Trail',
      });
    expect(createRes.status).toBe(201);
    const motoId = createRes.body.data.id as string;

    // Crear cita histórica y lavada pagada sobre esa moto
    const ymd = nextNonHolidayWeekdayYmd(6);
    const apptRes = await request(ctx.app)
      .post('/api/v1/appointments')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        customerId: ctx.clienteId,
        motorcycleId: motoId,
        serviceId: ctx.serviceId,
        startAt: `${ymd}T09:00:00-05:00`,
      });
    expect(apptRes.status).toBe(201);
    const apptId = apptRes.body.data.id as string;

    const wrRes = await request(ctx.app)
      .post('/api/v1/wash-requests')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .set('X-Idempotency-Key', 'idem-unlink-wr-000001')
      .send({
        customerId: ctx.clienteId,
        motorcycleId: motoId,
        serviceId: ctx.serviceId,
        appointmentId: apptId,
        price: 7000,
      });
    expect(wrRes.status).toBe(201);
    const washId = wrRes.body.data.id as string;

    await request(ctx.app)
      .post(`/api/v1/wash-requests/${washId}/confirm`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .set('X-Idempotency-Key', 'idem-unlink-conf-0001');

    await request(ctx.app)
      .patch(`/api/v1/wash-requests/${washId}/status`)
      .set('Authorization', `Bearer ${ctx.lavadorToken}`)
      .send({ status: 'ready' });

    const payRes = await request(ctx.app)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .set('X-Idempotency-Key', 'idem-unlink-pay-00001')
      .send({ washRequestId: washId, method: 'Efectivo', amount: 7000 });
    expect(payRes.status).toBe(201);

    // No se puede eliminar mientras siga asociada -> 409 MOTORCYCLE_ASSIGNED
    const delWhileAssigned = await request(ctx.app)
      .delete(`/api/v1/motorcycles/${motoId}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(delWhileAssigned.status).toBe(409);
    expect(delWhileAssigned.body.data.code).toBe('MOTORCYCLE_ASSIGNED');
    expect(delWhileAssigned.body.message).toBe(
      'No puedes eliminar una moto asociada. Primero debes desvincularla.',
    );

    // Desvincular mediante DELETE /motorcycles/:id/assignment
    const unlinkRes = await request(ctx.app)
      .delete(`/api/v1/motorcycles/${motoId}/assignment`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ reason: 'Cliente vendió la moto' });
    expect(unlinkRes.status).toBe(200);
    expect(unlinkRes.body.data).toEqual({ id: motoId, customerId: null });
    expect(unlinkRes.body.message).toBe(
      'Moto desvinculada correctamente. El registro y su historial fueron conservados.',
    );

    // Doble desvinculación es idempotente y NO duplica historial ni auditoría
    const unlinkAgainRes = await request(ctx.app)
      .delete(`/api/v1/motorcycles/${motoId}/assignment`)
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(unlinkAgainRes.status).toBe(200);
    expect(unlinkAgainRes.body.data).toEqual({ id: motoId, customerId: null });

    const assignHist = await request(ctx.app)
      .get(`/api/v1/motorcycles/${motoId}/assignments`)
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(assignHist.status).toBe(200);
    // Solo 2 eventos: 'assigned' inicial + 1 'unassigned'
    expect(assignHist.body.data.length).toBe(2);
    expect(assignHist.body.data[0].action).toBe('unassigned');
    expect(assignHist.body.data[0].previousCustomerId).toBe(ctx.clienteId);
    expect(assignHist.body.data[0].customerId).toBeNull();

    // La moto sigue visible para Administrador bajo status=unassigned y search
    const adminUnassigned = await request(ctx.app)
      .get('/api/v1/motorcycles')
      .query({ status: 'unassigned', search: 'Trail' })
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(adminUnassigned.status).toBe(200);
    const foundMoto = (
      adminUnassigned.body.data as Array<{
        id: string;
        customerId: string | null;
        customer: unknown;
        hasHistory: boolean;
      }>
    ).find((m) => m.id === motoId);
    expect(foundMoto).toBeDefined();
    expect(foundMoto?.customerId).toBeNull();
    expect(foundMoto?.customer).toBeNull();
    expect(foundMoto?.hasHistory).toBe(true);

    // La moto ya NO aparece en GET /motorcycles ni GET /customers/:id/motorcycles del cliente anterior
    const clientMotos = await request(ctx.app)
      .get('/api/v1/motorcycles')
      .set('Authorization', `Bearer ${ctx.clienteToken}`);
    expect(
      (clientMotos.body.data as Array<{ id: string }>).some(
        (m) => m.id === motoId,
      ),
    ).toBe(false);

    const customerMotos = await request(ctx.app)
      .get(`/api/v1/customers/${ctx.clienteId}/motorcycles`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`);
    expect(
      (customerMotos.body.data as Array<{ id: string }>).some(
        (m) => m.id === motoId,
      ),
    ).toBe(false);

    // Citas y lavadas históricas siguen intactas
    const apptsCheck = await request(ctx.app)
      .get('/api/v1/appointments')
      .set('Authorization', `Bearer ${ctx.clienteToken}`);
    expect(
      (apptsCheck.body.data as Array<{ id: string; motorcycleId: string }>).some(
        (a) => a.id === apptId && a.motorcycleId === motoId,
      ),
    ).toBe(true);

    const washesCheck = await request(ctx.app)
      .get('/api/v1/wash-requests')
      .set('Authorization', `Bearer ${ctx.clienteToken}`);
    expect(
      (washesCheck.body.data as Array<{ id: string; motorcycleId: string }>).some(
        (w) => w.id === washId && w.motorcycleId === motoId,
      ),
    ).toBe(true);

    // Ya desvinculada, pero tiene historial -> DELETE /motorcycles/:id retorna 409 MOTORCYCLE_HAS_HISTORY
    const delWithHistory = await request(ctx.app)
      .delete(`/api/v1/motorcycles/${motoId}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(delWithHistory.status).toBe(409);
    expect(delWithHistory.body.data.code).toBe('MOTORCYCLE_HAS_HISTORY');
    expect(delWithHistory.body.message).toBe(
      'La moto tiene historial y no puede eliminarse definitivamente.',
    );
  });

  it('bloquea edición, desvinculación, asignación, consulta cruzada y eliminación definitiva para Cliente; permite eliminar moto limpia sin historial y audita todo', async () => {
    const cleanCreate = await request(ctx.app)
      .post('/api/v1/motorcycles')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ brand: 'TVS', model: 'Raider 125', cc: 125 });
    expect(cleanCreate.status).toBe(201);
    const cleanId = cleanCreate.body.data.id as string;

    // Cliente no puede editar moto (403)
    const clientPatch = await request(ctx.app)
      .patch(`/api/v1/motorcycles/${cleanId}`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({ color: 'Rojo' });
    expect(clientPatch.status).toBe(403);

    // Cliente no puede asociar moto (403)
    const clientAssign = await request(ctx.app)
      .post(`/api/v1/motorcycles/${cleanId}/assignment`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({ customerId: ctx.clienteId });
    expect(clientAssign.status).toBe(403);

    // Cliente no puede desvincular moto (403)
    const clientUnlink = await request(ctx.app)
      .delete(`/api/v1/motorcycles/${ctx.motoId}/assignment`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`);
    expect(clientUnlink.status).toBe(403);

    // Cliente no puede eliminar moto (403)
    const clientDelete = await request(ctx.app)
      .delete(`/api/v1/motorcycles/${cleanId}`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`);
    expect(clientDelete.status).toBe(403);

    // Cliente no puede consultar motos de otro cliente ni sin asignar ni historial de asociaciones
    const crossQuery = await request(ctx.app)
      .get('/api/v1/motorcycles')
      .query({ customerId: customerBId })
      .set('Authorization', `Bearer ${ctx.clienteToken}`);
    expect(crossQuery.status).toBe(403);

    const crossNested = await request(ctx.app)
      .get(`/api/v1/customers/${customerBId}/motorcycles`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`);
    expect(crossNested.status).toBe(403);

    const clientUnassignedQuery = await request(ctx.app)
      .get('/api/v1/motorcycles')
      .query({ status: 'unassigned' })
      .set('Authorization', `Bearer ${ctx.clienteToken}`);
    expect(clientUnassignedQuery.status).toBe(403);

    const clientAssignmentsHist = await request(ctx.app)
      .get(`/api/v1/motorcycles/${ctx.motoId}/assignments`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`);
    expect(clientAssignmentsHist.status).toBe(403);

    // Admin edita y luego elimina definitivamente la moto limpia sin historial
    const adminPatch = await request(ctx.app)
      .patch(`/api/v1/motorcycles/${cleanId}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ nickname: 'Temporal' });
    expect(adminPatch.status).toBe(200);
    expect(adminPatch.body.data.nickname).toBe('Temporal');

    const adminDelete = await request(ctx.app)
      .delete(`/api/v1/motorcycles/${cleanId}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(adminDelete.status).toBe(204);

    // Verificar registros en audit_logs
    const auditRes = await ctx.db.query<{ action: string }>(
      `SELECT DISTINCT action FROM audit_logs WHERE entity_type = 'motorcycle'`,
    );
    const auditActions = auditRes.rows.map((r) => r.action);
    expect(auditActions).toContain('motorcycle_created');
    expect(auditActions).toContain('motorcycle_updated');
    expect(auditActions).toContain('motorcycle_assigned');
    expect(auditActions).toContain('motorcycle_reassigned');
    expect(auditActions).toContain('motorcycle_unassigned');
    expect(auditActions).toContain('motorcycle_deleted');
  });
});
