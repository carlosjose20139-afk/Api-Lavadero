-- Migración 009: Integridad financiera para cierre transaccional de lavadas con pago manual obligatorio
-- Reglas:
-- - Idempotente y compatible con bases nuevas y existentes.
-- - Conserva todos los pagos, lavadas e ingresos históricos sin borrar datos.
-- - Mantiene la relación directa entre payments, wash_requests, users (cliente y operador) e incomes.
-- - Garantiza a nivel de base de datos que una lavada nunca tenga más de un pago ni más de un ingreso de lavada.

-- 1. Garantizar que payments conserve relación directa con cliente y métodos permitidos (incluyendo Bre-B)
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES users(id);

UPDATE payments p
SET customer_id = wr.customer_id
FROM wash_requests wr
WHERE p.wash_request_id = wr.id
  AND p.customer_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_payments_customer_id
  ON payments(customer_id);

DO $$
DECLARE
  c_name text;
BEGIN
  FOR c_name IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'payments'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) LIKE '%method%'
  LOOP
    EXECUTE format('ALTER TABLE payments DROP CONSTRAINT IF EXISTS %I', c_name);
  END LOOP;
END $$;

ALTER TABLE payments
  ADD CONSTRAINT chk_payments_method
  CHECK (method IN ('Efectivo', 'Nequi', 'Daviplata', 'Bre-B'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_wash_request_id
  ON payments(wash_request_id);

-- 2. Enlazar incomes con payment_id y recorded_by sin afectar registros existentes
ALTER TABLE incomes
  ADD COLUMN IF NOT EXISTS payment_id UUID REFERENCES payments(id),
  ADD COLUMN IF NOT EXISTS recorded_by UUID REFERENCES users(id);

UPDATE incomes i
SET payment_id = COALESCE(i.payment_id, p.id),
    recorded_by = COALESCE(i.recorded_by, p.recorded_by)
FROM payments p
WHERE i.source = 'wash'
  AND i.wash_request_id = p.wash_request_id
  AND (i.payment_id IS NULL OR i.recorded_by IS NULL);

-- 3. Evitar ingresos duplicados para una misma lavada o un mismo pago a nivel de base de datos
CREATE UNIQUE INDEX IF NOT EXISTS uq_incomes_wash_request_id
  ON incomes(wash_request_id)
  WHERE source = 'wash' AND wash_request_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_incomes_payment_id
  ON incomes(payment_id)
  WHERE payment_id IS NOT NULL;

-- 4. Índices financieros para reportes y consultas rápidas
CREATE INDEX IF NOT EXISTS idx_incomes_occurred_at_desc
  ON incomes(occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_incomes_customer_id
  ON incomes(customer_id);

CREATE INDEX IF NOT EXISTS idx_incomes_recorded_by
  ON incomes(recorded_by);

-- ROLLBACK (ejecutar manualmente solo si se requiere revertir esta migración):
-- DROP INDEX IF EXISTS idx_incomes_recorded_by;
-- DROP INDEX IF EXISTS idx_incomes_customer_id;
-- DROP INDEX IF EXISTS idx_incomes_occurred_at_desc;
-- DROP INDEX IF EXISTS uq_incomes_payment_id;
-- DROP INDEX IF EXISTS uq_incomes_wash_request_id;
-- ALTER TABLE incomes DROP COLUMN IF EXISTS recorded_by;
-- ALTER TABLE incomes DROP COLUMN IF EXISTS payment_id;
-- DROP INDEX IF EXISTS idx_payments_customer_id;
-- ALTER TABLE payments DROP COLUMN IF EXISTS customer_id;
-- DELETE FROM schema_migrations WHERE version = '009_wash_completion_financial_integrity.sql';
