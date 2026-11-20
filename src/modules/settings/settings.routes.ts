import { Router } from 'express';
import { z } from 'zod';
import type { DbClient } from '../../db/index.js';
import { createAuthMiddleware } from '../../middleware/auth.js';
import { validateBody } from '../../middleware/validate.js';
import { ok } from '../../utils/response.js';
import {
  isLoyaltyEnabled,
  updateLoyaltyEnabledSetting,
} from './settings.service.js';

const updateLoyaltySettingsSchema = z
  .object({
    loyaltyEnabled: z.boolean({
      message: 'loyaltyEnabled es obligatorio y debe ser booleano (true o false)',
    }),
  })
  .strict();

export function createSettingsRouter(db: DbClient): Router {
  const router = Router();
  const { authenticate, requireRoles } = createAuthMiddleware(db);

  // Endpoint público sin autenticación: expone únicamente banderas públicas seguras
  router.get('/public', async (_req, res, next) => {
    try {
      const loyaltyEnabled = await isLoyaltyEnabled(db);
      return ok(
        res,
        { loyaltyEnabled },
        'Configuración pública consultada exitosamente',
      );
    } catch (err) {
      next(err);
    }
  });

  // Endpoint administrativo: solo Administrador autenticado vía JWT
  router.patch(
    '/loyalty',
    authenticate(),
    requireRoles('Administrador'),
    validateBody(updateLoyaltySettingsSchema),
    async (req, res, next) => {
      try {
        const actor = req.user!;
        const { loyaltyEnabled } = req.body as z.infer<
          typeof updateLoyaltySettingsSchema
        >;

        const updated = await updateLoyaltyEnabledSetting(db, {
          actor,
          loyaltyEnabled,
          ipAddress: req.clientIp,
        });

        return ok(
          res,
          updated,
          'Configuración de Fidelización actualizada exitosamente',
        );
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
