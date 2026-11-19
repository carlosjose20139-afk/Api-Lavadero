import type { DbClient } from './index.js';
import { hashPassword, newUuid } from '../utils/crypto.js';
import { logger } from '../config/logger.js';

export async function seedDevelopmentData(db: DbClient): Promise<void> {
  const existingAdmin = await db.query<{ id: string }>(
    `SELECT id FROM users WHERE username = 'admin'`,
  );
  if (existingAdmin.rows[0]) {
    logger.info('Seed omitido: el usuario administrador ya existe');
    return;
  }

  const adminId = newUuid();
  const adminHash = await hashPassword('Admin1234*');

  await db.withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO users (id, name, username, password_hash, role, is_active, terms_accepted_at, privacy_policy_version)
       VALUES ($1, 'Administrador Los Malditos', 'admin', $2, 'Administrador', TRUE, NOW(), '2026.1-ley1581')`,
      [adminId, adminHash],
    );
  });

  logger.info('Seed aplicado: usuario administrador creado');
}
