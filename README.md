# Los Malditos — Backend REST API (`/api/v1`)

Backend productivo en **Node.js 22 + TypeScript + Express + PostgreSQL** para el lavadero de motos **Los Malditos** en Colombia. Implementa estrictamente el contrato `docs/api/openapi.yaml`, opera en moneda **COP** y zona horaria **America/Bogota** (ISO-8601), sin pasarelas de pago, sin servicio a domicilio y con minimización de datos conforme a la **Ley 1581 de 2012**.

---

## Elección del stack y arquitectura

- **Node.js 22 + TypeScript + Express**: arranque rápido, tipado estricto de punta a punta, validación de entrada con **Zod** (`.strict()` para rechazar campos prohibidos como teléfono, correo, cédula o placa) y soporte nativo de streaming para reportes (`csv`, `xlsx`, `pdf`).
- **PostgreSQL 16 (con `pg` Pool en producción/Docker y respaldo embebido `PGlite` para desarrollo sin demonio externo)**: ejecuta el mismo DDL SQL (`migrations/*.sql`), transacciones `BEGIN/COMMIT`, bloqueos `FOR UPDATE` y tipos `UUID`/`TIMESTAMPTZ`/`JSONB` en todos los entornos.
- **Seguridad**: contraseñas con `bcryptjs` (coste 12 en producción), JWT de corta duración + refresh tokens opacos revocables en base de datos, bloqueo temporal tras intentos fallidos sin enumeración de usuarios, `helmet`, `cors`, `express-rate-limit`, `X-Idempotency-Key` transaccional y logs estructurados con `pino` con redacción de credenciales.

### Estructura modular

- `migrations/`: migraciones SQL idempotentes (`001_initial_schema.sql`, `002_seed_shop_defaults.sql`, `003_motorcycle_decoupling.sql`, `004_promotions_lifecycle.sql`, `005_forum_replies_audit.sql`, `006_loyalty_lifecycle.sql`, `007_loyalty_settings.sql`).
- `src/modules/`: routers por dominio (`auth`, `customers`, `motorcycles`, `services`, `appointments`, `washRequests`, `notifications`, `loyalty`, `settings`, `finance`, `inventory`, `employees`, `promotions`, `reviews`, `forum`, `reports`, `legal`).
- `src/services/`: auditoría (`audit.service.ts`), notificaciones in-app + FCM (`notification.service.ts`), moderación (`moderation.service.ts`) y proceso programado de vencimientos (`scheduler.service.ts`).
- `docs/api/openapi.yaml`: contrato OpenAPI 3.0.3 servido en `/api/docs`, `/api/v1/openapi.yaml` y `/api/v1/openapi.json`.

---

## Instalación y ejecución local

1. Copia el archivo de variables de entorno:
   ```bash
   cp .env.example .env
   ```
2. Instala dependencias:
   ```bash
   npm install
   ```
3. Ejecuta las migraciones y el seed de desarrollo:
   ```bash
   npm run db:migrate
   npm run db:seed
   ```
   > Si `DATABASE_URL` está vacío en `.env`, el proyecto usa PostgreSQL embebido (`PGlite`) en `./data/pgdata` para arrancar inmediatamente. Para conectar a PostgreSQL externo, define `DATABASE_URL=postgresql://usuario:clave@localhost:5432/los_malditos`.
4. Inicia el servidor en desarrollo:
   ```bash
   npm run dev
   ```
   Documentación interactiva disponible en `http://localhost:3000/api/docs` (o el puerto configurado en `PORT`).

### Credencial inicial generada por el seed

El comando `npm run db:seed` (`src/db/seed.ts`) crea únicamente el usuario Administrador y deja limpias las tablas de clientes, empleados, motos, servicios, inventario y promociones:

| Rol | Usuario | Contraseña |
| --- | --- | --- |
| Administrador | `admin` | `Admin1234*` |

---

## Docker Compose (API + PostgreSQL 16)

```bash
docker compose up --build -d
```

Luego aplica el seed inicial dentro del contenedor si lo necesitas:

```bash
docker compose exec api npm run db:seed
```

La API quedará disponible en `http://localhost:8080/api/v1` y PostgreSQL en el puerto `5432`.

---

## Pruebas automatizadas y validación OpenAPI

```bash
# Validar sintaxis TypeScript
npm run lint

# Verificar paridad 100% entre docs/api/openapi.yaml y las rutas Express
npm run openapi:validate

# Ejecutar suite completa de integración (auth, disponibilidad, lavadas, fidelización, foro, reportes)
npm test

# Compilar bundle productivo
npm run build
```

---

## Configuración de Firebase Cloud Messaging (FCM)

1. Genera una clave privada de cuenta de servicio en Firebase Console (formato JSON).
2. Asigna el JSON serializado en la variable de entorno `FIREBASE_SERVICE_ACCOUNT_JSON`.
3. La aplicación Flutter registra sus tokens con `POST /api/v1/devices`.
4. **Respaldo sin FCM**: si `FIREBASE_SERVICE_ACCOUNT_JSON` está vacío, la API guarda igualmente todas las notificaciones en la tabla `notifications` para que Flutter las consulte por polling mediante `GET /api/v1/notifications`. Si FCM reporta tokens inválidos/desregistrados, el backend los marca automáticamente como `is_valid = FALSE`.

---

## Producción, rotación de secretos y backups

### Variables críticas en producción

- `NODE_ENV=production`
- `DATABASE_URL`: cadena TLS hacia PostgreSQL 16 gestionado.
- `JWT_ACCESS_SECRET` y `JWT_REFRESH_SECRET`: secretos independientes de al menos 64 caracteres aleatorios (`openssl rand -hex 48`).
- `BCRYPT_ROUNDS=12`
- `CORS_ORIGINS`: orígenes permitidos separados por coma (sin `*` en producción si hay clientes web).

### Rotación de secretos

1. Genera nuevos secretos con `openssl rand -hex 48`.
2. Actualiza `JWT_ACCESS_SECRET` y `JWT_REFRESH_SECRET` en el gestor de secretos y reinicia el servicio.
3. Al rotar `JWT_ACCESS_SECRET`, los access tokens emitidos (TTL de 15 min) dejan de ser válidos; los clientes renovarán usando `POST /api/v1/auth/refresh` (cuyos refresh tokens son opacos almacenados con hash SHA-256 en PostgreSQL).
4. Para revocar todas las sesiones activas ante un incidente, ejecuta:
   ```sql
   UPDATE refresh_tokens SET revoked_at = NOW() WHERE revoked_at IS NULL;
   ```

### Backups y restauración de PostgreSQL

Backup lógico diario comprimido:
```bash
pg_dump "$DATABASE_URL" --format=custom --no-owner --file="backup_los_malditos_$(date +%F).dump"
```

Restauración:
```bash
pg_restore --dbname="$DATABASE_URL" --clean --if-exists backup_los_malditos_2026-11-18.dump
```

---

## Ejemplos de respuestas de la API (`/api/v1`)

### 1. Login (`POST /api/v1/auth/login`)

```json
{
  "data": {
    "user": {
      "id": "8e4f93e6-4928-4d6f-9871-5a40e34b6d11",
      "name": "Mateo Motero",
      "username": "mateo.moto",
      "role": "Cliente",
      "isActive": true,
      "mustChangePassword": false,
      "termsAcceptedAt": "2026-11-18T09:15:00.000-05:00",
      "createdAt": "2026-11-18T09:15:00.000-05:00"
    },
    "accessToken": "eyJhbGciOiJIUzI1NiIs...",
    "refreshToken": "f9c2c6b3a1...",
    "expiresIn": 900
  },
  "message": "Sesión iniciada exitosamente"
}
```

### 2. Crear lavada para confirmar (`POST /api/v1/wash-requests`)

```json
{
  "data": {
    "id": "6f29a8d2-90c8-4c5c-96f9-4b1de594d901",
    "customerId": "8e4f93e6-4928-4d6f-9871-5a40e34b6d11",
    "motorcycleId": "2d31b8e2-2c30-4f7e-8a6b-7b2b7a982e10",
    "serviceId": "9a1c1c42-4e18-4847-b152-f62467c44209",
    "appointmentId": null,
    "price": 6000,
    "scheduledAt": null,
    "expiresInMinutes": 15,
    "customerName": "Mateo Motero",
    "motorcycleName": "Yamaha MT-03 (La Negra)",
    "serviceName": "Lavada Express",
    "status": "pending_confirmation",
    "rejectionReason": null,
    "confirmedAt": null,
    "completedAt": null,
    "audit": [
      {
        "id": "b198c020-3d8e-4e43-907e-e8e382313b00",
        "actorId": "a1b2c3d4-0000-4000-8000-000000000001",
        "actorName": "Administrador Los Malditos",
        "action": "created",
        "occurredAt": "2026-11-18T10:00:00.000-05:00",
        "previousContent": null,
        "newContent": "pending_confirmation (tarifa base COP 7000, descuento pendingBalance COP 1000, total COP 6000)"
      }
    ]
  },
  "message": "Solicitud de lavada enviada para confirmación. Se descontó pendingBalance de COP 1000 sobre COP 7000, quedando en COP 6000."
}
```

### 3. Confirmar lavada (`POST /api/v1/wash-requests/{id}/confirm`)

```json
{
  "data": {
    "id": "6f29a8d2-90c8-4c5c-96f9-4b1de594d901",
    "status": "confirmed",
    "confirmedAt": "2026-11-18T10:02:11.000-05:00"
  },
  "message": "Lavada confirmada exitosamente y agregada a la cola del día"
}
```

### 4. Rechazar lavada (`POST /api/v1/wash-requests/{id}/reject`)

```json
{
  "data": {
    "id": "6f29a8d2-90c8-4c5c-96f9-4b1de594d901",
    "status": "rejected",
    "rejectionReason": "No alcanzo a llegar antes de las 5 PM"
  },
  "message": "Solicitud de lavada rechazada"
}
```

### 5. Registrar pago manual (`POST /api/v1/payments`)

```json
{
  "data": {
    "id": "e41f8c2a-3210-4c9e-b110-12a4b5c6d7e8",
    "washRequestId": "6f29a8d2-90c8-4c5c-96f9-4b1de594d901",
    "method": "Nequi",
    "amount": 6000,
    "reference": "NEQ-88412",
    "paidAt": "2026-11-18T10:45:00.000-05:00",
    "employeeCommission": 1800
  },
  "message": "Pago manual (Nequi) registrado exitosamente"
}
```

### 6. Error de conflicto (`409 Conflict`)

```json
{
  "data": {
    "code": "MOTORCYCLE_HAS_HISTORY"
  },
  "message": "La moto tiene historial y no puede eliminarse definitivamente."
}
```

### 7. Respuesta paginada (`GET /api/v1/customers?page=1&pageSize=20`)

```json
{
  "data": [
    {
      "id": "8e4f93e6-4928-4d6f-9871-5a40e34b6d11",
      "name": "Mateo Motero",
      "username": "mateo.moto",
      "role": "Cliente",
      "isActive": true,
      "mustChangePassword": false,
      "termsAcceptedAt": "2026-11-18T09:15:00.000-05:00",
      "createdAt": "2026-11-18T09:15:00.000-05:00",
      "notes": null,
      "pendingBalance": 0,
      "completedWashes": 1,
      "motorcycles": []
    }
  ],
  "meta": {
    "page": 1,
    "pageSize": 20,
    "total": 1,
    "totalPages": 1
  },
  "message": "Clientes consultados exitosamente"
}
```

### 8. Flujo de motos independientes (solo Administrador)

```bash
# Crear moto sin cliente asignado
curl -X POST https://apilosmalditos.jminternet.online/api/v1/motorcycles \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"brand":"Boxer","model":"CT 100","cc":100,"nickname":"La Guerrera"}'

# Asociar o reasignar moto a un cliente
curl -X POST https://apilosmalditos.jminternet.online/api/v1/motorcycles/$MOTO_ID/assignment \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"customerId":"'$CUSTOMER_ID'"}'

# Desvincular moto sin eliminar registro ni historial
curl -X DELETE https://apilosmalditos.jminternet.online/api/v1/motorcycles/$MOTO_ID/assignment \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Consultar historial de asociaciones
curl https://apilosmalditos.jminternet.online/api/v1/motorcycles/$MOTO_ID/assignments \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```
