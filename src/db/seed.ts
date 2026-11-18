import type { DbClient } from './index.js';
import { hashPassword, newUuid } from '../utils/crypto.js';
import { logger } from '../config/logger.js';

export async function seedDevelopmentData(db: DbClient): Promise<void> {
  const existingAdmin = await db.query<{ id: string }>(
    `SELECT id FROM users WHERE username = 'admin'`,
  );
  if (existingAdmin.rows[0]) {
    logger.info('Seed omitido: los datos iniciales ya existen');
    return;
  }

  const adminId = newUuid();
  const lavadorUserId = newUuid();
  const clienteId = newUuid();
  const employeeId = newUuid();
  const motoId = newUuid();
  const svcBasicaId = newUuid();
  const svcDetalladaId = newUuid();
  const svcPremiumId = newUuid();

  const [adminHash, lavadorHash, clienteHash] = await Promise.all([
    hashPassword('Admin1234*'),
    hashPassword('Lavador1234*'),
    hashPassword('Cliente1234*'),
  ]);

  await db.withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO users (id, name, username, password_hash, role, is_active, terms_accepted_at, privacy_policy_version)
       VALUES
         ($1, 'Administrador Los Malditos', 'admin', $4, 'Administrador', TRUE, NOW(), '2026.1-ley1581'),
         ($2, 'Carlos Lavador', 'lavador', $5, 'Lavador', TRUE, NOW(), '2026.1-ley1581'),
         ($3, 'Mateo Motero', 'mateo.moto', $6, 'Cliente', TRUE, NOW(), '2026.1-ley1581')`,
      [adminId, lavadorUserId, clienteId, adminHash, lavadorHash, clienteHash],
    );

    await tx.query(
      `INSERT INTO employees (id, user_id, name, role, commission_percent, is_active)
       VALUES ($1, $2, 'Carlos Lavador', 'Lavador', 30.00, TRUE)`,
      [employeeId, lavadorUserId],
    );

    await tx.query(
      `INSERT INTO loyalty_cards (customer_id, stamps, completed_washes, qr_token)
       VALUES ($1, 0, 0, 'LM-SEED-MATEO-001')`,
      [clienteId],
    );

    await tx.query(
      `INSERT INTO motorcycles (id, customer_id, brand, model, cc, nickname, color)
       VALUES ($1, $2, 'Yamaha', 'MT-03', 321, 'La Negra', 'Negro Mate')`,
      [motoId, clienteId],
    );

    await tx.query(
      `INSERT INTO services (id, name, description, price, duration_minutes, surcharge_from_cc, is_active)
       VALUES
         ($1, 'Lavada Express', 'Lavado general con espuma activa y secado con microfibra', 7000, 30, 500, TRUE),
         ($2, 'Lavada Detallada', 'Lavado profundo de motor, cadena, rines y encerado protector', 15000, 60, 500, TRUE),
         ($3, 'Lavada Full Malditos', 'Desengrasado completo, hidratación de plásticos y lubricación de cadena', 25000, 90, 600, TRUE)`,
      [svcBasicaId, svcDetalladaId, svcPremiumId],
    );

    await tx.query(
      `INSERT INTO inventory_items (id, name, unit, current_stock, minimum_stock, estimated_use_per_wash)
       VALUES
         ($1, 'Shampoo Neutro Espuma', 'litro', 20, 5, 0.15),
         ($2, 'Paños de Microfibra', 'paquete', 12, 3, 0.25),
         ($3, 'Desengrasante Cadena', 'litro', 8, 2, 0.10)`,
      [newUuid(), newUuid(), newUuid()],
    );

    const now = new Date();
    const endsAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    await tx.query(
      `INSERT INTO promotions (id, title, description, discount_amount, discount_percent, starts_at, ends_at, is_active, created_by)
       VALUES ($1, 'Martes de Cadena Limpia', 'Descuento especial en Lavada Detallada los martes en el lavadero', 2000, NULL, $2, $3, TRUE, $4)`,
      [newUuid(), now, endsAt, adminId],
    );
  });

  logger.info('Seed de desarrollo aplicado exitosamente');
}
