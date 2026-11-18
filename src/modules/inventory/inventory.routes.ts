import { Router } from 'express';
import { z } from 'zod';
import type { DbClient } from '../../db/index.js';
import { createAuthMiddleware } from '../../middleware/auth.js';
import {
  idParamSchema,
  paginationQuerySchema,
  validateBody,
  validateParams,
  validateQuery,
} from '../../middleware/validate.js';
import { recordAuditLog } from '../../services/audit.service.js';
import { newUuid } from '../../utils/crypto.js';
import { AppError, created, paginated } from '../../utils/response.js';

const inventoryInputSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    unit: z.enum(['unidad', 'litro', 'kilogramo', 'paquete']),
    currentStock: z.coerce.number().min(0),
    minimumStock: z.coerce.number().min(0),
    estimatedUsePerWash: z.coerce.number().min(0).optional().default(0),
  })
  .strict();

const movementInputSchema = z
  .object({
    type: z.enum(['in', 'out', 'adjustment']),
    quantity: z.coerce.number().min(0),
    reason: z.string().trim().max(300).optional(),
  })
  .strict();

interface InventoryRow {
  id: string;
  name: string;
  unit: string;
  current_stock: string | number;
  minimum_stock: string | number;
  estimated_use_per_wash: string | number;
}

function mapInventory(row: InventoryRow) {
  const currentStock = Number(row.current_stock);
  const minimumStock = Number(row.minimum_stock);
  return {
    id: row.id,
    name: row.name,
    unit: row.unit,
    currentStock,
    minimumStock,
    estimatedUsePerWash: Number(row.estimated_use_per_wash),
    isLowStock: currentStock <= minimumStock,
  };
}

export function createInventoryRouter(db: DbClient): Router {
  const router = Router();
  const { authenticate, requireRoles } = createAuthMiddleware(db);

  router.get(
    '/items',
    authenticate(),
    requireRoles('Administrador', 'Lavador'),
    validateQuery(paginationQuerySchema),
    async (_req, res, next) => {
      try {
        const { page, pageSize } = res.locals.query as z.infer<
          typeof paginationQuerySchema
        >;
        const countRes = await db.query<{ cnt: string | number }>(
          `SELECT COUNT(*) AS cnt FROM inventory_items`,
        );
        const total = Number(countRes.rows[0]?.cnt ?? 0);
        const offset = (page - 1) * pageSize;

        const rowsRes = await db.query<InventoryRow>(
          `SELECT id, name, unit, current_stock, minimum_stock, estimated_use_per_wash
           FROM inventory_items
           ORDER BY (current_stock <= minimum_stock) DESC, name ASC
           LIMIT $1 OFFSET $2`,
          [pageSize, offset],
        );

        return paginated(
          res,
          rowsRes.rows.map(mapInventory),
          page,
          pageSize,
          total,
          'Inventario consultado exitosamente',
        );
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/items',
    authenticate(),
    requireRoles('Administrador'),
    validateBody(inventoryInputSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const body = req.body as z.infer<typeof inventoryInputSchema>;
        const id = newUuid();

        const inserted = await db.withTransaction(async (tx) => {
          const ins = await tx.query<InventoryRow>(
            `INSERT INTO inventory_items (
               id, name, unit, current_stock, minimum_stock, estimated_use_per_wash
             )
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, name, unit, current_stock, minimum_stock, estimated_use_per_wash`,
            [
              id,
              body.name,
              body.unit,
              body.currentStock,
              body.minimumStock,
              body.estimatedUsePerWash ?? 0,
            ],
          );

          await recordAuditLog(tx, {
            actorId: actor.id,
            actorRole: actor.role,
            action: 'inventory_item_created',
            entityType: 'inventory_item',
            entityId: id,
            ipAddress: req.clientIp,
            changes: body,
          });

          return ins.rows[0]!;
        });

        return created(
          res,
          mapInventory(inserted),
          'Insumo de inventario creado exitosamente',
        );
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/items/:id/movements',
    authenticate(),
    requireRoles('Administrador', 'Lavador'),
    validateParams(idParamSchema),
    validateBody(movementInputSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { id } = res.locals.params as { id: string };
        const body = req.body as z.infer<typeof movementInputSchema>;

        const updated = await db.withTransaction(async (tx) => {
          const itemRes = await tx.query<InventoryRow>(
            `SELECT id, name, unit, current_stock, minimum_stock, estimated_use_per_wash
             FROM inventory_items WHERE id = $1 FOR UPDATE`,
            [id],
          );
          const item = itemRes.rows[0];
          if (!item) {
            throw new AppError(
              404,
              'INVENTORY_ITEM_NOT_FOUND',
              'Insumo de inventario no encontrado',
            );
          }

          const prev = Number(item.current_stock);
          let nextStock = prev;

          if (body.type === 'in') {
            nextStock = Number((prev + body.quantity).toFixed(2));
          } else if (body.type === 'out') {
            if (prev - body.quantity < 0) {
              throw new AppError(
                409,
                'INSUFFICIENT_STOCK',
                `Stock insuficiente para '${item.name}' (disponible: ${prev} ${item.unit})`,
              );
            }
            nextStock = Number((prev - body.quantity).toFixed(2));
          } else {
            nextStock = Number(body.quantity.toFixed(2));
          }

          const upd = await tx.query<InventoryRow>(
            `UPDATE inventory_items
             SET current_stock = $1, updated_at = NOW()
             WHERE id = $2
             RETURNING id, name, unit, current_stock, minimum_stock, estimated_use_per_wash`,
            [nextStock, id],
          );

          await tx.query(
            `INSERT INTO inventory_movements (
               id, item_id, type, quantity, previous_stock, new_stock, reason, actor_id
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              newUuid(),
              id,
              body.type,
              body.quantity,
              prev,
              nextStock,
              body.reason ?? null,
              actor.id,
            ],
          );

          await recordAuditLog(tx, {
            actorId: actor.id,
            actorRole: actor.role,
            action: 'inventory_movement_recorded',
            entityType: 'inventory_item',
            entityId: id,
            ipAddress: req.clientIp,
            changes: {
              type: body.type,
              quantity: body.quantity,
              previousStock: prev,
              newStock: nextStock,
            },
          });

          return upd.rows[0]!;
        });

        return created(
          res,
          mapInventory(updated),
          'Movimiento de inventario registrado exitosamente',
        );
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
