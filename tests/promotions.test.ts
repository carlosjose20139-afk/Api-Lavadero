import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrator.js';
import {
  parsePromotionIsoDate,
  sanitizePromotionText,
  validatePromotionDateWindow,
  validatePromotionDiscounts,
} from '../src/modules/promotions/promotions.service.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';

function isoOffsetHours(hoursFromNow: number): string {
  return new Date(Date.now() + hoursFromNow * 60 * 60 * 1000).toISOString();
}

describe('Promociones: Pruebas unitarias de sanitización y validaciones', () => {
  it('sanitiza HTML, scripts y atributos peligrosos en title y description', () => {
    expect(
      sanitizePromotionText('Promo <b>2x1</b> <script>alert(1)</script> Bogotá'),
    ).toBe('Promo 2x1 Bogotá');
    expect(
      sanitizePromotionText('<img src=x onerror=alert(1)>Descuento < 3 horas'),
    ).toBe('Descuento < 3 horas');
    expect(sanitizePromotionText('<script>alert("xss")</script>')).toBe('');
  });

  it('valida fechas ISO-8601 reales y rechaza fechas imposibles o rangos invertidos', () => {
    const start = parsePromotionIsoDate('2026-12-01T00:00:00.000Z', 'startsAt');
    const end = parsePromotionIsoDate('2026-12-31T23:59:59.000Z', 'endsAt');
    expect(() => validatePromotionDateWindow(start, end)).not.toThrow();

    expect(() =>
      parsePromotionIsoDate('2026-02-30T10:00:00.000Z', 'startsAt'),
    ).toThrow(/fecha y hora válida/i);
    expect(() => parsePromotionIsoDate('no-es-fecha', 'startsAt')).toThrow(
      /ISO-8601/i,
    );
    expect(() => validatePromotionDateWindow(end, start)).toThrow(
      /posterior a la fecha de inicio/i,
    );
  });

  it('valida descuentos en monto COP y porcentaje sin permitir valores fuera de rango ni combinados', () => {
    expect(() => validatePromotionDiscounts(2000, null)).not.toThrow();
    expect(() => validatePromotionDiscounts(null, 15)).not.toThrow();
    expect(() => validatePromotionDiscounts(null, null)).not.toThrow();

    expect(() => validatePromotionDiscounts(-500, null)).toThrow();
    expect(() => validatePromotionDiscounts(null, 120)).toThrow();
    expect(() => validatePromotionDiscounts(2000, 15)).toThrow();
  });
});

describe('Promociones: CRUD completo, RBAC, vigencia, auditoría y migraciones', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('permite ciclo CRUD completo al Administrador, sanitiza HTML, preserva historial y registra auditoría', async () => {
    // 1. Administrador crea una promoción vigente (con intento XSS sanitizado)
    const createRes = await request(ctx.app)
      .post('/api/v1/promotions')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        title: 'Promo <b>Cadena</b> <script>alert(1)</script> Limpia',
        description:
          'Descuento especial <img src=x onerror=alert(1)> para clientes frecuentes',
        discountAmount: 2000,
        startsAt: isoOffsetHours(-2),
        endsAt: isoOffsetHours(48),
        isActive: true,
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.data.title).toBe('Promo Cadena Limpia');
    expect(createRes.body.data.description).toBe(
      'Descuento especial para clientes frecuentes',
    );
    expect(createRes.body.data.discountAmount).toBe(2000);
    expect(createRes.body.data.discountPercent).toBeNull();
    expect(createRes.body.data.isActive).toBe(true);
    expect(createRes.body.data.createdAt).toBeDefined();
    expect(createRes.body.data.updatedAt).toBeDefined();
    expect(createRes.body.data.deletedAt).toBeNull();

    const promoId = createRes.body.data.id as string;

    // 6. Cliente y Lavador pueden consultar promociones activas y vigentes
    const clientList = await request(ctx.app)
      .get('/api/v1/promotions')
      .set('Authorization', `Bearer ${ctx.clienteToken}`);
    expect(clientList.status).toBe(200);
    expect(clientList.body.meta).toBeDefined();
    expect(
      (clientList.body.data as Array<{ id: string }>).some(
        (p) => p.id === promoId,
      ),
    ).toBe(true);

    const lavadorList = await request(ctx.app)
      .get('/api/v1/promotions')
      .set('Authorization', `Bearer ${ctx.lavadorToken}`);
    expect(lavadorList.status).toBe(200);
    expect(
      (lavadorList.body.data as Array<{ id: string }>).some(
        (p) => p.id === promoId,
      ),
    ).toBe(true);

    // 2. Administrador edita parcialmente la promoción (incluye cambio a discountPercent)
    const newStart = isoOffsetHours(-1);
    const newEnd = isoOffsetHours(72);
    const patchRes = await request(ctx.app)
      .patch(`/api/v1/promotions/${promoId}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        title: 'Lavada básica de temporada',
        description: 'Descuento especial para clientes frecuentes',
        discountPercent: 15,
        startsAt: newStart,
        endsAt: newEnd,
      });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.message).toBe('Promoción actualizada');
    expect(patchRes.body.data.id).toBe(promoId);
    expect(patchRes.body.data.title).toBe('Lavada básica de temporada');
    expect(patchRes.body.data.discountPercent).toBe(15);
    expect(patchRes.body.data.discountAmount).toBeNull();

    // No debe permitir cambiar id en PATCH
    const patchWithId = await request(ctx.app)
      .patch(`/api/v1/promotions/${promoId}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        id: '00000000-0000-4000-8000-000000000999',
        title: 'Intento cambio ID',
      });
    expect(patchWithId.status).toBe(422);
    expect(patchWithId.body.data.code).toBe('VALIDATION_ERROR');

    // 4 y 13. Administrador desactiva la promoción -> desaparece para Cliente pero no se borra
    const deactivateRes = await request(ctx.app)
      .patch(`/api/v1/promotions/${promoId}/status`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ isActive: false });
    expect(deactivateRes.status).toBe(200);
    expect(deactivateRes.body.data.isActive).toBe(false);

    const clientAfterDeactivate = await request(ctx.app)
      .get('/api/v1/promotions')
      .set('Authorization', `Bearer ${ctx.clienteToken}`);
    expect(
      (clientAfterDeactivate.body.data as Array<{ id: string }>).some(
        (p) => p.id === promoId,
      ),
    ).toBe(false);

    // Lavador tampoco ve inactivas aunque envíe includeInactive=true
    const lavadorWithFlag = await request(ctx.app)
      .get('/api/v1/promotions')
      .query({ includeInactive: 'true' })
      .set('Authorization', `Bearer ${ctx.lavadorToken}`);
    expect(
      (lavadorWithFlag.body.data as Array<{ id: string }>).some(
        (p) => p.id === promoId,
      ),
    ).toBe(false);

    // Administrador sí la ve con includeInactive=true
    const adminAllAfterDeactivate = await request(ctx.app)
      .get('/api/v1/promotions')
      .query({ includeInactive: 'true' })
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(
      (adminAllAfterDeactivate.body.data as Array<{ id: string }>).some(
        (p) => p.id === promoId,
      ),
    ).toBe(true);

    // 3. Administrador vuelve a activar la promoción -> reaparece para Cliente
    const activateRes = await request(ctx.app)
      .patch(`/api/v1/promotions/${promoId}/status`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ isActive: true });
    expect(activateRes.status).toBe(200);
    expect(activateRes.body.data.isActive).toBe(true);

    const clientAfterActivate = await request(ctx.app)
      .get('/api/v1/promotions')
      .set('Authorization', `Bearer ${ctx.clienteToken}`);
    expect(
      (clientAfterActivate.body.data as Array<{ id: string }>).some(
        (p) => p.id === promoId,
      ),
    ).toBe(true);

    // 5. Administrador elimina lógicamente la promoción (conserva fila + auditoría + otros recursos)
    const deleteRes = await request(ctx.app)
      .delete(`/api/v1/promotions/${promoId}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.message).toContain('eliminada');
    expect(deleteRes.body.data.id).toBe(promoId);
    expect(deleteRes.body.data.deletedAt).not.toBeNull();

    // Ya eliminada, no aparece ni para Cliente ni para Admin con includeInactive=true
    const adminAfterDelete = await request(ctx.app)
      .get('/api/v1/promotions')
      .query({ includeInactive: 'true' })
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(
      (adminAfterDelete.body.data as Array<{ id: string }>).some(
        (p) => p.id === promoId,
      ),
    ).toBe(false);

    // Moto, cliente y servicio siguen intactos
    const motosCheck = await request(ctx.app)
      .get('/api/v1/motorcycles')
      .set('Authorization', `Bearer ${ctx.clienteToken}`);
    expect(motosCheck.status).toBe(200);
    expect(motosCheck.body.data.length).toBeGreaterThan(0);

    // 15. La auditoría registra correctamente todas las acciones con actor, valores anteriores y nuevos
    const auditRes = await ctx.db.query<{
      actor_id: string;
      actor_role: string;
      action: string;
      entity_id: string;
      ip_address: string | null;
      changes: {
        previous?: Record<string, unknown> | null;
        new?: Record<string, unknown>;
      };
      occurred_at: Date | string;
    }>(
      `SELECT actor_id, actor_role, action, entity_id, ip_address, changes, occurred_at
       FROM audit_logs
       WHERE entity_type = 'promotion' AND entity_id = $1
       ORDER BY occurred_at ASC`,
      [promoId],
    );

    const actions = auditRes.rows.map((r) => r.action);
    expect(actions).toEqual([
      'promotion_created',
      'promotion_updated',
      'promotion_deactivated',
      'promotion_activated',
      'promotion_deleted',
    ]);
    for (const row of auditRes.rows) {
      expect(row.actor_role).toBe('Administrador');
      expect(row.actor_id).toBeDefined();
      expect(row.occurred_at).toBeDefined();
      expect(row.ip_address).toBeTruthy();
    }
    const updateAudit = auditRes.rows.find(
      (r) => r.action === 'promotion_updated',
    );
    expect(updateAudit?.changes.previous?.title).toBe('Promo Cadena Limpia');
    expect(updateAudit?.changes.new?.title).toBe('Lavada básica de temporada');
  });

  it('oculta promociones vencidas y futuras al Cliente pero las muestra al Administrador con includeInactive=true', async () => {
    const expiredRes = await request(ctx.app)
      .post('/api/v1/promotions')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        title: 'Promoción vencida ayer',
        description: 'Ya terminó su vigencia',
        discountPercent: 10,
        startsAt: isoOffsetHours(-48),
        endsAt: isoOffsetHours(-1),
        isActive: true,
      });
    expect(expiredRes.status).toBe(201);
    const expiredId = expiredRes.body.data.id as string;

    const futureRes = await request(ctx.app)
      .post('/api/v1/promotions')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        title: 'Promoción futura próxima semana',
        description: 'Aún no inicia su vigencia',
        discountPercent: 20,
        startsAt: isoOffsetHours(24),
        endsAt: isoOffsetHours(72),
        isActive: true,
      });
    expect(futureRes.status).toBe(201);
    const futureId = futureRes.body.data.id as string;

    // 12. Cliente no ve promociones vencidas ni futuras
    const clientList = await request(ctx.app)
      .get('/api/v1/promotions')
      .set('Authorization', `Bearer ${ctx.clienteToken}`);
    const clientIds = (clientList.body.data as Array<{ id: string }>).map(
      (p) => p.id,
    );
    expect(clientIds).not.toContain(expiredId);
    expect(clientIds).not.toContain(futureId);

    // Administrador con includeInactive=true sí ve ambas
    const adminList = await request(ctx.app)
      .get('/api/v1/promotions')
      .query({ includeInactive: 'true' })
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    const adminIds = (adminList.body.data as Array<{ id: string }>).map(
      (p) => p.id,
    );
    expect(adminIds).toContain(expiredId);
    expect(adminIds).toContain(futureId);
  });

  it('aplica estrictamente RBAC (401 sin token, 403 para Cliente y Lavador en crear/editar/estado/eliminar)', async () => {
    const createdByAdmin = await request(ctx.app)
      .post('/api/v1/promotions')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        title: 'Promo RBAC',
        description: 'Prueba de permisos por rol',
        discountPercent: 10,
        startsAt: isoOffsetHours(-1),
        endsAt: isoOffsetHours(24),
      });
    const promoId = createdByAdmin.body.data.id as string;

    // Sin token -> 401
    const unauthCreate = await request(ctx.app)
      .post('/api/v1/promotions')
      .send({
        title: 'Sin auth',
        description: 'Debe fallar',
        startsAt: isoOffsetHours(1),
        endsAt: isoOffsetHours(5),
      });
    expect(unauthCreate.status).toBe(401);

    // 7, 8, 9. Cliente no puede crear, editar, cambiar estado ni eliminar
    const clientCreate = await request(ctx.app)
      .post('/api/v1/promotions')
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({
        title: 'Promo Cliente',
        description: 'No permitida',
        startsAt: isoOffsetHours(1),
        endsAt: isoOffsetHours(5),
      });
    expect(clientCreate.status).toBe(403);
    expect(clientCreate.body.data.code).toBe('PROMOTION_FORBIDDEN');

    const clientPatch = await request(ctx.app)
      .patch(`/api/v1/promotions/${promoId}`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({ title: 'Editada por cliente' });
    expect(clientPatch.status).toBe(403);
    expect(clientPatch.body.data.code).toBe('PROMOTION_FORBIDDEN');

    const clientStatus = await request(ctx.app)
      .patch(`/api/v1/promotions/${promoId}/status`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({ isActive: false });
    expect(clientStatus.status).toBe(403);
    expect(clientStatus.body.data.code).toBe('PROMOTION_FORBIDDEN');

    const clientDelete = await request(ctx.app)
      .delete(`/api/v1/promotions/${promoId}`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`);
    expect(clientDelete.status).toBe(403);
    expect(clientDelete.body.data.code).toBe('PROMOTION_FORBIDDEN');

    // 10. Lavador no puede crear, editar, activar/desactivar ni eliminar
    const lavadorCreate = await request(ctx.app)
      .post('/api/v1/promotions')
      .set('Authorization', `Bearer ${ctx.lavadorToken}`)
      .send({
        title: 'Promo Lavador',
        description: 'No permitida',
        startsAt: isoOffsetHours(1),
        endsAt: isoOffsetHours(5),
      });
    expect(lavadorCreate.status).toBe(403);
    expect(lavadorCreate.body.data.code).toBe('PROMOTION_FORBIDDEN');

    const lavadorPatch = await request(ctx.app)
      .patch(`/api/v1/promotions/${promoId}`)
      .set('Authorization', `Bearer ${ctx.lavadorToken}`)
      .send({ title: 'Editada por lavador' });
    expect(lavadorPatch.status).toBe(403);

    const lavadorStatus = await request(ctx.app)
      .patch(`/api/v1/promotions/${promoId}/status`)
      .set('Authorization', `Bearer ${ctx.lavadorToken}`)
      .send({ isActive: false });
    expect(lavadorStatus.status).toBe(403);

    const lavadorDelete = await request(ctx.app)
      .delete(`/api/v1/promotions/${promoId}`)
      .set('Authorization', `Bearer ${ctx.lavadorToken}`);
    expect(lavadorDelete.status).toBe(403);
  });

  it('rechaza fechas inválidas, descuentos inválidos, XSS vacío y retorna 404 PROMOTION_NOT_FOUND para IDs inexistentes', async () => {
    const validPromo = await request(ctx.app)
      .post('/api/v1/promotions')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        title: 'Promo Validación',
        description: 'Base para probar validaciones',
        discountPercent: 10,
        startsAt: '2026-12-01T00:00:00.000Z',
        endsAt: '2026-12-15T23:59:59.000Z',
      });
    expect(validPromo.status).toBe(201);
    const promoId = validPromo.body.data.id as string;

    // 11. Fechas inválidas en creación y edición
    const badRangeCreate = await request(ctx.app)
      .post('/api/v1/promotions')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        title: 'Rango invertido',
        description: 'Debe rechazarse',
        discountPercent: 10,
        startsAt: '2026-12-20T00:00:00.000Z',
        endsAt: '2026-12-10T00:00:00.000Z',
      });
    expect(badRangeCreate.status).toBe(422);
    expect(badRangeCreate.body.data.code).toBe('PROMOTION_INVALID_DATES');

    const badFormatPatch = await request(ctx.app)
      .patch(`/api/v1/promotions/${promoId}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ startsAt: '2026-02-30T10:00:00Z' });
    expect(badFormatPatch.status).toBe(422);
    expect(badFormatPatch.body.data.code).toBe('PROMOTION_INVALID_DATES');

    const badRangePatch = await request(ctx.app)
      .patch(`/api/v1/promotions/${promoId}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ startsAt: '2026-12-25T00:00:00.000Z' });
    expect(badRangePatch.status).toBe(422);
    expect(badRangePatch.body.data.code).toBe('PROMOTION_INVALID_DATES');

    // Descuentos inválidos
    const badPercent = await request(ctx.app)
      .patch(`/api/v1/promotions/${promoId}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ discountPercent: 150 });
    expect(badPercent.status).toBe(422);
    expect(badPercent.body.data.code).toBe('PROMOTION_INVALID_DISCOUNT');

    const combinedDiscount = await request(ctx.app)
      .post('/api/v1/promotions')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        title: 'Doble descuento',
        description: 'No permitido',
        discountAmount: 2000,
        discountPercent: 15,
        startsAt: '2026-12-01T00:00:00.000Z',
        endsAt: '2026-12-10T00:00:00.000Z',
      });
    expect(combinedDiscount.status).toBe(422);
    expect(combinedDiscount.body.data.code).toBe('PROMOTION_INVALID_DISCOUNT');

    // Solo script HTML queda vacío -> VALIDATION_ERROR
    const pureScript = await request(ctx.app)
      .post('/api/v1/promotions')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        title: '<script>alert(1)</script>',
        description: 'Descripción normal',
        startsAt: '2026-12-01T00:00:00.000Z',
        endsAt: '2026-12-10T00:00:00.000Z',
      });
    expect(pureScript.status).toBe(422);
    expect(pureScript.body.data.code).toBe('VALIDATION_ERROR');

    // 14. ID inexistente devuelve 404 PROMOTION_NOT_FOUND
    const missingId = '99999999-9999-4999-8999-999999999999';
    const patch404 = await request(ctx.app)
      .patch(`/api/v1/promotions/${missingId}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ title: 'No existe' });
    expect(patch404.status).toBe(404);
    expect(patch404.body.data.code).toBe('PROMOTION_NOT_FOUND');

    const status404 = await request(ctx.app)
      .patch(`/api/v1/promotions/${missingId}/status`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ isActive: false });
    expect(status404.status).toBe(404);
    expect(status404.body.data.code).toBe('PROMOTION_NOT_FOUND');

    const delete404 = await request(ctx.app)
      .delete(`/api/v1/promotions/${missingId}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(delete404.status).toBe(404);
    expect(delete404.body.data.code).toBe('PROMOTION_NOT_FOUND');
  });

  it('16. ejecuta migración 004 sobre base limpia y sobre base existente conservando datos previos', async () => {
    // A) Base limpia completa
    const cleanDb = createDatabase({ pgliteDir: ':memory:' });
    const appliedClean = await runMigrations(cleanDb);
    expect(appliedClean).toContain('004_promotions_lifecycle.sql');
    const cleanCols = await cleanDb.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'promotions'
       ORDER BY column_name`,
    );
    const cleanColNames = cleanCols.rows.map((r) => r.column_name);
    expect(cleanColNames).toContain('updated_at');
    expect(cleanColNames).toContain('deleted_at');
    await cleanDb.close();

    // B) Base existente (migrada hasta 003 con datos previos en promotions)
    const existingDb = createDatabase({ pgliteDir: ':memory:' });
    const migrationsDir = path.resolve(process.cwd(), 'migrations');
    for (const file of [
      '001_initial_schema.sql',
      '002_seed_shop_defaults.sql',
      '003_motorcycle_decoupling.sql',
    ]) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      await existingDb.exec(sql);
      await existingDb.query(
        `INSERT INTO schema_migrations (version) VALUES ($1)`,
        [file],
      );
    }

    const legacyPromoId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await existingDb.query(
      `INSERT INTO promotions (id, title, description, discount_amount, starts_at, ends_at, is_active)
       VALUES ($1, 'Promo Legacy', 'Existente antes de migración 004', 1500, NOW(), NOW() + INTERVAL '7 days', TRUE)`,
      [legacyPromoId],
    );

    const appliedUpgrade = await runMigrations(existingDb);
    expect(appliedUpgrade).toContain('004_promotions_lifecycle.sql');

    const upgradedRow = await existingDb.query<{
      id: string;
      title: string;
      updated_at: Date | string | null;
      deleted_at: Date | string | null;
    }>(`SELECT id, title, updated_at, deleted_at FROM promotions WHERE id = $1`, [
      legacyPromoId,
    ]);
    expect(upgradedRow.rows[0]?.id).toBe(legacyPromoId);
    expect(upgradedRow.rows[0]?.title).toBe('Promo Legacy');
    expect(upgradedRow.rows[0]?.updated_at).not.toBeNull();
    expect(upgradedRow.rows[0]?.deleted_at).toBeNull();

    await existingDb.close();
  });
});
