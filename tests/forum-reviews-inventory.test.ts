import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/testApp.js';

describe('Foro con auditoría inmutable, Reseñas, Inventario, Motos y Reportes', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('preserva historial completo del foro tras edición, respuesta y eliminación/moderación', async () => {
    // Crear publicación
    const postRes = await request(ctx.app)
      .post('/api/v1/forum/posts')
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({
        title: 'Recomendación lubricante de cadena',
        content: '¿Qué lubricante usan después del lavado en temporada de lluvia?',
      });
    expect(postRes.status).toBe(201);
    const postId = postRes.body.data.id as string;

    // Filtro automático de lenguaje ofensivo
    const offensiveRes = await request(ctx.app)
      .post('/api/v1/forum/posts')
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({
        title: 'Queja',
        content: 'Esto es una porquería malparido',
      });
    expect(offensiveRes.status).toBe(422);

    // Otro usuario no puede editar publicación ajena
    const otherUserEdit = await request(ctx.app)
      .patch(`/api/v1/forum/posts/${postId}`)
      .set('Authorization', `Bearer ${ctx.lavadorToken}`)
      .send({ content: 'Edición no autorizada' });
    expect(otherUserEdit.status).toBe(403);

    // Autor edita su contenido
    const editRes = await request(ctx.app)
      .patch(`/api/v1/forum/posts/${postId}`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({
        content: '¿Qué lubricante recomiendan en Bogotá cuando llueve?',
      });
    expect(editRes.status).toBe(200);
    expect(editRes.body.data.editedAt).not.toBeNull();

    // Responder publicación
    const replyRes = await request(ctx.app)
      .post(`/api/v1/forum/posts/${postId}/replies`)
      .set('Authorization', `Bearer ${ctx.lavadorToken}`)
      .send({ content: 'En el lavadero usamos Motul C2 o C4 para lluvia.' });
    expect(replyRes.status).toBe(201);
    expect(replyRes.body.data.replies.length).toBe(1);

    // Admin modera eliminando la publicación (soft-delete), pero el historial jamás se elimina
    const delRes = await request(ctx.app)
      .delete(`/api/v1/forum/posts/${postId}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(delRes.status).toBe(204);

    // Verificar auditoría inmutable (solo Administrador)
    const forbiddenAudit = await request(ctx.app)
      .get('/api/v1/forum/audit')
      .set('Authorization', `Bearer ${ctx.clienteToken}`);
    expect(forbiddenAudit.status).toBe(403);

    const auditRes = await request(ctx.app)
      .get('/api/v1/forum/audit')
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(auditRes.status).toBe(200);

    const actions = (
      auditRes.body.data as Array<{
        action: string;
        previousContent: string | null;
        newContent: string | null;
      }>
    ).map((a) => a.action);
    expect(actions).toContain('created');
    expect(actions).toContain('edited');
    expect(actions).toContain('moderated');

    const editedEntry = (
      auditRes.body.data as Array<{
        action: string;
        previousContent: string | null;
        newContent: string | null;
      }>
    ).find((a) => a.action === 'edited');
    expect(editedEntry?.previousContent).toContain('temporada de lluvia');
    expect(editedEntry?.newContent).toContain('Bogotá cuando llueve');
  });

  it('permite reseña solo al cliente dueño cuando la lavada está pagada y bloquea reseña del administrador', async () => {
    // Crear lavada y pagarla
    const wr = await request(ctx.app)
      .post('/api/v1/wash-requests')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .set('X-Idempotency-Key', 'idem-rev-wash-000001')
      .send({
        customerId: ctx.clienteId,
        motorcycleId: ctx.motoId,
        serviceId: ctx.serviceId,
        price: 7000,
      });
    const washId = wr.body.data.id as string;

    // Antes de estar pagada, cliente no puede reseñar
    const prematureReview = await request(ctx.app)
      .post('/api/v1/reviews')
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({ washRequestId: washId, rating: 5, comment: 'Excelente' });
    expect(prematureReview.status).toBe(409);

    await request(ctx.app)
      .post(`/api/v1/wash-requests/${washId}/confirm`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .set('X-Idempotency-Key', 'idem-rev-conf-000001');

    await request(ctx.app)
      .patch(`/api/v1/wash-requests/${washId}/status`)
      .set('Authorization', `Bearer ${ctx.lavadorToken}`)
      .send({ status: 'ready' });

    await request(ctx.app)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .set('X-Idempotency-Key', 'idem-rev-pay-0000001')
      .send({ washRequestId: washId, method: 'Nequi', amount: 7000 });

    // Administrador no puede crear reseña como cliente
    const adminAsCustomer = await request(ctx.app)
      .post('/api/v1/reviews')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ washRequestId: washId, rating: 5, comment: 'Auto-reseña' });
    expect(adminAsCustomer.status).toBe(403);

    // Cliente dueño sí puede reseñar
    const reviewRes = await request(ctx.app)
      .post('/api/v1/reviews')
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({
        washRequestId: washId,
        rating: 5,
        comment: 'Quedó impecable la moto, muy buena atención.',
      });
    expect(reviewRes.status).toBe(201);
    const reviewId = reviewRes.body.data.id as string;

    // Administrador responde y modera visibilidad
    const modRes = await request(ctx.app)
      .patch(`/api/v1/reviews/${reviewId}/moderate`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        isVisible: true,
        adminReply: '¡Gracias por visitarnos en Los Malditos!',
      });
    expect(modRes.status).toBe(200);
    expect(modRes.body.data.adminReply).toContain('Los Malditos');
  });

  it('impide eliminar moto con historial (409) y valida movimientos de inventario y reportes CSV/XLSX/PDF', async () => {
    // La moto del seed ya tiene lavadas asociadas -> DELETE debe devolver 409
    const deleteWithHistory = await request(ctx.app)
      .delete(`/api/v1/motorcycles/${ctx.motoId}`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`);
    expect(deleteWithHistory.status).toBe(409);

    // Una moto nueva sin citas ni lavadas sí puede eliminarse (204)
    const newMoto = await request(ctx.app)
      .post('/api/v1/motorcycles')
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({ brand: 'KTM', model: 'Duke 200', cc: 200 });
    expect(newMoto.status).toBe(201);
    const deleteClean = await request(ctx.app)
      .delete(`/api/v1/motorcycles/${newMoto.body.data.id}`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`);
    expect(deleteClean.status).toBe(204);

    // Inventario: crear insumo, registrar salida y alerta isLowStock
    const itemRes = await request(ctx.app)
      .post('/api/v1/inventory/items')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        name: 'Cera Carnauba',
        unit: 'litro',
        currentStock: 4,
        minimumStock: 2,
        estimatedUsePerWash: 0.2,
      });
    expect(itemRes.status).toBe(201);
    const itemId = itemRes.body.data.id as string;

    const outMove = await request(ctx.app)
      .post(`/api/v1/inventory/items/${itemId}/movements`)
      .set('Authorization', `Bearer ${ctx.lavadorToken}`)
      .send({ type: 'out', quantity: 2.5, reason: 'Consumo diario' });
    expect(outMove.status).toBe(201);
    expect(outMove.body.data.currentStock).toBe(1.5);
    expect(outMove.body.data.isLowStock).toBe(true);

    const overOut = await request(ctx.app)
      .post(`/api/v1/inventory/items/${itemId}/movements`)
      .set('Authorization', `Bearer ${ctx.lavadorToken}`)
      .send({ type: 'out', quantity: 5, reason: 'Exceso' });
    expect(overOut.status).toBe(409);

    // Dashboard y exportación CSV/XLSX/PDF
    const today = new Date().toISOString().slice(0, 10);
    const dash = await request(ctx.app)
      .get('/api/v1/reports/dashboard')
      .query({ from: '2026-01-01', to: '2026-12-31' })
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(dash.status).toBe(200);
    expect(typeof dash.body.data.averageTicket).toBe('number');

    for (const fmt of ['csv', 'xlsx', 'pdf'] as const) {
      const exp = await request(ctx.app)
        .get('/api/v1/reports/export')
        .query({ format: fmt, from: '2026-01-01', to: today })
        .set('Authorization', `Bearer ${ctx.adminToken}`);
      expect(exp.status).toBe(200);
    }
  });
});
