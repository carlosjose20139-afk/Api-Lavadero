-- Configuración operativa inicial del lavadero Los Malditos
INSERT INTO shop_settings (id, open_hour, close_hour, parallel_bays, slot_step_minutes, open_sunday)
VALUES (1, 8, 18, 2, 30, FALSE)
ON CONFLICT (id) DO NOTHING;
