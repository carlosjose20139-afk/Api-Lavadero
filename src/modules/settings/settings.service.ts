import type { DbClient, DbExecutor } from '../../db/index.js';
import type { AuthUser } from '../../middleware/auth.js';
import { recordAuditLog } from '../../services/audit.service.js';
import { notificationService } from '../../services/notification.service.js';
import { newUuid } from '../../utils/crypto.js';
import { AppError } from '../../utils/response.js';
import { toIsoBogota, toIsoBogotaNullable } from '../../utils/time.js';

export const LOYALTY_ENABLED_KEY = 'loyaltyEnabled';

export interface LoyaltySettingsDto {
  loyaltyEnabled: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

function parseBooleanSetting(raw: unknown, fallback = true): boolean {
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return fallback;
}

export async function isLoyaltyEnabled(db: DbExecutor): Promise<boolean> {
  try {
    const res = await db.query<{ value_json: unknown }>(
      `SELECT value_json
       FROM business_settings
       WHERE key = $1`,
      [LOYALTY_ENABLED_KEY],
    );
    const row = res.rows[0];
    if (!row) {
      return true;
    }
    return parseBooleanSetting(row.value_json, true);
  } catch {
    // Compatibilidad segura si la tabla o fila aún no estuviera presente
    return true;
  }
}

export async function getLoyaltySettings(
  db: DbExecutor,
): Promise<LoyaltySettingsDto> {
  try {
    const res = await db.query<{
      value_json: unknown;
      updated_at: Date | string;
      updated_by: string | null;
    }>(
      `SELECT value_json, updated_at, updated_by
       FROM business_settings
       WHERE key = $1`,
      [LOYALTY_ENABLED_KEY],
    );
    const row = res.rows[0];
    if (!row) {
      return {
        loyaltyEnabled: true,
        updatedAt: null,
        updatedBy: null,
      };
    }
    return {
      loyaltyEnabled: parseBooleanSetting(row.value_json, true),
      updatedAt: toIsoBogotaNullable(row.updated_at),
      updatedBy: row.updated_by ?? null,
    };
  } catch {
    return {
      loyaltyEnabled: true,
      updatedAt: null,
      updatedBy: null,
    };
  }
}

export async function assertLoyaltyEnabled(db: DbExecutor): Promise<void> {
  const enabled = await isLoyaltyEnabled(db);
  if (!enabled) {
    throw new AppError(
      409,
      'LOYALTY_DISABLED',
      'La campaña de Fidelización está desactivada temporalmente',
    );
  }
}

export async function updateLoyaltyEnabledSetting(
  db: DbClient,
  params: {
    actor: AuthUser;
    loyaltyEnabled: boolean;
    ipAddress?: string;
  },
): Promise<{
  loyaltyEnabled: boolean;
  updatedAt: string;
  updatedBy: string;
}> {
  const { actor, loyaltyEnabled, ipAddress } = params;

  return db.withTransaction(async (tx) => {
    const prevRes = await tx.query<{ value_json: unknown }>(
      `SELECT value_json
       FROM business_settings
       WHERE key = $1
       FOR UPDATE`,
      [LOYALTY_ENABLED_KEY],
    );
    const previousValue = prevRes.rows[0]
      ? parseBooleanSetting(prevRes.rows[0].value_json, true)
      : true;

    const upsertRes = await tx.query<{
      value_json: unknown;
      updated_at: Date | string;
      updated_by: string | null;
    }>(
      `INSERT INTO business_settings (id, key, value_json, updated_at, updated_by)
       VALUES ($1, $2, $3::jsonb, NOW(), $4)
       ON CONFLICT (key)
       DO UPDATE SET value_json = EXCLUDED.value_json,
                     updated_at = NOW(),
                     updated_by = EXCLUDED.updated_by
       RETURNING value_json, updated_at, updated_by`,
      [
        newUuid(),
        LOYALTY_ENABLED_KEY,
        JSON.stringify(loyaltyEnabled),
        actor.id,
      ],
    );
    const updatedRow = upsertRes.rows[0]!;
    const updatedAtIso = toIsoBogota(updatedRow.updated_at);

    await recordAuditLog(tx, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'loyalty_settings_updated',
      entityType: 'business_settings',
      entityId: LOYALTY_ENABLED_KEY,
      ipAddress,
      changes: {
        action: 'loyalty_settings_updated',
        actorId: actor.id,
        actorRole: actor.role,
        key: LOYALTY_ENABLED_KEY,
        previousValue,
        newValue: loyaltyEnabled,
        updatedAt: updatedAtIso,
        ipAddress: ipAddress ?? null,
      },
    });

    // Notificación interna únicamente para administradores (nunca a clientes al desactivar/reactivar)
    await notificationService.notifyAdmins(tx, {
      title: loyaltyEnabled
        ? 'Campaña de Fidelización 7+1 activada'
        : 'Campaña de Fidelización 7+1 desactivada',
      body: loyaltyEnabled
        ? `${actor.name} activó globalmente el módulo de Fidelización 7+1.`
        : `${actor.name} desactivó temporalmente el módulo de Fidelización 7+1.`,
      type: 'loyalty_settings_updated',
      deepLink: '/settings/loyalty',
      payload: {
        key: LOYALTY_ENABLED_KEY,
        previousValue,
        loyaltyEnabled,
        updatedBy: actor.id,
        updatedAt: updatedAtIso,
      },
    });

    return {
      loyaltyEnabled,
      updatedAt: updatedAtIso,
      updatedBy: updatedRow.updated_by ?? actor.id,
    };
  });
}
