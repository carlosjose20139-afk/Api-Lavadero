import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express, { type Express } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yaml';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import type { DbClient } from './db/index.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { createAppointmentsRouter } from './modules/appointments/appointments.routes.js';
import { createAuthRouter } from './modules/auth/auth.routes.js';
import { createCustomersRouter } from './modules/customers/customers.routes.js';
import { createEmployeesRouter } from './modules/employees/employees.routes.js';
import {
  createExpensesRouter,
  createIncomesRouter,
  createPaymentsRouter,
} from './modules/finance/finance.routes.js';
import { createForumRouter } from './modules/forum/forum.routes.js';
import { createInventoryRouter } from './modules/inventory/inventory.routes.js';
import { createLegalRouter } from './modules/legal/legal.routes.js';
import { createLoyaltyRouter } from './modules/loyalty/loyalty.routes.js';
import { createMotorcyclesRouter } from './modules/motorcycles/motorcycles.routes.js';
import {
  createDevicesRouter,
  createNotificationsRouter,
} from './modules/notifications/notifications.routes.js';
import { createPromotionsRouter } from './modules/promotions/promotions.routes.js';
import { createReportsRouter } from './modules/reports/reports.routes.js';
import { createReviewsRouter } from './modules/reviews/reviews.routes.js';
import { createServicesRouter } from './modules/services/services.routes.js';
import { createWashRequestsRouter } from './modules/washRequests/washRequests.routes.js';
import { ok } from './utils/response.js';
import { toIsoBogota } from './utils/time.js';

export interface CreateAppOptions {
  enableRateLimit?: boolean;
}

function loadOpenApiSpec(): { rawYaml: string; parsed: Record<string, unknown> } {
  const candidates = [
    path.resolve(process.cwd(), 'docs/api/openapi.yaml'),
    path.resolve(process.cwd(), 'public/assets/aistudio/openapi_d77dc774.yaml'),
  ];
  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) {
      const rawYaml = fs.readFileSync(filePath, 'utf8');
      const parsed = YAML.parse(rawYaml) as Record<string, unknown>;
      return { rawYaml, parsed };
    }
  }
  return {
    rawYaml: 'openapi: 3.0.3\ninfo:\n  title: Los Malditos API\n  version: 1.0.0\npaths: {}\n',
    parsed: { openapi: '3.0.3', info: { title: 'Los Malditos API', version: '1.0.0' }, paths: {} },
  };
}

export function createApp(db: DbClient, options: CreateAppOptions = {}): Express {
  const app = express();
  const enableRateLimit = options.enableRateLimit ?? env.NODE_ENV !== 'test';
  const openApi = loadOpenApiSpec();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.use(
    cors({
      origin: env.CORS_ORIGIN_LIST === '*' ? true : env.CORS_ORIGIN_LIST,
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Idempotency-Key'],
    }),
  );

  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));

  // Log estructurado por petición sin datos sensibles
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      logger.info({
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        durationMs: Date.now() - start,
      });
    });
    next();
  });

  if (enableRateLimit) {
    app.use(
      '/api/v1',
      rateLimit({
        windowMs: env.RATE_LIMIT_WINDOW_MS,
        max: env.RATE_LIMIT_MAX,
        standardHeaders: true,
        legacyHeaders: false,
        message: {
          data: { code: 'RATE_LIMIT_EXCEEDED' },
          message: 'Demasiadas solicitudes. Intenta nuevamente en unos minutos',
        },
      }),
    );

    app.use(
      '/api/v1/auth/login',
      rateLimit({
        windowMs: env.RATE_LIMIT_WINDOW_MS,
        max: env.AUTH_RATE_LIMIT_MAX,
        standardHeaders: true,
        legacyHeaders: false,
        message: {
          data: { code: 'AUTH_RATE_LIMIT_EXCEEDED' },
          message: 'Demasiados intentos de inicio de sesión desde esta IP',
        },
      }),
    );
  }

  // Documentación OpenAPI y entrada informativa
  app.get('/', (_req, res) => {
    res.status(200).type('html').send(`<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Los Malditos API</title>
    <style>
      body{font-family:system-ui,-apple-system,sans-serif;background:#111;color:#f5f5f5;margin:0;padding:40px 24px;line-height:1.6}
      main{max-width:720px;margin:0 auto;background:#1b1b1e;border:1px solid #2d2d34;border-radius:12px;padding:32px}
      h1{margin-top:0;color:#ff6b2c}
      code{background:#26262b;padding:2px 6px;border-radius:4px}
      a{color:#ff8a4c;text-decoration:none;font-weight:600}
      a:hover{text-decoration:underline}
    </style>
  </head>
  <body>
    <main>
      <h1>Los Malditos — Backend REST API v1</h1>
      <p>Servicio operativo en zona horaria <code>America/Bogota</code> y moneda <code>COP</code>.</p>
      <ul>
        <li>Documentación interactiva: <a href="/api/docs">/api/docs</a></li>
        <li>Contrato OpenAPI YAML: <a href="/api/v1/openapi.yaml">/api/v1/openapi.yaml</a></li>
        <li>Contrato OpenAPI JSON: <a href="/api/v1/openapi.json">/api/v1/openapi.json</a></li>
        <li>Estado del servidor: <a href="/api/v1/health">/api/v1/health</a></li>
      </ul>
    </main>
  </body>
</html>`);
  });

  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openApi.parsed));

  const apiV1 = express.Router();

  apiV1.get('/health', async (_req, res, next) => {
    try {
      await db.query('SELECT 1 AS ok');
      return ok(
        res,
        {
          status: 'healthy',
          driver: db.driver,
          timezone: 'America/Bogota',
          currency: 'COP',
          timestamp: toIsoBogota(new Date()),
        },
        'API operativa',
      );
    } catch (err) {
      next(err);
    }
  });

  apiV1.get('/openapi.yaml', (_req, res) => {
    res.type('text/yaml; charset=utf-8').send(openApi.rawYaml);
  });

  apiV1.get('/openapi.json', (_req, res) => {
    res.json(openApi.parsed);
  });

  apiV1.use('/auth', createAuthRouter(db));
  apiV1.use('/customers', createCustomersRouter(db));
  apiV1.use('/motorcycles', createMotorcyclesRouter(db));
  apiV1.use('/services', createServicesRouter(db));
  apiV1.use('/appointments', createAppointmentsRouter(db));
  apiV1.use('/wash-requests', createWashRequestsRouter(db));
  apiV1.use('/notifications', createNotificationsRouter(db));
  apiV1.use('/devices', createDevicesRouter(db));
  apiV1.use('/loyalty', createLoyaltyRouter(db));
  apiV1.use('/payments', createPaymentsRouter(db));
  apiV1.use('/expenses', createExpensesRouter(db));
  apiV1.use('/incomes', createIncomesRouter(db));
  apiV1.use('/inventory', createInventoryRouter(db));
  apiV1.use('/employees', createEmployeesRouter(db));
  apiV1.use('/promotions', createPromotionsRouter(db));
  apiV1.use('/reviews', createReviewsRouter(db));
  apiV1.use('/forum', createForumRouter(db));
  apiV1.use('/reports', createReportsRouter(db));
  apiV1.use('/legal', createLegalRouter(db));

  app.use('/api/v1', apiV1);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
