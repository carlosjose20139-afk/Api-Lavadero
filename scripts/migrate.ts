import { createDatabase } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrator.js';
import { logger } from '../src/config/logger.js';

async function main() {
  const db = createDatabase();
  try {
    const applied = await runMigrations(db);
    logger.info({ applied }, 'Proceso de migraciones finalizado');
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error('Error aplicando migraciones:', err);
  process.exit(1);
});
