import type { DbExecutor } from '../db/index.js';
import { newUuid } from '../utils/crypto.js';

const SENSITIVE_KEYS = new Set([
  'password',
  'passwordhash',
  'password_hash',
  'currentpassword',
  'newpassword',
  'temporarypassword',
  'accesstoken',
  'refreshtoken',
  'token',
  'tokenhash',
]);

function sanitizeAuditValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map(sanitizeAuditValue);
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(k.toLowerCase())) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = sanitizeAuditValue(v);
      }
    }
    return out;
  }
  return value;
}

export async function recordAuditLog(
  db: DbExecutor,
  params: {
    actorId?: string | null;
    actorRole?: string | null;
    action: string;
    entityType: string;
    entityId?: string | null;
    ipAddress?: string | null;
    changes?: Record<string, unknown> | null;
  },
): Promise<void> {
  const sanitizedChanges = params.changes
    ? sanitizeAuditValue(params.changes)
    : null;

  await db.query(
    `INSERT INTO audit_logs (id, actor_id, actor_role, action, entity_type, entity_id, ip_address, changes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      newUuid(),
      params.actorId ?? null,
      params.actorRole ?? null,
      params.action,
      params.entityType,
      params.entityId ?? null,
      params.ipAddress ?? null,
      sanitizedChanges ? JSON.stringify(sanitizedChanges) : null,
    ],
  );
}
