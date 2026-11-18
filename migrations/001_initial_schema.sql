-- Migración inicial: Esquema completo de Los Malditos API (PostgreSQL 16+)
-- Moneda: COP | Zona horaria de negocio: America/Bogota

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  username VARCHAR(40) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('Cliente', 'Lavador', 'Administrador')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT,
  pending_balance INTEGER NOT NULL DEFAULT 0 CHECK (pending_balance >= 0),
  failed_login_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_attempts >= 0),
  locked_until TIMESTAMPTZ,
  terms_accepted_at TIMESTAMPTZ,
  privacy_policy_version VARCHAR(20),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);

-- Motos: estrictamente marca, modelo, cilindraje, apodo y color opcional (sin placa).
CREATE TABLE IF NOT EXISTS motorcycles (
  id UUID PRIMARY KEY,
  customer_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  brand VARCHAR(80) NOT NULL,
  model VARCHAR(80) NOT NULL,
  cc INTEGER NOT NULL CHECK (cc >= 1),
  nickname VARCHAR(80),
  color VARCHAR(40),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_motorcycles_customer_id ON motorcycles(customer_id);

CREATE TABLE IF NOT EXISTS services (
  id UUID PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price INTEGER NOT NULL CHECK (price >= 0),
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes >= 1),
  surcharge_from_cc INTEGER CHECK (surcharge_from_cc IS NULL OR surcharge_from_cc >= 1),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS shop_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  open_hour INTEGER NOT NULL DEFAULT 8 CHECK (open_hour >= 0 AND open_hour <= 23),
  close_hour INTEGER NOT NULL DEFAULT 18 CHECK (close_hour >= 1 AND close_hour <= 24),
  parallel_bays INTEGER NOT NULL DEFAULT 2 CHECK (parallel_bays >= 1),
  slot_step_minutes INTEGER NOT NULL DEFAULT 30 CHECK (slot_step_minutes >= 5),
  open_sunday BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS blocked_dates (
  id UUID PRIMARY KEY,
  blocked_date DATE NOT NULL UNIQUE,
  reason TEXT NOT NULL,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS employees (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  name VARCHAR(120) NOT NULL,
  role VARCHAR(30) NOT NULL CHECK (role IN ('Lavador')),
  commission_percent NUMERIC(5,2) NOT NULL CHECK (commission_percent >= 0 AND commission_percent <= 100),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS loyalty_cards (
  customer_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  stamps INTEGER NOT NULL DEFAULT 0 CHECK (stamps >= 0 AND stamps <= 7),
  completed_washes INTEGER NOT NULL DEFAULT 0 CHECK (completed_washes >= 0),
  qr_token VARCHAR(120) NOT NULL UNIQUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS appointments (
  id UUID PRIMARY KEY,
  customer_id UUID NOT NULL REFERENCES users(id),
  motorcycle_id UUID NOT NULL REFERENCES motorcycles(id),
  service_id UUID NOT NULL REFERENCES services(id),
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  notes TEXT,
  is_loyalty_redemption BOOLEAN NOT NULL DEFAULT FALSE,
  loyalty_reward_id UUID,
  status VARCHAR(20) NOT NULL CHECK (status IN ('scheduled', 'confirmed', 'completed', 'cancelled', 'waitlisted')),
  cancellation_reason TEXT,
  cancellation_fee INTEGER NOT NULL DEFAULT 0 CHECK (cancellation_fee >= 0),
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_appointments_start_at ON appointments(start_at);
CREATE INDEX IF NOT EXISTS idx_appointments_customer_id ON appointments(customer_id);
CREATE INDEX IF NOT EXISTS idx_appointments_motorcycle_id ON appointments(motorcycle_id);

CREATE TABLE IF NOT EXISTS loyalty_rewards (
  id UUID PRIMARY KEY,
  customer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(160) NOT NULL,
  valid_from TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('available', 'redeemed', 'expired')),
  redeemed_appointment_id UUID REFERENCES appointments(id),
  redeemed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loyalty_rewards_customer_id ON loyalty_rewards(customer_id);

CREATE TABLE IF NOT EXISTS wash_requests (
  id UUID PRIMARY KEY,
  customer_id UUID NOT NULL REFERENCES users(id),
  motorcycle_id UUID NOT NULL REFERENCES motorcycles(id),
  service_id UUID NOT NULL REFERENCES services(id),
  appointment_id UUID REFERENCES appointments(id),
  employee_id UUID REFERENCES employees(id),
  base_price INTEGER NOT NULL CHECK (base_price >= 0),
  applied_pending_balance INTEGER NOT NULL DEFAULT 0 CHECK (applied_pending_balance >= 0),
  price INTEGER NOT NULL CHECK (price >= 0),
  scheduled_at TIMESTAMPTZ,
  expires_in_minutes INTEGER NOT NULL DEFAULT 15 CHECK (expires_in_minutes >= 1),
  expires_at TIMESTAMPTZ NOT NULL,
  status VARCHAR(30) NOT NULL CHECK (
    status IN (
      'pending_confirmation',
      'confirmed',
      'rejected',
      'expired',
      'washing',
      'drying',
      'ready',
      'paid',
      'cancelled'
    )
  ),
  rejection_reason VARCHAR(500),
  before_photo_url TEXT,
  after_photo_url TEXT,
  confirmed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wash_requests_status_expires ON wash_requests(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_wash_requests_customer_id ON wash_requests(customer_id);
CREATE INDEX IF NOT EXISTS idx_wash_requests_created_at ON wash_requests(created_at);

CREATE TABLE IF NOT EXISTS wash_request_audits (
  id UUID PRIMARY KEY,
  wash_request_id UUID NOT NULL REFERENCES wash_requests(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES users(id),
  actor_name VARCHAR(120) NOT NULL,
  action VARCHAR(50) NOT NULL,
  previous_content TEXT,
  new_content TEXT,
  ip_address TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wash_request_audits_wr ON wash_request_audits(wash_request_id, occurred_at);

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(200) NOT NULL,
  body TEXT NOT NULL,
  type VARCHAR(60) NOT NULL,
  deep_link TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, is_read, created_at DESC);

CREATE TABLE IF NOT EXISTS device_tokens (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  platform VARCHAR(10) NOT NULL CHECK (platform IN ('android', 'ios', 'web')),
  is_valid BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_device_tokens_user_valid ON device_tokens(user_id, is_valid);

CREATE TABLE IF NOT EXISTS loyalty_stamps (
  id UUID PRIMARY KEY,
  customer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wash_request_id UUID NOT NULL UNIQUE REFERENCES wash_requests(id),
  granted_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY,
  wash_request_id UUID NOT NULL UNIQUE REFERENCES wash_requests(id),
  method VARCHAR(20) NOT NULL CHECK (method IN ('Efectivo', 'Nequi', 'Daviplata')),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  reference VARCHAR(120),
  employee_commission INTEGER NOT NULL DEFAULT 0 CHECK (employee_commission >= 0),
  recorded_by UUID REFERENCES users(id),
  paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS expenses (
  id UUID PRIMARY KEY,
  category VARCHAR(30) NOT NULL CHECK (category IN ('Agua', 'Jabon', 'Luz', 'Nomina', 'Guantes', 'Paños', 'Otro')),
  description TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount >= 0),
  occurred_at TIMESTAMPTZ NOT NULL,
  is_recurring BOOLEAN NOT NULL DEFAULT FALSE,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS incomes (
  id UUID PRIMARY KEY,
  source VARCHAR(30) NOT NULL CHECK (source IN ('wash', 'cancellation_fee', 'other')),
  wash_request_id UUID REFERENCES wash_requests(id),
  appointment_id UUID REFERENCES appointments(id),
  customer_id UUID REFERENCES users(id),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  status VARCHAR(20) NOT NULL DEFAULT 'confirmed' CHECK (status IN ('pending', 'confirmed', 'settled')),
  notes TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inventory_items (
  id UUID PRIMARY KEY,
  name VARCHAR(120) NOT NULL UNIQUE,
  unit VARCHAR(20) NOT NULL CHECK (unit IN ('unidad', 'litro', 'kilogramo', 'paquete')),
  current_stock NUMERIC(12,2) NOT NULL CHECK (current_stock >= 0),
  minimum_stock NUMERIC(12,2) NOT NULL CHECK (minimum_stock >= 0),
  estimated_use_per_wash NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (estimated_use_per_wash >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id UUID PRIMARY KEY,
  item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  type VARCHAR(20) NOT NULL CHECK (type IN ('in', 'out', 'adjustment')),
  quantity NUMERIC(12,2) NOT NULL CHECK (quantity >= 0),
  previous_stock NUMERIC(12,2) NOT NULL,
  new_stock NUMERIC(12,2) NOT NULL,
  reason TEXT,
  actor_id UUID REFERENCES users(id),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS promotions (
  id UUID PRIMARY KEY,
  title VARCHAR(160) NOT NULL,
  description TEXT NOT NULL,
  discount_amount INTEGER CHECK (discount_amount IS NULL OR discount_amount >= 0),
  discount_percent NUMERIC(5,2) CHECK (discount_percent IS NULL OR (discount_percent >= 0 AND discount_percent <= 100)),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reviews (
  id UUID PRIMARY KEY,
  customer_id UUID NOT NULL REFERENCES users(id),
  wash_request_id UUID NOT NULL UNIQUE REFERENCES wash_requests(id),
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comment VARCHAR(1000) NOT NULL,
  admin_reply TEXT,
  is_visible BOOLEAN NOT NULL DEFAULT TRUE,
  moderated_by UUID REFERENCES users(id),
  moderated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS forum_posts (
  id UUID PRIMARY KEY,
  parent_id UUID REFERENCES forum_posts(id),
  author_id UUID NOT NULL REFERENCES users(id),
  title VARCHAR(160) NOT NULL DEFAULT '',
  content VARCHAR(5000) NOT NULL,
  edited_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_forum_posts_parent_id ON forum_posts(parent_id);

-- Auditoría inmutable del foro: nunca se eliminan registros aunque se borre una publicación
CREATE TABLE IF NOT EXISTS forum_audits (
  id UUID PRIMARY KEY,
  post_id UUID NOT NULL,
  actor_id UUID NOT NULL REFERENCES users(id),
  actor_name VARCHAR(120) NOT NULL,
  action VARCHAR(20) NOT NULL CHECK (action IN ('created', 'edited', 'deleted', 'moderated')),
  previous_content TEXT,
  new_content TEXT,
  ip_address TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_forum_audits_actor_action ON forum_audits(actor_id, action, occurred_at DESC);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  idempotency_key VARCHAR(100) NOT NULL,
  actor_id UUID NOT NULL,
  method VARCHAR(10) NOT NULL,
  path TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response_body JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (idempotency_key, actor_id, method, path)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY,
  actor_id UUID,
  actor_role VARCHAR(20),
  action VARCHAR(80) NOT NULL,
  entity_type VARCHAR(60) NOT NULL,
  entity_id TEXT,
  ip_address TEXT,
  changes JSONB,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_occurred_at ON audit_logs(occurred_at DESC);

CREATE TABLE IF NOT EXISTS data_management_requests (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  request_type VARCHAR(30) NOT NULL CHECK (request_type IN ('access', 'rectification', 'deletion', 'revocation')),
  details TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_review', 'resolved', 'rejected')),
  admin_notes TEXT,
  resolved_by UUID REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
