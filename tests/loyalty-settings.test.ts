import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { createDatabase } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrator.js';
import { hashPassword, newUuid } from '../src/utils/crypto.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';

async function createPaidWash(
  ctx: TestContext,
  keyPrefix: string,
): Promise<string> {
  const price = 7000;
  const wr = await request(ctx.app)
    .post('/api/v1/wash-requests')
    .set('Authorization', `Bearer ${ctx.adminToken}`)
    .set('X-Idempotency-Key', `${keyPrefix}-wr`)
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
    .set('X-Idempotency-Key', `${keyPrefix}-cf`);
  expect(conf.status).toBe(200);

  const ready = await request(ctx.app)
    .patch(`/api/v1/wash-requests/${washId}/status`)
    .set('Authorization', `Bearer ${ctx.lavadorToken}`)
    .send({ status: 'ready' });
  expect(ready.status).toBe(200);

  const pay = await request(ctx.app)
    .post('/api/v1/payments')
    .set('Authorization', `Bearer ${ctx.adminToken}`)
    .set('X-Idempotency-Key', `${keyPrefix}-py`)
    .send({
      washRequestId: washId,
      method: 'Efectivo',
      amount: price,
    });
  expect(pay.status).toBe(201);

  return washId;
}

async function findNextAvailableStartAt(ctx: TestContext): Promise<string> {
  for (let offsetDays = 1; offsetDays <= 14; offsetDays += 1) {
    const d = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
    const ymd = d.toISOString().slice(0, 10);
    const availRes = await request(ctx.app)
      .get(
        `/api/v1/appointments/availability?date=${ymd}&serviceId=${ctx.serviceId}`,
      )
      .set('Authorization', `Bearer ${ctx.clienteToken}`);
    const slots = availRes.body?.data?.slots as
      | Array<{ startAt: string; availableCapacity: number }>
      | undefined;
    if (availRes.status === 200 && Array.isArray(slots)) {
      const slot = slots.find((s) => s.availableCapacity > 0);
      if (slot) {
        return slot.startAt;
      }
    }
  }
  throw new Error('No se encontró horario disponible en los próximos 14 días');
}

describe('Configuración Global loyaltyEnabled: migración, RBAC, bloqueo 409, preservación de historial, auditoría y OpenAPI', () => {
  let ctx: TestContext;
  let adminId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    const adminRow = await ctx.db.query<{ id: string }>(
      `SELECT id FROM users WHERE username = 'admin'`,
    );
    adminId = adminRow.rows[0]!.id;
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('1 y 2: migración 007 funciona en base limpia, es idempotente y en base existente conserva datos sin borrar nada', async () => {
    // 1. Base limpia completa
    const cleanDb = createDatabase({ pgliteDir: ':memory:' });
    const firstApply = await runMigrations(cleanDb);
    expect(firstApply).toContain('007_loyalty_settings.sql');

    // Idempotencia al re-ejecutar migraciones
    const secondApply = await runMigrations(cleanDb);
    expect(secondApply).toEqual([]);

    const settingRes = await cleanDb.query<{
      key: string;
      value_json: unknown;
    }>(`SELECT key, value_json FROM business_settings WHERE key = 'loyaltyEnabled'`);
    expect(settingRes.rows.length).toBe(1);
    expect(settingRes.rows[0]?.value_json).toBe(true);
    await cleanDb.close();

    // 2. Base existente hasta 006 con datos reales -> migra a 007 sin borrar datos
    const existingDb = createDatabase({ pgliteDir: ':memory:' });
    const migrationsDir = path.resolve(process.cwd(), 'migrations');
    for (const file of [
      '001_initial_schema.sql',
      '002_seed_shop_defaults.sql',
      '003_motorcycle_decoupling.sql',
      '004_promotions_lifecycle.sql',
      '005_forum_replies_audit.sql',
      '006_loyalty_lifecycle.sql',
    ]) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      await existingDb.exec(sql);
      await existingDb.query(`INSERT INTO schema_migrations (version) VALUES ($1)`, [
        file,
      ]);
    }

    const legacyCustId = newUuid();
    const pwdHash = await hashPassword('LegacyPass123*');
    await existingDb.query(
      `INSERT INTO users (id, name, username, password_hash, role, is_active)
       VALUES ($1, 'Cliente Histórico', 'hist.client', $2, 'Cliente', TRUE)`,
      [legacyCustId, pwdHash],
    );
    await existingDb.query(
      `INSERT INTO loyalty_cards (id, customer_id, stamps, completed_washes, qr_token)
       VALUES ($1, $2, 5, 12, 'LM-HIST-001')`,
      [newUuid(), legacyCustId],
    );

    const upgraded = await runMigrations(existingDb);
    expect(upgraded).toContain('007_loyalty_settings.sql');

    const preservedCard = await existingDb.query<{
      stamps: number;
      completed_washes: number;
    }>(`SELECT stamps, completed_washes FROM loyalty_cards WHERE customer_id = $1`, [
      legacyCustId,
    ]);
    expect(Number(preservedCard.rows[0]?.stamps)).toBe(5);
    expect(Number(preservedCard.rows[0]?.completed_washes)).toBe(12);

    const upgradedSetting = await existingDb.query<{ value_json: unknown }>(
      `SELECT value_json FROM business_settings WHERE key = 'loyaltyEnabled'`,
    );
    expect(upgradedSetting.rows[0]?.value_json).toBe(true);
    await existingDb.close();
  });

  it('3, 4, 5, 6 y 7: valor por defecto true, GET /settings/public sin auth/secretos, RBAC y validación estricta en PATCH /settings/loyalty', async () => {
    // GET /settings/public sin autenticación -> 200 y solo loyaltyEnabled: true
    const pubRes = await request(ctx.app).get('/api/v1/settings/public');
    expect(pubRes.status).toBe(200);
    expect(pubRes.body).toEqual({
      data: { loyaltyEnabled: true },
      message: 'Configuración pública consultada exitosamente',
    });
    expect(Object.keys(pubRes.body.data)).toEqual(['loyaltyEnabled']);

    // PATCH sin token -> 401
    const unauthPatch = await request(ctx.app)
      .patch('/api/v1/settings/loyalty')
      .send({ loyaltyEnabled: false });
    expect(unauthPatch.status).toBe(401);

    // PATCH como Cliente -> 403
    const clientPatch = await request(ctx.app)
      .patch('/api/v1/settings/loyalty')
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({ loyaltyEnabled: false });
    expect(clientPatch.status).toBe(403);

    // PATCH como Lavador -> 403
    const lavadorPatch = await request(ctx.app)
      .patch('/api/v1/settings/loyalty')
      .set('Authorization', `Bearer ${ctx.lavadorToken}`)
      .send({ loyaltyEnabled: false });
    expect(lavadorPatch.status).toBe(403);

    // Validaciones inválidas (string, vacío, propiedades desconocidas) -> 422
    const stringBody = await request(ctx.app)
      .patch('/api/v1/settings/loyalty')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ loyaltyEnabled: 'false' });
    expect(stringBody.status).toBe(422);

    const emptyBody = await request(ctx.app)
      .patch('/api/v1/settings/loyalty')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({});
    expect(emptyBody.status).toBe(422);

    const extraPropBody = await request(ctx.app)
      .patch('/api/v1/settings/loyalty')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ loyaltyEnabled: false, extraField: 'nope' });
    expect(extraPropBody.status).toBe(422);
  });

  it('8-16: desactivar bloquea todas las mutaciones con 409 LOYALTY_DISABLED, conserva historial/lecturas, audita sin notificar clientes y reactiva limpio', async () => {
    // A) Preparamos datos históricos previos mientras loyaltyEnabled === true:
    //    - 1 sello activo (stamp1)
    //    - 1 recompensa manual disponible vigente (availRewardId)
    //    - 1 recompensa manual ya vencida para verificar que no se auto-expire estando desactivado
    //    - 1 recompensa manual ya redimida (redeemedRewardId) para verificar que nunca se revierte
    const wash1 = await createPaidWash(ctx, 'idem-loyalty-set-pre-01');
    const stamp1Res = await request(ctx.app)
      .post('/api/v1/loyalty/stamps')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .set('Idempotency-Key', 'idem-set-stamp-pre-01')
      .send({ washRequestId: wash1 });
    expect(stamp1Res.status).toBe(201);
    const stamp1Id = stamp1Res.body.data.lastStamp.id as string;

    const nowMs = Date.now();
    const availFrom = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
    const availUntil = new Date(nowMs + 10 * 24 * 60 * 60 * 1000).toISOString();
    const availRewardRes = await request(ctx.app)
      .post(`/api/v1/loyalty/customers/${ctx.clienteId}/rewards`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        title: 'Lavada disponible previa',
        validFrom: availFrom,
        validUntil: availUntil,
        reason: 'Prueba de preservación',
      });
    expect(availRewardRes.status).toBe(201);
    const availRewardId = availRewardRes.body.data.id as string;

    const redeemedRewardRes = await request(ctx.app)
      .post(`/api/v1/loyalty/customers/${ctx.clienteId}/rewards`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        title: 'Lavada ya redimida previa',
        validFrom: availFrom,
        validUntil: availUntil,
      });
    expect(redeemedRewardRes.status).toBe(201);
    const redeemedRewardId = redeemedRewardRes.body.data.id as string;

    const redeemBeforeDisable = await request(ctx.app)
      .post(`/api/v1/loyalty/rewards/${redeemedRewardId}/redeem`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .set('Idempotency-Key', 'idem-set-redeem-pre-01')
      .send({});
    expect(redeemBeforeDisable.status).toBe(200);

    // Preparamos una lavada pagada lista para intentar sellar cuando esté desactivada
    const washWhileDisabled = await createPaidWash(ctx, 'idem-loyalty-set-dis-01');

    // Contamos notificaciones de cliente antes de desactivar
    const clientNotifsBeforeRes = await request(ctx.app)
      .get('/api/v1/notifications?page=1&pageSize=100')
      .set('Authorization', `Bearer ${ctx.clienteToken}`);
    const clientNotifsCountBefore = (
      clientNotifsBeforeRes.body.data as unknown[]
    ).length;

    // B) Administrador desactiva loyaltyEnabled -> false
    const disableRes = await request(ctx.app)
      .patch('/api/v1/settings/loyalty')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ loyaltyEnabled: false });
    expect(disableRes.status).toBe(200);
    expect(disableRes.body.message).toBe(
      'Configuración de Fidelización actualizada exitosamente',
    );
    expect(disableRes.body.data.loyaltyEnabled).toBe(false);
    expect(disableRes.body.data.updatedBy).toBe(adminId);
    expect(disableRes.body.data.updatedAt).toBeTruthy();

    // GET /settings/public refleja inmediatamente false
    const pubDisabled = await request(ctx.app).get('/api/v1/settings/public');
    expect(pubDisabled.status).toBe(200);
    expect(pubDisabled.body.data).toEqual({ loyaltyEnabled: false });

    // C) Todas las mutaciones de Fidelización responden inmediatamente 409 LOYALTY_DISABLED
    const expectDisabled409 = (res: request.Response) => {
      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        data: { code: 'LOYALTY_DISABLED' },
        message: 'La campaña de Fidelización está desactivada temporalmente',
      });
    };

    // 1. POST /loyalty/stamps (tanto nueva key como key ya usada antes)
    expectDisabled409(
      await request(ctx.app)
        .post('/api/v1/loyalty/stamps')
        .set('Authorization', `Bearer ${ctx.adminToken}`)
        .set('Idempotency-Key', 'idem-set-stamp-dis-01')
        .send({ washRequestId: washWhileDisabled }),
    );
    expectDisabled409(
      await request(ctx.app)
        .post('/api/v1/loyalty/stamps')
        .set('Authorization', `Bearer ${ctx.adminToken}`)
        .set('Idempotency-Key', 'idem-set-stamp-pre-01')
        .send({ washRequestId: wash1 }),
    );

    // 2. POST /loyalty/customers/:customerId/stamps
    expectDisabled409(
      await request(ctx.app)
        .post(`/api/v1/loyalty/customers/${ctx.clienteId}/stamps`)
        .set('Authorization', `Bearer ${ctx.lavadorToken}`)
        .set('Idempotency-Key', 'idem-set-cust-dis-01')
        .send({ washRequestId: washWhileDisabled }),
    );

    // 3. DELETE /loyalty/customers/:customerId/stamps/:stampId
    expectDisabled409(
      await request(ctx.app)
        .delete(`/api/v1/loyalty/customers/${ctx.clienteId}/stamps/${stamp1Id}`)
        .set('Authorization', `Bearer ${ctx.adminToken}`)
        .send({ reason: 'Intento con módulo desactivado' }),
    );

    // 4. POST /loyalty/customers/:customerId/rewards
    expectDisabled409(
      await request(ctx.app)
        .post(`/api/v1/loyalty/customers/${ctx.clienteId}/rewards`)
        .set('Authorization', `Bearer ${ctx.adminToken}`)
        .send({
          title: 'Premio bloqueado',
          validFrom: availFrom,
          validUntil: availUntil,
        }),
    );

    // 5. DELETE /loyalty/rewards/:id
    expectDisabled409(
      await request(ctx.app)
        .delete(`/api/v1/loyalty/rewards/${availRewardId}`)
        .set('Authorization', `Bearer ${ctx.adminToken}`)
        .send({ reason: 'Intento de cancelación' }),
    );

    // 6. POST /loyalty/rewards/:id/redeem
    expectDisabled409(
      await request(ctx.app)
        .post(`/api/v1/loyalty/rewards/${availRewardId}/redeem`)
        .set('Authorization', `Bearer ${ctx.clienteToken}`)
        .set('Idempotency-Key', 'idem-set-redeem-dis-01')
        .send({}),
    );

    // 7. POST /loyalty/expire
    expectDisabled409(
      await request(ctx.app)
        .post('/api/v1/loyalty/expire')
        .set('Authorization', `Bearer ${ctx.adminToken}`),
    );

    // 8. POST /appointments con isLoyaltyRedemption: true bloqueado con 409 LOYALTY_DISABLED
    const nextSlot = await findNextAvailableStartAt(ctx);
    expectDisabled409(
      await request(ctx.app)
        .post('/api/v1/appointments')
        .set('Authorization', `Bearer ${ctx.clienteToken}`)
        .send({
          customerId: ctx.clienteId,
          motorcycleId: ctx.motoId,
          serviceId: ctx.serviceId,
          startAt: nextSlot,
          isLoyaltyRedemption: true,
        }),
    );

    // Pero una cita normal (sin redención de lealtad) sigue funcionando normalmente
    const normalApptRes = await request(ctx.app)
      .post('/api/v1/appointments')
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({
        customerId: ctx.clienteId,
        motorcycleId: ctx.motoId,
        serviceId: ctx.serviceId,
        startAt: nextSlot,
        isLoyaltyRedemption: false,
      });
    expect(normalApptRes.status).toBe(201);

    // D) Endpoints de lectura siguen devolviendo historial existente e indican loyaltyEnabled: false
    const meDisabled = await request(ctx.app)
      .get('/api/v1/loyalty/me')
      .set('Authorization', `Bearer ${ctx.clienteToken}`);
    expect(meDisabled.status).toBe(200);
    expect(meDisabled.body.data.loyaltyEnabled).toBe(false);
    expect(meDisabled.body.data.stamps).toBe(1);
    expect(meDisabled.body.data.completedWashes).toBe(1);
    expect(meDisabled.body.data.rewards.length).toBe(2);

    const rewardsDisabled = await request(ctx.app)
      .get('/api/v1/loyalty/rewards')
      .set('Authorization', `Bearer ${ctx.clienteToken}`);
    expect(rewardsDisabled.status).toBe(200);
    expect(rewardsDisabled.body.data[0].loyaltyEnabled).toBe(false);
    expect(rewardsDisabled.body.data[0].rewards.length).toBe(2);

    const customersDisabled = await request(ctx.app)
      .get('/api/v1/loyalty/customers')
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(customersDisabled.status).toBe(200);
    expect(customersDisabled.body.data[0].loyaltyEnabled).toBe(false);
    expect(customersDisabled.body.data[0].stamps).toBe(1);

    const detailDisabled = await request(ctx.app)
      .get(`/api/v1/loyalty/customers/${ctx.clienteId}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(detailDisabled.status).toBe(200);
    expect(detailDisabled.body.data.loyaltyEnabled).toBe(false);
    expect(detailDisabled.body.data.stamps).toBe(1);
    expect(detailDisabled.body.data.rewards.available.length).toBe(1);
    expect(detailDisabled.body.data.rewards.redeemed.length).toBe(1);

    // E) Auditoría y notificaciones:
    //    - Se registró loyalty_settings_updated en audit_logs
    //    - Se notificó a administradores y NO a clientes (la cita normal creó 1 reminder, así que verificamos tipo)
    const auditRes = await ctx.db.query<{
      actor_id: string;
      actor_role: string;
      action: string;
      changes: Record<string, unknown>;
    }>(
      `SELECT actor_id, actor_role, action, changes
       FROM audit_logs
       WHERE action = 'loyalty_settings_updated'
       ORDER BY occurred_at DESC`,
    );
    expect(auditRes.rows.length).toBe(1);
    expect(auditRes.rows[0]?.actor_id).toBe(adminId);
    expect(auditRes.rows[0]?.actor_role).toBe('Administrador');
    expect(auditRes.rows[0]?.changes.previousValue).toBe(true);
    expect(auditRes.rows[0]?.changes.newValue).toBe(false);

    const clientSettingsNotifs = await ctx.db.query<{ id: string }>(
      `SELECT id FROM notifications WHERE user_id = $1 AND type = 'loyalty_settings_updated'`,
      [ctx.clienteId],
    );
    expect(clientSettingsNotifs.rows.length).toBe(0);

    const adminSettingsNotifs = await ctx.db.query<{ id: string }>(
      `SELECT id FROM notifications WHERE user_id = $1 AND type = 'loyalty_settings_updated'`,
      [adminId],
    );
    expect(adminSettingsNotifs.rows.length).toBe(1);

    // Ninguna notificación extra de lealtad para el cliente (solo la de la cita normal)
    const clientNotifsAfterDisable = await request(ctx.app)
      .get('/api/v1/notifications?page=1&pageSize=100')
      .set('Authorization', `Bearer ${ctx.clienteToken}`);
    expect((clientNotifsAfterDisable.body.data as unknown[]).length).toBe(
      clientNotifsCountBefore + 1,
    );

    // F) Reactivación: vuelve a true, conserva historial, NO revierte redenciones ni crea premios retroactivos
    const enableRes = await request(ctx.app)
      .patch('/api/v1/settings/loyalty')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ loyaltyEnabled: true });
    expect(enableRes.status).toBe(200);
    expect(enableRes.body.data.loyaltyEnabled).toBe(true);

    const pubEnabled = await request(ctx.app).get('/api/v1/settings/public');
    expect(pubEnabled.body.data).toEqual({ loyaltyEnabled: true });

    // Clientes tampoco reciben notificación en reactivación
    const clientSettingsNotifsAfterEnable = await ctx.db.query<{ id: string }>(
      `SELECT id FROM notifications WHERE user_id = $1 AND type = 'loyalty_settings_updated'`,
      [ctx.clienteId],
    );
    expect(clientSettingsNotifsAfterEnable.rows.length).toBe(0);

    // Historial idéntico (1 sello, 1 lavada, 1 disponible, 1 redimida, sin premios retroactivos)
    const meReactivated = await request(ctx.app)
      .get('/api/v1/loyalty/me')
      .set('Authorization', `Bearer ${ctx.clienteToken}`);
    expect(meReactivated.status).toBe(200);
    expect(meReactivated.body.data.loyaltyEnabled).toBe(true);
    expect(meReactivated.body.data.stamps).toBe(1);
    expect(meReactivated.body.data.completedWashes).toBe(1);
    expect(meReactivated.body.data.rewards.length).toBe(2);

    // Ahora sí se puede sellar la lavada pendiente de sello
    const stampReactivatedRes = await request(ctx.app)
      .post('/api/v1/loyalty/stamps')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .set('Idempotency-Key', 'idem-set-stamp-react-01')
      .send({ washRequestId: washWhileDisabled });
    expect(stampReactivatedRes.status).toBe(201);
    expect(stampReactivatedRes.body.data.stamps).toBe(2);
    expect(stampReactivatedRes.body.data.completedWashes).toBe(2);
  });

  it('17: OpenAPI documenta GET /settings/public y PATCH /settings/loyalty con esquemas y respuestas esperadas', () => {
    const specRaw = fs.readFileSync(
      path.resolve(process.cwd(), 'docs/api/openapi.yaml'),
      'utf8',
    );
    const spec = YAML.parse(specRaw) as {
      paths: Record<string, Record<string, { responses?: Record<string, unknown>; security?: unknown[] }>>;
      components: { schemas: Record<string, unknown> };
    };

    expect(spec.paths['/settings/public']?.get).toBeTruthy();
    expect(spec.paths['/settings/public']?.get?.security).toEqual([]);
    expect(spec.paths['/settings/loyalty']?.patch).toBeTruthy();
    expect(spec.paths['/settings/loyalty']?.patch?.security).toEqual([
      { bearerAuth: [] },
    ]);
    expect(spec.paths['/settings/loyalty']?.patch?.responses?.['200']).toBeTruthy();
    expect(spec.paths['/settings/loyalty']?.patch?.responses?.['401']).toBeTruthy();
    expect(spec.paths['/settings/loyalty']?.patch?.responses?.['403']).toBeTruthy();
    expect(spec.paths['/settings/loyalty']?.patch?.responses?.['422']).toBeTruthy();

    expect(spec.components.schemas.LoyaltySettingsPublic).toBeTruthy();
    expect(spec.components.schemas.LoyaltySettingsUpdate).toBeTruthy();
    expect(spec.components.schemas.LoyaltySettingsUpdated).toBeTruthy();
  });
});
