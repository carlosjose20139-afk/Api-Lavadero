import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { createDatabase, type DbClient } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrator.js';
import { seedDevelopmentData } from '../../src/db/seed.js';
import { hashPassword, newUuid } from '../../src/utils/crypto.js';

export interface TestContext {
  db: DbClient;
  app: Express;
  adminToken: string;
  lavadorToken: string;
  clienteToken: string;
  clienteId: string;
  motoId: string;
  serviceId: string;
  cleanup: () => Promise<void>;
}

export async function createTestContext(): Promise<TestContext> {
  process.env.NODE_ENV = 'test';
  const db = createDatabase({ pgliteDir: ':memory:' });
  await runMigrations(db);
  await seedDevelopmentData(db);

  const adminRow = await db.query<{ id: string }>(
    `SELECT id FROM users WHERE username = 'admin'`,
  );
  const adminId = adminRow.rows[0]!.id;
  const lavadorUserId = newUuid();
  const clienteUserId = newUuid();
  const employeeId = newUuid();
  const testMotoId = newUuid();
  const testServiceId = newUuid();

  const [lavadorHash, clienteHash] = await Promise.all([
    hashPassword('Lavador1234*'),
    hashPassword('Cliente1234*'),
  ]);

  await db.withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO users (id, name, username, password_hash, role, is_active, terms_accepted_at, privacy_policy_version)
       VALUES
         ($1, 'Carlos Lavador', 'lavador', $3, 'Lavador', TRUE, NOW(), '2026.1-ley1581'),
         ($2, 'Mateo Motero', 'mateo.moto', $4, 'Cliente', TRUE, NOW(), '2026.1-ley1581')`,
      [lavadorUserId, clienteUserId, lavadorHash, clienteHash],
    );

    await tx.query(
      `INSERT INTO employees (id, user_id, name, role, commission_percent, is_active)
       VALUES ($1, $2, 'Carlos Lavador', 'Lavador', 30.00, TRUE)`,
      [employeeId, lavadorUserId],
    );

    await tx.query(
      `INSERT INTO loyalty_cards (customer_id, stamps, completed_washes, qr_token)
       VALUES ($1, 0, 0, 'LM-TEST-MATEO-001')`,
      [clienteUserId],
    );

    await tx.query(
      `INSERT INTO motorcycles (id, customer_id, brand, model, cc, nickname, color)
       VALUES ($1, $2, 'Yamaha', 'MT-03', 321, 'La Negra', 'Negro Mate')`,
      [testMotoId, clienteUserId],
    );

    await tx.query(
      `INSERT INTO motorcycle_customer_assignments (
         id, motorcycle_id, customer_id, action, performed_by, previous_customer_id, reason
       )
       VALUES ($1, $2, $3, 'assigned', $4, NULL, 'Fixture inicial de pruebas')`,
      [newUuid(), testMotoId, clienteUserId, adminId],
    );

    await tx.query(
      `INSERT INTO services (id, name, description, price, duration_minutes, surcharge_from_cc, is_active)
       VALUES ($1, 'Lavada Express', 'Lavado general con espuma activa y secado con microfibra', 7000, 30, 500, TRUE)`,
      [testServiceId],
    );
  });

  const app = createApp(db, { enableRateLimit: false });

  const [adminLogin, lavadorLogin, clienteLogin] = await Promise.all([
    request(app)
      .post('/api/v1/auth/login')
      .send({ username: 'admin', password: 'Admin1234*' }),
    request(app)
      .post('/api/v1/auth/login')
      .send({ username: 'lavador', password: 'Lavador1234*' }),
    request(app)
      .post('/api/v1/auth/login')
      .send({ username: 'mateo.moto', password: 'Cliente1234*' }),
  ]);

  const adminToken = adminLogin.body.data.accessToken as string;
  const lavadorToken = lavadorLogin.body.data.accessToken as string;
  const clienteToken = clienteLogin.body.data.accessToken as string;
  const clienteId = clienteLogin.body.data.user.id as string;

  const motosRes = await request(app)
    .get('/api/v1/motorcycles')
    .set('Authorization', `Bearer ${clienteToken}`);
  const motoId = motosRes.body.data[0].id as string;

  const servicesRes = await request(app).get('/api/v1/services');
  const expressSvc = (
    servicesRes.body.data as Array<{ id: string; name: string }>
  ).find((s) => s.name === 'Lavada Express');
  const serviceId = expressSvc!.id;

  return {
    db,
    app,
    adminToken,
    lavadorToken,
    clienteToken,
    clienteId,
    motoId,
    serviceId,
    cleanup: async () => {
      await db.close();
    },
  };
}
