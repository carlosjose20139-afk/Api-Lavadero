import { env } from '../../config/env.js';
import type { DbClient, DbExecutor } from '../../db/index.js';
import type { AuthUser } from '../../middleware/auth.js';
import { recordAuditLog } from '../../services/audit.service.js';
import { notificationService } from '../../services/notification.service.js';
import { expireOutdatedLoyaltyRewards } from '../../services/scheduler.service.js';
import { generateOpaqueToken, newUuid } from '../../utils/crypto.js';
import { AppError } from '../../utils/response.js';
import { toIsoBogota, toIsoBogotaNullable } from '../../utils/time.js';

export type RewardStatus = 'available' | 'redeemed' | 'expired' | 'cancelled';
export type RewardSource = 'automatic' | 'manual';
export type StampStatus = 'active' | 'reversed';
export type LoyaltyAuditAction =
  | 'loyalty_stamp_created'
  | 'loyalty_stamp_reversed'
  | 'loyalty_reward_created'
  | 'loyalty_reward_redeemed'
  | 'loyalty_reward_cancelled'
  | 'loyalty_reward_expired'
  | 'loyalty_reward_moderated';

export interface LoyaltyRewardDto {
  id: string;
  customerId: string;
  title: string;
  validFrom: string;
  validUntil: string;
  status: RewardStatus;
  source: RewardSource;
  sourceStampId: string | null;
  appointmentId: string | null;
  reason: string | null;
  redeemedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LoyaltyStampDto {
  id: string;
  loyaltyCardId: string | null;
  customerId: string;
  washRequestId: string;
  actorId: string | null;
  actorName: string | null;
  status: StampStatus;
  reason: string | null;
  createdAt: string;
  reversedAt: string | null;
  reversedBy: string | null;
  reversedByName: string | null;
  washStatus?: string | null;
  washPrice?: number | null;
  serviceName?: string | null;
  motorcycleLabel?: string | null;
}

export interface LoyaltyCardDto {
  id: string;
  customerId: string;
  stamps: number;
  completedWashes: number;
  qrToken: string;
  qrTokenExpiresAt: string;
  updatedAt: string;
  rewards: LoyaltyRewardDto[];
}

export interface LoyaltyCustomerSummaryDto {
  customerId: string;
  customerName: string;
  username: string;
  isActive: boolean;
  stamps: number;
  completedWashes: number;
  availableRewards: number;
  expiredRewards: number;
  lastWashAt: string | null;
}

export interface LoyaltyAuditDto {
  id: string;
  actorId: string | null;
  actorRole: string | null;
  actorName: string | null;
  customerId: string;
  action: LoyaltyAuditAction;
  targetId: string | null;
  targetType: 'loyalty_stamp' | 'loyalty_reward' | 'loyalty_card';
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  ipAddress: string | null;
  createdAt: string;
}

interface LoyaltyCardRow {
  id: string;
  customer_id: string;
  stamps: number;
  completed_washes: number;
  qr_token: string;
  qr_token_expires_at: Date | string | null;
  updated_at: Date | string;
}

interface LoyaltyRewardRow {
  id: string;
  customer_id: string;
  title: string;
  valid_from: Date | string;
  valid_until: Date | string;
  status: RewardStatus;
  source: RewardSource | null;
  source_stamp_id: string | null;
  appointment_id: string | null;
  redeemed_appointment_id: string | null;
  reason: string | null;
  redeemed_at: Date | string | null;
  cancelled_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string | null;
}

interface LoyaltyStampRow {
  id: string;
  loyalty_card_id: string | null;
  customer_id: string;
  wash_request_id: string;
  actor_id: string | null;
  granted_by: string | null;
  actor_name?: string | null;
  status: StampStatus;
  reason: string | null;
  created_at: Date | string;
  reversed_at: Date | string | null;
  reversed_by: string | null;
  reversed_by_name?: string | null;
  wash_status?: string | null;
  wash_price?: number | null;
  service_name?: string | null;
  motorcycle_label?: string | null;
}

const UNSAFE_HTML_PATTERN =
  /<\s*\/?\s*[a-zA-Z!][^>]*>|<!--[\s\S]*?-->|\b(?:javascript|vbscript)\s*:|\bdata\s*:\s*text\/html|\bon[a-z]+\s*=/i;

export function sanitizeAndAssertSafeLoyaltyText(
  rawValue: string,
  fieldName: string,
  maxLength: number,
  required = false,
): string | null {
  const cleaned = rawValue
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();

  if (cleaned.length === 0) {
    if (required) {
      throw new AppError(
        422,
        'VALIDATION_ERROR',
        `El campo ${fieldName} es obligatorio y no puede estar vacío`,
        { [fieldName]: 'Campo obligatorio' },
      );
    }
    return null;
  }

  if (cleaned.length > maxLength) {
    throw new AppError(
      422,
      'VALIDATION_ERROR',
      `El campo ${fieldName} no puede superar ${maxLength} caracteres`,
      { [fieldName]: `Máximo ${maxLength} caracteres` },
    );
  }

  if (UNSAFE_HTML_PATTERN.test(cleaned)) {
    throw new AppError(
      422,
      'VALIDATION_ERROR',
      `El campo ${fieldName} contiene HTML, etiquetas o scripts no permitidos`,
      { [fieldName]: 'No se permite HTML, scripts ni etiquetas peligrosas' },
    );
  }

  return cleaned;
}

/**
 * Interpreta fechas en zona horaria America/Bogota (-05:00) cuando no incluyen offset explícito,
 * y valida calendario real.
 */
export function parseBogotaRewardDate(
  raw: string,
  fieldName: string,
  endOfDayIfDateOnly = false,
): Date {
  const value = raw.trim();
  let normalized = value;

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    normalized = endOfDayIfDateOnly
      ? `${value}T23:59:59.999-05:00`
      : `${value}T00:00:00.000-05:00`;
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?$/.test(value)) {
    normalized = `${value}-05:00`;
  } else if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  ) {
    throw new AppError(
      422,
      'VALIDATION_ERROR',
      `El campo ${fieldName} debe tener un formato de fecha ISO-8601 válido`,
      { [fieldName]: 'Formato ISO-8601 inválido' },
    );
  }

  const parsedMs = Date.parse(normalized);
  if (Number.isNaN(parsedMs)) {
    throw new AppError(
      422,
      'VALIDATION_ERROR',
      `El campo ${fieldName} no representa una fecha válida`,
      { [fieldName]: 'Fecha inválida' },
    );
  }

  const parsed = new Date(parsedMs);
  // Verificación de desbordamiento de calendario (ej. 2026-02-30)
  const ymdMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (ymdMatch) {
    const y = Number(ymdMatch[1]);
    const m = Number(ymdMatch[2]);
    const d = Number(ymdMatch[3]);
    const check = new Date(Date.UTC(y, m - 1, d));
    if (
      check.getUTCFullYear() !== y ||
      check.getUTCMonth() + 1 !== m ||
      check.getUTCDate() !== d
    ) {
      throw new AppError(
        422,
        'VALIDATION_ERROR',
        `La fecha en ${fieldName} no existe en el calendario`,
        { [fieldName]: 'Fecha calendario inexistente' },
      );
    }
  }

  return parsed;
}

export function mapLoyaltyReward(row: LoyaltyRewardRow): LoyaltyRewardDto {
  return {
    id: row.id,
    customerId: row.customer_id,
    title: row.title,
    validFrom: toIsoBogota(row.valid_from),
    validUntil: toIsoBogota(row.valid_until),
    status: row.status,
    source: row.source ?? 'automatic',
    sourceStampId: row.source_stamp_id ?? null,
    appointmentId: row.appointment_id ?? row.redeemed_appointment_id ?? null,
    reason: row.reason ?? null,
    redeemedAt: toIsoBogotaNullable(row.redeemed_at),
    cancelledAt: toIsoBogotaNullable(row.cancelled_at),
    createdAt: toIsoBogota(row.created_at),
    updatedAt: toIsoBogota(row.updated_at ?? row.created_at),
  };
}

export function mapLoyaltyStamp(row: LoyaltyStampRow): LoyaltyStampDto {
  return {
    id: row.id,
    loyaltyCardId: row.loyalty_card_id ?? null,
    customerId: row.customer_id,
    washRequestId: row.wash_request_id,
    actorId: row.actor_id ?? row.granted_by ?? null,
    actorName: row.actor_name ?? null,
    status: row.status ?? 'active',
    reason: row.reason ?? null,
    createdAt: toIsoBogota(row.created_at),
    reversedAt: toIsoBogotaNullable(row.reversed_at),
    reversedBy: row.reversed_by ?? null,
    reversedByName: row.reversed_by_name ?? null,
    ...(row.wash_status !== undefined ? { washStatus: row.wash_status } : {}),
    ...(row.wash_price !== undefined
      ? { washPrice: row.wash_price !== null ? Number(row.wash_price) : null }
      : {}),
    ...(row.service_name !== undefined ? { serviceName: row.service_name } : {}),
    ...(row.motorcycle_label !== undefined
      ? { motorcycleLabel: row.motorcycle_label }
      : {}),
  };
}

async function recordLoyaltyAudit(
  tx: DbExecutor,
  params: {
    customerId: string;
    actorId: string | null;
    actorRole: string | null;
    actorName: string | null;
    action: LoyaltyAuditAction;
    targetId: string | null;
    targetType: 'loyalty_stamp' | 'loyalty_reward' | 'loyalty_card';
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    reason?: string | null;
    ipAddress?: string | null;
  },
): Promise<void> {
  const createdAtIso = toIsoBogota(new Date());

  await tx.query(
    `INSERT INTO loyalty_audits (
       id, customer_id, actor_id, actor_role, actor_name, action,
       target_id, target_type, before_state, after_state, reason, ip_address
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12)`,
    [
      newUuid(),
      params.customerId,
      params.actorId,
      params.actorRole,
      params.actorName,
      params.action,
      params.targetId,
      params.targetType,
      params.before ? JSON.stringify(params.before) : null,
      params.after ? JSON.stringify(params.after) : null,
      params.reason ?? null,
      params.ipAddress ?? null,
    ],
  );

  await recordAuditLog(tx, {
    actorId: params.actorId,
    actorRole: params.actorRole,
    action: params.action,
    entityType: params.targetType,
    entityId: params.targetId,
    ipAddress: params.ipAddress,
    changes: {
      actorId: params.actorId,
      actorRole: params.actorRole,
      customerId: params.customerId,
      targetId: params.targetId,
      targetType: params.targetType,
      before: params.before,
      after: params.after,
      reason: params.reason ?? null,
      createdAt: createdAtIso,
    },
  });
}

function nextQrExpiryDate(): Date {
  return new Date(Date.now() + env.LOYALTY_QR_TTL_MINUTES * 60 * 1000);
}

export async function getOrCreateLoyaltyCard(
  db: DbExecutor,
  customerId: string,
  options: { rewardStatusFilter?: RewardStatus } = {},
): Promise<LoyaltyCardDto> {
  let cardRes = await db.query<LoyaltyCardRow>(
    `SELECT id, customer_id, stamps, completed_washes, qr_token, qr_token_expires_at, updated_at
     FROM loyalty_cards
     WHERE customer_id = $1`,
    [customerId],
  );

  if (!cardRes.rows[0]) {
    const newId = newUuid();
    const qrToken = `LM-${generateOpaqueToken(18)}`;
    const qrExpiresAt = nextQrExpiryDate();
    await db.query(
      `INSERT INTO loyalty_cards (id, customer_id, stamps, completed_washes, qr_token, qr_token_expires_at)
       VALUES ($1, $2, 0, 0, $3, $4)
       ON CONFLICT (customer_id) DO NOTHING`,
      [newId, customerId, qrToken, qrExpiresAt],
    );
    cardRes = await db.query<LoyaltyCardRow>(
      `SELECT id, customer_id, stamps, completed_washes, qr_token, qr_token_expires_at, updated_at
       FROM loyalty_cards
       WHERE customer_id = $1`,
      [customerId],
    );
  }

  let card = cardRes.rows[0]!;
  const now = new Date();
  const expiresAt = card.qr_token_expires_at
    ? new Date(card.qr_token_expires_at)
    : null;

  // Nunca exponer tokens QR sin expiración o ya expirados: rotar automáticamente
  if (!expiresAt || expiresAt <= now) {
    const rotatedToken = `LM-${generateOpaqueToken(18)}`;
    const rotatedExpiry = nextQrExpiryDate();
    const updRes = await db.query<LoyaltyCardRow>(
      `UPDATE loyalty_cards
       SET qr_token = $1, qr_token_expires_at = $2, updated_at = NOW()
       WHERE customer_id = $3
       RETURNING id, customer_id, stamps, completed_washes, qr_token, qr_token_expires_at, updated_at`,
      [rotatedToken, rotatedExpiry, customerId],
    );
    if (updRes.rows[0]) {
      card = updRes.rows[0];
    }
  }

  const rewardParams: unknown[] = [customerId];
  let statusClause = '';
  if (options.rewardStatusFilter) {
    rewardParams.push(options.rewardStatusFilter);
    statusClause = ` AND status = $2`;
  }

  const rewardsRes = await db.query<LoyaltyRewardRow>(
    `SELECT id, customer_id, title, valid_from, valid_until, status, source,
            source_stamp_id, appointment_id, redeemed_appointment_id, reason,
            redeemed_at, cancelled_at, created_at, updated_at
     FROM loyalty_rewards
     WHERE customer_id = $1${statusClause}
     ORDER BY created_at DESC`,
    rewardParams,
  );

  return {
    id: card.id,
    customerId: card.customer_id,
    stamps: Number(card.stamps),
    completedWashes: Number(card.completed_washes),
    qrToken: card.qr_token,
    qrTokenExpiresAt: toIsoBogota(
      card.qr_token_expires_at ?? nextQrExpiryDate(),
    ),
    updatedAt: toIsoBogota(card.updated_at),
    rewards: rewardsRes.rows.map(mapLoyaltyReward),
  };
}

async function assertCustomerExists(
  db: DbExecutor,
  customerId: string,
): Promise<{ id: string; name: string; username: string; is_active: boolean }> {
  const res = await db.query<{
    id: string;
    name: string;
    username: string;
    is_active: boolean;
    role: string;
  }>(
    `SELECT id, name, username, is_active, role
     FROM users
     WHERE id = $1`,
    [customerId],
  );
  const user = res.rows[0];
  if (!user || user.role !== 'Cliente') {
    throw new AppError(404, 'CUSTOMER_NOT_FOUND', 'Cliente no encontrado');
  }
  return user;
}

export async function grantLoyaltyStampTx(
  tx: DbExecutor,
  params: {
    actor: AuthUser;
    washRequestId: string;
    expectedCustomerId?: string;
    reason?: string;
    ipAddress?: string;
  },
): Promise<{
  card: LoyaltyCardDto;
  stamp: LoyaltyStampDto;
  rewardCreated: LoyaltyRewardDto | null;
  message: string;
}> {
  const { actor, washRequestId, expectedCustomerId, ipAddress } = params;
  const cleanReason =
    params.reason !== undefined
      ? sanitizeAndAssertSafeLoyaltyText(params.reason, 'reason', 500, false)
      : null;

  if (expectedCustomerId) {
    await assertCustomerExists(tx, expectedCustomerId);
  }

  const wrRes = await tx.query<{
    id: string;
    customer_id: string;
    status: string;
  }>(
    `SELECT id, customer_id, status
     FROM wash_requests
     WHERE id = $1
     FOR UPDATE`,
    [washRequestId],
  );
  const wr = wrRes.rows[0];
  if (!wr) {
    throw new AppError(
      404,
      'WASH_REQUEST_NOT_FOUND',
      'Solicitud de lavada no encontrada',
    );
  }

  if (expectedCustomerId && wr.customer_id !== expectedCustomerId) {
    throw new AppError(
      409,
      'WASH_CUSTOMER_MISMATCH',
      'La lavada no pertenece al cliente indicado; no se puede usar una lavada como sello de dos clientes',
    );
  }

  if (wr.status !== 'paid') {
    throw new AppError(
      409,
      'WASH_NOT_PAID',
      `Solo se otorga sello a una lavada pagada y completada (estado actual: '${wr.status}')`,
    );
  }

  // Asegurar tarjeta existente y bloquear fila
  await getOrCreateLoyaltyCard(tx, wr.customer_id);
  const cardRes = await tx.query<LoyaltyCardRow>(
    `SELECT id, customer_id, stamps, completed_washes, qr_token, qr_token_expires_at, updated_at
     FROM loyalty_cards
     WHERE customer_id = $1
     FOR UPDATE`,
    [wr.customer_id],
  );
  const currentCard = cardRes.rows[0]!;

  const dupStamp = await tx.query<{ id: string }>(
    `SELECT id FROM loyalty_stamps WHERE wash_request_id = $1`,
    [washRequestId],
  );
  if (dupStamp.rows[0]) {
    throw new AppError(
      409,
      'DUPLICATE_STAMP',
      'Esta lavada ya tiene un sello de fidelización registrado',
    );
  }

  const prevStamps = Number(currentCard.stamps);
  const prevCompleted = Number(currentCard.completed_washes);
  const incremented = prevStamps + 1;
  const completedSeventh = incremented >= 7;
  const nextStamps = completedSeventh ? 0 : incremented;
  const nextCompleted = prevCompleted + 1;

  const stampId = newUuid();
  const stampIns = await tx.query<LoyaltyStampRow>(
    `INSERT INTO loyalty_stamps (
       id, loyalty_card_id, customer_id, wash_request_id, granted_by, actor_id, status, reason
     )
     VALUES ($1, $2, $3, $4, $5, $5, 'active', $6)
     RETURNING id, loyalty_card_id, customer_id, wash_request_id, actor_id, granted_by,
               status, reason, created_at, reversed_at, reversed_by`,
    [
      stampId,
      currentCard.id,
      wr.customer_id,
      washRequestId,
      actor.id,
      cleanReason,
    ],
  );
  const createdStamp = mapLoyaltyStamp({
    ...stampIns.rows[0]!,
    actor_name: actor.name,
  });

  await tx.query(
    `UPDATE loyalty_cards
     SET stamps = $1, completed_washes = $2, updated_at = NOW()
     WHERE customer_id = $3`,
    [nextStamps, nextCompleted, wr.customer_id],
  );

  await recordLoyaltyAudit(tx, {
    customerId: wr.customer_id,
    actorId: actor.id,
    actorRole: actor.role,
    actorName: actor.name,
    action: 'loyalty_stamp_created',
    targetId: stampId,
    targetType: 'loyalty_stamp',
    before: {
      stamps: prevStamps,
      completedWashes: prevCompleted,
    },
    after: {
      stampId,
      washRequestId,
      stamps: nextStamps,
      completedWashes: nextCompleted,
      completedSeventh,
    },
    reason: cleanReason ?? 'Sello registrado por lavada pagada',
    ipAddress,
  });

  let rewardCreated: LoyaltyRewardDto | null = null;
  if (completedSeventh) {
    const rewardId = newUuid();
    const validFrom = new Date();
    const validUntil = new Date(
      validFrom.getTime() + env.LOYALTY_REWARD_VALID_DAYS * 24 * 60 * 60 * 1000,
    );

    const rewardIns = await tx.query<LoyaltyRewardRow>(
      `INSERT INTO loyalty_rewards (
         id, customer_id, title, valid_from, valid_until, status,
         source, source_stamp_id, reason, created_by
       )
       VALUES ($1, $2, $3, $4, $5, 'available', 'automatic', $6, $7, $8)
       RETURNING id, customer_id, title, valid_from, valid_until, status, source,
                 source_stamp_id, appointment_id, redeemed_appointment_id, reason,
                 redeemed_at, cancelled_at, created_at, updated_at`,
      [
        rewardId,
        wr.customer_id,
        'Lavada gratis',
        validFrom,
        validUntil,
        stampId,
        'Premio automático por completar 7 sellos',
        actor.id,
      ],
    );
    rewardCreated = mapLoyaltyReward(rewardIns.rows[0]!);

    await recordLoyaltyAudit(tx, {
      customerId: wr.customer_id,
      actorId: actor.id,
      actorRole: actor.role,
      actorName: actor.name,
      action: 'loyalty_reward_created',
      targetId: rewardId,
      targetType: 'loyalty_reward',
      before: null,
      after: {
        rewardId,
        title: rewardCreated.title,
        status: rewardCreated.status,
        source: 'automatic',
        sourceStampId: stampId,
        validFrom: rewardCreated.validFrom,
        validUntil: rewardCreated.validUntil,
      },
      reason: 'Recompensa generada automáticamente al completar 7 sellos',
      ipAddress,
    });

    await notificationService.createAndNotifyUser(tx, {
      userId: wr.customer_id,
      title: '¡Completaste 7 sellos en Los Malditos!',
      body: 'Tu tarjeta completó el ciclo 7+1 y se reinició a 0 sellos para un nuevo ciclo.',
      type: 'loyalty_stamp_created',
      deepLink: '/loyalty/me',
      payload: {
        stampId,
        washRequestId,
        customerId: wr.customer_id,
        stamps: nextStamps,
        completedSeventh: true,
      },
    });

    await notificationService.createAndNotifyUser(tx, {
      userId: wr.customer_id,
      title: '¡Ganaste una Lavada gratis!',
      body: `Tienes disponible una recompensa "${rewardCreated.title}" válida desde ${rewardCreated.validFrom} hasta ${rewardCreated.validUntil}.`,
      type: 'reward_assigned',
      deepLink: '/loyalty/rewards',
      payload: {
        rewardId,
        stampId,
        customerId: wr.customer_id,
        validFrom: rewardCreated.validFrom,
        validUntil: rewardCreated.validUntil,
      },
    });
  } else {
    await notificationService.createAndNotifyUser(tx, {
      userId: wr.customer_id,
      title: 'Nuevo sello registrado en tu tarjeta 7+1',
      body: `Sumaste 1 sello (${nextStamps}/7). ¡Sigue acumulando para tu lavada gratis!`,
      type: 'loyalty_stamp_created',
      deepLink: '/loyalty/me',
      payload: {
        stampId,
        washRequestId,
        customerId: wr.customer_id,
        stamps: nextStamps,
        completedWashes: nextCompleted,
      },
    });
  }

  const card = await getOrCreateLoyaltyCard(tx, wr.customer_id);
  return {
    card,
    stamp: createdStamp,
    rewardCreated,
    message: completedSeventh
      ? 'Sello registrado. ¡El cliente completó 7 sellos y recibió una recompensa automática!'
      : 'Sello de fidelización registrado exitosamente',
  };
}

export async function reverseLoyaltyStamp(
  db: DbClient,
  params: {
    actor: AuthUser;
    customerId: string;
    stampId: string;
    reason?: string;
    ipAddress?: string;
  },
): Promise<{
  stamp: LoyaltyStampDto;
  card: LoyaltyCardDto;
  revertedReward: LoyaltyRewardDto | null;
}> {
  const { actor, customerId, stampId, ipAddress } = params;
  const cleanReason =
    params.reason !== undefined
      ? sanitizeAndAssertSafeLoyaltyText(params.reason, 'reason', 500, false)
      : null;
  const finalReason = cleanReason ?? 'Sello revertido por administración';

  return db.withTransaction(async (tx) => {
    await assertCustomerExists(tx, customerId);

    const stampRes = await tx.query<LoyaltyStampRow>(
      `SELECT id, loyalty_card_id, customer_id, wash_request_id, actor_id, granted_by,
              status, reason, created_at, reversed_at, reversed_by
       FROM loyalty_stamps
       WHERE id = $1 AND customer_id = $2
       FOR UPDATE`,
      [stampId, customerId],
    );
    const existingStamp = stampRes.rows[0];
    if (!existingStamp) {
      throw new AppError(
        404,
        'STAMP_NOT_FOUND',
        'Sello de fidelización no encontrado para el cliente',
      );
    }

    if (existingStamp.status === 'reversed') {
      throw new AppError(
        409,
        'STAMP_ALREADY_REVERSED',
        'El sello ya fue revertido anteriormente',
      );
    }

    await getOrCreateLoyaltyCard(tx, customerId);
    const cardRes = await tx.query<LoyaltyCardRow>(
      `SELECT id, customer_id, stamps, completed_washes, qr_token, qr_token_expires_at, updated_at
       FROM loyalty_cards
       WHERE customer_id = $1
       FOR UPDATE`,
      [customerId],
    );
    const cardRow = cardRes.rows[0]!;

    // Verificar si este sello generó una recompensa
    const linkedRewardRes = await tx.query<LoyaltyRewardRow>(
      `SELECT id, customer_id, title, valid_from, valid_until, status, source,
              source_stamp_id, appointment_id, redeemed_appointment_id, reason,
              redeemed_at, cancelled_at, created_at, updated_at
       FROM loyalty_rewards
       WHERE source_stamp_id = $1
       FOR UPDATE`,
      [stampId],
    );
    const linkedReward = linkedRewardRes.rows[0];
    let revertedReward: LoyaltyRewardDto | null = null;
    let rewardWasRevertedFromAvailable = false;

    if (linkedReward) {
      if (linkedReward.status === 'redeemed') {
        throw new AppError(
          409,
          'REWARD_ALREADY_REDEEMED',
          'No se puede revertir el sello porque la recompensa generada ya fue redimida',
        );
      }

      if (linkedReward.status === 'available') {
        rewardWasRevertedFromAvailable = true;
        const cancelReason = `Recompensa revertida por anulación de sello (${finalReason})`;
        const updReward = await tx.query<LoyaltyRewardRow>(
          `UPDATE loyalty_rewards
           SET status = 'cancelled',
               cancelled_at = NOW(),
               cancelled_by = $1,
               reason = $2,
               updated_at = NOW()
           WHERE id = $3
           RETURNING id, customer_id, title, valid_from, valid_until, status, source,
                     source_stamp_id, appointment_id, redeemed_appointment_id, reason,
                     redeemed_at, cancelled_at, created_at, updated_at`,
          [actor.id, cancelReason, linkedReward.id],
        );
        revertedReward = mapLoyaltyReward(updReward.rows[0]!);

        await recordLoyaltyAudit(tx, {
          customerId,
          actorId: actor.id,
          actorRole: actor.role,
          actorName: actor.name,
          action: 'loyalty_reward_cancelled',
          targetId: linkedReward.id,
          targetType: 'loyalty_reward',
          before: { status: linkedReward.status },
          after: {
            status: 'cancelled',
            cancelledAt: revertedReward.cancelledAt,
          },
          reason: cancelReason,
          ipAddress,
        });

        await notificationService.createAndNotifyUser(tx, {
          userId: customerId,
          title: 'Recompensa revertida por ajuste de sello',
          body: `La recompensa "${linkedReward.title}" fue cancelada porque se revirtió el sello que la generó.`,
          type: 'loyalty_reward_cancelled',
          deepLink: '/loyalty/rewards',
          payload: {
            rewardId: linkedReward.id,
            stampId,
            customerId,
          },
        });
      }
    }

    const updStampRes = await tx.query<LoyaltyStampRow>(
      `UPDATE loyalty_stamps
       SET status = 'reversed',
           reversed_at = NOW(),
           reversed_by = $1,
           reason = $2
       WHERE id = $3
       RETURNING id, loyalty_card_id, customer_id, wash_request_id, actor_id, granted_by,
                 status, reason, created_at, reversed_at, reversed_by`,
      [actor.id, finalReason, stampId],
    );
    const updatedStamp = mapLoyaltyStamp({
      ...updStampRes.rows[0]!,
      reversed_by_name: actor.name,
    });

    const prevStamps = Number(cardRow.stamps);
    const prevCompleted = Number(cardRow.completed_washes);
    let nextStamps = prevStamps;
    if (rewardWasRevertedFromAvailable && prevStamps === 0) {
      nextStamps = 6;
    } else if (prevStamps > 0) {
      nextStamps = prevStamps - 1;
    }
    const nextCompleted = Math.max(0, prevCompleted - 1);

    await tx.query(
      `UPDATE loyalty_cards
       SET stamps = $1, completed_washes = $2, updated_at = NOW()
       WHERE customer_id = $3`,
      [nextStamps, nextCompleted, customerId],
    );

    await recordLoyaltyAudit(tx, {
      customerId,
      actorId: actor.id,
      actorRole: actor.role,
      actorName: actor.name,
      action: 'loyalty_stamp_reversed',
      targetId: stampId,
      targetType: 'loyalty_stamp',
      before: {
        status: existingStamp.status,
        stamps: prevStamps,
        completedWashes: prevCompleted,
      },
      after: {
        status: 'reversed',
        reversedAt: updatedStamp.reversedAt,
        stamps: nextStamps,
        completedWashes: nextCompleted,
        revertedRewardId: revertedReward?.id ?? null,
      },
      reason: finalReason,
      ipAddress,
    });

    await notificationService.createAndNotifyUser(tx, {
      userId: customerId,
      title: 'Ajuste en tu tarjeta de fidelización',
      body: `Se revirtió un sello de tu tarjeta (${finalReason}). Sellos actuales: ${nextStamps}/7.`,
      type: 'loyalty_stamp_reversed',
      deepLink: '/loyalty/me',
      payload: {
        stampId,
        customerId,
        stamps: nextStamps,
        reason: finalReason,
      },
    });

    const updatedCard = await getOrCreateLoyaltyCard(tx, customerId);
    return {
      stamp: updatedStamp,
      card: updatedCard,
      revertedReward,
    };
  });
}

export async function assignManualLoyaltyReward(
  db: DbClient,
  params: {
    actor: AuthUser;
    customerId: string;
    title: string;
    validFrom: string;
    validUntil: string;
    reason?: string;
    ipAddress?: string;
  },
): Promise<LoyaltyRewardDto> {
  const cleanTitle = sanitizeAndAssertSafeLoyaltyText(
    params.title,
    'title',
    160,
    true,
  )!;
  const cleanReason =
    params.reason !== undefined
      ? sanitizeAndAssertSafeLoyaltyText(params.reason, 'reason', 500, false)
      : null;

  const validFromDate = parseBogotaRewardDate(params.validFrom, 'validFrom', false);
  const validUntilDate = parseBogotaRewardDate(params.validUntil, 'validUntil', true);

  if (validUntilDate <= validFromDate) {
    throw new AppError(
      422,
      'INVALID_DATE_RANGE',
      'validUntil debe ser estrictamente posterior a validFrom',
      { validUntil: 'Debe ser posterior a validFrom' },
    );
  }

  const maxSpanMs = env.LOYALTY_MAX_MANUAL_VALID_DAYS * 24 * 60 * 60 * 1000;
  if (validUntilDate.getTime() - validFromDate.getTime() > maxSpanMs) {
    throw new AppError(
      422,
      'VALIDITY_WINDOW_TOO_LONG',
      `La vigencia de una recompensa manual no puede superar ${env.LOYALTY_MAX_MANUAL_VALID_DAYS} días`,
      {
        validUntil: `Máximo ${env.LOYALTY_MAX_MANUAL_VALID_DAYS} días desde validFrom`,
      },
    );
  }

  return db.withTransaction(async (tx) => {
    await assertCustomerExists(tx, params.customerId);
    await getOrCreateLoyaltyCard(tx, params.customerId);

    const rewardId = newUuid();
    const finalReason = cleanReason ?? 'Premio asignado manualmente por administración';
    const insRes = await tx.query<LoyaltyRewardRow>(
      `INSERT INTO loyalty_rewards (
         id, customer_id, title, valid_from, valid_until, status,
         source, source_stamp_id, reason, created_by
       )
       VALUES ($1, $2, $3, $4, $5, 'available', 'manual', NULL, $6, $7)
       RETURNING id, customer_id, title, valid_from, valid_until, status, source,
                 source_stamp_id, appointment_id, redeemed_appointment_id, reason,
                 redeemed_at, cancelled_at, created_at, updated_at`,
      [
        rewardId,
        params.customerId,
        cleanTitle,
        validFromDate,
        validUntilDate,
        finalReason,
        params.actor.id,
      ],
    );
    const reward = mapLoyaltyReward(insRes.rows[0]!);

    await recordLoyaltyAudit(tx, {
      customerId: params.customerId,
      actorId: params.actor.id,
      actorRole: params.actor.role,
      actorName: params.actor.name,
      action: 'loyalty_reward_created',
      targetId: rewardId,
      targetType: 'loyalty_reward',
      before: null,
      after: {
        id: reward.id,
        title: reward.title,
        status: reward.status,
        source: 'manual',
        validFrom: reward.validFrom,
        validUntil: reward.validUntil,
      },
      reason: finalReason,
      ipAddress: params.ipAddress,
    });

    await notificationService.createAndNotifyUser(tx, {
      userId: params.customerId,
      title: `Recibiste una recompensa: ${reward.title}`,
      body: `Administración te asignó "${reward.title}". Vigencia: desde ${reward.validFrom} hasta ${reward.validUntil}.`,
      type: 'reward_assigned',
      deepLink: '/loyalty/rewards',
      payload: {
        rewardId: reward.id,
        customerId: params.customerId,
        validFrom: reward.validFrom,
        validUntil: reward.validUntil,
        source: 'manual',
      },
    });

    return reward;
  });
}

export async function cancelLoyaltyReward(
  db: DbClient,
  params: {
    actor: AuthUser;
    rewardId: string;
    reason?: string;
    ipAddress?: string;
  },
): Promise<LoyaltyRewardDto> {
  const cleanReason =
    params.reason !== undefined
      ? sanitizeAndAssertSafeLoyaltyText(params.reason, 'reason', 500, false)
      : null;
  const finalReason = cleanReason ?? 'Recompensa cancelada por administración';

  // Expiramos primero recompensas vencidas para no cancelar incorrectamente una ya vencida
  await expireOutdatedLoyaltyRewards(db);

  return db.withTransaction(async (tx) => {
    const res = await tx.query<LoyaltyRewardRow>(
      `SELECT id, customer_id, title, valid_from, valid_until, status, source,
              source_stamp_id, appointment_id, redeemed_appointment_id, reason,
              redeemed_at, cancelled_at, created_at, updated_at
       FROM loyalty_rewards
       WHERE id = $1
       FOR UPDATE`,
      [params.rewardId],
    );
    const existing = res.rows[0];
    if (!existing) {
      throw new AppError(404, 'REWARD_NOT_FOUND', 'Recompensa no encontrada');
    }

    if (existing.status === 'redeemed') {
      throw new AppError(
        409,
        'REWARD_ALREADY_REDEEMED',
        'No se puede cancelar una recompensa que ya fue redimida',
      );
    }
    if (existing.status === 'expired') {
      throw new AppError(
        409,
        'REWARD_ALREADY_EXPIRED',
        'La recompensa ya está vencida y se conserva como historial',
      );
    }
    if (existing.status === 'cancelled') {
      throw new AppError(
        409,
        'REWARD_ALREADY_CANCELLED',
        'La recompensa ya fue cancelada anteriormente',
      );
    }

    const upd = await tx.query<LoyaltyRewardRow>(
      `UPDATE loyalty_rewards
       SET status = 'cancelled',
           cancelled_at = NOW(),
           cancelled_by = $1,
           reason = $2,
           updated_at = NOW()
       WHERE id = $3
       RETURNING id, customer_id, title, valid_from, valid_until, status, source,
                 source_stamp_id, appointment_id, redeemed_appointment_id, reason,
                 redeemed_at, cancelled_at, created_at, updated_at`,
      [params.actor.id, finalReason, params.rewardId],
    );
    const updated = mapLoyaltyReward(upd.rows[0]!);

    await recordLoyaltyAudit(tx, {
      customerId: existing.customer_id,
      actorId: params.actor.id,
      actorRole: params.actor.role,
      actorName: params.actor.name,
      action: 'loyalty_reward_cancelled',
      targetId: params.rewardId,
      targetType: 'loyalty_reward',
      before: {
        status: existing.status,
        title: existing.title,
      },
      after: {
        status: 'cancelled',
        cancelledAt: updated.cancelledAt,
      },
      reason: finalReason,
      ipAddress: params.ipAddress,
    });

    await notificationService.createAndNotifyUser(tx, {
      userId: existing.customer_id,
      title: 'Tu recompensa de fidelización fue cancelada',
      body: `La recompensa "${existing.title}" fue cancelada (${finalReason}).`,
      type: 'loyalty_reward_cancelled',
      deepLink: '/loyalty/rewards',
      payload: {
        rewardId: params.rewardId,
        customerId: existing.customer_id,
        reason: finalReason,
      },
    });

    return updated;
  });
}

export async function redeemLoyaltyRewardTx(
  tx: DbExecutor,
  params: {
    actor: AuthUser;
    rewardId: string;
    appointmentId?: string | null;
    ipAddress?: string;
  },
): Promise<LoyaltyCardDto> {
  const { actor, rewardId, appointmentId, ipAddress } = params;

  const rewardRes = await tx.query<LoyaltyRewardRow>(
    `SELECT id, customer_id, title, valid_from, valid_until, status, source,
            source_stamp_id, appointment_id, redeemed_appointment_id, reason,
            redeemed_at, cancelled_at, created_at, updated_at
     FROM loyalty_rewards
     WHERE id = $1
     FOR UPDATE`,
    [rewardId],
  );
  const reward = rewardRes.rows[0];
  if (!reward) {
    throw new AppError(404, 'REWARD_NOT_FOUND', 'Premio no encontrado');
  }

  const isOwner = reward.customer_id === actor.id;
  const isAdmin = actor.role === 'Administrador';
  if (!isOwner && !isAdmin) {
    throw new AppError(
      403,
      'FORBIDDEN',
      'Solo el cliente propietario o un Administrador autorizado pueden redimir esta recompensa',
    );
  }

  const now = new Date();
  const validFrom = new Date(reward.valid_from);
  const validUntil = new Date(reward.valid_until);

  if (reward.status === 'cancelled') {
    throw new AppError(
      409,
      'REWARD_CANCELLED',
      'La recompensa fue cancelada y no puede ser redimida',
    );
  }
  if (reward.status === 'redeemed') {
    throw new AppError(
      409,
      'REWARD_ALREADY_REDEEMED',
      'El premio ya fue redimido anteriormente',
    );
  }
  if (reward.status === 'expired' || now > validUntil) {
    throw new AppError(
      409,
      'REWARD_EXPIRED',
      'El premio venció y ya no puede ser redimido',
    );
  }
  if (now < validFrom) {
    throw new AppError(
      409,
      'REWARD_NOT_YET_VALID',
      `El premio solo puede redimirse a partir de ${toIsoBogota(validFrom)}`,
    );
  }

  if (appointmentId) {
    const apptRes = await tx.query<{
      id: string;
      customer_id: string;
      start_at: Date | string;
      status: string;
    }>(
      `SELECT id, customer_id, start_at, status
       FROM appointments
       WHERE id = $1`,
      [appointmentId],
    );
    const appt = apptRes.rows[0];
    if (!appt) {
      throw new AppError(404, 'APPOINTMENT_NOT_FOUND', 'La cita no existe');
    }
    if (appt.customer_id !== reward.customer_id) {
      throw new AppError(
        409,
        'APPOINTMENT_CUSTOMER_MISMATCH',
        'La cita indicada no pertenece al cliente propietario de la recompensa',
      );
    }
    if (appt.status === 'cancelled') {
      throw new AppError(
        409,
        'INVALID_APPOINTMENT_STATE',
        'No se puede asociar una recompensa a una cita cancelada',
      );
    }
    const apptStart = new Date(appt.start_at);
    if (apptStart < validFrom || apptStart > validUntil) {
      throw new AppError(
        409,
        'REWARD_WINDOW_INVALID',
        'La cita debe estar agendada dentro del periodo de vigencia del premio (validFrom - validUntil)',
      );
    }
  }

  await tx.query(
    `UPDATE loyalty_rewards
     SET status = 'redeemed',
         appointment_id = $1,
         redeemed_appointment_id = $1,
         redeemed_at = NOW(),
         redeemed_by = $2,
         updated_at = NOW()
     WHERE id = $3`,
    [appointmentId ?? null, actor.id, rewardId],
  );

  await tx.query(
    `UPDATE loyalty_cards
     SET stamps = CASE WHEN stamps = 7 THEN 0 ELSE stamps END,
         updated_at = NOW()
     WHERE customer_id = $1`,
    [reward.customer_id],
  );

  const redeemedAtIso = toIsoBogota(new Date());
  await recordLoyaltyAudit(tx, {
    customerId: reward.customer_id,
    actorId: actor.id,
    actorRole: actor.role,
    actorName: actor.name,
    action: 'loyalty_reward_redeemed',
    targetId: rewardId,
    targetType: 'loyalty_reward',
    before: {
      status: reward.status,
      appointmentId: reward.appointment_id ?? reward.redeemed_appointment_id,
    },
    after: {
      status: 'redeemed',
      appointmentId: appointmentId ?? null,
      redeemedAt: redeemedAtIso,
      redeemedBy: actor.id,
    },
    reason: 'Recompensa redimida',
    ipAddress,
  });

  await notificationService.createAndNotifyUser(tx, {
    userId: reward.customer_id,
    title: 'Recompensa redimida exitosamente',
    body: `Tu premio "${reward.title}" fue redimido correctamente.`,
    type: 'loyalty_reward_redeemed',
    deepLink: '/loyalty/rewards',
    payload: {
      rewardId,
      customerId: reward.customer_id,
      appointmentId: appointmentId ?? null,
      redeemedAt: redeemedAtIso,
    },
  });

  return getOrCreateLoyaltyCard(tx, reward.customer_id);
}

export async function listLoyaltyCustomers(
  db: DbClient,
  query: {
    search?: string;
    status: 'all' | 'available_reward' | 'no_reward' | 'blocked';
    sort: 'stamps_desc' | 'completed_washes_desc' | 'newest';
    page: number;
    pageSize: number;
  },
): Promise<{ items: LoyaltyCustomerSummaryDto[]; total: number }> {
  await expireOutdatedLoyaltyRewards(db);

  const conditions: string[] = [`u.role = 'Cliente'`];
  const params: unknown[] = [];

  if (query.search && query.search.trim().length > 0) {
    params.push(`%${query.search.trim()}%`);
    conditions.push(
      `(u.name ILIKE $${params.length} OR u.username ILIKE $${params.length})`,
    );
  }

  if (query.status === 'available_reward') {
    conditions.push(
      `EXISTS (SELECT 1 FROM loyalty_rewards lr WHERE lr.customer_id = u.id AND lr.status = 'available')`,
    );
  } else if (query.status === 'no_reward') {
    conditions.push(
      `NOT EXISTS (SELECT 1 FROM loyalty_rewards lr WHERE lr.customer_id = u.id AND lr.status = 'available')`,
    );
  } else if (query.status === 'blocked') {
    conditions.push(
      `(u.is_active = FALSE OR (u.locked_until IS NOT NULL AND u.locked_until > NOW()))`,
    );
  }

  const whereSql = `WHERE ${conditions.join(' AND ')}`;

  const countRes = await db.query<{ cnt: string | number }>(
    `SELECT COUNT(*) AS cnt FROM users u ${whereSql}`,
    params,
  );
  const total = Number(countRes.rows[0]?.cnt ?? 0);

  let orderBySql = 'u.created_at DESC';
  if (query.sort === 'stamps_desc') {
    orderBySql = 'COALESCE(lc.stamps, 0) DESC, COALESCE(lc.completed_washes, 0) DESC, u.created_at DESC';
  } else if (query.sort === 'completed_washes_desc') {
    orderBySql = 'COALESCE(lc.completed_washes, 0) DESC, COALESCE(lc.stamps, 0) DESC, u.created_at DESC';
  }

  const offset = (query.page - 1) * query.pageSize;
  const rowsRes = await db.query<{
    customer_id: string;
    customer_name: string;
    username: string;
    is_active: boolean;
    stamps: number | null;
    completed_washes: number | null;
    available_rewards: string | number;
    expired_rewards: string | number;
    last_wash_at: Date | string | null;
  }>(
    `SELECT
       u.id AS customer_id,
       u.name AS customer_name,
       u.username,
       u.is_active,
       COALESCE(lc.stamps, 0) AS stamps,
       COALESCE(lc.completed_washes, 0) AS completed_washes,
       (SELECT COUNT(*) FROM loyalty_rewards lr WHERE lr.customer_id = u.id AND lr.status = 'available') AS available_rewards,
       (SELECT COUNT(*) FROM loyalty_rewards lr WHERE lr.customer_id = u.id AND lr.status = 'expired') AS expired_rewards,
       (SELECT MAX(COALESCE(wr.completed_at, wr.created_at))
        FROM wash_requests wr
        WHERE wr.customer_id = u.id AND wr.status = 'paid') AS last_wash_at
     FROM users u
     LEFT JOIN loyalty_cards lc ON lc.customer_id = u.id
     ${whereSql}
     ORDER BY ${orderBySql}
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, query.pageSize, offset],
  );

  return {
    items: rowsRes.rows.map((r) => ({
      customerId: r.customer_id,
      customerName: r.customer_name,
      username: r.username,
      isActive: r.is_active,
      stamps: Number(r.stamps ?? 0),
      completedWashes: Number(r.completed_washes ?? 0),
      availableRewards: Number(r.available_rewards ?? 0),
      expiredRewards: Number(r.expired_rewards ?? 0),
      lastWashAt: toIsoBogotaNullable(r.last_wash_at),
    })),
    total,
  };
}

export async function getLoyaltyCustomerDetail(
  db: DbClient,
  customerId: string,
): Promise<{
  customer: {
    id: string;
    name: string;
    username: string;
    isActive: boolean;
  };
  card: LoyaltyCardDto;
  stamps: number;
  completedWashes: number;
  stampsHistory: LoyaltyStampDto[];
  stampWashes: Array<{
    stampId: string;
    washRequestId: string;
    status: string | null;
    price: number | null;
    serviceName: string | null;
    motorcycleLabel: string | null;
    stampStatus: StampStatus;
    stampedAt: string;
  }>;
  rewards: {
    available: LoyaltyRewardDto[];
    redeemed: LoyaltyRewardDto[];
    expired: LoyaltyRewardDto[];
    cancelled: LoyaltyRewardDto[];
  };
  audit: LoyaltyAuditDto[];
  updatedAt: string;
}> {
  const customer = await assertCustomerExists(db, customerId);
  await expireOutdatedLoyaltyRewards(db);
  const card = await getOrCreateLoyaltyCard(db, customerId);

  const stampsRes = await db.query<LoyaltyStampRow>(
    `SELECT
       ls.id,
       ls.loyalty_card_id,
       ls.customer_id,
       ls.wash_request_id,
       ls.actor_id,
       ls.granted_by,
       actor.name AS actor_name,
       ls.status,
       ls.reason,
       ls.created_at,
       ls.reversed_at,
       ls.reversed_by,
       rev.name AS reversed_by_name,
       wr.status AS wash_status,
       wr.price AS wash_price,
       s.name AS service_name,
       CONCAT(m.brand, ' ', m.model) AS motorcycle_label
     FROM loyalty_stamps ls
     LEFT JOIN users actor ON actor.id = COALESCE(ls.actor_id, ls.granted_by)
     LEFT JOIN users rev ON rev.id = ls.reversed_by
     LEFT JOIN wash_requests wr ON wr.id = ls.wash_request_id
     LEFT JOIN services s ON s.id = wr.service_id
     LEFT JOIN motorcycles m ON m.id = wr.motorcycle_id
     WHERE ls.customer_id = $1
     ORDER BY ls.created_at DESC`,
    [customerId],
  );
  const stampsHistory = stampsRes.rows.map(mapLoyaltyStamp);

  const stampWashes = stampsHistory.map((s) => ({
    stampId: s.id,
    washRequestId: s.washRequestId,
    status: s.washStatus ?? null,
    price: s.washPrice ?? null,
    serviceName: s.serviceName ?? null,
    motorcycleLabel: s.motorcycleLabel ?? null,
    stampStatus: s.status,
    stampedAt: s.createdAt,
  }));

  const available = card.rewards.filter((r) => r.status === 'available');
  const redeemed = card.rewards.filter((r) => r.status === 'redeemed');
  const expired = card.rewards.filter((r) => r.status === 'expired');
  const cancelled = card.rewards.filter((r) => r.status === 'cancelled');

  const auditsRes = await db.query<{
    id: string;
    actor_id: string | null;
    actor_role: string | null;
    actor_name: string | null;
    customer_id: string;
    action: LoyaltyAuditAction;
    target_id: string | null;
    target_type: 'loyalty_stamp' | 'loyalty_reward' | 'loyalty_card';
    before_state: Record<string, unknown> | null;
    after_state: Record<string, unknown> | null;
    reason: string | null;
    ip_address: string | null;
    created_at: Date | string;
  }>(
    `SELECT id, actor_id, actor_role, actor_name, customer_id, action,
            target_id, target_type, before_state, after_state, reason, ip_address, created_at
     FROM loyalty_audits
     WHERE customer_id = $1
     ORDER BY created_at DESC`,
    [customerId],
  );

  return {
    customer: {
      id: customer.id,
      name: customer.name,
      username: customer.username,
      isActive: customer.is_active,
    },
    card,
    stamps: card.stamps,
    completedWashes: card.completedWashes,
    stampsHistory,
    stampWashes,
    rewards: {
      available,
      redeemed,
      expired,
      cancelled,
    },
    audit: auditsRes.rows.map((a) => ({
      id: a.id,
      actorId: a.actor_id,
      actorRole: a.actor_role,
      actorName: a.actor_name,
      customerId: a.customer_id,
      action: a.action,
      targetId: a.target_id,
      targetType: a.target_type,
      before: a.before_state,
      after: a.after_state,
      reason: a.reason,
      ipAddress: a.ip_address,
      createdAt: toIsoBogota(a.created_at),
    })),
    updatedAt: card.updatedAt,
  };
}
