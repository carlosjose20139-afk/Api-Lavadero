import { Router } from 'express';
import { z } from 'zod';
import type { DbClient, DbExecutor } from '../../db/index.js';
import { createAuthMiddleware } from '../../middleware/auth.js';
import {
  idParamSchema,
  isoDateTimeSchema,
  paginationQuerySchema,
  uuidSchema,
  validateBody,
  validateParams,
  validateQuery,
} from '../../middleware/validate.js';
import { listCustomerMotorcycles } from '../motorcycles/motorcycles.service.js';
import { recordAuditLog } from '../../services/audit.service.js';
import {
  generateOpaqueToken,
  generateTemporaryPassword,
  hashPassword,
  newUuid,
} from '../../utils/crypto.js';
import { AppError, created, ok, paginated } from '../../utils/response.js';
import { toIsoBogota, toIsoBogotaNullable } from '../../utils/time.js';

const listCustomersQuerySchema = paginationQuerySchema.extend({
  search: z.string().trim().optional(),
  status: z.enum(['active', 'blocked']).optional(),
});

const customerIdParamSchema = z.object({
  customerId: uuidSchema,
});

const listCustomerMotorcyclesQuerySchema = paginationQuerySchema.extend({
  includeInactive: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
});

// Estricto según contrato: solo name, username, password y termsAcceptedAt.
// Rechaza explícitamente teléfono, correo, cédula, placa u otros campos prohibidos.
const createCustomerSchema = z
  .object({
    name: z.string().trim().min(2, 'El nombre debe tener al menos 2 caracteres').max(120),
    username: z
      .string()
      .trim()
      .min(3, 'El usuario debe tener al menos 3 caracteres')
      .max(40)
      .regex(
        /^[a-zA-Z0-9_.-]+$/,
        'El usuario solo puede contener letras, números, punto, guión y guión bajo',
      ),
    password: z
      .string()
      .min(8, 'La contraseña debe tener al menos 8 caracteres')
      .max(128),
    termsAcceptedAt: isoDateTimeSchema.optional(),
  })
  .strict();

const patchCustomerSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    notes: z.string().max(2000).nullable().optional(),
    isBlocked: z.boolean().optional(),
  })
  .strict();

interface CustomerRow {
  id: string;
  name: string;
  username: string;
  role: string;
  is_active: boolean;
  must_change_password: boolean;
  notes: string | null;
  pending_balance: number;
  terms_accepted_at: Date | string | null;
  created_at: Date | string;
}

interface MotorcycleRow {
  id: string;
  customer_id: string;
  brand: string;
  model: string;
  cc: number;
  nickname: string | null;
  color: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

async function hydrateCustomer(db: DbExecutor, row: CustomerRow) {
  const [motosRes, washesRes] = await Promise.all([
    db.query<MotorcycleRow>(
      `SELECT id, customer_id, brand, model, cc, nickname, color, created_at, updated_at
       FROM motorcycles
       WHERE customer_id = $1 AND is_active = TRUE
       ORDER BY created_at DESC`,
      [row.id],
    ),
    db.query<{ cnt: string | number }>(
      `SELECT COUNT(*) AS cnt FROM wash_requests WHERE customer_id = $1 AND status = 'paid'`,
      [row.id],
    ),
  ]);

  return {
    id: row.id,
    name: row.name,
    username: row.username,
    role: row.role,
    isActive: row.is_active,
    mustChangePassword: row.must_change_password,
    termsAcceptedAt: toIsoBogotaNullable(row.terms_accepted_at),
    createdAt: toIsoBogota(row.created_at),
    notes: row.notes,
    pendingBalance: Number(row.pending_balance),
    completedWashes: Number(washesRes.rows[0]?.cnt ?? 0),
    motorcycles: motosRes.rows.map((m) => ({
      id: m.id,
      customerId: m.customer_id,
      brand: m.brand,
      model: m.model,
      cc: Number(m.cc),
      nickname: m.nickname,
      color: m.color,
      createdAt: toIsoBogota(m.created_at),
      updatedAt: toIsoBogota(m.updated_at),
    })),
  };
}

export function createCustomersRouter(db: DbClient): Router {
  const router = Router();
  const { authenticate, requireRoles } = createAuthMiddleware(db);

  router.get(
    '/',
    authenticate(),
    requireRoles('Administrador'),
    validateQuery(listCustomersQuerySchema),
    async (_req, res, next) => {
      try {
        const { page, pageSize, search, status } = res.locals.query as z.infer<
          typeof listCustomersQuerySchema
        >;
        const conditions: string[] = [`role = 'Cliente'`];
        const params: unknown[] = [];

        if (search) {
          params.push(`%${search}%`);
          conditions.push(
            `(name ILIKE $${params.length} OR username ILIKE $${params.length})`,
          );
        }
        if (status === 'active') {
          conditions.push('is_active = TRUE');
        } else if (status === 'blocked') {
          conditions.push('is_active = FALSE');
        }

        const whereSql = `WHERE ${conditions.join(' AND ')}`;
        const countRes = await db.query<{ cnt: string | number }>(
          `SELECT COUNT(*) AS cnt FROM users ${whereSql}`,
          params,
        );
        const total = Number(countRes.rows[0]?.cnt ?? 0);

        const offset = (page - 1) * pageSize;
        const listRes = await db.query<CustomerRow>(
          `SELECT id, name, username, role, is_active, must_change_password,
                  notes, pending_balance, terms_accepted_at, created_at
           FROM users
           ${whereSql}
           ORDER BY created_at DESC
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, pageSize, offset],
        );

        const customers = await Promise.all(
          listRes.rows.map((row) => hydrateCustomer(db, row)),
        );

        return paginated(
          res,
          customers,
          page,
          pageSize,
          total,
          'Clientes consultados exitosamente',
        );
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/',
    authenticate(),
    requireRoles('Administrador'),
    validateBody(createCustomerSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const body = req.body as z.infer<typeof createCustomerSchema>;

        const existing = await db.query<{ id: string }>(
          `SELECT id FROM users WHERE LOWER(username) = LOWER($1)`,
          [body.username],
        );
        if (existing.rows[0]) {
          throw new AppError(
            409,
            'USERNAME_EXISTS',
            'El nombre de usuario ya está registrado',
          );
        }

        const customerId = newUuid();
        const passwordHash = await hashPassword(body.password);
        const termsAcceptedAt = body.termsAcceptedAt
          ? new Date(body.termsAcceptedAt)
          : new Date();

        const createdUser = await db.withTransaction(async (tx) => {
          const userRes = await tx.query<CustomerRow>(
            `INSERT INTO users (
               id, name, username, password_hash, role, is_active,
               must_change_password, terms_accepted_at, privacy_policy_version
             )
             VALUES ($1, $2, $3, $4, 'Cliente', TRUE, FALSE, $5, '2026.1-ley1581')
             RETURNING id, name, username, role, is_active, must_change_password,
                       notes, pending_balance, terms_accepted_at, created_at`,
            [customerId, body.name, body.username, passwordHash, termsAcceptedAt],
          );

          await tx.query(
            `INSERT INTO loyalty_cards (id, customer_id, stamps, completed_washes, qr_token, qr_token_expires_at)
             VALUES ($1, $2, 0, 0, $3, NOW() + INTERVAL '24 hours')`,
            [newUuid(), customerId, `LM-${generateOpaqueToken(18)}`],
          );

          await recordAuditLog(tx, {
            actorId: actor.id,
            actorRole: actor.role,
            action: 'customer_created',
            entityType: 'user',
            entityId: customerId,
            ipAddress: req.clientIp,
            changes: {
              name: body.name,
              username: body.username,
              termsAcceptedAt: toIsoBogota(termsAcceptedAt),
            },
          });

          return userRes.rows[0]!;
        });

        return created(
          res,
          {
            id: createdUser.id,
            name: createdUser.name,
            username: createdUser.username,
            role: createdUser.role,
            isActive: createdUser.is_active,
            mustChangePassword: createdUser.must_change_password,
            termsAcceptedAt: toIsoBogotaNullable(createdUser.terms_accepted_at),
            createdAt: toIsoBogota(createdUser.created_at),
          },
          'Cliente creado exitosamente desde mostrador',
        );
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    '/:id',
    authenticate(),
    requireRoles('Administrador', 'Cliente'),
    validateParams(idParamSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { id } = res.locals.params as { id: string };

        if (actor.role === 'Cliente' && actor.id !== id) {
          throw new AppError(
            403,
            'FORBIDDEN',
            'Solo puedes consultar tu propio perfil de cliente',
          );
        }

        const userRes = await db.query<CustomerRow>(
          `SELECT id, name, username, role, is_active, must_change_password,
                  notes, pending_balance, terms_accepted_at, created_at
           FROM users
           WHERE id = $1 AND role = 'Cliente'`,
          [id],
        );
        const row = userRes.rows[0];
        if (!row) {
          throw new AppError(404, 'CUSTOMER_NOT_FOUND', 'Cliente no encontrado');
        }

        const customer = await hydrateCustomer(db, row);
        return ok(res, customer, 'Detalle de cliente consultado exitosamente');
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    '/:customerId/motorcycles',
    authenticate(),
    requireRoles('Administrador', 'Cliente'),
    validateParams(customerIdParamSchema),
    validateQuery(listCustomerMotorcyclesQuerySchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { customerId } = res.locals.params as { customerId: string };
        const { page, pageSize, includeInactive } = res.locals.query as z.infer<
          typeof listCustomerMotorcyclesQuerySchema
        >;
        const { items, total } = await listCustomerMotorcycles(
          db,
          actor,
          customerId,
          { page, pageSize, includeInactive },
        );
        return paginated(
          res,
          items,
          page,
          pageSize,
          total,
          'Motos del cliente consultadas exitosamente',
        );
      } catch (err) {
        next(err);
      }
    },
  );

  router.patch(
    '/:id',
    authenticate(),
    requireRoles('Administrador'),
    validateParams(idParamSchema),
    validateBody(patchCustomerSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { id } = res.locals.params as { id: string };
        const body = req.body as z.infer<typeof patchCustomerSchema>;

        const updatedRow = await db.withTransaction(async (tx) => {
          const existingRes = await tx.query<CustomerRow>(
            `SELECT id, name, username, role, is_active, must_change_password,
                    notes, pending_balance, terms_accepted_at, created_at
             FROM users
             WHERE id = $1 AND role = 'Cliente'
             FOR UPDATE`,
            [id],
          );
          const existing = existingRes.rows[0];
          if (!existing) {
            throw new AppError(404, 'CUSTOMER_NOT_FOUND', 'Cliente no encontrado');
          }

          const nextName = body.name ?? existing.name;
          const nextNotes =
            body.notes !== undefined ? body.notes : existing.notes;
          const nextActive =
            body.isBlocked !== undefined ? !body.isBlocked : existing.is_active;

          const upd = await tx.query<CustomerRow>(
            `UPDATE users
             SET name = $1, notes = $2, is_active = $3, updated_at = NOW()
             WHERE id = $4
             RETURNING id, name, username, role, is_active, must_change_password,
                       notes, pending_balance, terms_accepted_at, created_at`,
            [nextName, nextNotes, nextActive, id],
          );

          if (!nextActive) {
            await tx.query(
              `UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
              [id],
            );
          }

          await recordAuditLog(tx, {
            actorId: actor.id,
            actorRole: actor.role,
            action: 'customer_updated',
            entityType: 'user',
            entityId: id,
            ipAddress: req.clientIp,
            changes: body,
          });

          return upd.rows[0]!;
        });

        const customer = await hydrateCustomer(db, updatedRow);
        return ok(res, customer, 'Cliente actualizado exitosamente');
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/:id/reset-password',
    authenticate(),
    requireRoles('Administrador'),
    validateParams(idParamSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { id } = res.locals.params as { id: string };

        const temporaryPassword = generateTemporaryPassword(12);
        const tempHash = await hashPassword(temporaryPassword);

        await db.withTransaction(async (tx) => {
          const check = await tx.query<{ id: string }>(
            `SELECT id FROM users WHERE id = $1 AND role = 'Cliente' FOR UPDATE`,
            [id],
          );
          if (!check.rows[0]) {
            throw new AppError(404, 'CUSTOMER_NOT_FOUND', 'Cliente no encontrado');
          }

          await tx.query(
            `UPDATE users
             SET password_hash = $1,
                 must_change_password = TRUE,
                 failed_login_attempts = 0,
                 locked_until = NULL,
                 updated_at = NOW()
             WHERE id = $2`,
            [tempHash, id],
          );

          await tx.query(
            `UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
            [id],
          );

          await recordAuditLog(tx, {
            actorId: actor.id,
            actorRole: actor.role,
            action: 'customer_password_reset',
            entityType: 'user',
            entityId: id,
            ipAddress: req.clientIp,
            changes: { mustChangePassword: true },
          });
        });

        return ok(
          res,
          {
            temporaryPassword,
            mustChangePassword: true,
          },
          'Contraseña restablecida. El cliente debe cambiarla al iniciar sesión',
        );
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
