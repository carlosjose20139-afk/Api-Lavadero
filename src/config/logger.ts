import pino from 'pino';
import { env } from './env.js';

export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : env.NODE_ENV === 'production' ? 'info' : 'debug',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body.password',
      'req.body.currentPassword',
      'req.body.newPassword',
      'req.body.refreshToken',
      'req.body.token',
      'password',
      'passwordHash',
      'temporaryPassword',
      'accessToken',
      'refreshToken',
      'token',
    ],
    censor: '[REDACTED]',
  },
  base: {
    service: 'los-malditos-api',
    timezone: 'America/Bogota',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});
