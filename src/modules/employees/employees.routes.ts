import { Router } from 'express';
import { z } from 'zod';
import type { DbClient } from '../../db/index.js';
import { createAuthMiddleware } from '../../middleware/auth.js';
import {
  paginationQuerySchema,
  validateBody,
  validateQuery,
} from '../../middleware/validate.js';
import { recordAuditLog } from '../../services/audit.service.js';
import { newUuid } from '../../utils/crypto.js';
import { created, paginated } from '../../utils/response.js';

const employeeInputSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    role: z.enum(['Lavador']),
    commissionPercent: z.coerce.number().min(0).max(100),
    isActive: z.boolean().optional().default(true),
  })
  .strict();

interface EmployeeRow {
  id: string;
  name: string;
  role: string;
  commission_percent: string | number;
  is_active: boolean;
}

function mapEmployee(row: EmployeeRow) {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    commissionPercent: Number(row.commission_percent),
    isActive: row.is_active,
  };
}

export function createEmployeesRouter(db: DbClient): Router {
  const router = Router();
  const { authenticate, requireRoles } = createAuthMiddleware(db);

  router.get(
    '/',
    authenticate(),
    requireRoles('Administrador', 'Lavador'),
    validateQuery(paginationQuerySchema),
    async (_req, res, next) => {
      try {
        const { page, pageSize } = res.locals.query as z.infer<
          typeof paginationQuerySchema
        >;
        const countRes = await db.query<{ cnt: string | number }>(
          `SELECT COUNT(*) AS cnt FROM employees`,
        );
        const total = Number(countRes.rows[0]?.cnt ?? 0);
        const offset = (page - 1) * pageSize;

        const rowsRes = await db.query<EmployeeRow>(
          `SELECT id, name, role, commission_percent, is_active
           FROM employees
           ORDER BY name ASC
           LIMIT $1 OFFSET $2`,
          [pageSize, offset],
        );

        return paginated(
          res,
          rowsRes.rows.map(mapEmployee),
          page,
          pageSize,
          total,
          'Empleados consultados exitosamente',
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
    validateBody(employeeInputSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const body = req.body as z.infer<typeof employeeInputSchema>;
        const id = newUuid();

        const inserted = await db.withTransaction(async (tx) => {
          const ins = await tx.query<EmployeeRow>(
            `INSERT INTO employees (id, name, role, commission_percent, is_active)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, name, role, commission_percent, is_active`,
            [id, body.name, body.role, body.commissionPercent, body.isActive ?? true],
          );

          await recordAuditLog(tx, {
            actorId: actor.id,
            actorRole: actor.role,
            action: 'employee_created',
            entityType: 'employee',
            entityId: id,
            ipAddress: req.clientIp,
            changes: body,
          });

          return ins.rows[0]!;
        });

        return created(
          res,
          mapEmployee(inserted),
          'Empleado lavador creado exitosamente',
        );
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
