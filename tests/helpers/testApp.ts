import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { createDatabase, type DbClient } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrator.js';
import { seedDevelopmentData } from '../../src/db/seed.js';

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
