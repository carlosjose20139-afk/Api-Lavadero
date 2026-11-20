-- Migración 007: Configuración global de negocio (business_settings) y bandera loyaltyEnabled
-- Reglas:
-- - Idempotente; no borra ni altera datos existentes.
-- - Valor predeterminado de loyaltyEnabled = true para compatibilidad total.

CREATE TABLE IF NOT EXISTS business_settings (
  id UUID PRIMARY KEY,
  key VARCHAR(100) UNIQUE NOT NULL,
  value_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID NULL REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_business_settings_key
  ON business_settings(key);

INSERT INTO business_settings (id, key, value_json, updated_at, updated_by)
VALUES (
  gen_random_uuid(),
  'loyaltyEnabled',
  'true'::jsonb,
  NOW(),
  NULL
)
ON CONFLICT (key) DO NOTHING;

-- DOWN (reversión documentada para rollback manual si se requiere):
-- DROP INDEX IF EXISTS idx_business_settings_key;
-- DROP TABLE IF EXISTS business_settings;
