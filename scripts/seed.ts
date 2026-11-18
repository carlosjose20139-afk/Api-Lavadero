import { createDatabase } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrator.js';
import { seedDevelopmentData } from '../src/db/seed.js';

async function main() {
  const db = createDatabase();
  try {
    await runMigrations(db);
    await seedDevelopmentData(db);
    console.log('Seed de desarrollo ejecutado correctamente.');
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error('Error ejecutando seed:', err);
  process.exit(1);
});
