import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrator.js';
import {
  detectUnsafeForumHtml,
  sanitizeAndValidateForumReplyContent,
} from '../src/modules/forum/forum.service.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';

describe('Respuestas del Foro: Pruebas unitarias de validación y XSS', () => {
  it('detecta HTML, scripts y vectores XSS sin bloquear texto normal', () => {
    expect(detectUnsafeForumHtml('<script>alert(1)</script>')).toBe(true);
    expect(detectUnsafeForumHtml('<img src=x onerror=alert(1)>')).toBe(true);
    expect(detectUnsafeForumHtml('Hola <b>amigo</b>')).toBe(true);
    expect(detectUnsafeForumHtml('javascript:alert(1)')).toBe(true);
    expect(detectUnsafeForumHtml('Recomendación: lavar con agua < 30°C')).toBe(false);
  });

  it('valida longitud, contenido vacío, HTML/XSS y lenguaje ofensivo', () => {
    expect(
      sanitizeAndValidateForumReplyContent('  Excelente consejo para la cadena  '),
    ).toBe('Excelente consejo para la cadena');

    expect(() => sanitizeAndValidateForumReplyContent('   ')).toThrow(/vacío/i);
    expect(() =>
      sanitizeAndValidateForumReplyContent('a'.repeat(5001)),
    ).toThrow(/5000/i);
    expect(() =>
      sanitizeAndValidateForumReplyContent('<script>alert(1)</script>'),
    ).toThrow(/HTML/i);
    expect(() =>
      sanitizeAndValidateForumReplyContent('Esto es una mierda malparido'),
    ).toThrow(/ofensivo/i);
  });
});

describe('Respuestas del Foro: CRUD completo, RBAC, moderación, auditoría y migraciones', () => {
  let ctx: TestContext;
  let clienteBToken: string;

  beforeAll(async () => {
    ctx = await createTestContext();

    // Crear segundo cliente para validar aislamiento entre clientes
    const custB = await request(ctx.app)
      .post('/api/v1/customers')
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({
        name: 'Sofía Moto',
        username: 'sofia.moto',
        password: 'Password123*',
      });
    expect(custB.status).toBe(201);

    const loginB = await request(ctx.app)
      .post('/api/v1/auth/login')
      .send({ username: 'sofia.moto', password: 'Password123*' });
    expect(loginB.status).toBe(200);
    clienteBToken = loginB.body.data.accessToken as string;
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('permite a Cliente crear, editar (actualiza editedAt) y eliminar lógicamente su propia respuesta sin borrar el post padre ni otras respuestas', async () => {
    // Crear publicación padre
    const postRes = await request(ctx.app)
      .post('/api/v1/forum/posts')
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({
        title: '¿Cada cuánto lubrican la cadena?',
        content: 'En temporada de lluvia en Bogotá siento que se seca rápido.',
      });
    expect(postRes.status).toBe(201);
    const postId = postRes.body.data.id as string;

    // 1. Cliente crea una respuesta
    const createReplyRes = await request(ctx.app)
      .post(`/api/v1/forum/posts/${postId}/replies`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({ content: 'Yo la lubrico cada 300 kilómetros.' });
    expect(createReplyRes.status).toBe(201);
    expect(createReplyRes.body.data.replies.length).toBe(1);
    const reply1 = createReplyRes.body.data.replies[0] as {
      id: string;
      postId: string;
      authorId: string;
      authorName: string;
      content: string;
      createdAt: string;
      editedAt: string | null;
      deletedAt: string | null;
    };
    expect(reply1.postId).toBe(postId);
    expect(reply1.authorId).toBe(ctx.clienteId);
    expect(reply1.editedAt).toBeNull();
    expect(reply1.deletedAt).toBeNull();

    // Crear segunda respuesta para verificar que no se elimina ni se altera al borrar la primera
    const createReply2Res = await request(ctx.app)
      .post(`/api/v1/forum/posts/${postId}/replies`)
      .set('Authorization', `Bearer ${clienteBToken}`)
      .send({ content: 'Y después de rodar bajo lluvia fuerte.' });
    expect(createReply2Res.status).toBe(201);
    const reply2Id = createReply2Res.body.data.replies[1].id as string;

    // 2 y 9. Cliente edita su propia respuesta -> actualiza editedAt
    const patchRes = await request(ctx.app)
      .patch(`/api/v1/forum/replies/${reply1.id}`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({ content: 'Yo la lubrico cada 250 kilómetros con Motul C4.' });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.message).toBe('Respuesta actualizada exitosamente');
    expect(patchRes.body.data.id).toBe(reply1.id);
    expect(patchRes.body.data.postId).toBe(postId);
    expect(patchRes.body.data.authorId).toBe(ctx.clienteId);
    expect(patchRes.body.data.content).toBe(
      'Yo la lubrico cada 250 kilómetros con Motul C4.',
    );
    expect(patchRes.body.data.editedAt).not.toBeNull();
    expect(patchRes.body.data.deletedAt).toBeNull();

    // No permite modificar id, postId, authorId ni createdAt
    const forbiddenFieldsPatch = await request(ctx.app)
      .patch(`/api/v1/forum/replies/${reply1.id}`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({
        content: 'Intento con campos prohibidos',
        authorId: ctx.clienteId,
        postId,
      });
    expect(forbiddenFieldsPatch.status).toBe(422);
    expect(forbiddenFieldsPatch.body.data.code).toBe('VALIDATION_ERROR');

    // 3 y 10. Cliente elimina lógicamente su propia respuesta -> establece deletedAt
    const deleteRes = await request(ctx.app)
      .delete(`/api/v1/forum/replies/${reply1.id}`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`);
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.message).toBe('Respuesta eliminada exitosamente');
    expect(deleteRes.body.data.id).toBe(reply1.id);
    expect(deleteRes.body.data.deletedAt).not.toBeNull();

    // No permite doble eliminación (409) ni editar eliminada (409)
    const doubleDelete = await request(ctx.app)
      .delete(`/api/v1/forum/replies/${reply1.id}`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`);
    expect(doubleDelete.status).toBe(409);

    const editDeleted = await request(ctx.app)
      .patch(`/api/v1/forum/replies/${reply1.id}`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({ content: 'Editar tras eliminar' });
    expect(editDeleted.status).toBe(409);

    // 11. La respuesta eliminada no aparece para Cliente ni Lavador; post padre y reply2 siguen visibles
    const clientFeed = await request(ctx.app)
      .get('/api/v1/forum/posts')
      .query({ includeDeleted: 'true' })
      .set('Authorization', `Bearer ${ctx.clienteToken}`);
    expect(clientFeed.status).toBe(200);
    const postForClient = (
      clientFeed.body.data as Array<{
        id: string;
        replies: Array<{ id: string }>;
      }>
    ).find((p) => p.id === postId);
    expect(postForClient).toBeDefined();
    expect(postForClient!.replies.map((r) => r.id)).toEqual([reply2Id]);

    const lavadorFeed = await request(ctx.app)
      .get('/api/v1/forum/posts')
      .query({ includeDeleted: 'true' })
      .set('Authorization', `Bearer ${ctx.lavadorToken}`);
    const postForLavador = (
      lavadorFeed.body.data as Array<{
        id: string;
        replies: Array<{ id: string }>;
      }>
    ).find((p) => p.id === postId);
    expect(postForLavador!.replies.map((r) => r.id)).toEqual([reply2Id]);

    // 12. Administrador sí puede consultar respuestas eliminadas con includeDeleted=true en orden cronológico
    const adminFeed = await request(ctx.app)
      .get('/api/v1/forum/posts')
      .query({ includeDeleted: 'true' })
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(adminFeed.status).toBe(200);
    const postForAdmin = (
      adminFeed.body.data as Array<{
        id: string;
        replies: Array<{ id: string; deletedAt: string | null }>;
      }>
    ).find((p) => p.id === postId);
    expect(postForAdmin!.replies.length).toBe(2);
    expect(postForAdmin!.replies[0]!.id).toBe(reply1.id);
    expect(postForAdmin!.replies[0]!.deletedAt).not.toBeNull();
    expect(postForAdmin!.replies[1]!.id).toBe(reply2Id);
    expect(postForAdmin!.replies[1]!.deletedAt).toBeNull();

    // 13, 14 y 15. Auditoría registrada al crear, editar y eliminar en GET /forum/audit y audit_logs
    const auditRes = await request(ctx.app)
      .get('/api/v1/forum/audit')
      .query({ targetType: 'forum_reply', actorId: ctx.clienteId })
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(auditRes.status).toBe(200);

    const events = auditRes.body.data as Array<{
      id: string;
      actorId: string;
      actorName: string;
      action: string;
      targetId: string;
      targetType: string;
      before: { content: string } | null;
      after: { content: string } | null;
      createdAt: string;
      ipAddress: string | null;
    }>;
    const reply1Events = events.filter((e) => e.targetId === reply1.id);
    expect(reply1Events.map((e) => e.action)).toEqual(
      expect.arrayContaining(['created', 'edited', 'deleted']),
    );
    const editedEvent = reply1Events.find((e) => e.action === 'edited');
    expect(editedEvent?.targetType).toBe('forum_reply');
    expect(editedEvent?.before?.content).toBe('Yo la lubrico cada 300 kilómetros.');
    expect(editedEvent?.after?.content).toBe(
      'Yo la lubrico cada 250 kilómetros con Motul C4.',
    );
    expect(editedEvent?.createdAt).toBeDefined();
    expect(editedEvent?.ipAddress).toBeTruthy();

    const deletedEvent = reply1Events.find((e) => e.action === 'deleted');
    expect(deletedEvent?.before?.content).toBe(
      'Yo la lubrico cada 250 kilómetros con Motul C4.',
    );
    expect(deletedEvent?.after).toBeNull();

    // Verificar registros en tabla central audit_logs
    const auditLogsDb = await ctx.db.query<{
      action: string;
      entity_type: string;
      entity_id: string;
    }>(
      `SELECT action, entity_type, entity_id
       FROM audit_logs
       WHERE entity_type = 'forum_reply' AND entity_id = $1
       ORDER BY occurred_at ASC`,
      [reply1.id],
    );
    expect(auditLogsDb.rows.map((r) => r.action)).toEqual([
      'forum_reply_created',
      'forum_reply_edited',
      'forum_reply_deleted',
    ]);
  });

  it('cumple RBAC: Cliente y Lavador no editan/eliminan ajenas, Lavador sí gestiona las propias, y Administrador modera cualquier respuesta', async () => {
    const postRes = await request(ctx.app)
      .post('/api/v1/forum/posts')
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({
        title: 'Cuidado de frenos',
        content: '¿Qué líquido recomiendan después de lavar?',
      });
    const postId = postRes.body.data.id as string;

    // Respuesta de Cliente A
    const clientReplyRes = await request(ctx.app)
      .post(`/api/v1/forum/posts/${postId}/replies`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({ content: 'Respuesta de Cliente A' });
    const clientReplyId = clientReplyRes.body.data.replies[0].id as string;

    // 8. Respuesta de Lavador
    const lavadorReplyRes = await request(ctx.app)
      .post(`/api/v1/forum/posts/${postId}/replies`)
      .set('Authorization', `Bearer ${ctx.lavadorToken}`)
      .send({ content: 'Respuesta inicial del Lavador' });
    expect(lavadorReplyRes.status).toBe(201);
    const lavadorReplyId = lavadorReplyRes.body.data.replies[1].id as string;

    // Sin token -> 401
    const unauthEdit = await request(ctx.app)
      .patch(`/api/v1/forum/replies/${clientReplyId}`)
      .send({ content: 'Sin auth' });
    expect(unauthEdit.status).toBe(401);

    const unauthDelete = await request(ctx.app).delete(
      `/api/v1/forum/replies/${clientReplyId}`,
    );
    expect(unauthDelete.status).toBe(401);

    // 4 y 5. Cliente B no edita ni elimina respuesta ajena (403 FORUM_REPLY_FORBIDDEN)
    const clientBEdit = await request(ctx.app)
      .patch(`/api/v1/forum/replies/${clientReplyId}`)
      .set('Authorization', `Bearer ${clienteBToken}`)
      .send({ content: 'Intento ajeno' });
    expect(clientBEdit.status).toBe(403);
    expect(clientBEdit.body.data.code).toBe('FORUM_REPLY_FORBIDDEN');

    const clientBDelete = await request(ctx.app)
      .delete(`/api/v1/forum/replies/${clientReplyId}`)
      .set('Authorization', `Bearer ${clienteBToken}`);
    expect(clientBDelete.status).toBe(403);
    expect(clientBDelete.body.data.code).toBe('FORUM_REPLY_FORBIDDEN');

    // 8. Lavador no edita ni elimina respuesta de Cliente A, pero SÍ edita y elimina la suya
    const lavadorEditOther = await request(ctx.app)
      .patch(`/api/v1/forum/replies/${clientReplyId}`)
      .set('Authorization', `Bearer ${ctx.lavadorToken}`)
      .send({ content: 'Lavador editando ajena' });
    expect(lavadorEditOther.status).toBe(403);
    expect(lavadorEditOther.body.data.code).toBe('FORUM_REPLY_FORBIDDEN');

    const lavadorDeleteOther = await request(ctx.app)
      .delete(`/api/v1/forum/replies/${clientReplyId}`)
      .set('Authorization', `Bearer ${ctx.lavadorToken}`);
    expect(lavadorDeleteOther.status).toBe(403);
    expect(lavadorDeleteOther.body.data.code).toBe('FORUM_REPLY_FORBIDDEN');

    const lavadorEditOwn = await request(ctx.app)
      .patch(`/api/v1/forum/replies/${lavadorReplyId}`)
      .set('Authorization', `Bearer ${ctx.lavadorToken}`)
      .send({ content: 'Respuesta editada por el Lavador' });
    expect(lavadorEditOwn.status).toBe(200);
    expect(lavadorEditOwn.body.data.editedAt).not.toBeNull();

    const lavadorDeleteOwn = await request(ctx.app)
      .delete(`/api/v1/forum/replies/${lavadorReplyId}`)
      .set('Authorization', `Bearer ${ctx.lavadorToken}`);
    expect(lavadorDeleteOwn.status).toBe(200);
    expect(lavadorDeleteOwn.body.data.deletedAt).not.toBeNull();

    // 6. Administrador edita cualquier respuesta por moderación
    const adminEditRes = await request(ctx.app)
      .patch(`/api/v1/forum/replies/${clientReplyId}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ content: 'Respuesta moderada por administración' });
    expect(adminEditRes.status).toBe(200);
    expect(adminEditRes.body.data.content).toBe(
      'Respuesta moderada por administración',
    );
    expect(adminEditRes.body.data.editedAt).not.toBeNull();

    // 7. Administrador elimina cualquier respuesta por moderación
    const adminDeleteRes = await request(ctx.app)
      .delete(`/api/v1/forum/replies/${clientReplyId}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(adminDeleteRes.status).toBe(200);
    expect(adminDeleteRes.body.data.deletedAt).not.toBeNull();

    // Auditoría debe incluir eventos moderated para la respuesta moderada
    const modAuditRes = await request(ctx.app)
      .get('/api/v1/forum/audit')
      .query({ targetType: 'forum_reply', action: 'moderated' })
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(modAuditRes.status).toBe(200);
    expect(
      (modAuditRes.body.data as Array<{ targetId: string }>).some(
        (e) => e.targetId === clientReplyId,
      ),
    ).toBe(true);
  });

  it('rechaza contenido vacío, muy largo, peligroso/ofensivo (422) y retorna 404 para IDs inexistentes', async () => {
    const postRes = await request(ctx.app)
      .post('/api/v1/forum/posts')
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({
        title: 'Validaciones respuestas',
        content: 'Publicación base para pruebas de error',
      });
    const postId = postRes.body.data.id as string;

    const replyRes = await request(ctx.app)
      .post(`/api/v1/forum/posts/${postId}/replies`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({ content: 'Respuesta válida inicial' });
    const replyId = replyRes.body.data.replies[0].id as string;

    // 16. Contenido vacío en creación y edición -> 422 FORUM_REPLY_INVALID_CONTENT
    const emptyCreate = await request(ctx.app)
      .post(`/api/v1/forum/posts/${postId}/replies`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({ content: '   ' });
    expect(emptyCreate.status).toBe(422);
    expect(emptyCreate.body.data.code).toBe('FORUM_REPLY_INVALID_CONTENT');

    const emptyPatch = await request(ctx.app)
      .patch(`/api/v1/forum/replies/${replyId}`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({ content: '' });
    expect(emptyPatch.status).toBe(422);
    expect(emptyPatch.body.data.code).toBe('FORUM_REPLY_INVALID_CONTENT');

    // 17. Contenido demasiado largo (> 5000) -> 422 FORUM_REPLY_INVALID_CONTENT
    const longPatch = await request(ctx.app)
      .patch(`/api/v1/forum/replies/${replyId}`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({ content: 'x'.repeat(5001) });
    expect(longPatch.status).toBe(422);
    expect(longPatch.body.data.code).toBe('FORUM_REPLY_INVALID_CONTENT');

    // 18. Contenido peligroso (XSS/HTML) y lenguaje ofensivo -> 422 FORUM_REPLY_INVALID_CONTENT
    const xssPatch = await request(ctx.app)
      .patch(`/api/v1/forum/replies/${replyId}`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({ content: 'Prueba <script>alert(1)</script>' });
    expect(xssPatch.status).toBe(422);
    expect(xssPatch.body.data.code).toBe('FORUM_REPLY_INVALID_CONTENT');

    const offensivePatch = await request(ctx.app)
      .patch(`/api/v1/forum/replies/${replyId}`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({ content: 'Eres un idiota marica' });
    expect(offensivePatch.status).toBe(422);
    expect(offensivePatch.body.data.code).toBe('FORUM_REPLY_INVALID_CONTENT');

    // ID con formato inválido -> 422 VALIDATION_ERROR
    const badUuid = await request(ctx.app)
      .patch('/api/v1/forum/replies/no-es-uuid')
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({ content: 'Contenido válido' });
    expect(badUuid.status).toBe(422);
    expect(badUuid.body.data.code).toBe('VALIDATION_ERROR');

    // 19. ID inexistente -> 404 FORUM_REPLY_NOT_FOUND (y tampoco confunde un postId raíz con replyId)
    const missingId = '99999999-9999-4999-8999-999999999999';
    const patch404 = await request(ctx.app)
      .patch(`/api/v1/forum/replies/${missingId}`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`)
      .send({ content: 'No existe' });
    expect(patch404.status).toBe(404);
    expect(patch404.body.data.code).toBe('FORUM_REPLY_NOT_FOUND');

    const delete404 = await request(ctx.app)
      .delete(`/api/v1/forum/replies/${missingId}`)
      .set('Authorization', `Bearer ${ctx.clienteToken}`);
    expect(delete404.status).toBe(404);
    expect(delete404.body.data.code).toBe('FORUM_REPLY_NOT_FOUND');

    const rootPostAsReply404 = await request(ctx.app)
      .delete(`/api/v1/forum/replies/${postId}`)
      .set('Authorization', `Bearer ${ctx.adminToken}`);
    expect(rootPostAsReply404.status).toBe(404);
    expect(rootPostAsReply404.body.data.code).toBe('FORUM_REPLY_NOT_FOUND');
  });

  it('20 y 21. ejecuta migración 005 sobre base limpia y sobre base existente conservando datos y haciendo backfill de target_type', async () => {
    // 20. Base limpia completa
    const cleanDb = createDatabase({ pgliteDir: ':memory:' });
    const appliedClean = await runMigrations(cleanDb);
    expect(appliedClean).toContain('005_forum_replies_audit.sql');

    const auditCols = await cleanDb.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'forum_audits'`,
    );
    expect(auditCols.rows.map((r) => r.column_name)).toContain('target_type');
    await cleanDb.close();

    // 21. Base existente (migrada hasta 004 con post, respuesta y auditoría previas)
    const existingDb = createDatabase({ pgliteDir: ':memory:' });
    const migrationsDir = path.resolve(process.cwd(), 'migrations');
    for (const file of [
      '001_initial_schema.sql',
      '002_seed_shop_defaults.sql',
      '003_motorcycle_decoupling.sql',
      '004_promotions_lifecycle.sql',
    ]) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      await existingDb.exec(sql);
      await existingDb.query(
        `INSERT INTO schema_migrations (version) VALUES ($1)`,
        [file],
      );
    }

    const legacyUserId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const legacyPostId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const legacyReplyId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

    await existingDb.query(
      `INSERT INTO users (id, name, username, password_hash, role, is_active)
       VALUES ($1, 'Usuario Legacy', 'legacy.user', 'hash', 'Cliente', TRUE)`,
      [legacyUserId],
    );
    await existingDb.query(
      `INSERT INTO forum_posts (id, parent_id, author_id, title, content)
       VALUES
         ($1, NULL, $3, 'Post Legacy', 'Contenido post legacy'),
         ($2, $1, $3, '', 'Contenido respuesta legacy')`,
      [legacyPostId, legacyReplyId, legacyUserId],
    );
    await existingDb.query(
      `INSERT INTO forum_audits (id, post_id, actor_id, actor_name, action, new_content)
       VALUES
         ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1', $1, $3, 'Usuario Legacy', 'created', 'Contenido post legacy'),
         ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2', $2, $3, 'Usuario Legacy', 'created', 'Contenido respuesta legacy')`,
      [legacyPostId, legacyReplyId, legacyUserId],
    );

    const appliedUpgrade = await runMigrations(existingDb);
    expect(appliedUpgrade).toContain('005_forum_replies_audit.sql');

    const auditsAfter = await existingDb.query<{
      post_id: string;
      target_type: string;
    }>(`SELECT post_id, target_type FROM forum_audits ORDER BY post_id`);
    const postAudit = auditsAfter.rows.find((r) => r.post_id === legacyPostId);
    const replyAudit = auditsAfter.rows.find((r) => r.post_id === legacyReplyId);
    expect(postAudit?.target_type).toBe('forum_post');
    expect(replyAudit?.target_type).toBe('forum_reply');

    await existingDb.close();
  });
});
