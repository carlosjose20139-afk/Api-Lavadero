import {
  cert,
  getApps,
  initializeApp,
  type ServiceAccount,
} from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import type { DbExecutor } from '../db/index.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { newUuid } from '../utils/crypto.js';
import { toIsoBogota } from '../utils/time.js';

export type NotificationType =
  | 'wash_confirmation_required'
  | 'wash_confirmed'
  | 'wash_rejected'
  | 'wash_expired'
  | 'wash_ready'
  | 'appointment_reminder'
  | 'reward_assigned'
  | 'pending_charge'
  | 'moderation'
  | 'data_request';

export interface NotificationRecord {
  id: string;
  userId: string;
  title: string;
  body: string;
  type: string;
  deepLink: string | null;
  payload: Record<string, unknown>;
  isRead: boolean;
  createdAt: string;
}

export interface FcmDispatcher {
  sendToTokens(
    tokens: string[],
    message: {
      title: string;
      body: string;
      data: Record<string, string>;
    },
  ): Promise<{ invalidTokens: string[] }>;
}

class FirebaseFcmDispatcher implements FcmDispatcher {
  private initialized = false;
  private enabled = false;

  private ensureInit(): boolean {
    if (this.initialized) return this.enabled;
    this.initialized = true;

    const rawJson = env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
    if (!rawJson) {
      this.enabled = false;
      return false;
    }

    try {
      const credentials = JSON.parse(rawJson) as ServiceAccount;
      if (getApps().length === 0) {
        initializeApp({
          credential: cert(credentials),
        });
      }
      this.enabled = true;
      logger.info('FCM inicializado correctamente');
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : 'error' },
        'FCM no pudo inicializarse; se continuará solo con notificaciones in-app',
      );
      this.enabled = false;
    }
    return this.enabled;
  }

  async sendToTokens(
    tokens: string[],
    message: {
      title: string;
      body: string;
      data: Record<string, string>;
    },
  ): Promise<{ invalidTokens: string[] }> {
    if (tokens.length === 0 || !this.ensureInit()) {
      return { invalidTokens: [] };
    }

    try {
      const response = await getMessaging().sendEachForMulticast({
        tokens,
        notification: {
          title: message.title,
          body: message.body,
        },
        data: message.data,
      });

      const invalidTokens: string[] = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success && resp.error) {
          const code = resp.error.code;
          if (
            code === 'messaging/registration-token-not-registered' ||
            code === 'messaging/invalid-registration-token'
          ) {
            const badToken = tokens[idx];
            if (badToken) invalidTokens.push(badToken);
          }
        }
      });
      return { invalidTokens };
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : 'error' },
        'Fallo envío FCM; la notificación in-app permanece guardada para polling',
      );
      return { invalidTokens: [] };
    }
  }
}

export class NotificationService {
  constructor(private readonly fcm: FcmDispatcher = new FirebaseFcmDispatcher()) {}

  async createAndNotifyUser(
    db: DbExecutor,
    params: {
      userId: string;
      title: string;
      body: string;
      type: NotificationType;
      deepLink?: string | null;
      payload?: Record<string, unknown>;
    },
  ): Promise<NotificationRecord> {
    const id = newUuid();
    const payload = params.payload ?? {};
    const deepLink = params.deepLink ?? null;

    const inserted = await db.query<{
      id: string;
      user_id: string;
      title: string;
      body: string;
      type: string;
      deep_link: string | null;
      payload: Record<string, unknown>;
      is_read: boolean;
      created_at: Date | string;
    }>(
      `INSERT INTO notifications (id, user_id, title, body, type, deep_link, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       RETURNING id, user_id, title, body, type, deep_link, payload, is_read, created_at`,
      [
        id,
        params.userId,
        params.title,
        params.body,
        params.type,
        deepLink,
        JSON.stringify(payload),
      ],
    );

    const row = inserted.rows[0]!;

    // Despacho FCM únicamente a los dispositivos válidos del usuario propietario
    const deviceRes = await db.query<{ token: string }>(
      `SELECT token FROM device_tokens WHERE user_id = $1 AND is_valid = TRUE`,
      [params.userId],
    );
    const tokens = deviceRes.rows.map((r) => r.token);

    if (tokens.length > 0) {
      const stringData: Record<string, string> = {
        notificationId: id,
        type: params.type,
        ...(deepLink ? { deepLink } : {}),
      };
      for (const [k, v] of Object.entries(payload)) {
        if (v !== undefined && v !== null) {
          stringData[k] = typeof v === 'string' ? v : JSON.stringify(v);
        }
      }

      const { invalidTokens } = await this.fcm.sendToTokens(tokens, {
        title: params.title,
        body: params.body,
        data: stringData,
      });

      if (invalidTokens.length > 0) {
        await db.query(
          `UPDATE device_tokens SET is_valid = FALSE WHERE token = ANY($1::text[])`,
          [invalidTokens],
        );
      }
    }

    return {
      id: row.id,
      userId: row.user_id,
      title: row.title,
      body: row.body,
      type: row.type,
      deepLink: row.deep_link,
      payload: row.payload ?? {},
      isRead: row.is_read,
      createdAt: toIsoBogota(row.created_at),
    };
  }

  async notifyAdmins(
    db: DbExecutor,
    params: {
      title: string;
      body: string;
      type: NotificationType;
      deepLink?: string | null;
      payload?: Record<string, unknown>;
    },
  ): Promise<void> {
    const admins = await db.query<{ id: string }>(
      `SELECT id FROM users WHERE role = 'Administrador' AND is_active = TRUE`,
    );
    for (const adminUser of admins.rows) {
      await this.createAndNotifyUser(db, {
        userId: adminUser.id,
        ...params,
      });
    }
  }
}

export const notificationService = new NotificationService();
