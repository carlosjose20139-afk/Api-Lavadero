-- Migración 008: Pagos manuales completos con soporte Bre-B, restricción de monto > 0, índices y prevención de duplicados
-- Reglas:
-- - Idempotente y compatible con bases nuevas y existentes.
-- - Conserva todos los pagos históricos sin borrar datos.
-- - Acepta los métodos manuales: Efectivo, Nequi, Daviplata y Bre-B (sin pasarelas de pago).

-- 1. Garantizar existencia de la tabla payments si no existiera
CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY,
  wash_request_id UUID NOT NULL UNIQUE REFERENCES wash_requests(id),
  method VARCHAR(20) NOT NULL,
  amount INTEGER NOT NULL,
  reference VARCHAR(120),
  employee_commission INTEGER NOT NULL DEFAULT 0 CHECK (employee_commission >= 0),
  recorded_by UUID REFERENCES users(id),
  paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Garantizar columnas necesarias en tablas existentes sin pérdida de datos
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS reference VARCHAR(120),
  ADD COLUMN IF NOT EXISTS employee_commission INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recorded_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- 3. Actualizar restricción CHECK de method para incluir 'Bre-B' manteniendo Efectivo, Nequi y Daviplata
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

-- 4. Actualizar restricción CHECK de amount para exigir monto entero estrictamente mayor a 0 en nuevos registros
DO $$
DECLARE
  c_name text;
  has_non_positive boolean;
BEGIN
  FOR c_name IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'payments'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) LIKE '%amount%'
  LOOP
    EXECUTE format('ALTER TABLE payments DROP CONSTRAINT IF EXISTS %I', c_name);
  END LOOP;

  SELECT EXISTS (SELECT 1 FROM payments WHERE amount <= 0) INTO has_non_positive;
  IF has_non_positive THEN
    ALTER TABLE payments
      ADD CONSTRAINT chk_payments_amount CHECK (amount > 0) NOT VALID;
  ELSE
    ALTER TABLE payments
      ADD CONSTRAINT chk_payments_amount CHECK (amount > 0);
  END IF;
END $$;

-- 5. Garantizar unicidad por wash_request_id para evitar pagos duplicados sobre una misma lavada
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_wash_request_id
  ON payments(wash_request_id);

-- 6. Índices operativos para consultas paginadas y filtros en GET /api/v1/payments
CREATE INDEX IF NOT EXISTS idx_payments_paid_at_desc
  ON payments(paid_at DESC);

CREATE INDEX IF NOT EXISTS idx_payments_method
  ON payments(method);

CREATE INDEX IF NOT EXISTS idx_payments_recorded_by
  ON payments(recorded_by);

CREATE INDEX IF NOT EXISTS idx_payments_method_paid_at
  ON payments(method, paid_at DESC);

-- ROLLBACK (ejecutar manualmente solo si se requiere revertir esta migración;
-- verificar antes que no existan pagos con method = 'Bre-B'):
-- DROP INDEX IF EXISTS idx_payments_method_paid_at;
-- DROP INDEX IF EXISTS idx_payments_recorded_by;
-- DROP INDEX IF EXISTS idx_payments_method;
-- DROP INDEX IF EXISTS idx_payments_paid_at_desc;
-- DROP INDEX IF EXISTS uq_payments_wash_request_id;
-- ALTER TABLE payments DROP CONSTRAINT IF EXISTS chk_payments_method;
-- ALTER TABLE payments ADD CONSTRAINT payments_method_check CHECK (method IN ('Efectivo', 'Nequi', 'Daviplata'));
-- ALTER TABLE payments DROP CONSTRAINT IF EXISTS chk_payments_amount;
-- ALTER TABLE payments ADD CONSTRAINT payments_amount_check CHECK (amount >= 0);
-- DELETE FROM schema_migrations WHERE version = '008_payments_breb_and_indexes.sql';
