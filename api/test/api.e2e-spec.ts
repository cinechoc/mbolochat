import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { ConversationsService } from '../src/conversations/conversations.service.js';
import { DRIZZLE, type Database } from '../src/db/db.module.js';
import { conversationInvites, users } from '../src/db/schema.js';

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

  describe('group conversations', () => {
    const account = async (firstName: string, lastName: string) => {
      const body = (await register(firstName, lastName)).body;
      return {
        token: body.accessToken as string,
        id: body.user.id as string,
        username: body.user.username as string,
      };
    };

    const dbUpdateExpired = async (token: string) => {
      await app
        .get<Database>(DRIZZLE)
        .update(conversationInvites)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(conversationInvites.token, token));
    };

    it('creates a group with identity, lets any member add, and enforces admin rights', async () => {
      const alice = await account('Gaelle', 'Roux');
      const bob = await account('Hugo', 'Noir');
      const charlie = await account('Ines', 'Verdier');

      const group = await request(app.getHttpServer())
        .post('/conversations')
        .set('Authorization', `Bearer ${alice.token}`)
        .send({
          type: 'GROUP',
          name: 'Les Randonneurs',
          emoji: '🌴',
          color: '#2fbf71',
          description: 'Préparer le trek',
          memberIds: [bob.id],
        })
        .expect(201);

      expect(group.body.ownerId).toBe(alice.id);
      expect(group.body.emoji).toBe('🌴');
      expect(group.body.color).toBe('#2fbf71');
      expect(group.body.description).toBe('Préparer le trek');
      const groupId = group.body.id;

      // Un simple membre peut ajouter quelqu'un (comportement Snapchat).
      const added = await request(app.getHttpServer())
        .post(`/conversations/${groupId}/members`)
        .set('Authorization', `Bearer ${bob.token}`)
        .send({ memberIds: [charlie.id] })
        .expect(201);
      expect(added.body.members).toHaveLength(3);

      // En revanche, l'identité et les rôles restent réservés aux admins.
      await request(app.getHttpServer())
        .patch(`/conversations/${groupId}`)
        .set('Authorization', `Bearer ${bob.token}`)
        .send({ name: 'Pirate' })
        .expect(403);

      await request(app.getHttpServer())
        .patch(`/conversations/${groupId}/members/${charlie.id}/role`)
        .set('Authorization', `Bearer ${bob.token}`)
        .send({ role: 'admin' })
        .expect(403);

      const promoted = await request(app.getHttpServer())
        .patch(`/conversations/${groupId}/members/${bob.id}/role`)
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ role: 'admin' })
        .expect(200);
      expect(
        promoted.body.members.find((member: { id: string }) => member.id === bob.id).role,
      ).toBe('admin');

      // Le propriétaire ne peut pas être rétrogradé, et il reste toujours un admin.
      await request(app.getHttpServer())
        .patch(`/conversations/${groupId}/members/${alice.id}/role`)
        .set('Authorization', `Bearer ${bob.token}`)
        .send({ role: 'member' })
        .expect(403);

      await request(app.getHttpServer())
        .patch(`/conversations/${groupId}/members/${bob.id}/role`)
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ role: 'member' })
        .expect(200);

      // Bob n'est plus admin : il ne peut plus exclure.
      await request(app.getHttpServer())
        .delete(`/conversations/${groupId}/members/${charlie.id}`)
        .set('Authorization', `Bearer ${bob.token}`)
        .expect(403);
    });

    it('suggests recent contacts before the alphabetical list', async () => {
      const alice = await account('Romy', 'Sugg');
      const bob = await account('Sam', 'Sugg');

      await request(app.getHttpServer())
        .post('/conversations')
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ memberIds: [bob.id] })
        .expect(201);

      const suggestions = await request(app.getHttpServer())
        .get('/users/suggestions')
        .set('Authorization', `Bearer ${alice.token}`)
        .expect(200);

      expect(suggestions.body.recent[0].id).toBe(bob.id);
      expect(suggestions.body.contacts.length).toBeGreaterThan(0);
      // On ne se suggère jamais soi-même, ni un contact déjà en tête de liste.
      const people = [...suggestions.body.recent, ...suggestions.body.contacts];
      expect(people.some((user: { id: string }) => user.id === alice.id)).toBe(false);
      expect(
        suggestions.body.contacts.some((user: { id: string }) => user.id === bob.id),
      ).toBe(false);
    });

    it('toggles emoji reactions and aggregates them', async () => {
      const alice = await account('Uma', 'React');
      const bob = await account('Vic', 'React');
      const conversation = await request(app.getHttpServer())
        .post('/conversations')
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ memberIds: [bob.id] })
        .expect(201);

      const service = app.get(ConversationsService);
      const message = await service.createMessage(conversation.body.id, alice.id, 'Bonjour');

      const first = await service.toggleReaction(
        conversation.body.id,
        message.id,
        bob.id,
        'mbolo-panther-2d/amour',
      );
      expect(first).toEqual([
        { reaction: 'mbolo-panther-2d/amour', count: 1, mine: true },
      ]);

      const removed = await service.toggleReaction(
        conversation.body.id,
        message.id,
        bob.id,
        'mbolo-panther-2d/amour',
      );
      expect(removed).toEqual([]);

      await expect(
        service.toggleReaction(conversation.body.id, message.id, bob.id, 'abc'),
      ).rejects.toBeTruthy();
    });

    it('lists links and searches the conversation history', async () => {
      const alice = await account('Wendy', 'Search');
      const bob = await account('Xavier', 'Search');
      const conversation = await request(app.getHttpServer())
        .post('/conversations')
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ memberIds: [bob.id] })
        .expect(201);

      const service = app.get(ConversationsService);
      await service.createMessage(
        conversation.body.id,
        alice.id,
        'Regarde https://example.com/page.',
      );
      await service.createMessage(
        conversation.body.id,
        bob.id,
        'Message secret pour la recherche',
      );

      const media = await request(app.getHttpServer())
        .get(`/conversations/${conversation.body.id}/media`)
        .set('Authorization', `Bearer ${bob.token}`)
        .expect(200);
      expect(media.body.attachments).toEqual([]);
      expect(media.body.links[0].url).toBe('https://example.com/page');

      const hits = await request(app.getHttpServer())
        .get(`/conversations/${conversation.body.id}/search`)
        .query({ q: 'secret' })
        .set('Authorization', `Bearer ${bob.token}`)
        .expect(200);
      expect(hits.body).toHaveLength(1);
      expect(hits.body[0].content).toContain('Message secret');

      await request(app.getHttpServer())
        .get(`/conversations/${conversation.body.id}/search`)
        .query({ q: 'secret' })
        .expect(401);
    });

    it('writes system messages for creation and additions', async () => {
      const alice = await account('Yara', 'Systeme');
      const bob = await account('Zack', 'Systeme');
      const charlie = await account('Anna', 'Systeme');

      const group = await request(app.getHttpServer())
        .post('/conversations')
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ type: 'GROUP', name: 'Journal', memberIds: [bob.id] })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/conversations/${group.body.id}/members`)
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ memberIds: [charlie.id] })
        .expect(201);

      const history = await request(app.getHttpServer())
        .get(`/conversations/${group.body.id}/messages`)
        .set('Authorization', `Bearer ${bob.token}`)
        .expect(200);

      const systemMessages = history.body.filter(
        (message: { type: string }) => message.type === 'system',
      );
      expect(systemMessages.length).toBeGreaterThanOrEqual(2);
      expect(
        systemMessages.some((message: { content: string }) =>
          message.content.includes('a créé le groupe'),
        ),
      ).toBe(true);
      expect(
        systemMessages.some((message: { content: string }) =>
          message.content.includes('a ajouté'),
        ),
      ).toBe(true);
    });

    it('enforces who-can-write and who-can-add permissions', async () => {
      const alice = await account('Bea', 'Perm');
      const bob = await account('Cedric', 'Perm');
      const charlie = await account('Diane', 'Perm');

      const group = await request(app.getHttpServer())
        .post('/conversations')
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ type: 'GROUP', name: 'Restreint', memberIds: [bob.id] })
        .expect(201);

      const updated = await request(app.getHttpServer())
        .patch(`/conversations/${group.body.id}`)
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ whoCanSend: 'admins', whoCanAdd: 'admins' })
        .expect(200);
      expect(updated.body.whoCanSend).toBe('admins');
      expect(updated.body.whoCanAdd).toBe('admins');

      const service = app.get(ConversationsService);
      await expect(
        service.createMessage(group.body.id, bob.id, 'Je ne devrais pas pouvoir'),
      ).rejects.toBeTruthy();
      const sent = await service.createMessage(group.body.id, alice.id, 'Message admin');
      expect(sent.content).toBe('Message admin');

      await request(app.getHttpServer())
        .post(`/conversations/${group.body.id}/members`)
        .set('Authorization', `Bearer ${bob.token}`)
        .send({ memberIds: [charlie.id] })
        .expect(403);

      await request(app.getHttpServer())
        .post(`/conversations/${group.body.id}/members`)
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ memberIds: [charlie.id] })
        .expect(201);
    });

    it('enforces the 100-member cap', async () => {
      const alice = await account('Jade', 'Leroy');
      const db = app.get<Database>(DRIZZLE);
      const fakeUsers = await db
        .insert(users)
        .values(
          Array.from({ length: 100 }, (_, index) => ({
            email: `fake_${suffix}_${index}@e2e.dev`,
            username: `fake_${suffix}_${index}`,
            displayName: `Fake ${index}`,
            passwordHash: 'x',
          })),
        )
        .returning({ id: users.id });

      const group = await request(app.getHttpServer())
        .post('/conversations')
        .set('Authorization', `Bearer ${alice.token}`)
        .send({
          type: 'GROUP',
          name: 'Grand groupe',
          memberIds: fakeUsers.slice(0, 99).map((user) => user.id),
        })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/conversations/${group.body.id}/members`)
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ memberIds: [fakeUsers[99].id] })
        .expect(409);
    });

    it('supports invite links with preview, join, expiry and approval', async () => {
      const alice = await account('Kenza', 'Moreau');
      const bob = await account('Lucas', 'Faure');
      const dina = await account('Maya', 'Costa');

      const group = await request(app.getHttpServer())
        .post('/conversations')
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ type: 'GROUP', name: 'Cercle', memberIds: [bob.id] })
        .expect(201);

      const invite = await request(app.getHttpServer())
        .post(`/conversations/${group.body.id}/invites`)
        .set('Authorization', `Bearer ${bob.token}`)
        .send({ expiresInHours: 24, maxUses: 2 })
        .expect(201);
      expect(invite.body.token).toBeTruthy();
      expect(invite.body.status).toBe('ok');

      // L'aperçu est public et ne dévoile aucun membre.
      const preview = await request(app.getHttpServer())
        .get(`/invites/${invite.body.token}`)
        .expect(200);
      expect(preview.body.group.name).toBe('Cercle');
      expect(preview.body.group.memberCount).toBe(2);

      const joined = await request(app.getHttpServer())
        .post(`/invites/${invite.body.token}/join`)
        .set('Authorization', `Bearer ${dina.token}`)
        .expect(200);
      expect(joined.body.status).toBe('joined');

      const members = await request(app.getHttpServer())
        .get(`/conversations/${group.body.id}`)
        .set('Authorization', `Bearer ${alice.token}`)
        .expect(200);
      expect(members.body.members).toHaveLength(3);

      // Invitation avec approbation : la demande attend un admin.
      const approvalInvite = await request(app.getHttpServer())
        .post(`/conversations/${group.body.id}/invites`)
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ requiresApproval: true, maxUses: 1 })
        .expect(201);
      const newcomer = await account('Nina', 'Baron');
      const pending = await request(app.getHttpServer())
        .post(`/invites/${approvalInvite.body.token}/join`)
        .set('Authorization', `Bearer ${newcomer.token}`)
        .expect(200);
      expect(pending.body.status).toBe('pending');

      const requests = await request(app.getHttpServer())
        .get(`/conversations/${group.body.id}/join-requests`)
        .set('Authorization', `Bearer ${alice.token}`)
        .expect(200);
      expect(requests.body).toHaveLength(1);

      await request(app.getHttpServer())
        .post(`/conversations/${group.body.id}/join-requests/${requests.body[0].id}/resolve`)
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ action: 'approve' })
        .expect(201);

      const afterApproval = await request(app.getHttpServer())
        .get(`/conversations/${group.body.id}`)
        .set('Authorization', `Bearer ${alice.token}`)
        .expect(200);
      expect(afterApproval.body.members).toHaveLength(4);

      // Un lien expiré est refusé avec 410.
      const expiredInvite = await request(app.getHttpServer())
        .post(`/conversations/${group.body.id}/invites`)
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ expiresInHours: 1 })
        .expect(201);
      await dbUpdateExpired(expiredInvite.body.token);
      const late = await account('Olga', 'Simon');
      await request(app.getHttpServer())
        .post(`/invites/${expiredInvite.body.token}/join`)
        .set('Authorization', `Bearer ${late.token}`)
        .expect(410);
    });

    it('uploads and removes the group photo', async () => {
      const alice = await account('Pauline', 'Girard');
      const bob = await account('Quentin', 'Aubert');
      const group = await request(app.getHttpServer())
        .post('/conversations')
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ type: 'GROUP', name: 'Photo', memberIds: [bob.id] })
        .expect(201);

      const png =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const uploaded = await request(app.getHttpServer())
        .post(`/conversations/${group.body.id}/photo`)
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ data: png, mimeType: 'image/png' })
        .expect(201);
      expect(uploaded.body.avatarUrl).toBeTruthy();

      await request(app.getHttpServer())
        .post(`/conversations/${group.body.id}/photo`)
        .set('Authorization', `Bearer ${bob.token}`)
        .send({ data: png, mimeType: 'image/png' })
        .expect(403);

      const removed = await request(app.getHttpServer())
        .delete(`/conversations/${group.body.id}/photo`)
        .set('Authorization', `Bearer ${alice.token}`)
        .expect(200);
      expect(removed.body.avatarUrl).toBeNull();
    });
  });
});
