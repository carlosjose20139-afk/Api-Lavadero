import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().optional().default(''),
  PGLITE_DATA_DIR: z.string().optional().default('./data/pgdata'),
  JWT_ACCESS_SECRET: z
    .string()
    .min(16)
    .default('los-malditos-dev-access-secret-key-2026'),
  JWT_REFRESH_SECRET: z
    .string()
    .min(16)
    .default('los-malditos-dev-refresh-secret-key-2026'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).optional(),
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(3).max(20).default(5),
  LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().min(1).max(120).default(15),
  CORS_ORIGINS: z.string().default('*'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(900000),
  RATE_LIMIT_MAX: z.coerce.number().int().min(10).default(300),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(5).default(30),
  SHOP_OPEN_HOUR: z.coerce.number().int().min(0).max(23).default(8),
  SHOP_CLOSE_HOUR: z.coerce.number().int().min(1).max(24).default(18),
  SHOP_PARALLEL_BAYS: z.coerce.number().int().min(1).max(50).default(2),
  SHOP_SLOT_STEP_MINUTES: z.coerce.number().int().min(5).max(120).default(30),
  SHOP_OPEN_SUNDAY: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  CANCELLATION_PENALTY_COP: z.coerce.number().int().min(0).default(1000),
  CANCELLATION_MIN_HOURS: z.coerce.number().min(0).default(3),
  EXPIRATION_CHECK_INTERVAL_MS: z.coerce.number().int().min(1000).default(30000),
  LOYALTY_REWARD_VALID_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  LOYALTY_MAX_MANUAL_VALID_DAYS: z.coerce.number().int().min(1).max(365).default(180),
  LOYALTY_QR_TTL_MINUTES: z.coerce.number().int().min(1).max(10080).default(1440),
  FIREBASE_SERVICE_ACCOUNT_JSON: z.string().optional().default(''),
});

const parsed = envSchema.parse(process.env);

export const env = {
  ...parsed,
  BCRYPT_ROUNDS:
    parsed.BCRYPT_ROUNDS ?? (parsed.NODE_ENV === 'test' ? 4 : 12),
  CORS_ORIGIN_LIST:
    parsed.CORS_ORIGINS === '*'
      ? '*'
      : parsed.CORS_ORIGINS.split(',')
          .map((o) => o.trim())
          .filter(Boolean),
};
