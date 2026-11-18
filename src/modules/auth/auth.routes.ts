import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import type { DbClient } from '../../db/index.js';
import { env } from '../../config/env.js';
import { createAuthMiddleware, getClientIp, type UserRole } from '../../middleware/auth.js';
import { validateBody } from '../../middleware/validate.js';
import { recordAuditLog } from '../../services/audit.service.js';
import {
  generateOpaqueToken,
  hashPassword,
  newUuid,
  sha256,
  verifyPassword,
} from '../../utils/crypto.js';
import { AppError, ok } from '../../utils/response.js';
import { toIsoBogota, toIsoBogotaNullable } from '../../utils/time.js';

const loginSchema = z
  .object({
    username: z.string().trim().min(1, 'El usuario es obligatorio'),
    password: z.string().min(1, 'La contraseña es obligatoria'),
  })
  .strict();

const refreshSchema = z
  .object({
    refreshToken: z.string().min(10, 'El refreshToken es obligatorio'),
  })
  .strict();

const logoutSchema = z
  .object({
    refreshToken: z.string().min(10).optional(),
  })
  .strict()
  .optional();

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'La contraseña actual es obligatoria'),
    newPassword: z
      .string()
      .min(8, 'La nueva contraseña debe tener al menos 8 caracteres')
      .max(128),
  })
  .strict();

function parseExpiresInSeconds(expr: string): number {
  const match = /^(\d+)([smhd])$/.exec(expr.trim());
  if (!match) return 900;
  const val = Number(match[1]);
  const unit = match[2];
  if (unit === 's') return val;
  if (unit === 'm') return val * 60;
  if (unit === 'h') return val * 3600;
  return val * 86400;
}

interface UserRow {
  id: string;
  name: string;
  username: string;
  password_hash: string;
  role: UserRole;
  is_active: boolean;
  must_change_password: boolean;
  failed_login_attempts: number;
  locked_until: Date | string | null;
  terms_accepted_at: Date | string | null;
  created_at: Date | string;
}

function mapUser(row: UserRow) {
  return {
    id: row.id,
    name: row.name,
    username: row.username,
    role: row.role,
    isActive: row.is_active,
    mustChangePassword: row.must_change_password,
    termsAcceptedAt: toIsoBogotaNullable(row.terms_accepted_at),
    createdAt: toIsoBogota(row.created_at),
  };
}

export function createAuthRouter(db: DbClient): Router {
  const router = Router();
  const { authenticate } = createAuthMiddleware(db);
  const accessExpiresSeconds = parseExpiresInSeconds(env.JWT_ACCESS_EXPIRES_IN);

  router.post('/login', validateBody(loginSchema), async (req, res, next) => {
    try {
      const { username, password } = req.body as z.infer<typeof loginSchema>;
      const ip = getClientIp(req);
      const userAgent = req.headers['user-agent'] ?? null;

      const userRes = await db.query<UserRow>(
        `SELECT id, name, username, password_hash, role, is_active, must_change_password,
                failed_login_attempts, locked_until, terms_accepted_at, created_at
         FROM users
         WHERE LOWER(username) = LOWER($1)`,
        [username],
      );

      const user = userRes.rows[0];
      const now = new Date();

      if (user && user.locked_until && new Date(user.locked_until) > now) {
        await verifyPassword(password, null);
        throw new AppError(
          401,
          'INVALID_CREDENTIALS',
          'Credenciales inválidas o acceso temporalmente bloqueado',
        );
      }

      const validPassword = await verifyPassword(
        password,
        user ? user.password_hash : null,
      );

      if (!user || !validPassword || !user.is_active) {
        if (user && !validPassword) {
          const nextAttempts = user.failed_login_attempts + 1;
          const shouldLock = nextAttempts >= env.LOGIN_MAX_ATTEMPTS;
          const lockedUntil = shouldLock
            ? new Date(now.getTime() + env.LOGIN_LOCKOUT_MINUTES * 60 * 1000)
            : null;

          await db.query(
            `UPDATE users
             SET failed_login_attempts = $1, locked_until = $2, updated_at = NOW()
             WHERE id = $3`,
            [nextAttempts, lockedUntil, user.id],
          );

          await recordAuditLog(db, {
            actorId: user.id,
            actorRole: user.role,
            action: shouldLock ? 'login_locked' : 'login_failed',
            entityType: 'user',
            entityId: user.id,
            ipAddress: ip,
            changes: { attempts: nextAttempts },
          });
        }
        throw new AppError(
          401,
          'INVALID_CREDENTIALS',
          'Credenciales inválidas o acceso temporalmente bloqueado',
        );
      }

      const sessionId = newUuid();
      const rawRefreshToken = generateOpaqueToken(36);
      const refreshExpiresAt = new Date(
        now.getTime() + env.JWT_REFRESH_EXPIRES_DAYS * 86400 * 1000,
      );

      await db.withTransaction(async (tx) => {
        await tx.query(
          `UPDATE users
           SET failed_login_attempts = 0, locked_until = NULL, updated_at = NOW()
           WHERE id = $1`,
          [user.id],
        );

        await tx.query(
          `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, ip_address, user_agent)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [sessionId, user.id, sha256(rawRefreshToken), refreshExpiresAt, ip, userAgent],
        );

        await recordAuditLog(tx, {
          actorId: user.id,
          actorRole: user.role,
          action: 'login_success',
          entityType: 'session',
          entityId: sessionId,
          ipAddress: ip,
        });
      });

      const accessToken = jwt.sign(
        { sub: user.id, role: user.role, sid: sessionId, type: 'access' },
        env.JWT_ACCESS_SECRET,
        { expiresIn: accessExpiresSeconds },
      );

      return ok(
        res,
        {
          user: mapUser(user),
          accessToken,
          refreshToken: rawRefreshToken,
          expiresIn: accessExpiresSeconds,
        },
        'Sesión iniciada exitosamente',
      );
    } catch (err) {
      next(err);
    }
  });

  router.post('/refresh', validateBody(refreshSchema), async (req, res, next) => {
    try {
      const { refreshToken } = req.body as z.infer<typeof refreshSchema>;
      const ip = getClientIp(req);
      const userAgent = req.headers['user-agent'] ?? null;
      const tokenHash = sha256(refreshToken);

      const session = await db.withTransaction(async (tx) => {
        const tokenRes = await tx.query<{
          id: string;
          user_id: string;
          expires_at: Date | string;
          revoked_at: Date | string | null;
        }>(
          `SELECT id, user_id, expires_at, revoked_at
           FROM refresh_tokens
           WHERE token_hash = $1
           FOR UPDATE`,
          [tokenHash],
        );

        const existing = tokenRes.rows[0];
        if (
          !existing ||
          existing.revoked_at !== null ||
          new Date(existing.expires_at) <= new Date()
        ) {
          throw new AppError(
            401,
            'INVALID_REFRESH_TOKEN',
            'El refresh token es inválido, fue revocado o expiró',
          );
        }

        const userRes = await tx.query<UserRow>(
          `SELECT id, name, username, password_hash, role, is_active, must_change_password,
                  failed_login_attempts, locked_until, terms_accepted_at, created_at
           FROM users
           WHERE id = $1`,
          [existing.user_id],
        );
        const user = userRes.rows[0];
        if (!user || !user.is_active) {
          throw new AppError(401, 'ACCOUNT_INACTIVE', 'La cuenta no está activa');
        }

        // Rotación de refresh token: revocar anterior y emitir nuevo
        await tx.query(
          `UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1`,
          [existing.id],
        );

        const newSessionId = newUuid();
        const newRawRefresh = generateOpaqueToken(36);
        const refreshExpiresAt = new Date(
          Date.now() + env.JWT_REFRESH_EXPIRES_DAYS * 86400 * 1000,
        );

        await tx.query(
          `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, ip_address, user_agent)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            newSessionId,
            user.id,
            sha256(newRawRefresh),
            refreshExpiresAt,
            ip,
            userAgent,
          ],
        );

        const accessToken = jwt.sign(
          { sub: user.id, role: user.role, sid: newSessionId, type: 'access' },
          env.JWT_ACCESS_SECRET,
          { expiresIn: accessExpiresSeconds },
        );

        return {
          user: mapUser(user),
          accessToken,
          refreshToken: newRawRefresh,
          expiresIn: accessExpiresSeconds,
        };
      });

      return ok(res, session, 'Sesión renovada exitosamente');
    } catch (err) {
      next(err);
    }
  });

  router.post(
    '/logout',
    authenticate({ allowDuringPasswordChange: true }),
    validateBody(logoutSchema),
    async (req, res, next) => {
      try {
        const user = req.user!;
        const body = req.body as { refreshToken?: string } | undefined;

        await db.withTransaction(async (tx) => {
          await tx.query(
            `UPDATE refresh_tokens
             SET revoked_at = NOW()
             WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
            [user.sessionId, user.id],
          );

          if (body?.refreshToken) {
            await tx.query(
              `UPDATE refresh_tokens
               SET revoked_at = NOW()
               WHERE token_hash = $1 AND user_id = $2 AND revoked_at IS NULL`,
              [sha256(body.refreshToken), user.id],
            );
          }

          await recordAuditLog(tx, {
            actorId: user.id,
            actorRole: user.role,
            action: 'logout',
            entityType: 'session',
            entityId: user.sessionId,
            ipAddress: req.clientIp,
          });
        });

        return ok(res, null, 'Sesión cerrada exitosamente');
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/change-password',
    authenticate({ allowDuringPasswordChange: true }),
    validateBody(changePasswordSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { currentPassword, newPassword } = req.body as z.infer<
          typeof changePasswordSchema
        >;

        if (currentPassword === newPassword) {
          throw new AppError(
            422,
            'VALIDATION_ERROR',
            'La nueva contraseña debe ser diferente a la contraseña actual',
            { newPassword: 'Debe ser distinta a la actual' },
          );
        }

        const userRes = await db.query<{ password_hash: string }>(
          `SELECT password_hash FROM users WHERE id = $1`,
          [actor.id],
        );
        const row = userRes.rows[0];
        if (!row || !(await verifyPassword(currentPassword, row.password_hash))) {
          throw new AppError(
            422,
            'INVALID_CURRENT_PASSWORD',
            'La contraseña actual es incorrecta',
            { currentPassword: 'Contraseña incorrecta' },
          );
        }

        const newHash = await hashPassword(newPassword);

        await db.withTransaction(async (tx) => {
          await tx.query(
            `UPDATE users
             SET password_hash = $1, must_change_password = FALSE, updated_at = NOW()
             WHERE id = $2`,
            [newHash, actor.id],
          );

          await recordAuditLog(tx, {
            actorId: actor.id,
            actorRole: actor.role,
            action: 'password_changed',
            entityType: 'user',
            entityId: actor.id,
            ipAddress: req.clientIp,
            changes: { mustChangePassword: false },
          });
        });

        return ok(res, null, 'Contraseña actualizada exitosamente');
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
