-- Migración 006: Ciclo completo de Fidelización 7+1, trazabilidad de sellos, recompensas y auditoría
-- Reglas:
-- - Conserva tablas e historial existentes sin duplicar estructuras ni borrar datos.
-- - Asegura idempotencia en re-ejecución.

-- 1. Extensión de loyalty_cards: id, created_at y expiración de qr_token
ALTER TABLE loyalty_cards
  ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS qr_token_expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours');

UPDATE loyalty_cards
SET id = gen_random_uuid()
WHERE id IS NULL;

ALTER TABLE loyalty_cards
  ALTER COLUMN id SET NOT NULL,
  ALTER COLUMN id SET DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX IF NOT EXISTS idx_loyalty_cards_id
  ON loyalty_cards(id);

-- 2. Extensión de loyalty_stamps: tarjeta, actor, estado active/reversed, motivo y reversión
ALTER TABLE loyalty_stamps
  ADD COLUMN IF NOT EXISTS loyalty_card_id UUID REFERENCES loyalty_cards(id),
  ADD COLUMN IF NOT EXISTS actor_id UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS reason TEXT,
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reversed_by UUID REFERENCES users(id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'loyalty_stamps_status_check'
  ) THEN
    ALTER TABLE loyalty_stamps
      ADD CONSTRAINT loyalty_stamps_status_check CHECK (status IN ('active', 'reversed'));
  END IF;
END $$;

-- Backfill de loyalty_card_id y actor_id para sellos previos a la migración 006
INSERT INTO loyalty_cards (id, customer_id, stamps, completed_washes, qr_token, qr_token_expires_at)
SELECT DISTINCT
  gen_random_uuid(),
  ls.customer_id,
  0,
  0,
  'LM-LEGACY-' || REPLACE(ls.customer_id::text, '-', ''),
  NOW() + INTERVAL '24 hours'
FROM loyalty_stamps ls
WHERE NOT EXISTS (
  SELECT 1 FROM loyalty_cards lc WHERE lc.customer_id = ls.customer_id
)
ON CONFLICT (customer_id) DO NOTHING;

UPDATE loyalty_stamps ls
SET loyalty_card_id = lc.id
FROM loyalty_cards lc
WHERE lc.customer_id = ls.customer_id
  AND ls.loyalty_card_id IS NULL;

UPDATE loyalty_stamps
SET actor_id = granted_by
WHERE actor_id IS NULL
  AND granted_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_loyalty_stamps_customer_created
  ON loyalty_stamps(customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_loyalty_stamps_card_id
  ON loyalty_stamps(loyalty_card_id);

CREATE INDEX IF NOT EXISTS idx_loyalty_stamps_status
  ON loyalty_stamps(status);

-- 3. Extensión de loyalty_rewards: estado cancelled, origen automatic/manual, sello origen, auditoría y cancelación
DO $$
DECLARE
  c_name text;
BEGIN
  FOR c_name IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'loyalty_rewards'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) LIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE loyalty_rewards DROP CONSTRAINT IF EXISTS %I', c_name);
  END LOOP;
END $$;

ALTER TABLE loyalty_rewards
  ADD CONSTRAINT loyalty_rewards_status_check
  CHECK (status IN ('available', 'redeemed', 'expired', 'cancelled'));

ALTER TABLE loyalty_rewards
  ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'automatic',
  ADD COLUMN IF NOT EXISTS source_stamp_id UUID REFERENCES loyalty_stamps(id),
  ADD COLUMN IF NOT EXISTS appointment_id UUID REFERENCES appointments(id),
  ADD COLUMN IF NOT EXISTS reason TEXT,
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS redeemed_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'loyalty_rewards_source_check'
  ) THEN
    ALTER TABLE loyalty_rewards
      ADD CONSTRAINT loyalty_rewards_source_check CHECK (source IN ('automatic', 'manual'));
  END IF;
END $$;

UPDATE loyalty_rewards
SET appointment_id = COALESCE(appointment_id, redeemed_appointment_id),
    updated_at = COALESCE(updated_at, redeemed_at, created_at)
WHERE appointment_id IS NULL AND redeemed_appointment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_loyalty_rewards_customer_status
  ON loyalty_rewards(customer_id, status);

CREATE INDEX IF NOT EXISTS idx_loyalty_rewards_status_valid_until
  ON loyalty_rewards(status, valid_until);

CREATE INDEX IF NOT EXISTS idx_loyalty_rewards_source_stamp
  ON loyalty_rewards(source_stamp_id);

-- 4. Tabla dedicada de auditoría de Fidelización (complementa audit_logs para consultas rápidas por cliente)
CREATE TABLE IF NOT EXISTS loyalty_audits (
  id UUID PRIMARY KEY,
  customer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES users(id),
  actor_role VARCHAR(20),
  actor_name VARCHAR(120),
  action VARCHAR(60) NOT NULL CHECK (
    action IN (
      'loyalty_stamp_created',
      'loyalty_stamp_reversed',
      'loyalty_reward_created',
      'loyalty_reward_redeemed',
      'loyalty_reward_cancelled',
      'loyalty_reward_expired',
      'loyalty_reward_moderated'
    )
  ),
  target_id UUID,
  target_type VARCHAR(40) NOT NULL CHECK (
    target_type IN ('loyalty_stamp', 'loyalty_reward', 'loyalty_card')
  ),
  before_state JSONB,
  after_state JSONB,
  reason TEXT,
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loyalty_audits_customer_created
  ON loyalty_audits(customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_loyalty_audits_action
  ON loyalty_audits(action, created_at DESC);

-- DOWN (reversión documentada para rollback manual si se requiere):
-- DROP INDEX IF EXISTS idx_loyalty_audits_action;
-- DROP INDEX IF EXISTS idx_loyalty_audits_customer_created;
-- DROP TABLE IF EXISTS loyalty_audits;
-- DROP INDEX IF EXISTS idx_loyalty_rewards_source_stamp;
-- DROP INDEX IF EXISTS idx_loyalty_rewards_status_valid_until;
-- DROP INDEX IF EXISTS idx_loyalty_rewards_customer_status;
-- ALTER TABLE loyalty_rewards DROP CONSTRAINT IF EXISTS loyalty_rewards_source_check;
-- ALTER TABLE loyalty_rewards DROP COLUMN IF EXISTS updated_at, DROP COLUMN IF EXISTS cancelled_by, DROP COLUMN IF EXISTS cancelled_at, DROP COLUMN IF EXISTS redeemed_by, DROP COLUMN IF EXISTS created_by, DROP COLUMN IF EXISTS reason, DROP COLUMN IF EXISTS appointment_id, DROP COLUMN IF EXISTS source_stamp_id, DROP COLUMN IF EXISTS source;
-- DROP INDEX IF EXISTS idx_loyalty_stamps_status;
-- DROP INDEX IF EXISTS idx_loyalty_stamps_card_id;
-- DROP INDEX IF EXISTS idx_loyalty_stamps_customer_created;
-- ALTER TABLE loyalty_stamps DROP CONSTRAINT IF EXISTS loyalty_stamps_status_check;
-- ALTER TABLE loyalty_stamps DROP COLUMN IF EXISTS reversed_by, DROP COLUMN IF EXISTS reversed_at, DROP COLUMN IF EXISTS reason, DROP COLUMN IF EXISTS status, DROP COLUMN IF EXISTS actor_id, DROP COLUMN IF EXISTS loyalty_card_id;
-- DROP INDEX IF EXISTS idx_loyalty_cards_id;
-- ALTER TABLE loyalty_cards DROP COLUMN IF EXISTS qr_token_expires_at, DROP COLUMN IF EXISTS created_at, DROP COLUMN IF EXISTS id;
