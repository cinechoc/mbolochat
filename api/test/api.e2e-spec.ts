import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { ConversationsService } from '../src/conversations/conversations.service.js';
import { DRIZZLE, type Database } from '../src/db/db.module.js';

describe('MboloChat API (e2e)', () => {
  let app: INestApplication;
  const suffix = Date.now();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    await migrate(app.get<Database>(DRIZZLE), { migrationsFolder: 'drizzle' });
  });

  afterAll(async () => {
    await app.close();
  });

  let emailCounter = 0;

  const registerBody = (firstName: string, lastName: string) => {
    emailCounter += 1;
    return {
      firstName,
      lastName,
      email: `${firstName.toLowerCase()}_${lastName.toLowerCase()}_${suffix}_${emailCounter}@e2e.dev`,
      password: 'password123',
      birthday: '1995-06-15',
      gender: 'FEMALE',
    };
  };

  const register = (firstName: string, lastName: string) =>
    request(app.getHttpServer())
      .post('/auth/register')
      .send(registerBody(firstName, lastName))
      .expect(201);

  it('supports the full messaging flow', async () => {
    const alice = (await register('Alice', 'Martin')).body;
    const bob = (await register('Bob', 'Durand')).body;
    alice.token = alice.accessToken;
    bob.token = bob.accessToken;

    expect(alice.user.username).toMatch(/^alice\.martin/);
    expect(alice.user.displayName).toBe('Alice Martin');

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ emailOrUsername: bob.user.username, password: 'password123' })
      .expect(200);
    expect(login.body.accessToken).toBeTruthy();

    const search = await request(app.getHttpServer())
      .get('/users/search')
      .query({ q: bob.user.username })
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);
    expect(search.body).toHaveLength(1);
    expect(search.body[0].id).toBe(bob.user.id);

    const conversation = await request(app.getHttpServer())
      .post('/conversations')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ memberIds: [bob.user.id] })
      .expect(201);
    expect(conversation.body.type).toBe('DIRECT');
    expect(conversation.body.members).toHaveLength(2);

    const again = await request(app.getHttpServer())
      .post('/conversations')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ memberIds: [bob.user.id] })
      .expect(201);
    expect(again.body.id).toBe(conversation.body.id);

    const conversationsService = app.get(ConversationsService);
    await conversationsService.createMessage(conversation.body.id, alice.user.id, 'Salut Bob !');

    const messages = await request(app.getHttpServer())
      .get(`/conversations/${conversation.body.id}/messages`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200);
    expect(messages.body).toHaveLength(1);
    expect(messages.body[0].content).toBe('Salut Bob !');
    expect(messages.body[0].sender.id).toBe(alice.user.id);
  });

  it('envoie et cite un sticker sans pièce jointe', async () => {
    const alice = (await register('Sara', 'Sticker')).body;
    const bob = (await register('Tom', 'Sticker')).body;
    const conversation = await request(app.getHttpServer())
      .post('/conversations')
      .set('Authorization', `Bearer ${alice.accessToken}`)
      .send({ memberIds: [bob.user.id] })
      .expect(201);
    const conversationId = conversation.body.id;
    const conversationsService = app.get(ConversationsService);

    const sticker = await conversationsService.createMessage(
      conversationId,
      alice.user.id,
      '',
      undefined,
      undefined,
      undefined,
      null,
      null,
      'sticker',
      'mbolo/merci',
    );
    expect(sticker.type).toBe('sticker');
    expect(sticker.stickerRef).toBe('mbolo/merci');
    expect(sticker.attachment).toBeNull();

    const list = await request(app.getHttpServer())
      .get(`/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${bob.accessToken}`)
      .expect(200);
    expect(list.body.at(-1)).toMatchObject({
      type: 'sticker',
      stickerRef: 'mbolo/merci',
      content: '',
    });

    const summary = await request(app.getHttpServer())
      .get(`/conversations/${conversationId}`)
      .set('Authorization', `Bearer ${bob.accessToken}`)
      .expect(200);
    expect(summary.body.lastMessage).toMatchObject({
      type: 'sticker',
      stickerRef: 'mbolo/merci',
    });

    const reply = await conversationsService.createMessage(
      conversationId,
      bob.user.id,
      'Bien reçu',
      undefined,
      undefined,
      sticker.id,
    );
    expect(reply.replyTo).toMatchObject({
      type: 'sticker',
      content: '',
      deleted: false,
    });

    await expect(
      conversationsService.createMessage(
        conversationId,
        alice.user.id,
        '',
        undefined,
        undefined,
        undefined,
        null,
        null,
        'sticker',
        'Mbolo/Merci',
      ),
    ).rejects.toThrow('Référence de sticker invalide');
    await expect(
      conversationsService.createMessage(
        conversationId,
        alice.user.id,
        'texte',
        undefined,
        undefined,
        undefined,
        null,
        null,
        'text',
        'mbolo/merci',
      ),
    ).rejects.toThrow('stickerRef');
    await expect(
      conversationsService.createMessage(
        conversationId,
        alice.user.id,
        '',
        'fake-upload',
        undefined,
        undefined,
        null,
        null,
        'sticker',
        'mbolo/merci',
      ),
    ).rejects.toThrow('pièce jointe');
  });

  it('pins, mutes and unpins a conversation for the current user only', async () => {
    const alice = (await register('Lucie', 'Perez')).body;
    const bob = (await register('Marc', 'Petit')).body;
    alice.token = alice.accessToken;
    bob.token = bob.accessToken;

    const conversation = await request(app.getHttpServer())
      .post('/conversations')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ memberIds: [bob.user.id] })
      .expect(201);
    const conversationId = conversation.body.id;

    const pinned = await request(app.getHttpServer())
      .patch(`/conversations/${conversationId}/preferences`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ pinned: true, muted: true })
      .expect(200);
    expect(pinned.body.pinned).toBe(true);
    expect(pinned.body.muted).toBe(true);

    // Les préférences sont propres à chaque membre.
    const bobView = await request(app.getHttpServer())
      .get(`/conversations/${conversationId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200);
    expect(bobView.body.pinned).toBe(false);
    expect(bobView.body.muted).toBe(false);

    const aliceView = await request(app.getHttpServer())
      .get('/conversations')
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);
    const aliceConversation = aliceView.body.find((item: { id: string }) => item.id === conversationId);
    expect(aliceConversation.pinned).toBe(true);

    const unpinned = await request(app.getHttpServer())
      .patch(`/conversations/${conversationId}/preferences`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ pinned: false })
      .expect(200);
    expect(unpinned.body.pinned).toBe(false);
    expect(unpinned.body.muted).toBe(true);
  });

  it('sorts pinned conversations first and exposes the read state of members', async () => {
    const alice = (await register('Sara', 'Diallo')).body;
    const bob = (await register('Tom', 'Roy')).body;
    alice.token = alice.accessToken;
    bob.token = bob.accessToken;

    const first = await request(app.getHttpServer())
      .post('/conversations')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ memberIds: [bob.user.id] })
      .expect(201);

    const conversationsService = app.get(ConversationsService);
    await conversationsService.createMessage(first.body.id, bob.user.id, 'Coucou');

    await request(app.getHttpServer())
      .patch(`/conversations/${first.body.id}/preferences`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ pinned: true })
      .expect(200);

    const list = await request(app.getHttpServer())
      .get('/conversations')
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);
    expect(list.body[0].id).toBe(first.body.id);
    expect(list.body[0].pinned).toBe(true);
    // Le timestamp du dernier message doit être sérialisable en ISO.
    expect(list.body[0].lastMessage.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Bob n'a pas encore lu : son lastReadAt est null.
    const aliceView = await request(app.getHttpServer())
      .get('/conversations')
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);
    const bobMember = aliceView.body[0].members.find(
      (member: { id: string }) => member.id === bob.user.id,
    );
    expect(bobMember.lastReadAt).toBeNull();

    await request(app.getHttpServer())
      .post(`/conversations/${first.body.id}/read`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(204);

    const afterRead = await request(app.getHttpServer())
      .get('/conversations')
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);
    const bobAfterRead = afterRead.body[0].members.find(
      (member: { id: string }) => member.id === bob.user.id,
    );
    expect(bobAfterRead.lastReadAt).toBeTruthy();

    // Avec plusieurs discussions, la liste doit rester triée sans erreur.
    const second = await request(app.getHttpServer())
      .post('/conversations')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ memberIds: [bob.user.id], name: 'Autre groupe', type: 'GROUP' })
      .expect(201);
    await conversationsService.createMessage(second.body.id, bob.user.id, 'Dans le second groupe');

    const multi = await request(app.getHttpServer())
      .get('/conversations')
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);
    expect(multi.body).toHaveLength(2);
    // La discussion épinglée reste en tête, puis la plus récente.
    expect(multi.body[0].id).toBe(first.body.id);
    expect(multi.body[1].id).toBe(second.body.id);
  });

  it('rejects unauthenticated requests', async () => {
    await request(app.getHttpServer()).get('/conversations').expect(401);
  });

  it('rejects duplicate emails', async () => {
    const body = registerBody('Emma', 'Petit');
    await request(app.getHttpServer()).post('/auth/register').send(body).expect(201);
    await request(app.getHttpServer()).post('/auth/register').send(body).expect(409);
  });

  it('generates unique usernames for identical names', async () => {
    const first = (await register('Jean', 'Dupont')).body;
    const second = (await register('Jean', 'Dupont')).body;

    expect(first.user.username).toMatch(/^jean\.dupont/);
    expect(second.user.username).toMatch(/^jean\.dupont/);
    expect(second.user.username).not.toBe(first.user.username);
    expect(second.user.displayName).toBe('Jean Dupont');
  });

  it('uploads then deletes the profile avatar', async () => {
    const account = (await register('Avatar', 'Test')).body;
    const token = account.accessToken;
    const userId = account.user.id;
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZQAAAABJRU5ErkJggg==';

    const uploaded = await request(app.getHttpServer())
      .post('/users/me/avatar')
      .set('Authorization', `Bearer ${token}`)
      .send({ data: png, mimeType: 'image/png' })
      .expect(201);
    expect(uploaded.body.avatarUrl).toContain(encodeURIComponent(`/uploads/${userId}.png`));
    expect(existsSync(join(process.cwd(), 'uploads', `${userId}.png`))).toBe(true);

    const deleted = await request(app.getHttpServer())
      .delete('/users/me/avatar')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(deleted.body.avatarUrl).toBeNull();
    expect(existsSync(join(process.cwd(), 'uploads', `${userId}.png`))).toBe(false);

    const me = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(me.body.avatarUrl).toBeNull();
  });

  it('rejects underage registrations', async () => {
    const recentYear = new Date().getFullYear() - 10;
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        ...registerBody('Young', 'Kid'),
        birthday: `${recentYear}-01-01`,
      })
      .expect(400);
  });

  it('resets a forgotten password with a 6-digit code', async () => {
    const user = (await register('Nina', 'Rossi')).body;

    const forgot = await request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ emailOrUsername: user.user.username })
      .expect(200);
    expect(forgot.body.devCode).toMatch(/^\d{6}$/);

    const wrongCode = forgot.body.devCode === '000000' ? '111111' : '000000';
    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({ emailOrUsername: user.user.username, code: wrongCode, newPassword: 'newpassword123' })
      .expect(400);

    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({
        emailOrUsername: user.user.username,
        code: forgot.body.devCode,
        newPassword: 'newpassword123',
      })
      .expect(200);

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ emailOrUsername: user.user.username, password: 'newpassword123' })
      .expect(200);

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ emailOrUsername: user.user.username, password: 'password123' })
      .expect(401);
  });

  it('does not reveal unknown accounts and rejects invalid reset codes', async () => {
    const forgotUnknown = await request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ emailOrUsername: 'inconnu.introuvable' })
      .expect(200);
    expect(forgotUnknown.body.devCode).toBeUndefined();

    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({ emailOrUsername: 'inconnu.introuvable', code: '123456', newPassword: 'whatever123' })
      .expect(400);

    const user = (await register('Omar', 'Blanc')).body;
    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({ emailOrUsername: user.user.username, code: '123456', newPassword: 'whatever123' })
      .expect(400);
  });
});
