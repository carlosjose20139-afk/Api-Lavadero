-- Migración 003: Desacoplamiento de motos y clientes + historial de asociaciones
-- Reglas:
-- - Una moto es un registro independiente (customer_id nullable).
-- - Desvincular nunca elimina la moto ni sus citas/lavadas/pagos/reseñas/fidelización.
-- - Conserva historial completo en motorcycle_customer_assignments.

ALTER TABLE motorcycles
  ALTER COLUMN customer_id DROP NOT NULL;

CREATE TABLE IF NOT EXISTS motorcycle_customer_assignments (
  id UUID PRIMARY KEY,
  motorcycle_id UUID NOT NULL REFERENCES motorcycles(id) ON DELETE RESTRICT,
  customer_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(20) NOT NULL CHECK (action IN ('assigned', 'unassigned', 'reassigned')),
  performed_by UUID NOT NULL REFERENCES users(id),
  previous_customer_id UUID REFERENCES users(id) ON DELETE SET NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_motorcycles_customer_id
  ON motorcycles(customer_id);

CREATE INDEX IF NOT EXISTS idx_motorcycle_assignments_motorcycle_id
  ON motorcycle_customer_assignments(motorcycle_id);

CREATE INDEX IF NOT EXISTS idx_motorcycle_assignments_customer_id
  ON motorcycle_customer_assignments(customer_id);

-- Backfill idempotente para motos existentes que ya tengan cliente asociado
INSERT INTO motorcycle_customer_assignments (
  id,
  motorcycle_id,
  customer_id,
  action,
  performed_by,
  previous_customer_id,
  occurred_at,
  reason
)
SELECT
  gen_random_uuid(),
  m.id,
  m.customer_id,
  'assigned',
  COALESCE(
    (SELECT u.id FROM users u WHERE u.role = 'Administrador' ORDER BY u.created_at ASC LIMIT 1),
    m.customer_id
  ),
  NULL,
  m.created_at,
  'Migración inicial de asociación existente'
FROM motorcycles m
WHERE m.customer_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM motorcycle_customer_assignments a
    WHERE a.motorcycle_id = m.id
  );
