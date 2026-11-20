-- Migración 004: Ciclo de vida completo de promociones (edición, estado, borrado lógico e índices)
-- Reglas:
-- - Agrega deleted_at para borrado lógico sin eliminar auditoría ni registros relacionados.
-- - Agrega updated_at si no existe y conserva created_at.
-- - Crea índices para is_active, starts_at, ends_at y deleted_at.
-- - No elimina ni altera datos existentes.

ALTER TABLE promotions
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

UPDATE promotions
SET updated_at = COALESCE(updated_at, created_at, NOW())
WHERE updated_at IS NULL;

ALTER TABLE promotions
  ALTER COLUMN updated_at SET DEFAULT NOW(),
  ALTER COLUMN updated_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_promotions_is_active
  ON promotions(is_active);

CREATE INDEX IF NOT EXISTS idx_promotions_starts_at
  ON promotions(starts_at);

CREATE INDEX IF NOT EXISTS idx_promotions_ends_at
  ON promotions(ends_at);

CREATE INDEX IF NOT EXISTS idx_promotions_deleted_at
  ON promotions(deleted_at);

CREATE INDEX IF NOT EXISTS idx_promotions_active_window
  ON promotions(is_active, starts_at, ends_at)
  WHERE deleted_at IS NULL;

-- DOWN (reversión documentada para rollback manual si se requiere):
-- DROP INDEX IF EXISTS idx_promotions_active_window;
-- DROP INDEX IF EXISTS idx_promotions_deleted_at;
-- DROP INDEX IF EXISTS idx_promotions_ends_at;
-- DROP INDEX IF EXISTS idx_promotions_starts_at;
-- DROP INDEX IF EXISTS idx_promotions_is_active;
-- ALTER TABLE promotions DROP COLUMN IF EXISTS deleted_at;
-- ALTER TABLE promotions DROP COLUMN IF EXISTS updated_at;
