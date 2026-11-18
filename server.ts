import { env } from './src/config/env.js';
import { logger } from './src/config/logger.js';
import { createDatabase } from './src/db/index.js';
import { runMigrations } from './src/db/migrator.js';
import { seedDevelopmentData } from './src/db/seed.js';
import { createApp } from './src/app.js';
import { startBackgroundScheduler } from './src/services/scheduler.service.js';

async function bootstrap() {
  const db = createDatabase();
  await runMigrations(db);

  if (env.NODE_ENV === 'development') {
    await seedDevelopmentData(db);
  }

  const app = createApp(db);
  const stopScheduler = startBackgroundScheduler(
    db,
    env.EXPIRATION_CHECK_INTERVAL_MS,
  );

  const server = app.listen(env.PORT, '0.0.0.0', () => {
    logger.info(
      { port: env.PORT, env: env.NODE_ENV, driver: db.driver },
      `Los Malditos API escuchando en http://0.0.0.0:${env.PORT}/api/v1`,
    );
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Apagando servidor ordenadamente');
    stopScheduler();
    server.close(async () => {
      await db.close();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  logger.fatal(
    { err: err instanceof Error ? err.message : 'unknown' },
    'Error fatal al iniciar el servidor',
  );
  process.exit(1);
});
