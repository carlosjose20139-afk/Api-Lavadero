import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/testApp.js';

describe('Auth, RBAC, Seguridad y Ley 1581', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('rechaza creación de clientes sin rol Administrador y rechaza campos prohibidos (teléfono, correo, cédula, placa)', async () => {
    const asCliente = await request(ctx.app)
      .post('/api/v1/customers')
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({
        name: 'Intruso',
        username: 'intruso1',
        password: 'Password123*',
      });
    expect(asCliente.status).toBe(403);

    const withForbiddenField = await request(ctx.app)
      .post('/api/v1/customers')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        name: 'Pedro Prueba',
        username: 'pedro.prueba',
        password: 'Password123*',
        phone: '3001234567',
        email: 'pedro@example.com',
        cedula: '10101010',
      });
    expect(withForbiddenField.status).toBe(422);
    expect(withForbiddenField.body.data.code).toBe('VALIDATION_ERROR');
  });

  it('rechaza campo placa al registrar moto', async () => {
    const res = await request(ctx.app)
      .post('/api/v1/motorcycles')
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({
        brand: 'Suzuki',
        model: 'Gixxer 250',
        cc: 249,
        plate: 'ABC12D',
      });
    expect(res.status).toBe(422);
  });

  it('permite crear cliente desde mostrador, restablecer contraseña y obliga a cambiarla al entrar', async () => {
    const created = await request(ctx.app)
      .post('/api/v1/customers')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        name: 'Laura Rider',
        username: 'laura.rider',
        password: 'MiPassword123*',
        termsAcceptedAt: '2026-11-18T09:00:00-05:00',
      });
    expect(created.status).toBe(201);
    expect(created.body.data.role).toBe('Cliente');
    const lauraId = created.body.data.id as string;

    // Restablecimiento por administrador
    const resetRes = await request(ctx.app)
      .post(`/api/v1/customers/${lauraId}/reset-password`)
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(resetRes.status).toBe(200);
    expect(resetRes.body.data.mustChangePassword).toBe(true);
    const tempPwd = resetRes.body.data.temporaryPassword as string;

    // Login con contraseña temporal
    const loginTemp = await request(ctx.app)
      .post('/api/v1/auth/login')
      .send({ username: 'laura.rider', password: tempPwd });
    expect(loginTemp.status).toBe(200);
    expect(loginTemp.body.data.user.mustChangePassword).toBe(true);
    const tempToken = loginTemp.body.data.accessToken as string;

    // Bloquea acceso a otros endpoints hasta cambiar la contraseña
    const blockedProfile = await request(ctx.app)
      .get(`/api/v1/customers/${lauraId}`)
      .set('Authorization', `Bearer ${tempToken}`);
    expect(blockedProfile.status).toBe(403);
    expect(blockedProfile.body.data.code).toBe('PASSWORD_CHANGE_REQUIRED');

    // Cambio obligatorio de contraseña
    const changeRes = await request(ctx.app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${tempToken}`)
      .send({
        currentPassword: tempPwd,
        newPassword: 'NuevoPassword123*',
      });
    expect(changeRes.status).toBe(200);

    // Ahora sí permite consultar su propio recurso
    const allowedProfile = await request(ctx.app)
      .get(`/api/v1/customers/${lauraId}`)
      .set('Authorization', `Bearer ${tempToken}`);
    expect(allowedProfile.status).toBe(200);
    expect(allowedProfile.body.data.mustChangePassword).toBe(false);

    // Un cliente no puede consultar a otro cliente
    const crossCustomer = await request(ctx.app)
      .get(`/api/v1/customers/${ctx.clienteId}`)
      .set('Authorization', `Bearer ${tempToken}`);
    expect(crossCustomer.status).toBe(403);
  });

  it('bloquea temporalmente tras intentos fallidos sin enumeración de usuarios y revoca tokens al hacer logout', async () => {
    await request(ctx.app)
      .post('/api/v1/customers')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        name: 'Juan Bloqueo',
        username: 'juan.lock',
        password: 'LockPassword123*',
      });

    // 5 intentos fallidos + 1 con usuario inexistente deben devolver mismo mensaje y estado 401
    const nonExistent = await request(ctx.app)
      .post('/api/v1/auth/login')
      .send({ username: 'no.existe.jamás', password: 'WrongPassword1!' });
    expect(nonExistent.status).toBe(401);

    let lastBadMsg = '';
    for (let i = 0; i < 5; i += 1) {
      const fail = await request(ctx.app)
        .post('/api/v1/auth/login')
        .send({ username: 'juan.lock', password: 'WrongPassword1!' });
      expect(fail.status).toBe(401);
      lastBadMsg = fail.body.message;
    }
    expect(lastBadMsg).toBe(nonExistent.body.message);

    // Aunque use la contraseña correcta, permanece bloqueado temporalmente
    const lockedAttempt = await request(ctx.app)
      .post('/api/v1/auth/login')
      .send({ username: 'juan.lock', password: 'LockPassword123*' });
    expect(lockedAttempt.status).toBe(401);

    // Refresh y logout revocan el token inmediatamente
    const login = await request(ctx.app)
      .post('/api/v1/auth/login')
      .send({ username: 'mateo.moto', password: 'Cliente1234*' });
    const access = login.body.data.accessToken as string;
    const refresh = login.body.data.refreshToken as string;

    const refreshRes = await request(ctx.app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: refresh });
    expect(refreshRes.status).toBe(200);
    const newAccess = refreshRes.body.data.accessToken as string;
    const newRefresh = refreshRes.body.data.refreshToken as string;

    // El refresh viejo ya no sirve
    const replayOldRefresh = await request(ctx.app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: refresh });
    expect(replayOldRefresh.status).toBe(401);

    // Logout revoca la sesión actual
    const logoutRes = await request(ctx.app)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${newAccess}`)
      .send({ refreshToken: newRefresh });
    expect(logoutRes.status).toBe(200);

    const afterLogout = await request(ctx.app)
      .get('/api/v1/loyalty/me')
      .set('Authorization', `Bearer ${newAccess}`);
    expect(afterLogout.status).toBe(401);
  });

  it('expone términos Ley 1581 y permite radicar solicitud de gestión de datos al administrador', async () => {
    const terms = await request(ctx.app).get('/api/v1/legal/terms');
    expect(terms.status).toBe(200);
    expect(terms.body.data.lawReference).toContain('1581');

    const reqData = await request(ctx.app)
      .post('/api/v1/legal/data-requests')
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({
        requestType: 'access',
        details: 'Solicito copia de mi historial registrado en Los Malditos.',
      });
    expect(reqData.status).toBe(201);
    const reqId = reqData.body.data.id as string;

    const adminList = await request(ctx.app)
      .get('/api/v1/legal/data-requests')
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(adminList.status).toBe(200);
    expect(adminList.body.data.some((r: { id: string }) => r.id === reqId)).toBe(true);
  });
});
