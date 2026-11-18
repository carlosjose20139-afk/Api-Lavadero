import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { DbClient } from '../db/index.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/response.js';

export type UserRole = 'Cliente' | 'Lavador' | 'Administrador';

export interface AuthUser {
  id: string;
  name: string;
  username: string;
  role: UserRole;
  sessionId: string;
  mustChangePassword: boolean;
}

export interface AccessTokenPayload {
  sub: string;
  role: UserRole;
  sid: string;
  type: 'access';
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      clientIp?: string;
    }
  }
}

export function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0]!.trim();
  }
  return req.ip || req.socket.remoteAddress || '0.0.0.0';
}

export function createAuthMiddleware(db: DbClient) {
  async function resolveUserFromHeader(authHeader?: string): Promise<AuthUser | null> {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return null;
    }
    const token = authHeader.slice(7).trim();
    if (!token) {
      return null;
    }

    let payload: AccessTokenPayload;
    try {
      payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
    } catch {
      throw new AppError(401, 'INVALID_TOKEN', 'El token de acceso es inválido o expiró');
    }

    if (payload.type !== 'access' || !payload.sub || !payload.sid) {
      throw new AppError(401, 'INVALID_TOKEN', 'Token de acceso malformado');
    }

    const sessionRes = await db.query<{
      revoked_at: Date | string | null;
      expires_at: Date | string;
      user_id: string;
      name: string;
      username: string;
      role: UserRole;
      is_active: boolean;
      must_change_password: boolean;
    }>(
      `SELECT rt.revoked_at, rt.expires_at, u.id AS user_id, u.name, u.username,
              u.role, u.is_active, u.must_change_password
       FROM refresh_tokens rt
       INNER JOIN users u ON u.id = rt.user_id
       WHERE rt.id = $1 AND rt.user_id = $2`,
      [payload.sid, payload.sub],
    );

    const row = sessionRes.rows[0];
    if (!row || row.revoked_at !== null || new Date(row.expires_at) <= new Date()) {
      throw new AppError(
        401,
        'SESSION_REVOKED',
        'La sesión fue cerrada o expiró. Inicia sesión nuevamente',
      );
    }

    if (!row.is_active) {
      throw new AppError(
        403,
        'ACCOUNT_BLOCKED',
        'Tu cuenta se encuentra bloqueada. Contacta al administrador',
      );
    }

    return {
      id: row.user_id,
      name: row.name,
      username: row.username,
      role: row.role,
      sessionId: payload.sid,
      mustChangePassword: row.must_change_password,
    };
  }

  function authenticate(options?: { allowDuringPasswordChange?: boolean }) {
    return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
      try {
        const user = await resolveUserFromHeader(req.headers.authorization);
        if (!user) {
          throw new AppError(401, 'UNAUTHORIZED', 'Se requiere autenticación Bearer JWT');
        }
        if (user.mustChangePassword && !options?.allowDuringPasswordChange) {
          throw new AppError(
            403,
            'PASSWORD_CHANGE_REQUIRED',
            'Debes cambiar tu contraseña temporal antes de continuar',
          );
        }
        req.user = user;
        req.clientIp = getClientIp(req);
        next();
      } catch (err) {
        next(err);
      }
    };
  }

  function optionalAuthenticate() {
    return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
      try {
        if (req.headers.authorization) {
          const user = await resolveUserFromHeader(req.headers.authorization);
          if (user) {
            req.user = user;
          }
        }
        req.clientIp = getClientIp(req);
        next();
      } catch {
        // En rutas públicas ignoramos tokens expirados si no se requiere autenticación obligatoria
        next();
      }
    };
  }

  function requireRoles(...roles: UserRole[]) {
    return (req: Request, _res: Response, next: NextFunction): void => {
      if (!req.user) {
        next(new AppError(401, 'UNAUTHORIZED', 'Se requiere autenticación'));
        return;
      }
      if (!roles.includes(req.user.role)) {
        next(
          new AppError(
            403,
            'FORBIDDEN',
            'No tienes permisos suficientes para realizar esta operación',
          ),
        );
        return;
      }
      next();
    };
  }

  return {
    authenticate,
    optionalAuthenticate,
    requireRoles,
  };
}
