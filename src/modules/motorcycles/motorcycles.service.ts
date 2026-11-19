import type { DbClient, DbExecutor } from '../../db/index.js';
import type { AuthUser } from '../../middleware/auth.js';
import { recordAuditLog } from '../../services/audit.service.js';
import { newUuid } from '../../utils/crypto.js';
import { AppError } from '../../utils/response.js';
import { toIsoBogota } from '../../utils/time.js';

export interface MotorcycleCustomerSummary {
  id: string;
  name: string;
  username: string;
}

export interface MotorcycleDto {
  id: string;
  brand: string;
  model: string;
  cc: number;
  nickname: string | null;
  color: string | null;
  customerId: string | null;
  customer: MotorcycleCustomerSummary | null;
  hasHistory: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MotorcycleAssignmentResultDto {
  id: string;
  brand: string;
  model: string;
  cc: number;
  nickname: string | null;
  color: string | null;
  customerId: string;
  updatedAt: string;
}

export interface MotorcycleAssignmentAuditDto {
  id: string;
  motorcycleId: string;
  customerId: string | null;
  customer: MotorcycleCustomerSummary | null;
  previousCustomerId: string | null;
  previousCustomer: MotorcycleCustomerSummary | null;
  action: 'assigned' | 'unassigned' | 'reassigned';
  performedBy: {
    id: string;
    name: string;
    username: string;
    role: string;
  };
  occurredAt: string;
  reason: string | null;
}

interface MotorcycleJoinedRow {
  id: string;
  customer_id: string | null;
  brand: string;
  model: string;
  cc: number;
  nickname: string | null;
  color: string | null;
  is_active: boolean;
  created_at: Date | string;
  updated_at: Date | string;
  customer_name: string | null;
  customer_username: string | null;
  has_history: boolean;
}

interface MotorcycleBaseRow {
  id: string;
  customer_id: string | null;
  brand: string;
  model: string;
  cc: number;
  nickname: string | null;
  color: string | null;
  is_active: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

interface AssignmentJoinedRow {
  id: string;
  motorcycle_id: string;
  customer_id: string | null;
  customer_name: string | null;
  customer_username: string | null;
  previous_customer_id: string | null;
  prev_customer_name: string | null;
  prev_customer_username: string | null;
  action: 'assigned' | 'unassigned' | 'reassigned';
  performed_by: string;
  performed_by_name: string;
  performed_by_username: string;
  performed_by_role: string;
  occurred_at: Date | string;
  reason: string | null;
}

function mapMotorcycle(row: MotorcycleJoinedRow): MotorcycleDto {
  return {
    id: row.id,
    brand: row.brand,
    model: row.model,
    cc: Number(row.cc),
    nickname: row.nickname,
    color: row.color,
    customerId: row.customer_id,
    customer:
      row.customer_id && row.customer_name && row.customer_username
        ? {
            id: row.customer_id,
            name: row.customer_name,
            username: row.customer_username,
          }
        : null,
    hasHistory: Boolean(row.has_history),
    createdAt: toIsoBogota(row.created_at),
    updatedAt: toIsoBogota(row.updated_at),
  };
}

async function fetchHydratedMotorcycle(
  db: DbExecutor,
  id: string,
): Promise<MotorcycleDto | null> {
  const res = await db.query<MotorcycleJoinedRow>(
    `SELECT m.id, m.customer_id, m.brand, m.model, m.cc, m.nickname, m.color,
            m.is_active, m.created_at, m.updated_at,
            u.name AS customer_name,
            u.username AS customer_username,
            (
              EXISTS (SELECT 1 FROM appointments a WHERE a.motorcycle_id = m.id)
              OR EXISTS (SELECT 1 FROM wash_requests wr WHERE wr.motorcycle_id = m.id)
              OR EXISTS (SELECT 1 FROM motorcycle_customer_assignments mca WHERE mca.motorcycle_id = m.id)
            ) AS has_history
     FROM motorcycles m
     LEFT JOIN users u ON u.id = m.customer_id
     WHERE m.id = $1`,
    [id],
  );
  const row = res.rows[0];
  return row ? mapMotorcycle(row) : null;
}

async function assertActiveCustomer(
  db: DbExecutor,
  customerId: string,
): Promise<{ id: string; name: string; username: string }> {
  const custRes = await db.query<{
    id: string;
    name: string;
    username: string;
    is_active: boolean;
  }>(
    `SELECT id, name, username, is_active
     FROM users
     WHERE id = $1 AND role = 'Cliente'`,
    [customerId],
  );
  const customer = custRes.rows[0];
  if (!customer) {
    throw new AppError(404, 'CUSTOMER_NOT_FOUND', 'Cliente no encontrado');
  }
  if (!customer.is_active) {
    throw new AppError(
      409,
      'CUSTOMER_INACTIVE',
      'El cliente se encuentra bloqueado o inactivo',
    );
  }
  return {
    id: customer.id,
    name: customer.name,
    username: customer.username,
  };
}

export interface ListMotorcyclesInput {
  page: number;
  pageSize: number;
  customerId?: string;
  status?: 'assigned' | 'unassigned';
  search?: string;
  includeInactive?: boolean;
}

export async function listMotorcycles(
  db: DbClient,
  actor: AuthUser,
  query: ListMotorcyclesInput,
): Promise<{ items: MotorcycleDto[]; total: number }> {
  if (actor.role === 'Cliente') {
    if (query.customerId && query.customerId !== actor.id) {
      throw new AppError(
        403,
        'FORBIDDEN',
        'No puedes consultar motos de otro cliente',
      );
    }
    if (query.status === 'unassigned') {
      throw new AppError(
        403,
        'FORBIDDEN',
        'Solo el administrador puede consultar motos no asignadas',
      );
    }
  }

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (!query.includeInactive || actor.role === 'Cliente') {
    conditions.push('m.is_active = TRUE');
  }

  if (actor.role === 'Cliente') {
    params.push(actor.id);
    conditions.push(`m.customer_id = $${params.length}`);
  } else {
    if (query.customerId) {
      params.push(query.customerId);
      conditions.push(`m.customer_id = $${params.length}`);
    }
    if (query.status === 'assigned') {
      conditions.push('m.customer_id IS NOT NULL');
    } else if (query.status === 'unassigned') {
      conditions.push('m.customer_id IS NULL');
    }
  }

  if (query.search) {
    params.push(`%${query.search}%`);
    const idx = params.length;
    conditions.push(
      `(m.brand ILIKE $${idx} OR m.model ILIKE $${idx} OR COALESCE(m.nickname, '') ILIKE $${idx})`,
    );
  }

  const whereSql =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const countRes = await db.query<{ cnt: string | number }>(
    `SELECT COUNT(*) AS cnt FROM motorcycles m ${whereSql}`,
    params,
  );
  const total = Number(countRes.rows[0]?.cnt ?? 0);

  const offset = (query.page - 1) * query.pageSize;
  const listRes = await db.query<MotorcycleJoinedRow>(
    `SELECT m.id, m.customer_id, m.brand, m.model, m.cc, m.nickname, m.color,
            m.is_active, m.created_at, m.updated_at,
            u.name AS customer_name,
            u.username AS customer_username,
            (
              EXISTS (SELECT 1 FROM appointments a WHERE a.motorcycle_id = m.id)
              OR EXISTS (SELECT 1 FROM wash_requests wr WHERE wr.motorcycle_id = m.id)
              OR EXISTS (SELECT 1 FROM motorcycle_customer_assignments mca WHERE mca.motorcycle_id = m.id)
            ) AS has_history
     FROM motorcycles m
     LEFT JOIN users u ON u.id = m.customer_id
     ${whereSql}
     ORDER BY m.created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, query.pageSize, offset],
  );

  return {
    items: listRes.rows.map(mapMotorcycle),
    total,
  };
}

export async function listCustomerMotorcycles(
  db: DbClient,
  actor: AuthUser,
  customerId: string,
  query: { page: number; pageSize: number; includeInactive?: boolean },
): Promise<{ items: MotorcycleDto[]; total: number }> {
  if (actor.role === 'Cliente' && actor.id !== customerId) {
    throw new AppError(
      403,
      'FORBIDDEN',
      'Solo puedes consultar tus propias motos asociadas',
    );
  }

  const customerRes = await db.query<{ id: string }>(
    `SELECT id FROM users WHERE id = $1 AND role = 'Cliente'`,
    [customerId],
  );
  if (!customerRes.rows[0]) {
    throw new AppError(404, 'CUSTOMER_NOT_FOUND', 'Cliente no encontrado');
  }

  return listMotorcycles(db, actor, {
    page: query.page,
    pageSize: query.pageSize,
    customerId,
    includeInactive: query.includeInactive,
  });
}

export interface CreateMotorcycleInput {
  customerId?: string | null;
  brand: string;
  model: string;
  cc: number;
  nickname?: string | null;
  color?: string | null;
}

export async function createMotorcycle(
  db: DbClient,
  actor: AuthUser,
  body: CreateMotorcycleInput,
  ipAddress?: string,
): Promise<MotorcycleDto> {
  const targetCustomerId = body.customerId ?? null;
  const motoId = newUuid();

  return db.withTransaction(async (tx) => {
    if (targetCustomerId) {
      await assertActiveCustomer(tx, targetCustomerId);
    }

    await tx.query(
      `INSERT INTO motorcycles (id, customer_id, brand, model, cc, nickname, color)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        motoId,
        targetCustomerId,
        body.brand,
        body.model,
        body.cc,
        body.nickname ?? null,
        body.color ?? null,
      ],
    );

    if (targetCustomerId) {
      await tx.query(
        `INSERT INTO motorcycle_customer_assignments (
           id, motorcycle_id, customer_id, action, performed_by, previous_customer_id, reason
         )
         VALUES ($1, $2, $3, 'assigned', $4, NULL, $5)`,
        [
          newUuid(),
          motoId,
          targetCustomerId,
          actor.id,
          'Asociación inicial al registrar moto',
        ],
      );

      await recordAuditLog(tx, {
        actorId: actor.id,
        actorRole: actor.role,
        action: 'motorcycle_assigned',
        entityType: 'motorcycle',
        entityId: motoId,
        ipAddress,
        changes: {
          previousCustomerId: null,
          customerId: targetCustomerId,
        },
      });
    }

    await recordAuditLog(tx, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'motorcycle_created',
      entityType: 'motorcycle',
      entityId: motoId,
      ipAddress,
      changes: {
        customerId: targetCustomerId,
        brand: body.brand,
        model: body.model,
        cc: body.cc,
        nickname: body.nickname ?? null,
        color: body.color ?? null,
      },
    });

    const createdMoto = await fetchHydratedMotorcycle(tx, motoId);
    return createdMoto!;
  });
}

export interface UpdateMotorcycleInput {
  customerId?: string | null;
  brand?: string;
  model?: string;
  cc?: number;
  nickname?: string | null;
  color?: string | null;
  isActive?: boolean;
}

export async function updateMotorcycle(
  db: DbClient,
  actor: AuthUser,
  id: string,
  body: UpdateMotorcycleInput,
  ipAddress?: string,
): Promise<MotorcycleDto> {
  return db.withTransaction(async (tx) => {
    const existingRes = await tx.query<MotorcycleBaseRow>(
      `SELECT id, customer_id, brand, model, cc, nickname, color, is_active, created_at, updated_at
       FROM motorcycles
       WHERE id = $1
       FOR UPDATE`,
      [id],
    );
    const existing = existingRes.rows[0];
    if (!existing) {
      throw new AppError(404, 'MOTORCYCLE_NOT_FOUND', 'Moto no encontrada');
    }

    const nextCustomerId =
      body.customerId !== undefined ? body.customerId : existing.customer_id;

    if (nextCustomerId !== existing.customer_id) {
      if (nextCustomerId !== null) {
        await assertActiveCustomer(tx, nextCustomerId);
      }

      const assignmentAction: 'assigned' | 'unassigned' | 'reassigned' =
        nextCustomerId === null
          ? 'unassigned'
          : existing.customer_id === null
            ? 'assigned'
            : 'reassigned';

      await tx.query(
        `INSERT INTO motorcycle_customer_assignments (
           id, motorcycle_id, customer_id, action, performed_by, previous_customer_id
         )
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          newUuid(),
          id,
          nextCustomerId,
          assignmentAction,
          actor.id,
          existing.customer_id,
        ],
      );

      await recordAuditLog(tx, {
        actorId: actor.id,
        actorRole: actor.role,
        action: `motorcycle_${assignmentAction}`,
        entityType: 'motorcycle',
        entityId: id,
        ipAddress,
        changes: {
          previousCustomerId: existing.customer_id,
          customerId: nextCustomerId,
        },
      });
    }

    await tx.query(
      `UPDATE motorcycles
       SET customer_id = $1,
           brand = $2,
           model = $3,
           cc = $4,
           nickname = $5,
           color = $6,
           is_active = $7,
           updated_at = NOW()
       WHERE id = $8`,
      [
        nextCustomerId,
        body.brand ?? existing.brand,
        body.model ?? existing.model,
        body.cc ?? existing.cc,
        body.nickname !== undefined ? body.nickname : existing.nickname,
        body.color !== undefined ? body.color : existing.color,
        body.isActive !== undefined ? body.isActive : existing.is_active,
        id,
      ],
    );

    await recordAuditLog(tx, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'motorcycle_updated',
      entityType: 'motorcycle',
      entityId: id,
      ipAddress,
      changes: { ...body },
    });

    const updated = await fetchHydratedMotorcycle(tx, id);
    return updated!;
  });
}

export async function assignMotorcycle(
  db: DbClient,
  actor: AuthUser,
  id: string,
  body: { customerId: string; reason?: string | null },
  ipAddress?: string,
): Promise<MotorcycleAssignmentResultDto> {
  return db.withTransaction(async (tx) => {
    const existingRes = await tx.query<MotorcycleBaseRow>(
      `SELECT id, customer_id, brand, model, cc, nickname, color, is_active, created_at, updated_at
       FROM motorcycles
       WHERE id = $1
       FOR UPDATE`,
      [id],
    );
    const existing = existingRes.rows[0];
    if (!existing) {
      throw new AppError(404, 'MOTORCYCLE_NOT_FOUND', 'Moto no encontrada');
    }

    await assertActiveCustomer(tx, body.customerId);

    if (existing.customer_id === body.customerId) {
      return {
        id: existing.id,
        brand: existing.brand,
        model: existing.model,
        cc: Number(existing.cc),
        nickname: existing.nickname,
        color: existing.color,
        customerId: existing.customer_id,
        updatedAt: toIsoBogota(existing.updated_at),
      };
    }

    const action: 'assigned' | 'reassigned' =
      existing.customer_id === null ? 'assigned' : 'reassigned';

    const updatedRes = await tx.query<MotorcycleBaseRow>(
      `UPDATE motorcycles
       SET customer_id = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, customer_id, brand, model, cc, nickname, color, is_active, created_at, updated_at`,
      [body.customerId, id],
    );
    const updated = updatedRes.rows[0]!;

    await tx.query(
      `INSERT INTO motorcycle_customer_assignments (
         id, motorcycle_id, customer_id, action, performed_by, previous_customer_id, reason
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        newUuid(),
        id,
        body.customerId,
        action,
        actor.id,
        existing.customer_id,
        body.reason ?? null,
      ],
    );

    await recordAuditLog(tx, {
      actorId: actor.id,
      actorRole: actor.role,
      action:
        action === 'assigned' ? 'motorcycle_assigned' : 'motorcycle_reassigned',
      entityType: 'motorcycle',
      entityId: id,
      ipAddress,
      changes: {
        previousCustomerId: existing.customer_id,
        customerId: body.customerId,
        reason: body.reason ?? null,
      },
    });

    return {
      id: updated.id,
      brand: updated.brand,
      model: updated.model,
      cc: Number(updated.cc),
      nickname: updated.nickname,
      color: updated.color,
      customerId: updated.customer_id!,
      updatedAt: toIsoBogota(updated.updated_at),
    };
  });
}

export async function unlinkMotorcycle(
  db: DbClient,
  actor: AuthUser,
  id: string,
  reason: string | null | undefined,
  ipAddress?: string,
): Promise<{ id: string; customerId: null }> {
  return db.withTransaction(async (tx) => {
    const existingRes = await tx.query<{
      id: string;
      customer_id: string | null;
    }>(
      `SELECT id, customer_id
       FROM motorcycles
       WHERE id = $1
       FOR UPDATE`,
      [id],
    );
    const existing = existingRes.rows[0];
    if (!existing) {
      throw new AppError(404, 'MOTORCYCLE_NOT_FOUND', 'Moto no encontrada');
    }

    if (existing.customer_id === null) {
      return { id: existing.id, customerId: null };
    }

    await tx.query(
      `UPDATE motorcycles
       SET customer_id = NULL, updated_at = NOW()
       WHERE id = $1`,
      [id],
    );

    await tx.query(
      `INSERT INTO motorcycle_customer_assignments (
         id, motorcycle_id, customer_id, action, performed_by, previous_customer_id, reason
       )
       VALUES ($1, $2, NULL, 'unassigned', $3, $4, $5)`,
      [newUuid(), id, actor.id, existing.customer_id, reason ?? null],
    );

    await recordAuditLog(tx, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'motorcycle_unassigned',
      entityType: 'motorcycle',
      entityId: id,
      ipAddress,
      changes: {
        previousCustomerId: existing.customer_id,
        customerId: null,
        reason: reason ?? null,
      },
    });

    return { id: existing.id, customerId: null };
  });
}

export async function deleteMotorcyclePermanently(
  db: DbClient,
  actor: AuthUser,
  id: string,
  ipAddress?: string,
): Promise<void> {
  await db.withTransaction(async (tx) => {
    const existingRes = await tx.query<{
      id: string;
      customer_id: string | null;
      brand: string;
      model: string;
      cc: number;
    }>(
      `SELECT id, customer_id, brand, model, cc
       FROM motorcycles
       WHERE id = $1
       FOR UPDATE`,
      [id],
    );
    const existing = existingRes.rows[0];
    if (!existing) {
      throw new AppError(404, 'MOTORCYCLE_NOT_FOUND', 'Moto no encontrada');
    }

    if (existing.customer_id !== null) {
      throw new AppError(
        409,
        'MOTORCYCLE_ASSIGNED',
        'No puedes eliminar una moto asociada. Primero debes desvincularla.',
      );
    }

    const [apptCount, washCount, assignmentCount] = await Promise.all([
      tx.query<{ cnt: string | number }>(
        `SELECT COUNT(*) AS cnt FROM appointments WHERE motorcycle_id = $1`,
        [id],
      ),
      tx.query<{ cnt: string | number }>(
        `SELECT COUNT(*) AS cnt FROM wash_requests WHERE motorcycle_id = $1`,
        [id],
      ),
      tx.query<{ cnt: string | number }>(
        `SELECT COUNT(*) AS cnt FROM motorcycle_customer_assignments WHERE motorcycle_id = $1`,
        [id],
      ),
    ]);

    const hasHistory =
      Number(apptCount.rows[0]?.cnt ?? 0) > 0 ||
      Number(washCount.rows[0]?.cnt ?? 0) > 0 ||
      Number(assignmentCount.rows[0]?.cnt ?? 0) > 0;

    if (hasHistory) {
      throw new AppError(
        409,
        'MOTORCYCLE_HAS_HISTORY',
        'La moto tiene historial y no puede eliminarse definitivamente.',
      );
    }

    await tx.query(`DELETE FROM motorcycles WHERE id = $1`, [id]);

    await recordAuditLog(tx, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'motorcycle_deleted',
      entityType: 'motorcycle',
      entityId: id,
      ipAddress,
      changes: {
        brand: existing.brand,
        model: existing.model,
        cc: Number(existing.cc),
      },
    });
  });
}

export async function listMotorcycleAssignments(
  db: DbClient,
  motorcycleId: string,
  query: { page: number; pageSize: number },
): Promise<{ items: MotorcycleAssignmentAuditDto[]; total: number }> {
  const motoRes = await db.query<{ id: string }>(
    `SELECT id FROM motorcycles WHERE id = $1`,
    [motorcycleId],
  );
  if (!motoRes.rows[0]) {
    throw new AppError(404, 'MOTORCYCLE_NOT_FOUND', 'Moto no encontrada');
  }

  const countRes = await db.query<{ cnt: string | number }>(
    `SELECT COUNT(*) AS cnt
     FROM motorcycle_customer_assignments
     WHERE motorcycle_id = $1`,
    [motorcycleId],
  );
  const total = Number(countRes.rows[0]?.cnt ?? 0);

  const offset = (query.page - 1) * query.pageSize;
  const rowsRes = await db.query<AssignmentJoinedRow>(
    `SELECT mca.id, mca.motorcycle_id, mca.customer_id, mca.previous_customer_id,
            mca.action, mca.performed_by, mca.occurred_at, mca.reason,
            cu.name AS customer_name, cu.username AS customer_username,
            pu.name AS prev_customer_name, pu.username AS prev_customer_username,
            au.name AS performed_by_name, au.username AS performed_by_username,
            au.role AS performed_by_role
     FROM motorcycle_customer_assignments mca
     LEFT JOIN users cu ON cu.id = mca.customer_id
     LEFT JOIN users pu ON pu.id = mca.previous_customer_id
     INNER JOIN users au ON au.id = mca.performed_by
     WHERE mca.motorcycle_id = $1
     ORDER BY mca.occurred_at DESC, mca.id DESC
     LIMIT $2 OFFSET $3`,
    [motorcycleId, query.pageSize, offset],
  );

  return {
    items: rowsRes.rows.map((row) => ({
      id: row.id,
      motorcycleId: row.motorcycle_id,
      customerId: row.customer_id,
      customer:
        row.customer_id && row.customer_name && row.customer_username
          ? {
              id: row.customer_id,
              name: row.customer_name,
              username: row.customer_username,
            }
          : null,
      previousCustomerId: row.previous_customer_id,
      previousCustomer:
        row.previous_customer_id &&
        row.prev_customer_name &&
        row.prev_customer_username
          ? {
              id: row.previous_customer_id,
              name: row.prev_customer_name,
              username: row.prev_customer_username,
            }
          : null,
      action: row.action,
      performedBy: {
        id: row.performed_by,
        name: row.performed_by_name,
        username: row.performed_by_username,
        role: row.performed_by_role,
      },
      occurredAt: toIsoBogota(row.occurred_at),
      reason: row.reason,
    })),
    total,
  };
}
